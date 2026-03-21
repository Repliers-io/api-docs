#!/usr/bin/env node
import { readFile, writeFile } from 'fs/promises';
import yaml from 'js-yaml';
import { dirname, join } from 'path';

const DOCS_DIR = join(dirname(new URL(import.meta.url).pathname), '..', 'docs');

// The 12 new YAML files to process
const YAML_FILES = [
  'listings.yml',
  'agents.yml',
  'clients.yml',
  'searches.yml',
  'estimates.yml',
  'messages.yml',
  'favorites.yml',
  'webhooks.yml',
  'members.yml',
  'offices.yml',
  'places.yml',
  'brokerages.yml',
];

// The standard empty response shape to match against
const EMPTY_RESPONSE_SHAPE = JSON.stringify({
  type: 'object',
  properties: {},
}, Object.keys({ type: '', properties: {} }).sort());

function isEmptyResponseSchema(schema) {
  if (!schema || typeof schema !== 'object') return false;
  return schema.type === 'object'
    && schema.properties !== undefined
    && Object.keys(schema.properties).length === 0
    && Object.keys(schema).length === 2;
}

function isStandardEmptyResponse(response) {
  if (!response || typeof response !== 'object') return false;
  const content = response.content?.['application/json'];
  if (!content) return false;
  const examples = content.examples;
  if (!examples || !examples.Result || Object.keys(examples).length !== 1) return false;
  if (examples.Result.value !== '{}') return false;
  return isEmptyResponseSchema(content.schema);
}

async function main() {
  let totalReplacements = 0;

  for (const fileName of YAML_FILES) {
    const filePath = join(DOCS_DIR, fileName);
    const raw = await readFile(filePath, 'utf8');
    const doc = yaml.load(raw);

    let fileReplacements = 0;

    for (const [pathName, pathObj] of Object.entries(doc.paths || {})) {
      for (const [method, operation] of Object.entries(pathObj)) {
        if (!operation || typeof operation !== 'object' || !operation.responses) continue;

        for (const [code, response] of Object.entries(operation.responses)) {
          if (!isStandardEmptyResponse(response)) continue;

          if (code === '200') {
            operation.responses[code] = { $ref: 'components.yml#/components/responses/EmptySuccess' };
            fileReplacements++;
          } else if (code === '400') {
            operation.responses[code] = { $ref: 'components.yml#/components/responses/BadRequest' };
            fileReplacements++;
          }
        }
      }
    }

    if (fileReplacements > 0) {
      const yamlContent = yaml.dump(doc, {
        lineWidth: -1,
        noRefs: true,
        quotingType: '"',
        forceQuotes: false,
      });
      await writeFile(filePath, yamlContent, 'utf8');
      console.log(`${fileName}: ${fileReplacements} responses replaced with $ref`);
    } else {
      console.log(`${fileName}: no matching responses found`);
    }

    totalReplacements += fileReplacements;
  }

  console.log(`\nTotal: ${totalReplacements} responses replaced`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
