// The API reference is generated from the route table; fail if it is stale.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderApiDocs } from '../../scripts/gen-api-docs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
test('docs/api.md matches the route table (run npm run docs:api)', () => {
  assert.equal(readFileSync(path.join(ROOT, 'docs/api.md'), 'utf8'), renderApiDocs());
});
