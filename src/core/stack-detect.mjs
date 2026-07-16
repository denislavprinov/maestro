// src/core/stack-detect.mjs
// Deterministic, offline stack detection for the stack-skills mirror. Read-only
// manifest sniffing — no LLM, no network. Each detected stack keys STACK_CATALOG
// in skill-vendor.mjs; `evidence` becomes the results-screen suggestion reason.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
const names = (dir) => { try { return readdirSync(dir); } catch { return []; } };

function pkgDeps(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    return { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  } catch { return {}; }
}

function pyDeps(dir) {
  return read(join(dir, 'pyproject.toml')) + '\n' + read(join(dir, 'requirements.txt'));
}

/**
 * Detect the target repo's stacks from manifests. Pure fs reads, top level only
 * (plus the conventional k8s/, manifests/, .github/workflows/ dirs).
 * @param {string} projectDir
 * @returns {Array<{stack: string, evidence: string}>} sorted by stack name
 */
export function detectStacks(projectDir) {
  const found = new Map(); // stack -> evidence

  // spring-boot: any JVM manifest mentioning spring-boot / springframework.boot
  for (const f of ['pom.xml', 'build.gradle', 'build.gradle.kts']) {
    const text = read(join(projectDir, f));
    if (/spring-boot|springframework\.boot/i.test(text)) { found.set('spring-boot', `Spring Boot detected (${f})`); break; }
  }

  // swift: SPM manifest or an Xcode project/workspace dir
  if (existsSync(join(projectDir, 'Package.swift'))) found.set('swift', 'Swift detected (Package.swift)');
  else {
    const xcode = names(projectDir).find((n) => n.endsWith('.xcodeproj') || n.endsWith('.xcworkspace'));
    if (xcode) found.set('swift', `Swift detected (${xcode})`);
  }

  // devops artifacts — each detects independently
  if (existsSync(join(projectDir, 'Dockerfile')) ||
      names(projectDir).some((n) => /^docker-compose.*\.ya?ml$/.test(n))) {
    found.set('docker', 'Docker detected (Dockerfile/docker-compose)');
  }
  if (existsSync(join(projectDir, 'Chart.yaml')) || existsSync(join(projectDir, 'kustomization.yaml'))) {
    found.set('kubernetes', 'Kubernetes detected (helm/kustomize manifest)');
  } else {
    for (const d of ['k8s', 'manifests']) {
      const hit = names(join(projectDir, d)).find((n) => /\.ya?ml$/.test(n) &&
        /apiVersion:/.test(read(join(projectDir, d, n))) && /kind:/.test(read(join(projectDir, d, n))));
      if (hit) { found.set('kubernetes', `Kubernetes detected (${d}/${hit})`); break; }
    }
  }
  if (names(projectDir).some((n) => n.endsWith('.tf'))) found.set('terraform', 'Terraform detected (*.tf)');
  if (names(join(projectDir, '.github', 'workflows')).some((n) => /\.ya?ml$/.test(n))) {
    found.set('github-actions', 'GitHub Actions detected (.github/workflows)');
  }

  // node web frameworks from package.json deps; nextjs implies react
  const deps = pkgDeps(projectDir);
  if (deps.next) found.set('nextjs', 'Next.js detected (package.json)');
  else if (deps.react) found.set('react', 'React detected (package.json)');
  if (deps.express) found.set('express', 'Express detected (package.json)');

  // python web frameworks
  const py = pyDeps(projectDir);
  if (/\bdjango\b/i.test(py)) found.set('django', 'Django detected (python manifest)');
  if (/\bfastapi\b/i.test(py)) found.set('fastapi', 'FastAPI detected (python manifest)');

  return [...found.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([stack, evidence]) => ({ stack, evidence }));
}
