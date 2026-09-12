#!/usr/bin/env node
// Walks every endpoint in docs/*.yml, calls the live Repliers API, infers a
// JSON Schema from the real response, and diffs it against whatever response
// schema is already documented (if any). Drafts — inferred schema, a scrubbed
// example, and the diff — are written to scripts/.output/ for manual review.
// Nothing here edits docs/*.yml directly.
//
// This is meant to run repeatedly (not just once for known gaps) so schema
// drift on ALREADY-documented endpoints gets caught too, not just first-time
// gaps.
//
// SETUP PHASE: before walking any GET endpoints, this creates one test
// agent/client/message/webhook/search/estimate/favorite (each clearly
// labelled "schema-discovery" in its name/content) so that GET-by-id and
// list endpoints always have real data to return, rather than depending on
// whatever happens to already exist in the account. This creates real
// records in whatever account REPLIERS_API_KEY belongs to. By default those
// records are deleted again in a cleanup phase at the end — pass
// --keep-created to leave them in place instead (their ids are printed so
// you can find/remove them later). Messages have no DELETE endpoint, so the
// one created message is never auto-deleted.
//
// SAFETY beyond the setup phase: only read-only calls are made against the
// rest of the API surface — every GET, plus the three "search via POST"
// endpoints (/listings, /buildings, /nlp) which are POST only because of
// body complexity, not because they mutate anything.
//   - PATCH and DELETE (other than our own cleanup) are always skipped —
//     modifying/deleting pre-existing real records just to document a
//     response shape isn't worth the risk; verify those manually.
//   - POST /agents/{agentId}/transfer (reassigns a client between two real
//     agents) is skipped unless --include-mutating is passed.
//
// GET /places is Canada-only, so if REPLIERS_API_KEY is scoped to a
// non-Canadian board, also set REPLIERS_PLACES_API_KEY to a Canada-scoped
// key — only that one call uses it, everything else uses REPLIERS_API_KEY.
//
// Usage:
//   REPLIERS_API_KEY=xxx node scripts/discover-response-schemas.mjs
//   REPLIERS_API_KEY=xxx REPLIERS_PLACES_API_KEY=yyy node scripts/discover-response-schemas.mjs
//   REPLIERS_API_KEY=xxx node scripts/discover-response-schemas.mjs --keep-created
//   REPLIERS_API_KEY=xxx REPLIERS_API_BASE_URL=https://dev.repliers.io node scripts/discover-response-schemas.mjs

import { readFileSync, readdirSync } from 'fs';
import { writeFile, mkdir, rm } from 'fs/promises';
import { dirname, join } from 'path';
import yaml from 'js-yaml';

const DOCS_DIR = join(dirname(new URL(import.meta.url).pathname), '..', 'docs');
const OUT_DIR = join(dirname(new URL(import.meta.url).pathname), '.output');
// Failed calls (non-2xx, or a thrown network error) land here with the full
// request + response — not just the truncated console line — so a bad
// request body can be iterated on without re-pasting terminal output.
const ERRORS_DIR = join(OUT_DIR, 'errors');
const BASE_URL = process.env.REPLIERS_API_BASE_URL || 'https://api.repliers.io';
const API_KEY = process.env.REPLIERS_API_KEY;
// GET /places is Canada-only; if your main key is scoped to a non-Canadian
// board (e.g. Houston), it won't have access. Set this to a Canada-scoped
// key to cover that one endpoint — falls back to REPLIERS_API_KEY if unset.
const PLACES_API_KEY = process.env.REPLIERS_PLACES_API_KEY || API_KEY;
const INCLUDE_MUTATING = process.argv.includes('--include-mutating');
const KEEP_CREATED = process.argv.includes('--keep-created');

if (!API_KEY) {
  console.error('Missing REPLIERS_API_KEY env var. Set it in .env and run via:');
  console.error('  npm run docs-discover-schemas');
  process.exit(1);
}

// Captures the exact console transcript (every console.log/process.stdout.write
// goes through here) so it can be written to summary.txt at the end — a full
// record of this run's outcome, not just the terminal scrollback, and
// overwritten fresh every run so it never conflicts with a previous run's
// results.
const SUMMARY_FILE = join(OUT_DIR, 'summary.txt');
let transcript = '';
const _origStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...args) => {
  transcript += chunk.toString();
  return _origStdoutWrite(chunk, ...args);
};

console.log(`This will create real test records (agent, client, message, webhook, search, estimate, favorite) against:`);
console.log(`  ${BASE_URL}`);
console.log(KEEP_CREATED ? 'They will be LEFT IN PLACE (--keep-created).' : 'They will be deleted again at the end (except the message — no delete endpoint exists for it).');
if (PLACES_API_KEY !== API_KEY) {
  console.log('GET /places will use REPLIERS_PLACES_API_KEY instead of REPLIERS_API_KEY.');
} else {
  console.log('GET /places is Canada-only — if REPLIERS_API_KEY isn\'t Canada-scoped, set REPLIERS_PLACES_API_KEY too.');
}
console.log('Ctrl-C now if that\'s not what you want.\n');

// ---- HTTP -------------------------------------------------

