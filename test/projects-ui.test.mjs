// test/projects-ui.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const html = readFileSync(fileURLToPath(new URL('../ui/public/index.html', import.meta.url)), 'utf8');
const appjs = readFileSync(fileURLToPath(new URL('../ui/public/app.js', import.meta.url)), 'utf8');

test('the free-text project path field is gone', () => {
  assert.ok(!html.includes('id="projectDir"'), 'old #projectDir input still in markup');
  assert.ok(!appjs.includes("$('#projectDir')"), 'app.js still wires #projectDir');
});

test('the project selector and add-form exist in markup', () => {
  assert.ok(html.includes('id="projectSelect"'), 'missing #projectSelect');
  assert.ok(html.includes('id="add-project"'), 'missing #add-project form');
});

test('app.js loads and uses the project registry', () => {
  assert.ok(appjs.includes("fetch('/api/projects')"), 'app.js does not GET /api/projects');
  assert.ok(appjs.includes('selectedProjectPath'), 'missing selectedProjectPath helper');
  assert.ok(appjs.includes('loadProjects'), 'missing loadProjects');
});

test('a Projects nav tab and view exist', () => {
  assert.ok(html.includes('data-nav="projects"'), 'missing Projects nav link');
  assert.ok(html.includes('data-view="projects"'), 'missing Projects view section');
  assert.ok(html.includes('id="projects-list"'), 'missing projects list container');
  assert.ok(html.includes('id="project-card-tpl"'), 'missing project card template');
});

test('app.js wires the Projects view (router + loader + PATCH/DELETE/POST)', () => {
  assert.ok(/VIEW_NAMES\s*=\s*\[[^\]]*'projects'/.test(appjs), "projects not in VIEW_NAMES");
  assert.ok(appjs.includes("name === 'projects'") && appjs.includes('loadProjectsView'),
    'showView does not load the projects view');
  assert.ok(appjs.includes("method: 'PATCH'") && appjs.includes("'/api/projects'"),
    'projects page does not PATCH the API');
});

test('the New Pipeline page no longer has a remove-project control', () => {
  assert.ok(!html.includes('id="project-delete"'), '#project-delete must be removed from New Pipeline');
  assert.ok(!appjs.includes('el.projectDelete'), 'projectDelete wiring must be removed');
});
