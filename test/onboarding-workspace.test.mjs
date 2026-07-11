// test/onboarding-workspace.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useTempHome } from './helpers/temp-home.mjs';
import { runOnboarding } from '../src/core/onboarding.mjs';
import { projectKey } from '../src/core/store.mjs';

useTempHome(after);

function freshRepo(name) {
  const dir = mkdtempSync(join(tmpdir(), `onb-ws-${name}-`));
  execSync('git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', { cwd: dir });
  return dir;
}

test('runOnboarding: neither projectDir nor workspace -> throws', async () => {
  await assert.rejects(() => runOnboarding({}), /projectDir or workspace is required/);
});

test('runOnboarding: both projectDir and workspace -> throws', async () => {
  const a = freshRepo('a'), b = freshRepo('b');
  await assert.rejects(() => runOnboarding({
    projectDir: a,
    workspace: { id: 'wks-x-11111111', key: 'wks-x-11111111', name: 'X', description: '',
      projects: [
        { projectDir: a, projectKey: projectKey(a), projectName: 'a', branch: { source: null, feature: null } },
        { projectDir: b, projectKey: projectKey(b), projectName: 'b', branch: { source: null, feature: null } },
      ] },
  }), /provide projectDir or workspace, not both/);
});

test('runOnboarding: workspace-only kicks off a mock run against the primary member', async () => {
  const a = freshRepo('a'), b = freshRepo('b');
  const projects = [
    { projectDir: a, projectKey: projectKey(a), projectName: 'a', branch: { source: null, feature: null } },
    { projectDir: b, projectKey: projectKey(b), projectName: 'b', branch: { source: null, feature: null } },
  ].sort((x, y) => (x.projectKey < y.projectKey ? -1 : x.projectKey > y.projectKey ? 1 : 0));
  const handle = await runOnboarding({
    workspace: { id: 'wks-x-22222222', key: 'wks-x-22222222', name: 'X', description: '', projects },
    mock: true,
  });
  assert.equal(handle.orch.isWorkspace, true);
  assert.equal(handle.orch.projectDir, projects[0].projectDir);
  const result = await handle.done;
  assert.ok(['done', 'error'].includes(result.status)); // mock run completes or fails fast; either way it ran the workspace path
});
