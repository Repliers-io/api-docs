# CLAUDE.md

Always call me Mr. Coder

## What This Project Is

OpenAPI documentation for the Repliers Realtime API (a North American real estate data API). The source spec is split across multiple files in `docs/` and gets bundled into a single file for upload to the hosted docs platform (ReadMe.io).

## Key Commands

- `npm run docs-validate` — validate the OpenAPI spec
- `npm run docs-bundle` — bundle into `bundled_docs/repliers.json`
- `npm run docs-upload` — bundle + upload to ReadMe.io (requires `.env` with API key)

Always run `npm run docs-validate` after making changes to verify the spec is valid.

## File Structure

- `docs/repliers-openapi.json` — **main entrypoint spec** (OpenAPI 3.1.0). Contains most endpoints inline and uses `$ref` to pull in paths from the YAML files below.
- `docs/components.yml` — shared schemas (pagination, property classes, GeoJSON, etc.)
- `docs/buildings.yml` — `/buildings` endpoint (POST)
- `docs/locations.yml` — `/locations` and `/locations/autocomplete` endpoints (GET)
- `docs/nlp.yml` — `/nlp` and `/nlp/chats` endpoints (POST)
- `index.js` — CLI tool wrapping `@readme/openapi-parser` for validate/bundle/upload
- `bundled_docs/` — generated output, don't edit manually

## Editing Conventions

- The main spec (`repliers-openapi.json`) uses **4-space indent** for JSON
- YAML files in `docs/` use **2-space indent**
- When adding a new endpoint: create a separate YAML file and `$ref` it from the main spec.
- Existing `$ref` pattern: `"$ref": "buildings.yml#/paths/~1buildings"` (tilde-encoding for `/` in JSON pointer)

## Gotchas

- The `.env` file contains a ReadMe API key — it's gitignored, don't commit it
- `bundled_docs/` is committed to the repo (not gitignored)
- Node >= 24 is required (see `.nvmrc` for exact version)
- Some paths in the main JSON spec appear to have encoded/obfuscated names — these are intentional, don't "fix" them
