#!/usr/bin/env node
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { validate, bundle, compileErrors } from '@readme/openapi-parser';
import { writeFile } from 'fs/promises';
import { dirname } from 'path';
import { mkdir } from 'fs/promises';
import pc from 'picocolors';

// Helper function to ensure directory exists
async function ensureDirectoryExists(filePath) {
  const dir = dirname(filePath);
  try {
    await mkdir(dir, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') {
      throw err;
    }
  }
}

// Helper function to validate a file
async function validateFile(filePath) {
  try {
    const result = await validate(filePath);

    if (result.valid) {
      return { valid: true, result };
    } else {
      console.error(pc.red(`✗ ${filePath} is not valid`));

      // Try to get formatted errors with colors
      try {
        const errorOutput = compileErrors(result, {
          colorize: true,
          format: 'stylish',
        });
        console.error(errorOutput);
      } catch (compileErr) {
        // Fallback to basic error display
        if (result.errors && result.errors.length > 0) {
          result.errors.forEach((error) => {
            console.error(pc.red(`  • ${error.message}`));
            if (error.path) {
              console.error(pc.gray(`    at ${error.path}`));
            }
          });
        }
      }

      return { valid: false, result };
    }
  } catch (err) {
    console.error(pc.red(`Error validating ${filePath}:`), err.message);
    return { valid: false, error: err };
  }
}

// Validate command handler
async function validateCommand(argv) {
  const { file } = argv;

  const validation = await validateFile(file);

  if (validation.valid) {
    console.log(pc.green(`✓ ${file} is valid`));
    process.exit(0);
  } else {
    process.exit(1);
  }
}

// Bundle command handler
async function bundleCommand(argv) {
  const { file, output } = argv;

  // First validate the file
  console.log(pc.blue(`Validating ${file}...`));
  const validation = await validateFile(file);

  if (!validation.valid) {
    console.error(pc.red(`Cannot bundle ${file}: validation failed`));
    process.exit(1);
  }

  console.log(pc.green(`✓ ${file} is valid, proceeding with bundling...`));

  try {
    const bundled = await bundle(file);
    const jsonOutput = JSON.stringify(bundled, null, 2);

    await ensureDirectoryExists(output);
    await writeFile(output, jsonOutput, 'utf8');

    console.log(pc.green(`✓ Bundled ${file} and saved to ${output}`));
  } catch (err) {
    console.error(pc.red(`Error bundling ${file}:`), err.message);
    process.exit(1);
  }
}

