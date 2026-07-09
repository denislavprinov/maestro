// Cross-tool readiness parity: after an Enable run, Claude, Copilot and Codex
// users must land on equivalent guidance. Drift guards over the three agent
// prompts that carry the contract, plus the Enable UI defaults.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const agent = (f) => readFileSync(join(here, '../agents', f), 'utf8');

test('clarifier default multiToolTargets covers cursor + copilot + AGENTS.md', () => {
  const md = agent('maestro-enable-clarifier.md');
  const block = md.match(/```json\s*([\s\S]*?)```/);
  const q = JSON.parse(block[1]).questions.find((x) => x.id === 'multiToolTargets');
  const first = q.options[0];
  assert.match(first, /\.cursor\/rules/);
  assert.match(first, /copilot-instructions\.md/);
  assert.match(first, /AGENTS\.md/, 'Codex reads AGENTS.md — must be in the default option');
});

test('projectOnboarding contract: every tool file self-sufficient, key workflows mirrored', () => {
  const md = agent('maestro-project-onboarding.md');
  assert.match(md, /self-sufficient/i, 'multi-tool section must demand self-sufficient files');
  assert.match(md, /pointer-only|stub/i, 'must forbid pointer-only stubs');
  assert.match(md, /[Kk]ey workflows?/, 'key-workflow knowledge must be mirrored into each tool file');
});

test('evaluator scores multiTool on parity, not bare file existence', () => {
  const md = agent('maestro-onboarding-evaluator.md');
  assert.match(md, /self-sufficien/i, 'evaluator must verify self-sufficiency per requested file');
  assert.match(md, /pointer-only|stub/i, 'a stub must count as missing');
});

test('Enable UI defaults select all three targets (AGENTS.md on by default)', async () => {
  const dom = new JSDOM(readFileSync(join(here, '../apps/enable/public/index.html'), 'utf8'),
    { url: 'http://localhost:4319/' });
  const { window } = dom;
  window.WebSocket = class { close() {} };
  window.fetch = () => Promise.resolve({ ok: true, status: 200, json: async () => ({ root: '/x', projects: [], runs: [] }) });
  for (const k of ['window', 'document', 'location', 'localStorage', 'WebSocket', 'fetch', 'navigator']) {
    try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); } catch {}
  }
  globalThis.window = window; globalThis.document = window.document;
  await import(join(here, '../apps/enable/public/app.js') + `?b=${Date.now()}_${Math.random()}`);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));

  const agents = window.document.querySelector('input[name="multiToolTargets"][value="agents"]');
  assert.ok(agents, 'AGENTS.md option present');
  assert.equal(agents.checked, true, 'AGENTS.md must be on by default (Codex parity)');
  for (const v of ['cursor', 'copilot']) {
    assert.equal(window.document.querySelector(`input[name="multiToolTargets"][value="${v}"]`).checked, true);
  }
});
