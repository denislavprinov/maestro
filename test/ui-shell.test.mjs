import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const html = readFileSync(fileURLToPath(new URL('../ui/public/index.html', import.meta.url)), 'utf8');

test('exactly four routed views', () => {
  assert.equal((html.match(/data-view/g) || []).length, 4);
});
test('four nav targets', () => {
  for (const v of ['new','running','history','composer']) assert.ok(html.includes(`data-nav="${v}"`), `missing data-nav=${v}`);
});
test('shell hooks present', () => {
  for (const id of ['run-card-tpl','hist-card-tpl','run-list','nav-running-count','nav-history-count','ws-dot'])
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
});
test('run-card template: 6 steps + qpanel + stop', () => {
  const m = html.match(/<template id="run-card-tpl">([\s\S]*?)<\/template>/);
  assert.ok(m, 'missing run-card-tpl');
  const tpl = m[1];
  for (const s of ['preflight','plan','refine','implement','review','done'])
    assert.ok(tpl.includes(`data-step="${s}"`), `tpl missing step ${s}`);
  assert.ok(tpl.includes('qpanel'), 'tpl missing qpanel slot');
  assert.ok(tpl.includes('btn-stop'), 'tpl missing btn-stop');
});
test('old shell removed', () => {
  assert.ok(!html.includes('class="layout"'), 'old .layout present');
  assert.ok(!html.includes('<ol id="steps"'), 'old #steps present');
});
