import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { useTempHome } from './helpers/temp-home.mjs';

useTempHome(after);

// PROJECTS_ROOT is read at module load, so the temp root must be set before the
// server is imported in before().
const ROOT = mkdtempSync(join(tmpdir(), 'enable-graph-root-'));
process.env.MAESTRO_ENABLE_PROJECTS_ROOT = ROOT;

const CDN = 'https://unpkg.com/vis-network@9.1.6/standalone/umd/vis-network.min.js';

function mkProject(name, { json, html, report } = {}) {
  const dir = join(ROOT, name);
  mkdirSync(dir, { recursive: true });
  execSync('git init -q', { cwd: dir });
  if (json || html || report) mkdirSync(join(dir, 'graphify-out'), { recursive: true });
  if (json) writeFileSync(join(dir, 'graphify-out', 'graph.json'), JSON.stringify(json));
  if (html) writeFileSync(join(dir, 'graphify-out', 'graph.html'), html);
  if (report) writeFileSync(join(dir, 'graphify-out', 'GRAPH_REPORT.md'), report);
  return dir;
}

mkProject('full', {
  json: { nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], edges: [] },
  html: `<html><head><script src="${CDN}"></script></head><body>graph</body></html>`,
  report: '# Graph Report\n\n## God Nodes\n\n- alpha\n',
});
mkProject('jsononly', { json: { nodes: [{ id: 'a' }], edges: [] } });
mkProject('bare', {}); // git repo, no graphify-out at all

let server, base, cookie;
before(async () => {
  ({ server } = await import('../apps/enable/server.mjs'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `127.0.0.1:${server.address().port}`;
  const res = await fetch(`http://${base}/`);
  cookie = (res.headers.get('set-cookie') || '').split(';')[0];
});
after(async () => { if (server) await new Promise((r) => server.close(r)); });

const get = (p) => fetch(`http://${base}${p}`, { headers: { cookie } });

test('graph/exists reports every artifact for a fully graphified project', async () => {
  const res = await get('/api/enable/graph/exists?project=full');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { exists: true, nodes: 3, hasHtml: true, hasReport: true });
});

test('graph/exists: graph.json present but no html/report', async () => {
  const res = await get('/api/enable/graph/exists?project=jsononly');
  assert.deepEqual(await res.json(), { exists: true, nodes: 1, hasHtml: false, hasReport: false });
});

test('graph/exists: no graphify-out at all', async () => {
  const res = await get('/api/enable/graph/exists?project=bare');
  assert.deepEqual(await res.json(), { exists: false, nodes: 0, hasHtml: false, hasReport: false });
});

test('graph/exists: unknown project name is not-exists (never 500)', async () => {
  const res = await get('/api/enable/graph/exists?project=nope');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).exists, false);
});

test('graph/exists: path traversal is rejected as not-exists', async () => {
  const res = await get('/api/enable/graph/exists?project=' + encodeURIComponent('../../etc'));
  assert.equal((await res.json()).exists, false);
});

test('graph/view serves graph.html with the vis-network CDN rewritten to the local vendor path', async () => {
  const res = await get('/api/enable/graph/view?project=full');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/html/);
  const body = await res.text();
  assert.ok(!body.includes('unpkg.com'), 'CDN url should be gone');
  assert.ok(body.includes('/vendor/vis-network.min.js'), 'local vendor path present');
});

test('graph/view is 404 when graph.html is missing', async () => {
  const res = await get('/api/enable/graph/view?project=jsononly');
  assert.equal(res.status, 404);
});

test('graph/view rejects path traversal with 404', async () => {
  const res = await get('/api/enable/graph/view?project=' + encodeURIComponent('../full'));
  assert.equal(res.status, 404);
});

test('graph/report serves the raw GRAPH_REPORT.md', async () => {
  const res = await get('/api/enable/graph/report?project=full');
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(body.includes('## God Nodes'));
});

test('graph/report is 404 when the report is missing', async () => {
  const res = await get('/api/enable/graph/report?project=jsononly');
  assert.equal(res.status, 404);
});
