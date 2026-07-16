import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectStacks } from '../src/core/stack-detect.mjs';
import { STACK_CATALOG } from '../src/core/skill-vendor.mjs';

const dir = () => mkdtempSync(join(tmpdir(), 'stacks-'));
const stacks = (d) => detectStacks(d).map((s) => s.stack);

test('empty repo detects nothing', () => {
  assert.deepEqual(detectStacks(dir()), []);
});

test('spring-boot via pom.xml containing spring-boot', () => {
  const d = dir();
  writeFileSync(join(d, 'pom.xml'), '<project><artifactId>spring-boot-starter-web</artifactId></project>');
  const out = detectStacks(d);
  assert.deepEqual(out.map((s) => s.stack), ['spring-boot']);
  assert.match(out[0].evidence, /pom\.xml/);
});

test('spring-boot via build.gradle.kts; plain java gradle does NOT match', () => {
  const d1 = dir();
  writeFileSync(join(d1, 'build.gradle.kts'), 'plugins { id("org.springframework.boot") }');
  assert.deepEqual(stacks(d1), ['spring-boot']);
  const d2 = dir();
  writeFileSync(join(d2, 'build.gradle'), 'plugins { id("java") }');
  assert.deepEqual(stacks(d2), []);
});

test('swift via Package.swift or *.xcodeproj', () => {
  const d1 = dir();
  writeFileSync(join(d1, 'Package.swift'), '// swift-tools-version:6.0');
  assert.deepEqual(stacks(d1), ['swift']);
  const d2 = dir();
  mkdirSync(join(d2, 'App.xcodeproj'), { recursive: true });
  assert.deepEqual(stacks(d2), ['swift']);
});

test('devops artifacts detect independently — Dockerfile alone must not suggest kubernetes', () => {
  const d = dir();
  writeFileSync(join(d, 'Dockerfile'), 'FROM node:22');
  assert.deepEqual(stacks(d), ['docker']);
});

test('kubernetes via Chart.yaml, kustomization.yaml, or k8s/ manifest with apiVersion+kind', () => {
  const d1 = dir();
  writeFileSync(join(d1, 'Chart.yaml'), 'name: app');
  assert.deepEqual(stacks(d1), ['kubernetes']);
  const d2 = dir();
  writeFileSync(join(d2, 'kustomization.yaml'), 'resources: []');
  assert.deepEqual(stacks(d2), ['kubernetes']);
  const d3 = dir();
  mkdirSync(join(d3, 'k8s'));
  writeFileSync(join(d3, 'k8s', 'deploy.yaml'), 'apiVersion: apps/v1\nkind: Deployment');
  assert.deepEqual(stacks(d3), ['kubernetes']);
  const d4 = dir();
  mkdirSync(join(d4, 'k8s'));
  writeFileSync(join(d4, 'k8s', 'notes.yaml'), 'just: notes');
  assert.deepEqual(stacks(d4), []);
});

test('terraform via *.tf; github-actions via .github/workflows/*.yml', () => {
  const d1 = dir();
  writeFileSync(join(d1, 'main.tf'), 'resource "x" "y" {}');
  assert.deepEqual(stacks(d1), ['terraform']);
  const d2 = dir();
  mkdirSync(join(d2, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(d2, '.github', 'workflows', 'ci.yml'), 'on: push');
  assert.deepEqual(stacks(d2), ['github-actions']);
});

test('package.json deps: react / nextjs (implies react — nextjs only) / express', () => {
  const d1 = dir();
  writeFileSync(join(d1, 'package.json'), JSON.stringify({ dependencies: { react: '^19' } }));
  assert.deepEqual(stacks(d1), ['react']);
  const d2 = dir();
  writeFileSync(join(d2, 'package.json'), JSON.stringify({ dependencies: { next: '^15', react: '^19' } }));
  assert.deepEqual(stacks(d2), ['nextjs']);
  const d3 = dir();
  writeFileSync(join(d3, 'package.json'), JSON.stringify({ dependencies: { express: '^4' }, devDependencies: {} }));
  assert.deepEqual(stacks(d3), ['express']);
  const d4 = dir();
  writeFileSync(join(d4, 'package.json'), 'not json');
  assert.deepEqual(stacks(d4), []);
});

test('python deps: django / fastapi via pyproject.toml or requirements.txt', () => {
  const d1 = dir();
  writeFileSync(join(d1, 'pyproject.toml'), '[project]\ndependencies = ["django>=5"]');
  assert.deepEqual(stacks(d1), ['django']);
  const d2 = dir();
  writeFileSync(join(d2, 'requirements.txt'), 'fastapi==0.115\nuvicorn');
  assert.deepEqual(stacks(d2), ['fastapi']);
});

test('multi-stack repo: sorted stack names, every stack is a STACK_CATALOG key', () => {
  const d = dir();
  writeFileSync(join(d, 'Dockerfile'), 'FROM eclipse-temurin');
  writeFileSync(join(d, 'pom.xml'), '<a>spring-boot</a>');
  mkdirSync(join(d, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(d, '.github', 'workflows', 'ci.yml'), 'on: push');
  const out = stacks(d);
  assert.deepEqual(out, ['docker', 'github-actions', 'spring-boot']);
  for (const s of out) assert.ok(Object.hasOwn(STACK_CATALOG, s));
});
