#!/usr/bin/env node
/**
 * Semantic verification: dereferences both baseline and current bundled specs,
 * then compares them path-by-path to ensure no information was lost.
 */
import { readFile } from 'fs/promises';
import { dereference } from '@readme/openapi-parser';
import { dirname, join } from 'path';

const ROOT = join(dirname(new URL(import.meta.url).pathname), '..');
const BASELINE = join(ROOT, 'bundled_docs', 'repliers-baseline.json');
const CURRENT = join(ROOT, 'bundled_docs', 'repliers.json');

function deepEqual(a, b, path = '') {
  if (a === b) return [];

  if (typeof a !== typeof b) {
    return [{ path, type: 'type_mismatch', expected: typeof a, got: typeof b }];
  }

  if (a === null || b === null) {
    return [{ path, type: 'value_mismatch', expected: a, got: b }];
  }

  if (typeof a !== 'object') {
    return [{ path, type: 'value_mismatch', expected: a, got: b }];
  }

  if (Array.isArray(a) !== Array.isArray(b)) {
    return [{ path, type: 'array_mismatch', expected: Array.isArray(a), got: Array.isArray(b) }];
  }

  const diffs = [];

  if (Array.isArray(a)) {
    if (a.length !== b.length) {
      diffs.push({ path, type: 'array_length', expected: a.length, got: b.length });
    }
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      diffs.push(...deepEqual(a[i], b[i], `${path}[${i}]`));
    }
  } else {
    const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of allKeys) {
      if (!(key in a)) {
        diffs.push({ path: `${path}.${key}`, type: 'missing_in_baseline', got: typeof b[key] });
      } else if (!(key in b)) {
        diffs.push({ path: `${path}.${key}`, type: 'missing_in_current', expected: typeof a[key] });
      } else {
        diffs.push(...deepEqual(a[key], b[key], `${path}.${key}`));
      }
    }
  }

  return diffs;
}

async function main() {
  console.log('Loading specs...');
  const baselineRaw = JSON.parse(await readFile(BASELINE, 'utf8'));
  const currentRaw = JSON.parse(await readFile(CURRENT, 'utf8'));

  console.log('Dereferencing baseline...');
  const baseline = await dereference(structuredClone(baselineRaw));

  console.log('Dereferencing current...');
  const current = await dereference(structuredClone(currentRaw));

  // Compare paths
  const baselinePaths = Object.keys(baseline.paths || {}).sort();
  const currentPaths = Object.keys(current.paths || {}).sort();

  const missingPaths = baselinePaths.filter(p => !currentPaths.includes(p));
  const extraPaths = currentPaths.filter(p => !baselinePaths.includes(p));

  if (missingPaths.length) {
    console.error(`FAIL: Paths missing from current: ${missingPaths.join(', ')}`);
  }
  if (extraPaths.length) {
    console.error(`FAIL: Extra paths in current: ${extraPaths.join(', ')}`);
  }

  let totalDiffs = 0;
  for (const pathName of baselinePaths) {
    if (!current.paths[pathName]) continue;

    const diffs = deepEqual(
      baseline.paths[pathName],
      current.paths[pathName],
      `paths.${pathName}`
    );

    if (diffs.length > 0) {
      console.error(`\nDiffs in ${pathName}: ${diffs.length}`);
      for (const d of diffs.slice(0, 5)) {
        console.error(`  ${d.path}: ${d.type} (expected: ${d.expected}, got: ${d.got})`);
      }
      if (diffs.length > 5) {
        console.error(`  ... and ${diffs.length - 5} more`);
      }
      totalDiffs += diffs.length;
    }
  }

  // Also compare top-level keys (excluding paths)
  for (const key of ['info', 'servers', 'components', 'security']) {
    const diffs = deepEqual(baseline[key], current[key], key);
    if (diffs.length > 0) {
      console.error(`\nDiffs in top-level '${key}': ${diffs.length}`);
      for (const d of diffs.slice(0, 3)) {
        console.error(`  ${d.path}: ${d.type}`);
      }
      totalDiffs += diffs.length;
    }
  }

  if (totalDiffs === 0 && missingPaths.length === 0 && extraPaths.length === 0) {
    console.log('\nPASS: Semantic content is identical');
    process.exit(0);
  } else {
    console.error(`\nFAIL: ${totalDiffs} total differences found`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
