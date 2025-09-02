# Docs

This repository contains OpenAPI spec files for [Repliers Realtime API](https://repliers.com/).

Hosted Docs can be found on [docs.repliers.io](https://docs.repliers.io).

### Folder Structure

- [docs](docs/) folder contains the OpenAPI spec source files.
- [bundled_docs](bundled_docs/) folder contains the bundled OpenAPI spec file ready for upload.

### Installation

Run `npm i` to install dependencies.

### Available commands

- `npm run docs-validate` - Validate the OpenAPI spec files.
- `npm run docs-bundle` - Bundle the OpenAPI spec files into a single file with resolved references.
- `npm run docs-upload` - Upload the bundled OpenAPI spec file to the host.