// Strip HTML tags from a string
function stripHtml(str) {
  if (!str) return '';
  return str
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// Format a schema type for display (e.g. "array[string]", "integer (int32)")
function formatType(schema) {
  if (!schema) return 'any';
  if (schema.type === 'array') {
    const itemType = schema.items?.type || 'any';
    return `array[${itemType}]`;
  }
  let t = schema.type || 'any';
  if (schema.enum) t += ` enum: ${schema.enum.join(', ')}`;
  if (schema.format) t += ` (${schema.format})`;
  if (schema.default !== undefined) t += ` default: ${schema.default}`;
  return t;
}

// Escape pipe characters in markdown table cells
function escapeCell(str) {
  return str.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

// Resolve a local JSON-pointer $ref against the bundled doc.
// The bundler deduplicates shared parameters by inlining the first use and
// emitting self-references (e.g. "#/paths/~1locations/get/parameters/0") for
// subsequent uses, so we have to follow them before rendering.
function resolveRef(doc, ref) {
  if (!ref || !ref.startsWith('#/')) return null;
  const segments = ref.slice(2).split('/').map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur = doc;
  for (const seg of segments) {
    if (cur == null) return null;
    cur = cur[seg];
  }
  return cur;
}

function resolveParams(params, bundled) {
  return (params || [])
    .map(p => (p && p.$ref ? resolveRef(bundled, p.$ref) : p))
    .filter(Boolean);
}

// Group and order paths from a bundled spec
function groupPaths(bundled) {
  const groups = {};
  for (const [path, pathObj] of Object.entries(bundled.paths || {})) {
    const prefix = path.split('/')[1] || 'root';
    if (!groups[prefix]) groups[prefix] = [];

    for (const [method, op] of Object.entries(pathObj)) {
      if (!op || typeof op !== 'object' || !op.summary) continue;
      if (op.deprecated) continue;

      const summary = op.summary.replace(/\s*\(Deprecated\)\s*$/i, '').trim();
      groups[prefix].push({ method: method.toUpperCase(), path, summary, op });
    }
  }

  const groupOrder = [
    'listings', 'locations', 'buildings', 'nlp',
    'agents', 'clients', 'searches', 'estimates',
    'messages', 'favorites', 'webhooks',
    'members', 'offices', 'brokerages', 'places',
  ];
  const orderedKeys = [
    ...groupOrder.filter(k => groups[k]),
    ...Object.keys(groups).filter(k => !groupOrder.includes(k)),
  ];

  return { groups, orderedKeys };
}

// Build the header shared by both llms.txt and llms-full.txt
function buildHeader(bundled) {
  const baseUrl = bundled.servers?.[0]?.url || 'https://api.repliers.io';
  const title = bundled.info?.title || 'API';

  let content = `# ${title}\n\n`;
  content += `> Real-time real estate data API for North America. Provides listings search, location data, building info, agent/client management, saved searches, market estimates, messaging, favorites, webhooks, and NLP-powered natural language search.\n\n`;
  content += `Base URL: ${baseUrl}\n`;
  content += `Auth: API key via \`REPLIERS-API-KEY\` header\n`;
  return content;
}

// Generate compact llms.txt
function generateCompact(bundled) {
  const { groups, orderedKeys } = groupPaths(bundled);
  let content = buildHeader(bundled);

  for (const group of orderedKeys) {
    const endpoints = groups[group];
    if (!endpoints || endpoints.length === 0) continue;

    const heading = group.charAt(0).toUpperCase() + group.slice(1);
    content += `\n## ${heading}\n\n`;

    for (const ep of endpoints) {
      content += `- ${ep.method} ${ep.path}: ${ep.summary}\n`;
    }
  }
  return { content, orderedKeys, groups };
}

// Generate detailed llms-full.txt
function generateFull(bundled) {
  const { groups, orderedKeys } = groupPaths(bundled);
  let content = buildHeader(bundled);
  let totalParams = 0;

  for (const group of orderedKeys) {
    const endpoints = groups[group];
    if (!endpoints || endpoints.length === 0) continue;

    const heading = group.charAt(0).toUpperCase() + group.slice(1);
    content += `\n## ${heading}\n`;

    for (const ep of endpoints) {
      const { op } = ep;
      content += `\n### ${ep.method} ${ep.path}\n\n`;

      // Description
      const desc = stripHtml(op.description || op.summary);
      if (desc) content += `${desc}\n`;

      // Path parameters
      const resolvedParams = resolveParams(op.parameters, bundled);
      const pathParams = resolvedParams.filter(p => p.in === 'path');
      if (pathParams.length > 0) {
        content += `\n**Path Parameters:**\n\n`;
        content += `| Name | Type | Description |\n|---|---|---|\n`;
        for (const p of pathParams) {
          content += `| ${p.name} | ${formatType(p.schema)} | ${escapeCell(stripHtml(p.description))} |\n`;
          totalParams++;
        }
      }

      // Query parameters
      const queryParams = resolvedParams.filter(p => p.in === 'query');
      if (queryParams.length > 0) {
        content += `\n**Query Parameters:**\n\n`;
        content += `| Name | Type | Description |\n|---|---|---|\n`;
        for (const p of queryParams) {
          content += `| ${p.name} | ${formatType(p.schema)} | ${escapeCell(stripHtml(p.description))} |\n`;
          totalParams++;
        }
      }

      // Request body
      const bodySchema = op.requestBody?.content?.['application/json']?.schema;
      if (bodySchema?.properties) {
        content += `\n**Request Body:**\n\n`;
        content += `| Field | Type | Required | Description |\n|---|---|---|---|\n`;
        const required = new Set(bodySchema.required || []);
        for (const [name, prop] of Object.entries(bodySchema.properties)) {
          const req = required.has(name) ? 'yes' : 'no';
          const propDesc = stripHtml(prop.description || '');
          content += `| ${name} | ${formatType(prop)} | ${req} | ${escapeCell(propDesc)} |\n`;
          totalParams++;
        }
      }

      content += `\n---\n`;
    }
  }

  return { content, orderedKeys, groups, totalParams };
}

// LLMs.txt command handler
async function llmsCommand(argv) {
  const { file, output, full } = argv;

  console.log(pc.blue(`Bundling ${file}...`));
  try {
    const bundled = await bundle(file);

    let content, orderedKeys, groups, totalParams;
    if (full) {
      ({ content, orderedKeys, groups, totalParams } = generateFull(bundled));
    } else {
      ({ content, orderedKeys, groups } = generateCompact(bundled));
    }

    await ensureDirectoryExists(output);
    await writeFile(output, content, 'utf8');

    const endpointCount = Object.values(groups).flat().length;
    const extra = full ? `, ${totalParams} params` : '';
    console.log(pc.green(`✓ Generated ${output} (${orderedKeys.length} groups, ${endpointCount} endpoints${extra})`));
  } catch (err) {
    console.error(pc.red(`Error generating LLMs.txt:`), err.message);
    process.exit(1);
  }
}

// Upload command handler (stubbed)
async function uploadCommand(argv) {
  const { file } = argv;

  // First validate the file
  console.log(`Validating ${file}...`);
  const validation = await validateFile(file);

  if (!validation.valid) {
    console.error(`Cannot upload ${file}: validation failed`);
    process.exit(1);
  }

  console.log(`✓ ${file} is valid`);
  console.log(`Upload functionality for ${file} is not yet implemented`);
  process.exit(0);
}

// Configure yargs
const cli = yargs(hideBin(process.argv))
  .scriptName('index.js')
  .usage('Usage: $0 <command> <file> [options]')
  .command(
    'validate <file>',
    'Validate an OpenAPI specification file',
    (yargs) => {
      return yargs.positional('file', {
        describe: 'Path to the OpenAPI specification file',
        type: 'string',
        demandOption: true,
      });
    },
    validateCommand
  )
  .command(
    'bundle <file>',
    'Bundle an OpenAPI specification and save to file',
    (yargs) => {
      return yargs
        .usage('$0 bundle <file> --output <output_file>')
        .positional('file', {
          describe: 'Path to the OpenAPI specification file',
          type: 'string',
          demandOption: true,
        })
        .option('output', {
          alias: 'o',
          describe: 'Output file path for bundled specification',
          type: 'string',
          demandOption: true,
        });
    },
    bundleCommand
  )
  .command(
    'llms <file>',
    'Generate LLMs.txt from an OpenAPI specification',
    (yargs) => {
      return yargs
        .usage('$0 llms <file> --output <output_file>')
        .positional('file', {
          describe: 'Path to the OpenAPI specification file',
          type: 'string',
          demandOption: true,
        })
        .option('output', {
          alias: 'o',
          describe: 'Output file path for LLMs.txt',
          type: 'string',
          default: './llms.txt',
        })
        .option('full', {
          describe: 'Generate detailed version with all parameters and request bodies',
          type: 'boolean',
          default: false,
        });
    },
    llmsCommand
  )
  .command(
    'upload <file>',
    'Upload specification (not yet implemented)',
    (yargs) => {
      return yargs.positional('file', {
        describe: 'Path to the OpenAPI specification file',
        type: 'string',
        demandOption: true,
      });
    },
    uploadCommand
  )
  .example('$0 validate ./docs/api.yml', 'Validate an OpenAPI specification')
  .example('$0 bundle ./docs/api.yml --output ./output/bundled.json', 'Bundle and save specification')
  .example('$0 upload ./docs/api.yml', 'Upload specification (stub)')
  .demandCommand(1, 'You need at least one command before moving on')
  .help('h')
  .alias('h', 'help')
  .version('1.0.0')
  .strict()
  .fail((msg, err, yargs) => {
    if (err) {
      console.error('Unexpected error:', err.message);
    } else {
      console.error('Error:', msg);
    }
    console.error('\n' + yargs.help());
    process.exit(1);
  });

// Parse arguments and execute
cli.parse();
