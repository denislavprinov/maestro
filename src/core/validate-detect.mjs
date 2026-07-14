// Static test-command detection: probes well-known project files and suggests
// validation commands for the shell gate. Pure file inspection, no LLM, no
// process spawn. Prefill/suggestion only — the user's input stays authoritative;
// detection never auto-enables the gate. Never throws.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

async function readIfPresent(dir, name) {
  try { return await readFile(join(dir, name), 'utf8'); } catch { return null; }
}

/**
 * Ordered suggestions for a project's validation command(s). Empty when nothing
 * recognizable exists. Order: npm, make, pytest, cargo.
 * @param {string} projectDir
 * @returns {Promise<string[]>}
 */
export async function detectValidationCommands(projectDir) {
  const out = [];

  const pkgText = await readIfPresent(projectDir, 'package.json');
  if (pkgText) {
    try {
      const scripts = JSON.parse(pkgText)?.scripts || {};
      const t = String(scripts.test || '');
      // npm init's placeholder is a failure echo, not a test suite.
      if (t && !/no test specified/i.test(t)) out.push('npm test');
    } catch { /* malformed package.json -> no npm suggestion */ }
  }

  const makefile = (await readIfPresent(projectDir, 'Makefile')) ?? (await readIfPresent(projectDir, 'makefile'));
  if (makefile && /^test\s*:/m.test(makefile)) out.push('make test');

  const pyproject = await readIfPresent(projectDir, 'pyproject.toml');
  if ((await readIfPresent(projectDir, 'pytest.ini')) !== null ||
      (pyproject && /\[tool\.pytest/.test(pyproject))) {
    out.push('pytest');
  }

  if ((await readIfPresent(projectDir, 'Cargo.toml')) !== null) out.push('cargo test');

  return out;
}
