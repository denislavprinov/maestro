// test/ui-validate-field.test.mjs — string assertions (mirrors
// ui-composer-legend.test.mjs) that the new-run form exposes a
// #validateCommands textarea, wired into the /api/run POST body and prefilled
// via GET /api/validate-detect on project selection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '../ui/public/index.html'), 'utf8');
const appJs = readFileSync(join(here, '../ui/public/app.js'), 'utf8');

test('index.html has a #validateCommands textarea in the new-run form', () => {
  assert.match(html, /id="validateCommands"/);
  assert.match(html, /<textarea[^>]*id="validateCommands"/);
});

test('app.js references validateCommands in the /api/run POST body', () => {
  assert.match(appJs, /validateCommands\s*:/);
});

test('app.js calls GET /api/validate-detect to prefill the field', () => {
  assert.match(appJs, /\/api\/validate-detect/);
});
