# Docs

This repository contains OpenAPI spec files for [Repliers Realtime API](https://repliers.com/).

Hosted Docs can be found on [docs.repliers.io](https://docs.repliers.io).

### Folder Structure

- [docs](docs/) folder contains the OpenAPI spec source files.
- [bundled_docs](bundled_docs/) folder contains the bundled OpenAPI spec file ready for upload.
- [scripts](scripts/) folder contains maintenance scripts, including schema discovery (see below).

### Installation

Run `npm i` to install dependencies.

### Available commands

- `npm run docs-validate` - Validate the OpenAPI spec files.
- `npm run docs-bundle` - Bundle the OpenAPI spec files into a single file with resolved references.
- `npm run docs-upload` - Upload the bundled OpenAPI spec file to the host.
- `npm run docs-llms` - Generate a compact endpoint index (`llms.txt`) for LLM consumption.
- `npm run docs-llms-full` - Generate a detailed endpoint reference (`llms-full.txt`) for LLM consumption.
- `npm run docs-discover-schemas` - Call the live Repliers API to find response fields that are undocumented or drifted from `docs/*.yml`. See below.

### Schema discovery

`scripts/discover-response-schemas.mjs` walks every endpoint, calls the live Repliers API, and diffs each real response against what's currently documented. It's read-only with respect to `docs/*.yml` — turning its findings into actual documentation updates is a manual review step. See [`.claude/skills/analyze-schema-discovery/`](.claude/skills/analyze-schema-discovery/SKILL.md) for the full workflow, including known diff-tool blind spots and other gotchas worth knowing before trusting its output blindly.

Requires `REPLIERS_API_KEY` in `.env` (`REPLIERS_PLACES_API_KEY` too, if that key isn't Canada-scoped — `GET /places` is Canada-only). It creates a handful of clearly-labelled test records (agent, client, message, webhook, search, estimate, favorite) so GET-by-id endpoints have real data to inspect, then deletes them again at the end. Nothing is ever run against pre-existing data — mutating calls beyond the initial setup are either opt-in (`--include-mutating`) or never made at all (PATCH/DELETE).

Every run flushes `scripts/.output/` first, so results never mix across runs:

- `scripts/.output/summary.txt` - the full run transcript, overwritten every run.
- `scripts/.output/*.json` - one draft per endpoint, with the inferred schema and a diff against the current docs.
- `scripts/.output/errors/*.json` - failed calls, with the exact request sent and the full response.
