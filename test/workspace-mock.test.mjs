// test/workspace-mock.test.mjs
// M4 §6.7: the two new MOCK_ROLE arms in claude-runner's runMock.
//  - workspace-scan: writes a deterministic §5.8-template description to MOCK_OUT and
//    emits one `INVESTIGATING <key> relations to <other>` log line per project.
//  - workspace-reviewer: mirrors mockReviewer — blocking count DECREASES with cycle so
//    the review->implementer loop terminates; writes ONE merged review md + json.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runClaude } from '../src/core/claude-runner.mjs';
import { hasBlocking } from '../src/core/protocol.mjs';

const tmpDirs = [];
async function makeTmpDir() {
  const dir = await mkdtemp(join(tmpdir(), 'maestro-ws-mock-'));
  tmpDirs.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

function collect() {
  const events = [];
  return { events, onEvent: (e) => events.push(e) };
}

test('workspace-scan mock writes a template description + one INVESTIGATING line per project', async () => {
  const dir = await makeTmpDir();
  const out = join(dir, 'workspace-description.md');
  const { events, onEvent } = collect();
  const prompt = [
    '## Member projects to investigate',
    '- **iam** (`iam-1a2b3c4d`): investigate /wt/iam',
    '- **ui** (`ui-5e6f7a8b`): investigate /wt/ui',
    'MOCK_ROLE: workspace-scan',
    `MOCK_OUT: ${out}`,
    'MOCK_BASE: Demo WS',
  ].join('\n');
  const { text } = await runClaude({ cwd: dir, prompt, mock: true, onEvent });
  assert.match(text, /workspace description written/);

  const md = await readFile(out, 'utf8');
  assert.match(md, /# Workspace: Demo WS/);
  assert.match(md, /## Overview/);
  assert.match(md, /## Projects/);
  assert.match(md, /## Interconnections/);
  assert.match(md, /## Change-coordination notes/);
  assert.match(md, /## Suggested change order/);

  const investigating = events.filter((e) => /^INVESTIGATING /.test(e.text || ''));
  assert.equal(investigating.length, 2, 'one INVESTIGATING line per project');
  assert.ok(investigating.some((e) => /iam-1a2b3c4d/.test(e.text)));
  assert.ok(investigating.some((e) => /ui-5e6f7a8b/.test(e.text)));
  assert.ok(events.some((e) => /^SYNTHESIZING /.test(e.text || '')), 'emits a synthesize line');
});

test('workspace-scan mock degrades gracefully with no member lines', async () => {
  const dir = await makeTmpDir();
  const out = join(dir, 'desc.md');
  const { onEvent } = collect();
  const prompt = `MOCK_ROLE: workspace-scan\nMOCK_OUT: ${out}\nMOCK_BASE: Empty`;
  await runClaude({ cwd: dir, prompt, mock: true, onEvent });
  const md = await readFile(out, 'utf8');
  assert.match(md, /# Workspace: Empty/, 'still writes a valid description');
});

test('workspace-reviewer mock: blocking count decreases with cycle (loop terminates)', async () => {
  const dir = await makeTmpDir();
  const md1 = join(dir, 'ws1.md'); const j1 = join(dir, 'ws1.json');
  const md2 = join(dir, 'ws2.md'); const j2 = join(dir, 'ws2.json');

  await runClaude({
    cwd: dir, mock: true, onEvent: () => {},
    prompt: `MOCK_ROLE: workspace-reviewer\nMOCK_OUT: ${md1}\nMOCK_JSON: ${j1}\nMOCK_CYCLE: 1`,
  });
  await runClaude({
    cwd: dir, mock: true, onEvent: () => {},
    prompt: `MOCK_ROLE: workspace-reviewer\nMOCK_OUT: ${md2}\nMOCK_JSON: ${j2}\nMOCK_CYCLE: 2`,
  });

  const c1 = JSON.parse(await readFile(j1, 'utf8'));
  const c2 = JSON.parse(await readFile(j2, 'utf8'));
  assert.ok(hasBlocking(c1), 'cycle 1 blocks');
  assert.ok(!hasBlocking(c2), 'cycle 2 does not block -> loop terminates');
  const blocking1 = c1.issues.filter((i) => i.severity === 'critical' || i.severity === 'major').length;
  const blocking2 = c2.issues.filter((i) => i.severity === 'critical' || i.severity === 'major').length;
  assert.ok(blocking2 < blocking1, 'blocking count strictly decreases');

  // ONE merged review md, union of issues, projectKey-prefixed locations.
  const md = await readFile(md1, 'utf8');
  assert.match(md, /Workspace Implementation Review/);
  assert.match(md, /union/i);
  for (const i of c1.issues) {
    assert.match(i.location, /^[a-z0-9-]+:/i, `projectKey-prefixed location (${i.location})`);
  }
});
