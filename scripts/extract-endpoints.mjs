#!/usr/bin/env node
import { readFile, writeFile } from 'fs/promises';
import yaml from 'js-yaml';
import { dirname, join } from 'path';

const DOCS_DIR = join(dirname(new URL(import.meta.url).pathname), '..', 'docs');
const MAIN_SPEC = join(DOCS_DIR, 'repliers-openapi.json');

// Endpoint groups: file name -> array of paths
const GROUPS = {
  listings: [
    '/listings',
    '/listings/{mlsNumber}',
    '/listings/{mlsNumber}/similar',
    '/listings/history',
    '/listings/deleted',
    '/listings/locations',
    '/listings/property-types',
    '/listings/buildings',
  ],
  agents: [
    '/agents',
    '/agents/{agentId}',
    '/agents/{agentId}/transfer',
  ],
  clients: [
    '/clients',
    '/clients/{clientId}',
    '/clients/tags',
    '/clients/tags/{tag}',
  ],
  searches: [
    '/searches',
    '/searches/{searchId}',
    '/searches/{searchId}/matches',
    '/searches/{searchId}/matches/{matchId}',
  ],
  estimates: [
    '/estimates',
    '/estimates/{estimateId}',
  ],
  messages: [
    '/messages',
    '/messages/{messageId}',
  ],
  favorites: [
    '/favorites',
    '/favorites/{favoriteId}',
  ],
  webhooks: [
    '/webhooks',
    '/webhooks/{webhookId}',
    '/webhooks/events',
  ],
  members: ['/members'],
  offices: ['/offices'],
  places: ['/places'],
  brokerages: ['/brokerages'],
};

// Convert a path like /listings/{mlsNumber} to JSON Pointer: ~1listings~1{mlsNumber}
function pathToJsonPointer(path) {
  return path.replace(/\//g, '~1');
}

// Capitalize first letter
function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

async function main() {
  const specRaw = await readFile(MAIN_SPEC, 'utf8');
  const spec = JSON.parse(specRaw);

  for (const [groupName, paths] of Object.entries(GROUPS)) {
    // Build the paths object for this YAML file
    const yamlPaths = {};
    for (const path of paths) {
      if (!(path in spec.paths)) {
        console.error(`WARNING: path ${path} not found in spec, skipping`);
        continue;
      }
      // Skip paths that are already $ref (already extracted)
      if ('$ref' in spec.paths[path]) {
        console.error(`WARNING: path ${path} is already a $ref, skipping`);
        continue;
      }
      yamlPaths[path] = spec.paths[path];
    }

    if (Object.keys(yamlPaths).length === 0) {
      console.log(`Skipping ${groupName}: no inline paths to extract`);
      continue;
    }

    // Build the standalone OpenAPI doc
    const yamlDoc = {
      openapi: '3.1.0',
      info: {
        title: `${capitalize(groupName)} API`,
        version: '1.0.0',
      },
      servers: [
        { url: 'https://api.repliers.io' },
      ],
      paths: yamlPaths,
    };

    // Write the YAML file
    const yamlContent = yaml.dump(yamlDoc, {
      lineWidth: -1, // don't wrap lines
      noRefs: true,  // don't use YAML anchors/aliases
      quotingType: '"',
      forceQuotes: false,
    });

    const yamlPath = join(DOCS_DIR, `${groupName}.yml`);
    await writeFile(yamlPath, yamlContent, 'utf8');
    console.log(`Created ${groupName}.yml (${Object.keys(yamlPaths).length} paths)`);

    // Replace inline paths with $ref in the main spec
    for (const path of Object.keys(yamlPaths)) {
      const pointer = pathToJsonPointer(path);
      spec.paths[path] = {
        $ref: `${groupName}.yml#/paths/${pointer}`,
      };
    }
  }

  // Write the updated main spec
  const updatedJson = JSON.stringify(spec, null, 4) + '\n';
  await writeFile(MAIN_SPEC, updatedJson, 'utf8');
  console.log('\nUpdated repliers-openapi.json with $ref pointers');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
