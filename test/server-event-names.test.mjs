// test/server-event-names.test.mjs — wireRun must forward the new 'stepskills'
// event through the pass-through broadcast (tagged with the run UUID), exactly as
// it forwards 'subagent'. EVENT_NAMES is not exported, so assert BEHAVIORALLY via
// the buffered events on the run entry (mirrors ui-runs-live-id.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runs, _testing } from '../ui/server.mjs';

function makeEntry(overrides = {}) {
  return {
    id: 'uuid-SK1',
    orch: new EventEmitter(),
    projectDir: '/tmp/x',
    title: 't',
    status: 'running',
    startedAt: new Date().toISOString(),
    events: [],
    pendingQuestion: null,
    ...overrides,
  };
}

test("wireRun: 'stepskills' events are forwarded, tagged with the run UUID", () => {
  const entry = makeEntry({ id: 'uuid-SK1' });
  runs.set(entry.id, entry);
  try {
    _testing.wireRun(entry);
    entry.orch.emit('stepskills', { nodeId: 'n1', cycle: 1, skills: ['skill:graphify'] });
    const buffered = entry.events.filter((e) => e.type === 'stepskills');
    assert.equal(buffered.length, 1, 'stepskills event is buffered/forwarded');
    assert.equal(buffered[0].runId, 'uuid-SK1', 'tagged with the run UUID');
    assert.deepEqual(buffered[0].skills, ['skill:graphify']);
    assert.equal(buffered[0].nodeId, 'n1');
    assert.equal(buffered[0].cycle, 1);
    assert.equal(entry.status, 'running', 'a stepskills event must not change run status');
  } finally {
    runs.delete(entry.id);
  }
});