async function apiCall(method, path, { query = {}, body, apiKey = API_KEY } = {}) {
  const url = new URL(BASE_URL + path);
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    method,
    headers: {
      'REPLIERS-API-KEY': apiKey,
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, ok: res.ok, body: parsed };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function briefErrorBody(result) {
  const str = typeof result.body === 'string' ? result.body : JSON.stringify(result.body);
  if (!str) return '';
  return str.length > 300 ? str.slice(0, 300) + '…' : str;
}

// Persists the FULL request + response for a failed call (non-2xx, or a
// thrown network error) so a bad request body can be fixed by reading the
// file, not by re-pasting truncated terminal output.
async function writeErrorDraft({ method, path, slugPath, query, body, result, error }) {
  const draft = {
    endpoint: `${method.toUpperCase()} ${path}`,
    request: { method: method.toUpperCase(), path, query: query || {}, body: body ?? null },
    httpStatus: result ? result.status : null,
    responseBody: result ? result.body : null,
    thrownError: error ? error.message : null,
  };
  await mkdir(ERRORS_DIR, { recursive: true });
  // Named after the endpoint template (e.g. /searches/{searchId}), not the
  // literal called path (e.g. /searches/12345) — stable across runs even
  // though the actual id (recorded in request.path above) will vary.
  const file = join(ERRORS_DIR, `${slug({ method, path: slugPath || path })}.json`);
  await writeFile(file, JSON.stringify(draft, null, 2) + '\n', 'utf8');
}

// ---- fake-value generation (never write real API data to disk) -----------

function seedRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}
const rand = seedRandom(42);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const FIRST_NAMES = ['Jordan', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Avery', 'Sam', 'Jamie'];
const LAST_NAMES = ['Nguyen', 'Smith', 'Garcia', 'Chen', 'Patel', 'Brown', 'Kim', 'Rossi'];
const STREETS = ['Maple Ave', 'King St W', 'Queen St E', 'Bay St', 'Elm Grove', 'Yonge St'];
const CITIES = ['Houston', 'Austin', 'Dallas', 'San Antonio', 'Katy'];
const COMPANIES = ['Acme Realty', 'Northshore Brokerage', 'Summit Real Estate', 'Harbor Properties'];
const WORDS = ['available', 'sample', 'pending', 'reviewed', 'active', 'draft'];

function fakeStringFor(key, sample) {
  const k = key.toLowerCase();
  if (/email/.test(k)) return `${pick(FIRST_NAMES).toLowerCase()}.${pick(LAST_NAMES).toLowerCase()}@example.com`;
  if (/phone/.test(k)) return '555-0100';
  if (/^first ?name$|firstname|^fname$/.test(k)) return pick(FIRST_NAMES);
  if (/^last ?name$|lastname|^lname$/.test(k)) return pick(LAST_NAMES);
  if (/^name$|fullname/.test(k)) return `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
  if (/street|address1|addressline/.test(k)) return `${100 + Math.floor(rand() * 900)} ${pick(STREETS)}`;
  if (/city/.test(k)) return pick(CITIES);
  if (/state|province/.test(k)) return 'TX';
  if (/country/.test(k)) return 'United States';
  if (/zip|postal/.test(k)) return '77002';
  if (/company|brokerage|office/.test(k)) return pick(COMPANIES);
  if (/url|link|href/.test(k)) return 'https://example.com/resource/123';
  if (/(^|_)id$|key$/.test(k)) return `sample-${key}-id`;
  if (/date|time|createdon|updatedon|created_at|updated_at/.test(k)) return new Date('2024-06-15T12:00:00Z').toISOString();
  if (/status/.test(k)) return pick(['active', 'inactive', 'pending']);
  if (/tag/.test(k)) return pick(['buyer', 'seller', 'hot-lead']);
  if (/mlsnumber/.test(k)) return 'C1234567';
  // Below: fields whose real values are numeric-shaped even though the API
  // types them as strings (common in public-record/parcel-style data) — a
  // generic word like "reviewed" as an example bathroom count reads as
  // broken, so give these a plausible-looking numeric string instead.
  if (/year/.test(k)) return String(1970 + Math.floor(rand() * 55));
  if (/acres/.test(k)) return (Math.round(rand() * 500) / 100).toFixed(2);
  if (/sqft|squarefeet/.test(k)) return String(500 + Math.floor(rand() * 4500));
  if (/percent/.test(k)) return String(Math.floor(rand() * 100));
  if (/^number(of)?[a-z]*|count$/.test(k)) return String(1 + Math.floor(rand() * 5));
  if (/value|price|amount/.test(k)) return String(50000 + Math.floor(rand() * 950000));
  if (typeof sample === 'string' && /^https?:\/\//.test(sample)) return 'https://example.com/resource/123';
  return pick(WORDS);
}

function scrubValue(key, value) {
  if (value === null) return null;
  if (Array.isArray(value)) return value.length ? [scrubValue(key, value[0])] : [];
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubValue(k, v);
    return out;
  }
  if (typeof value === 'string') return fakeStringFor(key, value);
  if (typeof value === 'number') return Number.isInteger(value) ? 42 : 42.5;
  if (typeof value === 'boolean') return true;
  return value;
}

// ---- schema inference from a live response -------------------------------

function inferSchema(value) {
  if (value === null) return { type: 'string', nullable: true };
  if (Array.isArray(value)) return { type: 'array', items: value.length ? inferSchema(value[0]) : {} };
  if (typeof value === 'object') {
    const properties = {};
    for (const [k, v] of Object.entries(value)) properties[k] = inferSchema(v);
    return { type: 'object', properties };
  }
  if (typeof value === 'string') return { type: 'string' };
  if (typeof value === 'number') return { type: Number.isInteger(value) ? 'integer' : 'number' };
  if (typeof value === 'boolean') return { type: 'boolean' };
  return {};
}

function attachExamples(schema, example) {
  if (schema.type === 'object' && example && typeof example === 'object') {
    for (const k of Object.keys(schema.properties || {})) attachExamples(schema.properties[k], example[k]);
  } else if (schema.type === 'array') {
    if (Array.isArray(example) && example.length) attachExamples(schema.items, example[0]);
  } else if (example !== undefined) {
    schema.example = example;
  }
  return schema;
}

function flattenSchemaPaths(schema, out, prefix = '', seen = new Set()) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.$ref) return; // already resolved before calling this on real (non-YAML-doc) inferred schemas
  if (schema.allOf) { for (const s of schema.allOf) flattenSchemaPaths(s, out, prefix, seen); return; }
  if (schema.oneOf || schema.anyOf) { for (const s of schema.oneOf || schema.anyOf) flattenSchemaPaths(s, out, prefix, seen); return; }
  if (schema.properties) {
    for (const [k, v] of Object.entries(schema.properties)) {
      const path = prefix ? `${prefix}.${k}` : k;
      out.add(path);
      if (!seen.has(path)) { seen.add(path); flattenSchemaPaths(v, out, path, seen); }
    }
  } else if (schema.type === 'array' && schema.items) {
    flattenSchemaPaths(schema.items, out, prefix ? `${prefix}[]` : '[]', seen);
  }
}

// ---- resolving refs across the hand-authored YAML docs -------------------

const fileCache = new Map();
function loadYaml(file) {
  if (!fileCache.has(file)) {
    fileCache.set(file, yaml.load(readFileSync(join(DOCS_DIR, file), 'utf8')));
  }
  return fileCache.get(file);
}

function resolvePointer(doc, pointer) {
  const parts = pointer.replace(/^#\//, '').split('/').filter(Boolean)
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let node = doc;
  for (const part of parts) node = node?.[part];
  return node;
}

function resolveRef(ref, currentFile) {
  const [filePart, pointerPart] = ref.split('#');
  const file = filePart || currentFile;
  return resolvePointer(loadYaml(file), '#' + (pointerPart || ''));
}

function resolveSchemaDeep(schema, currentFile, depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 15) return schema;
  if (schema.$ref) {
    const file = schema.$ref.includes('#') && schema.$ref.split('#')[0] ? schema.$ref.split('#')[0] : currentFile;
    return resolveSchemaDeep(resolveRef(schema.$ref, currentFile), file, depth + 1);
  }
  const out = { ...schema };
  if (schema.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(schema.properties)) out.properties[k] = resolveSchemaDeep(v, currentFile, depth + 1);
  }
  if (schema.items) out.items = resolveSchemaDeep(schema.items, currentFile, depth + 1);
  if (schema.allOf) out.allOf = schema.allOf.map((s) => resolveSchemaDeep(s, currentFile, depth + 1));
  if (schema.oneOf) out.oneOf = schema.oneOf.map((s) => resolveSchemaDeep(s, currentFile, depth + 1));
  if (schema.anyOf) out.anyOf = schema.anyOf.map((s) => resolveSchemaDeep(s, currentFile, depth + 1));
  return out;
}

function getExisting2xxSchema(op, currentFile) {
  const responses = op.responses || {};
  for (const [status, resp] of Object.entries(responses)) {
    if (!status.startsWith('2')) continue;
    let r = resp;
    let file = currentFile;
    if (r && r.$ref) {
      file = r.$ref.includes('#') && r.$ref.split('#')[0] ? r.$ref.split('#')[0] : currentFile;
      r = resolveRef(r.$ref, currentFile);
    }
    if (!r || !r.content) continue;
    for (const body of Object.values(r.content)) {
      if (body.schema) return resolveSchemaDeep(body.schema, file);
    }
  }
  return null;
}

// ---- enumerate every endpoint across docs/*.yml ---------------------------

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const SAFE_SEARCH_POST_BODIES = {
  '/listings': { resultsPerPage: 1 },
  // An empty body returned 0 buildings for this board across multiple runs.
  // buildings.yml documents `map` as a full GeoJSON object ({type,
  // coordinates}), but sending that got "invalid geojson polygon" back —
  // meanwhile listings.yml's OWN documented `map` param example (a working,
  // presumably-verified one) is just the bare coordinate ring array with no
  // {type,coordinates} envelope. Trying that shape here instead.
  '/buildings': {
    map: [[
      [-95.45, 29.70],
      [-95.30, 29.70],
      [-95.30, 29.82],
      [-95.45, 29.82],
      [-95.45, 29.70],
    ]],
  },
  '/nlp': { prompt: 'Find me a condo in Houston with at least 1 bedroom' },
};

// Some endpoints return meaningfully different shapes depending on query
// params (not just a filtered subset of the same shape) — e.g. GET
// /locations returns demographic data for type=neighborhood+source=LiveBy,
// parcel/public-record data for type=property+source=PublicRecord, school
// data for type=school+source=LiveBy, etc. A single default-params call
// can't see any of that. For paths listed here, the walk makes one extra
// call per variant (on top of the normal unfiltered call) and merges every
// response body together (deep union of keys/array-item-shapes) before
// inferring a schema — so the resulting draft covers the union of shapes
// actually observed, not just whatever the default call happened to return.
// Each variant is a query-param object merged into the normal query.
const PARAM_VARIANTS = {
  '/locations': [
    { source: 'MLS' }, // confirmed valid; docs used to say "MSL" (a typo), now fixed
    { source: 'LiveBy' },
    { source: 'PublicRecord' },
    { type: 'neighborhood', source: 'LiveBy' }, // exposes demographic data
    { type: 'property', source: 'PublicRecord' }, // exposes parcel/public-record data
    { type: 'school', source: 'LiveBy' }, // exposes school data
  ],
};

// Deep-merges two JSON-shaped values into one that has every key/shape seen
// in either — used to combine multiple param-variant responses into a
// single sample before schema inference, so the union of fields is visible.
function mergeSamples(a, b) {
  if (a === undefined) return b;
  if (b === undefined) return a;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length === 0) return b;
    if (b.length === 0) return a;
    return [mergeSamples(a[0], b[0])];
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = k in out ? mergeSamples(out[k], v) : v;
    return out;
  }
  // Scalar/type mismatch (e.g. null vs a real value) — prefer whichever is non-null.
  return a === null ? b : a;
}

// Deprecated endpoints that have been removed from docs/*.yml entirely (not
// just marked deprecated) — never probe these, regardless of method, even
// if a path with this name reappears (e.g. a future extract-endpoints.mjs
// rerun accidentally reintroduces one).
const EXCLUDED_PATHS = new Set([
  '/listings/buildings',
  '/listings/property-types',
  '/listings/locations',
]);

function loadAllEndpoints() {
  const files = readdirSync(DOCS_DIR).filter((f) => f.endsWith('.yml') && f !== 'components.yml');
  const endpoints = [];
  for (const file of files) {
    const doc = loadYaml(file);
    if (!doc.paths) continue;
    for (const [p, rawItem] of Object.entries(doc.paths)) {
      if (EXCLUDED_PATHS.has(p)) continue;
      let item = rawItem;
      let methods = item ? Object.keys(item).filter((k) => HTTP_METHODS.includes(k)) : [];
      let undocumentedStub = false;
      if (methods.length === 0) {
        // e.g. /listings/property-types: {} — wired into the main spec but
        // has no operation defined at all. Probe it as a GET anyway.
        methods = ['get'];
        item = { get: { summary: '(undocumented — no operation defined in spec)', parameters: [], responses: {} } };
        undocumentedStub = true;
      }
      for (const method of methods) {
        endpoints.push({ file, path: p, method, op: item[method], undocumentedStub });
      }
    }
  }
  // List-ish endpoints (fewer path params) before detail endpoints, so ids
  // harvested from a list response are available for its detail/child routes.
  endpoints.sort((a, b) => {
    const pa = (a.path.match(/{/g) || []).length;
    const pb = (b.path.match(/{/g) || []).length;
    if (pa !== pb) return pa - pb;
    return a.path.length - b.path.length;
  });
  return endpoints;
}

function classify(ep) {
  if (ep.method === 'get') return 'safe';
  if (ep.method === 'post' && ep.path in SAFE_SEARCH_POST_BODIES) return 'safe';
  if (ep.method === 'post') return 'mutating-create';
  return 'mutating-destructive'; // patch, delete, put
}

// ---- resolving required params from context / harvested ids --------------

const ID_ALIASES = {
  agentId: ['agentId', 'id'],
  clientId: ['clientId', 'id'],
  messageId: ['messageId', 'id'],
  webhookId: ['webhookId', 'id'],
  searchId: ['searchId', 'id'],
  matchId: ['matchId', 'id'],
  estimateId: ['estimateId', 'id'],
  favoriteId: ['favoriteId', 'id'],
  mlsNumber: ['mlsNumber'],
  addressKey: ['addressKey'],
  tag: ['tag'],
};

// Which endpoints are allowed to harvest which id — closes off the generic
// 'id' fallback from matching an unrelated resource. Proven necessary: a
// bare `id` field buried in e.g. GET /webhooks/events' sample event payload
// got mistaken for a real searchId/webhookId before those resources were
// ever actually fetched, because the old unscoped sweep checked EVERY
// response against EVERY alias. Scoping to only the endpoints that are
// actually about that resource makes the 'id' fallback safe to keep (it's
// still useful — e.g. GET /webhooks items may use a bare `id`, not
// `webhookId`), without the cross-resource collision risk.
const ID_SOURCE_PATHS = {
  agentId: ['/agents', '/agents/{agentId}'],
  clientId: ['/clients', '/clients/{clientId}'],
  messageId: ['/messages', '/messages/{messageId}'],
  webhookId: ['/webhooks', '/webhooks/{webhookId}'],
  searchId: ['/searches', '/searches/{searchId}'],
  matchId: ['/searches/{searchId}/matches', '/searches/{searchId}/matches/{matchId}'],
  estimateId: ['/estimates'],
  favoriteId: ['/favorites', '/favorites/{favoriteId}'],
  mlsNumber: ['/listings', '/listings/{mlsNumber}', '/listings/{mlsNumber}/similar', '/listings/history'],
  addressKey: ['/buildings', '/buildings/{addressKey}'],
  tag: ['/clients/tags', '/clients/tags/{tag}'],
};
// Downtown Toronto — GET /places is Canada-only, so this needs to stay
// Toronto-ish regardless of what board the main REPLIERS_API_KEY covers (see
// REPLIERS_PLACES_API_KEY below, since /places may need its own key).
const KNOWN_PARAM_VALUES = { lat: '43.6532', long: '-79.3832' };

const ctx = {}; // paramName -> harvested value, filled in as we go

function bfsFindFirst(root, aliasNames) {
  const keys = new Set(aliasNames.map((k) => k.toLowerCase()));
  const queue = [root];
  let guard = 0;
  while (queue.length && guard++ < 5000) {
    const node = queue.shift();
    if (!node || typeof node !== 'object') continue;
    if (!Array.isArray(node)) {
      for (const [k, v] of Object.entries(node)) {
        if (keys.has(k.toLowerCase()) && (typeof v === 'string' || typeof v === 'number')) return v;
      }
    }
    const children = Array.isArray(node) ? node : Object.values(node);
    for (const c of children) if (c && typeof c === 'object') queue.push(c);
  }
  return undefined;
}

function harvestIds(body, sourcePath) {
  for (const [param, aliases] of Object.entries(ID_ALIASES)) {
    if (ctx[param] !== undefined) continue;
    if (!ID_SOURCE_PATHS[param]?.includes(sourcePath)) continue;
    const found = bfsFindFirst(body, aliases);
    if (found !== undefined) ctx[param] = found;
  }
}

// Returns { query, pathParams } or { unresolved: [names] } if a required
// param has no known/harvested/type-fallback value.
function resolveParams(op) {
  const params = op.parameters || [];
  const query = {};
  const pathParams = {};
  const unresolved = [];
  for (const param of params) {
    if (param.required) {
      let value;
      const isIdParam = param.name in ID_ALIASES;
      if (ctx[param.name] !== undefined) value = ctx[param.name];
      else if (KNOWN_PARAM_VALUES[param.name] !== undefined) value = KNOWN_PARAM_VALUES[param.name];
      else if (isIdParam) {
        // Don't guess at a made-up id/key (webhookId=1, addressKey='test', …)
        // — it's essentially never real and just wastes a call producing a
        // meaningless 400/404. If we don't have a real one, skip cleanly.
      } else if (param.schema?.enum?.length) value = param.schema.enum[0];
      else if (param.schema?.type === 'integer' || param.schema?.type === 'number') value = 1;
      else if (param.schema?.type === 'boolean') value = true;
      else if (param.schema?.type === 'string') value = 'test';
      if (value === undefined) { unresolved.push(param.name); continue; }
      if (param.in === 'path') pathParams[param.name] = value;
      else if (param.in === 'query') query[param.name] = value;
    }
    // Deliberately NOT auto-filling most optional query params that merely
    // share a name with a tracked ctx id (e.g. "agentId") — proved unsafe:
    // GET /members has its own "agentId" query param, but it's an MLS board
    // identifier, not the Repliers-internal CRM agent id /agents uses. Same
    // param name, different id namespace — filtering by it silently zeroed
    // out real data.
    //
    // mlsNumber/addressKey are the exception: unlike agentId/clientId, they
    // refer to the same concept everywhere in this API, and GET
    // /listings/history proves it's actually necessary — it 400s without
    // one of mlsNumber/addressKey/streetName despite having zero documented
    // required params.
    else if (param.in === 'query' && ['mlsNumber', 'addressKey'].includes(param.name) && ctx[param.name] !== undefined) {
      query[param.name] = ctx[param.name];
    }
  }
  return { query, pathParams, unresolved };
}

function fillPath(pathTemplate, pathParams) {
  return pathTemplate.replace(/{([^}]+)}/g, (_, name) => encodeURIComponent(pathParams[name]));
}

// ---- setup phase: create one of each entity so GET-by-id has real data ---

const RUN_TAG = Date.now();
// Phone numbers must match ^1[0-9]{10}$ and are apparently unique per agent/
// client account-wide — a hardcoded phone caused a real 409 ("already in use
// by another agent") on a rerun, which cascaded into a pile of downstream
// failures. Derive a fresh one from RUN_TAG each run instead.
function phoneFor(offset) {
  return '1' + String((RUN_TAG + offset) % 10000000000).padStart(10, '0');
}

// Order matters: each step's prereqs must be ctx keys set by an earlier step.
const CREATE_STEPS = [
  {
    path: '/listings',
    kind: 'discover', // already documented — only run to harvest a real mlsNumber
    prereqs: [],
    body: () => ({ resultsPerPage: 1 }),
  },
  {
    path: '/agents',
    kind: 'create',
    prereqs: [],
    ctxKey: 'agentId',
    body: () => ({
      fname: 'Schema',
      lname: 'Discovery',
      phone: phoneFor(0),
      email: `schema.discovery.agent.${RUN_TAG}@example.com`,
      brokerage: 'Schema Discovery Test Brokerage',
      designation: 'Sales Representative',
    }),
  },
  {
    path: '/clients',
    kind: 'create',
    prereqs: ['agentId'],
    ctxKey: 'clientId',
    body: () => ({
      agentId: ctx.agentId,
      fname: 'Schema',
      lname: 'DiscoveryClient',
      phone: phoneFor(1),
      email: `schema.discovery.client.${RUN_TAG}@example.com`,
    }),
  },
  {
    path: '/messages',
    kind: 'create',
    prereqs: ['agentId', 'clientId'],
    ctxKey: 'messageId',
    body: () => ({
      sender: 'agent',
      agentId: ctx.agentId,
      clientId: ctx.clientId,
      content: { message: '[schema-discovery] test message — safe to ignore' },
    }),
  },
  {
    path: '/webhooks',
    kind: 'create',
    prereqs: [],
    ctxKey: 'webhookId',
    body: () => ({
      // Repliers verifies target_url is actually reachable before accepting
      // the subscription (confirmed via the real 400: "the provided
      // destination is invalid or unreachable") — example.com doesn't
      // satisfy that. httpbin.org/post is a standard public echo endpoint
      // built exactly for this kind of webhook testing.
      target_url: 'https://httpbin.org/post',
      event: 'agent.created',
    }),
  },
  {
    path: '/searches',
    kind: 'create',
    prereqs: ['clientId'],
    ctxKey: 'searchId',
    body: () => ({
      clientId: ctx.clientId,
      name: `[schema-discovery] test search ${RUN_TAG}`,
      class: ['residential'],
      type: 'sale',
      // Confirmed via a real 406: a broad $100k-$2M Houston-wide band
      // produced over 100 initial matches, which the API refuses to save
      // ("A search may produce a maximum of 100 initial results"). Narrowed
      // to a tight band around the real test listing's own $480k price.
      minPrice: 470000,
      maxPrice: 490000,
      minBeds: 4,
      maxBeds: 4,
      // Confirmed via two real 400s: `cities` alone wasn't enough — the API
      // still demanded `areas` specifically unless `map` is given, even
      // though its own error message for `map` claims areas/cities/
      // neighborhoods are interchangeable alternatives. None of this is in
      // the documented `required` list (class/clientId/maxPrice/minPrice/
      // type only). "Harris" matches the real listing's own `address.area`.
      cities: ['Houston'],
      areas: ['Harris'],
    }),
  },
  {
    path: '/estimates',
    kind: 'create',
    prereqs: ['clientId'],
    ctxKey: 'estimateId',
    body: () => ({
      clientId: ctx.clientId,
      // A real Houston listing (mlsNumber 11880858), not a fabricated
      // address — estimates are computed against real coverage data, so a
      // made-up address is much less likely to match than a real one.
      address: { area: 'Harris', state: 'TX', streetNumber: '12103', streetName: 'Cypresswood', streetSuffix: 'Drive', city: 'Houston', zip: '77070' },
      // The real listing's own lat/long — the 403 ("falls outside the
      // geographic boundaries authorized for your account") named `map` as
      // the offending param, suggesting the boundary check keys off this
      // rather than (or in addition to) the address.
      map: { latitude: 29.98234, longitude: -95.603577, point: 'POINT (-95.603577 29.98234)' },
      // Confirmed via the real 400 ("details is required"): required in
      // practice despite not being in the documented `required` list.
      // Values below match that same real listing's actual details.
      details: {
        propertyType: 'Residential',
        style: 'Single Family Residence',
        numBedrooms: 4,
        numBathrooms: 4,
        numGarageSpaces: 2,
        numParkingSpaces: 2,
        sqft: '3562',
        yearBuilt: '1983',
      },
      lot: {
        legalDescription: 'LT 9 & E 1 FT OF LT 8 BLK 16 LAKEWOOD FOREST SEC 11',
        squareFeet: 9400.248,
        features: 'Subdivided',
      },
      taxes: { annualAmount: 9722, assessmentYear: '2026' },
      sendEmailNow: false,
      sendEmailMonthly: false,
    }),
  },
  {
    path: '/favorites',
    kind: 'create',
    prereqs: ['clientId', 'mlsNumber'],
    ctxKey: 'favoriteId',
    body: () => ({ clientId: ctx.clientId, mlsNumber: ctx.mlsNumber }),
  },
];
const CREATED_PATHS = new Set(CREATE_STEPS.filter((s) => s.kind === 'create').map((s) => s.path));

async function createPhase() {
  console.log('--- Setup: creating test records so GET-by-id endpoints have real data ---');
  const created = [];
  for (const step of CREATE_STEPS) {
    const label = `POST ${step.path}`;
    const missing = (step.prereqs || []).filter((p) => ctx[p] === undefined);
    if (missing.length) {
      console.log(`${label} ... SKIPPED (missing prerequisite: ${missing.join(', ')})`);
      continue;
    }
    process.stdout.write(`${label} ... `);
    const requestBody = step.body();
    let result;
    try {
      result = await apiCall('post', step.path, { body: requestBody });
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
      await writeErrorDraft({ method: 'post', path: step.path, body: requestBody, error: err });
      continue;
    }
    if (!result.ok) {
      console.log(`HTTP ${result.status} — ${briefErrorBody(result)}`);
      await writeErrorDraft({ method: 'post', path: step.path, body: requestBody, result });
      continue;
    }
    if (step.kind === 'discover') {
      // Scoped to this one field only — safe to use the generic alias scan.
      ctx.mlsNumber = bfsFindFirst(result.body, ID_ALIASES.mlsNumber);
      console.log(ctx.mlsNumber ? `OK (mlsNumber=${ctx.mlsNumber})` : 'OK (no mlsNumber found in response)');
    } else {
      // Extract ONLY this step's own field from ITS OWN response — never
      // sweep the full ID_ALIASES map here. That sweep is fine once ids are
      // already anchored (later, during the GET walk), but during creation
      // every ctx[...] is still empty, so a generic `id` field on e.g. the
      // webhook response would otherwise get mistaken for searchId,
      // estimateId, etc. (each of which also falls back to a plain `id`).
      const value = result.body?.[step.ctxKey] ?? result.body?.id;
      if (value !== undefined) {
        ctx[step.ctxKey] = value;
        created.push({ path: step.path, ctxKey: step.ctxKey, id: value });
        console.log(`OK (${step.ctxKey}=${value})`);
      } else {
        console.log('OK (but could not find its id in the response — dependents may be skipped)');
      }
    }
    await sleep(150);
  }
  console.log('');
  return created;
}

const DELETE_PATH_BY_CTX_KEY = {
  favoriteId: '/favorites/{favoriteId}',
  estimateId: '/estimates/{estimateId}',
  searchId: '/searches/{searchId}',
  webhookId: '/webhooks/{webhookId}',
  clientId: '/clients/{clientId}',
  agentId: '/agents/{agentId}',
  // messageId intentionally omitted — no DELETE /messages/{messageId} endpoint exists
};
const CLEANUP_ORDER = ['favoriteId', 'estimateId', 'searchId', 'webhookId', 'clientId', 'agentId'];

async function cleanupPhase(created) {
  console.log('--- Cleanup: deleting the test records created above ---');
  const byKey = new Map(created.map((c) => [c.ctxKey, c]));
  for (const key of CLEANUP_ORDER) {
    const rec = byKey.get(key);
    if (!rec) continue;
    const filled = DELETE_PATH_BY_CTX_KEY[key].replace(/{[^}]+}/, encodeURIComponent(rec.id));
    process.stdout.write(`DELETE ${filled} ... `);
    try {
      const result = await apiCall('delete', filled);
      console.log(result.ok ? 'OK' : `HTTP ${result.status}`);
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
    }
    await sleep(150);
  }
  const msg = byKey.get('messageId');
  if (msg) console.log(`Note: created message ${msg.id} was NOT deleted — no DELETE /messages/{messageId} endpoint exists.`);
  console.log('');
}

// ---- main -------------------------------------------------

function slug(ep) {
  return `${ep.method}_${ep.path}`.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

async function main() {
  // Flush the whole output dir (drafts + errors) before this run starts.
  // Without this, an endpoint that succeeded last run but fails this run
  // (or vice versa) leaves a stale file from the other outcome sitting
  // alongside the current one — exactly the kind of conflicting-results
  // problem this is meant to avoid.
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });
  const created = await createPhase();
  const endpoints = loadAllEndpoints();
  const summary = [];

  for (const ep of endpoints) {
    const label = `${ep.method.toUpperCase()} ${ep.path}`;
    const category = classify(ep);

    if (ep.method === 'post' && CREATED_PATHS.has(ep.path)) {
      summary.push({ label, outcome: 'created_in_setup', detail: 'called during setup phase above' });
      continue;
    }
    if (category === 'mutating-destructive') {
      summary.push({ label, outcome: 'not_called', detail: 'PATCH/DELETE — always skipped, verify manually' });
      continue;
    }
    if (category === 'mutating-create' && !INCLUDE_MUTATING) {
      summary.push({ label, outcome: 'not_called', detail: 'reassigns real data — pass --include-mutating to call it' });
      continue;
    }

    process.stdout.write(`${label} ... `);
    const { query, pathParams, unresolved } = resolveParams(ep.op);
    if (unresolved.length) {
      console.log(`SKIPPED (couldn't resolve required param(s): ${unresolved.join(', ')})`);
      summary.push({ label, outcome: 'skipped', detail: `unresolved params: ${unresolved.join(', ')}` });
      continue;
    }

    const filledPath = fillPath(ep.path, pathParams);
    const isSearchPost = ep.path in SAFE_SEARCH_POST_BODIES;
    const callMethod = isSearchPost ? 'post' : 'get';
    const callBody = isSearchPost ? SAFE_SEARCH_POST_BODIES[ep.path] : undefined;
    let result;
    try {
      if (isSearchPost) {
        result = await apiCall('post', filledPath, { query, body: callBody });
      } else {
        const apiKey = ep.path === '/places' ? PLACES_API_KEY : API_KEY;
        result = await apiCall('get', filledPath, { query, apiKey });
      }
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
      summary.push({ label, outcome: 'error', detail: err.message });
      await writeErrorDraft({ method: callMethod, path: filledPath, slugPath: ep.path, query, body: callBody, error: err });
      continue;
    }

    if (!result.ok) {
      console.log(`HTTP ${result.status} — ${briefErrorBody(result)}`);
      summary.push({ label, outcome: 'http_error', detail: `HTTP ${result.status}` });
      await writeErrorDraft({ method: callMethod, path: filledPath, slugPath: ep.path, query, body: callBody, result });
      await sleep(150);
      continue;
    }

    harvestIds(result.body, ep.path);

    // If this endpoint's response shape varies by query param (see
    // PARAM_VARIANTS), make one extra call per variant and merge every
    // response body together so the schema we infer covers the union of
    // shapes actually observed, not just the default/unfiltered call.
    let mergedBody = result.body;
    const variants = !isSearchPost ? PARAM_VARIANTS[ep.path] : undefined;
    if (variants) {
      for (const variant of variants) {
        const variantLabel = Object.entries(variant).map(([k, v]) => `${k}=${v}`).join('&');
        process.stdout.write(`  variant ${label} (${variantLabel}) ... `);
        let variantResult;
        try {
          const apiKey = ep.path === '/places' ? PLACES_API_KEY : API_KEY;
          variantResult = await apiCall('get', filledPath, { query: { ...query, ...variant }, apiKey });
        } catch (err) {
          console.log(`ERROR: ${err.message}`);
          await sleep(150);
          continue;
        }
        if (!variantResult.ok) {
          console.log(`HTTP ${variantResult.status} — ${briefErrorBody(variantResult)}`);
          await writeErrorDraft({ method: 'get', path: filledPath, slugPath: `${ep.path} (${variantLabel})`, query: { ...query, ...variant }, result: variantResult });
        } else {
          console.log('OK');
          mergedBody = mergeSamples(mergedBody, variantResult.body);
        }
        await sleep(150);
      }
    }

    const inferredSchema = inferSchema(mergedBody);
    const scrubbedExample = scrubValue('root', mergedBody);
    attachExamples(inferredSchema, scrubbedExample);

    const existingSchema = getExisting2xxSchema(ep.op, ep.file);
    const existingPaths = new Set();
    const inferredPaths = new Set();
    if (existingSchema) flattenSchemaPaths(existingSchema, existingPaths);
    flattenSchemaPaths(inferredSchema, inferredPaths);

    const newFields = [...inferredPaths].filter((p) => !existingPaths.has(p));
    const notObserved = existingSchema ? [...existingPaths].filter((p) => !inferredPaths.has(p)) : [];

    const draft = {
      endpoint: label,
      sourceFile: ep.file,
      httpStatus: result.status,
      hadExistingDocumentedSchema: !!existingSchema,
      undocumentedStub: !!ep.undocumentedStub,
      paramVariantsMerged: variants ? variants.map((v) => Object.entries(v).map(([k, val]) => `${k}=${val}`).join('&')) : undefined,
      diff: {
        fieldsInLiveResponseNotInDocs: newFields,
        documentedFieldsNotObservedInThisSample: notObserved,
      },
      inferredSchema,
      scrubbedExampleResponse: scrubbedExample,
    };

    const file = join(OUT_DIR, `${slug(ep)}.json`);
    await writeFile(file, JSON.stringify(draft, null, 2) + '\n', 'utf8');

    const flag = !existingSchema ? 'UNDOCUMENTED' : newFields.length ? `DRIFT (+${newFields.length} field(s))` : 'matches docs';
    console.log(`OK [${flag}]`);
    summary.push({ label, outcome: 'ok', detail: flag, newFields, hadExistingDocumentedSchema: !!existingSchema });

    await sleep(150); // be polite to the live API
  }

  console.log('\n--- Summary ---');
  for (const s of summary) console.log(`${s.outcome.padEnd(10)} ${s.label}${s.detail ? '  — ' + s.detail : ''}`);

  const drift = summary.filter((s) => s.outcome === 'ok' && s.hadExistingDocumentedSchema && s.newFields?.length);
  const stillUndocumented = summary.filter((s) => s.outcome === 'ok' && !s.hadExistingDocumentedSchema);
  const notCalled = summary.filter((s) => s.outcome === 'not_called');

  if (drift.length) {
    console.log('\n*** SCHEMA DRIFT — live response has fields the docs don\'t mention ***');
    for (const d of drift) console.log(`  ${d.label}: ${d.newFields.slice(0, 10).join(', ')}${d.newFields.length > 10 ? ', …' : ''}`);
  }
  if (stillUndocumented.length) {
    console.log('\n*** STILL UNDOCUMENTED ***');
    for (const d of stillUndocumented) console.log(`  ${d.label}`);
  }
  if (notCalled.length) {
    console.log(`\n${notCalled.length} endpoint(s) not called automatically (mutating) — see "not_called" rows above.`);
  }

  console.log(`\nDrafts written to ${OUT_DIR} — nothing in docs/*.yml was modified.`);
  console.log(`Failed calls (full request + response) written to ${ERRORS_DIR}.`);

  if (KEEP_CREATED) {
    console.log('\n--keep-created: leaving test records in place. Created ids:');
    for (const c of created) console.log(`  ${c.path} -> ${c.ctxKey}=${c.id}`);
  } else {
    console.log('');
    await cleanupPhase(created);
  }

  // Written last so it captures everything above, including cleanup —
  // overwrites any summary.txt from a previous run.
  await writeFile(SUMMARY_FILE, transcript, 'utf8');
  console.log(`\nFull run summary written to ${SUMMARY_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
