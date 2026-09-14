---
name: analyze-schema-discovery
description: Run scripts/discover-response-schemas.mjs against the live Repliers API and turn its output into docs/*.yml updates. Use whenever asked to find undocumented/drifted response fields, run "discover schemas", or review scripts/.output/ results.
---

# Analyzing schema-discovery output

`scripts/discover-response-schemas.mjs` calls the live Repliers API, infers a
JSON Schema from each real response, and diffs it against whatever's already
documented in `docs/*.yml`. It is **read-only with respect to the docs** —
it never edits YAML itself. Turning its findings into doc updates is a
separate, human-judgment step. This skill is about doing that step well.

## Running it

```
npm run docs-discover-schemas              # safe endpoints only (GET + 3 search POSTs)
npm run docs-discover-schemas -- --include-mutating   # also calls POST-create endpoints
npm run docs-discover-schemas -- --keep-created       # skip cleanup, print created ids
```

Requires `REPLIERS_API_KEY` in `.env` (sourced automatically by the npm
script). If the key isn't Canada-scoped, also set `REPLIERS_PLACES_API_KEY`
for `GET /places`, which is Canada-only.

Every run **flushes `scripts/.output/` first** (both drafts and `errors/`),
so whatever's on disk after a run reflects that run only — never a mix of
this run's successes and a previous run's stale failures (or vice versa).

It creates real (clearly-labelled, e.g. `[schema-discovery] test search ...`)
records — an agent, client, message, webhook, search, estimate, favorite —
so GET-by-id endpoints have real data to return, then deletes them again at
the end (messages have no DELETE endpoint, so that one is left behind).
PATCH/DELETE on pre-existing data are never called; POST-create is gated
behind `--include-mutating`.

## Response shape can depend on query params, not just be filtered by them

Some endpoints don't just filter the same shape — different param values
expose genuinely different fields. `GET /locations` is the known case:
`type=school`+`source=LiveBy` returns a `school` object (district/metrics/
grades/etc.), `type=property`+`source=PublicRecord` returns a `publicRecord`
object (140+ parcel/tax/ownership fields), `type=neighborhood`+`source=LiveBy`
returns `demographics`. A single default (no-params) call sees none of this.

`PARAM_VARIANTS` in the script (near `SAFE_SEARCH_POST_BODIES`) handles this:
list extra query-param combinations per path, and the walk calls the
endpoint once per variant, deep-merging every response body into one
combined sample (via `mergeSamples`) before inferring a schema — so the
draft covers the union of shapes actually observed. If you find another
endpoint with param-dependent shape (not just param-dependent filtering),
add it here rather than writing a one-off exploration script — it stays
reusable and shows up in every future run automatically. When you add a
variant that turns out to hit a genuinely large fixed schema (like
`publicRecord`'s 140+ fields), generate the YAML fragment programmatically
from the draft's `inferredSchema` rather than hand-typing it — see the
session history for the pattern (a small Node script walking the schema
object, emitting `type:`/`properties:` at the right indent).

**Indentation gotcha when hand-splicing generated YAML**: figure out the
target indent from the schema's *direct* sibling (e.g. `demographics:`
itself), not from some deeply-nested leaf field inside it (e.g.
`demographics.medianMortgageMonthlyCost`) — the latter is several levels
deeper and anchoring off it will nest your new content one level too deep,
silently, with no YAML syntax error (it'll parse fine, just land inside the
wrong parent). Always re-run `yaml.load` and print
`Object.keys(theSchemaYouEdited.properties)` afterward to confirm the new
keys actually landed as direct siblings where intended — "the file parses"
is not the same as "it's structured correctly."

## Always add a pseudo-real `example:` — never leave a field bare

Every field should get an `example:`, not just `type:`/`description:`. Two
reasons: the hosted docs platform renders a bare type name (literally the
word `"string"`) when a field has no example, which reads as broken —
readers can't tell what the field actually looks like. And a well-chosen
example often communicates a field's purpose better than its name does,
especially for terse/coded field names (`ltvCurrEstComb`, `HAR_MLS`,
`numberofresmths`) where the description alone doesn't make it obvious.
Skipping `example:` "to keep it simple" is no longer the right default —
treat a field left without one as unfinished, not as a valid end state.

`scrubValue()`/`fakeStringFor()` in the script scrub every string, number,
and boolean unconditionally before anything is written to
`scripts/.output/*.json` — there's no code path where a real value survives
into a draft, even for a field name the scrubber doesn't specifically
recognize (it still gets replaced with a fake, never passed through). Pull
`example:` values from there (`scrubbedExampleResponse`), never from a raw
curl/manual test response, and never hand-invent something that could
double as real account data (someone's actual name, a real-looking phone
number, etc.).

If the scrubber's generic fallback produced something nonsensical for a
field's apparent type (e.g. a bathroom count example of `"reviewed"`, a
dollar amount of `"sample"`), that's a sign `fakeStringFor()` needs a new
pattern, not a reason to skip the example — add a semantic case (see the
`year`/`acres`/`sqft`/`value`/`price`/`amount`/`number(of)` patterns already
there for a model) so the fix benefits every future field with that same
naming pattern, then regenerate the draft and use the improved value.

None of this is about sensitivity — e.g. `GET /locations`' `publicRecord`
object (owner names, mailing addresses, tax/sale history) is legally public
record data, nothing extra-sensitive about it specifically. It's purely
about giving every field a plausible, useful example instead of an
accidentally-real one or none at all.

## Where to look

- **`scripts/.output/summary.txt`** — the full console transcript from the
  run, overwritten every time. Read this first — it's the fastest way to see
  what succeeded, what drifted, what's still undocumented, and what failed
  (with the real error body, not just a status code).
- **`scripts/.output/<slug>.json`** — one draft per successful endpoint:
  `diff.fieldsInLiveResponseNotInDocs`, `diff.documentedFieldsNotObservedInThisSample`,
  a full `inferredSchema`, and a `scrubbedExampleResponse` (see below).
- **`scripts/.output/errors/<slug>.json`** — one file per failed call (non-2xx
  or thrown error), with the *exact* request that was sent and the full
  response body. Use these to fix request bodies, not just to note "it
  failed."

## `scrubbedExampleResponse` is fake data — always

Every value in a draft's `scrubbedExampleResponse` has been replaced with a
synthetic placeholder (fake names, `example@example.com`, `555-0100`, `42`,
etc.) before it ever touched disk. It's safe to reference for **shape and
field names**, never for realistic-looking content — don't be misled by it
looking like plausible data.

## The diff is a hint, not ground truth — verify before writing anything

`fieldsInLiveResponseNotInDocs` is computed by resolving the documented
schema and diffing flattened property paths. It has real, known blind spots
in this codebase, discovered the hard way:

- **`oneOf`/multi-branch duplication**: several files (`listings.yml`
  especially) have the *same* response schema hand-duplicated inline across
  2–6 branches (`oneOf` variants, or titled `Version 1`/`Version 2`). A field
  documented in one branch but not another will show as "new" even though
  it's already half-covered. Before writing anything, `grep` the target file
  for the field/sibling names to see how many places actually need the fix.
- **Cross-file `$ref` and same-file `allOf`** resolution has occasionally
  under-detected fields that were already documented (e.g. `nlpId`/`nlpVersion`
  in `nlp.yml`, already in `NLPResponseObject`, showed as "new" once). If a
  "new" field looks suspiciously already-covered, check the actual schema
  before duplicating it.
- **Empty responses tell you nothing about shape.** If the live account had
  no data for an endpoint (empty array, `{}`), the diff can't tell you
  anything about item shape — don't write speculative fields; note "item
  shape not verified against a live response" instead of asserting types you
  didn't actually observe. If a later run *does* have real data for that
  endpoint, replace the placeholder note with the real shape.

Given this, treat every finding as "investigate," not "copy-paste":
`grep`/read the current `docs/*.yml` content, confirm what's really there,
and only then write the fix.

## Modeling dynamic-keyed data — don't enumerate what varies

Some response objects are keyed by data-dependent values, not a fixed field
set: MLS `features` bags (keys like `"Email"`, `"County"` that vary per
record), `bathrooms.1`/`.2`/`.3` (keyed by bathroom number), RESO/raw MLS
passthrough objects (`raw`, `reso` — hundreds of board-specific field names).
Documenting these as named properties is actively wrong the moment the next
record has a different key. Use `additionalProperties: true` with a note
explaining the keys vary, instead of enumerating a snapshot. When genuinely
unsure whether something is fixed (safe to enumerate) or dynamic (model
generically), prefer leaving it under-specified over guessing wrong.

## Match each file's existing conventions, not a global style

`nullable: true` vs. OpenAPI 3.1 `type: [string, "null"]` vs. no null
handling at all — different `docs/*.yml` files have already picked different
conventions. Match whichever the *target file* already uses; don't impose
one style across files. Same for `example:` usage — some files use it
heavily (`listings.yml`, `searches.yml`), others never do (`agents.yml`,
`clients.yml`) — follow the file you're editing.

## Real bugs hide in here too — not just gaps

This isn't only about missing fields. Past runs turned up: a pervasive
`ammenities`→`amenities` typo in `listings.yml` schema keys (confirmed via
live data, fixed everywhere it appeared as an actual key — left alone in
unrelated example-JSON text blocks as out of scope), a wrong request shape
for `buildings.yml`'s `map` parameter (rejected by the live API; the real
shape matched `listings.yml`'s own documented `map` param), and a real type
error in `places.yml` (`city`/`county` documented as strings, actually
`{id, name, slug}` objects), and a wrong enum value (`components.yml`'s
`LocationSource` enum listed `MSL`; the live API 400s on it and names `MLS`
as the valid value in its own error message). Read `errors/*.json` response
bodies closely — they're often telling you the docs are wrong, not just
incomplete. When a param takes an enum, don't just trust the documented
enum list — a live 400 (or the variant-exploration mechanism above) can
reveal the doc itself has the typo.

## After writing changes

Always run `npm run docs-validate` (and ideally `npm run docs-bundle`) after
editing `docs/*.yml`. For any edit spanning many lines or duplicated across
branches, re-read the surrounding YAML afterward (not just `docs-validate`,
which only checks that the spec parses — it won't catch e.g. a trailing
`"400"`/`"401"` block accidentally landing under the wrong key after a large
replacement). A quick `node -e "yaml.load(...)"` plus checking
`Object.keys()` on the part you just touched is cheap insurance.
