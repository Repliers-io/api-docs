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
