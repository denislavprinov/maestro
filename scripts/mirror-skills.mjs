// scripts/mirror-skills.mjs
// One-shot (re-runnable) ingestion for the stack-skills mirror. Clones each
// upstream at a pinned ref into a temp dir, copies the mapped skill dirs into
// skills/<local-name>/, writes ATTRIBUTION.md + copies the upstream LICENSE.
// Every refresh is a deliberate re-run + human review + commit — never runtime.
//
// Usage: node scripts/mirror-skills.mjs [--ref-override <repo>=<sha>]
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync, copyFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// upstream -> { ref: pin (branch/sha; sha recorded either way), skills: { localName: pathInRepo } }
const SOURCES = {
  'https://github.com/rrezartprebreza/spring-boot-skills': {
    ref: 'main',
    skills: {
      'rest-api-conventions': 'skills/spring-boot-3/rest-api-conventions',
      'spring-data-jpa': 'skills/spring-boot-3/spring-data-jpa',
      'spring-security-jwt': 'skills/spring-boot-3/spring-security-jwt',
      'flyway-migrations': 'skills/spring-boot-3/flyway-migrations',
      'testing-pyramid': 'skills/spring-boot-3/testing-pyramid',
    },
  },
  'https://github.com/Mindrally/skills': {
    ref: 'main',
    skills: {
      swift: 'swift', swiftui: 'swiftui-development',
      docker: 'docker', kubernetes: 'kubernetes', terraform: 'terraform', 'github-actions': 'github-workflow',
      react: 'react', nextjs: 'nextjs-react-typescript', django: 'django-python', fastapi: 'fastapi-python', express: 'express-typescript',
    },
  },
};

for (const [url, { ref, skills }] of Object.entries(SOURCES)) {
  const tmp = mkdtempSync(join(tmpdir(), 'mirror-'));
  execFileSync('git', ['clone', '--depth', '50', url, tmp], { stdio: 'inherit' });
  execFileSync('git', ['-C', tmp, 'checkout', ref], { stdio: 'inherit' });
  const sha = execFileSync('git', ['-C', tmp, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  for (const [local, remotePath] of Object.entries(skills)) {
    const src = join(tmp, remotePath);
    if (!existsSync(join(src, 'SKILL.md'))) {
      console.error(`SKIP ${local}: ${remotePath} has no SKILL.md at ${url}@${sha} — check the upstream layout`);
      continue;
    }
    const dest = join(repoRoot, 'skills', local);
    rmSync(dest, { recursive: true, force: true });
    cpSync(src, dest, { recursive: true });
    for (const lic of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
      if (existsSync(join(tmp, lic))) { copyFileSync(join(tmp, lic), join(dest, 'LICENSE')); break; }
    }
    writeFileSync(join(dest, 'ATTRIBUTION.md'),
      `# Attribution\n\nMirrored from ${url}\n\n- path: \`${remotePath}\`\n- commit: ${sha}\n` +
      `- mirrored: ${new Date().toISOString().slice(0, 10)}\n- local modifications: none\n`);
    console.log(`mirrored ${local} <- ${url}@${sha.slice(0, 7)}:${remotePath}`);
  }
  rmSync(tmp, { recursive: true, force: true });
}
console.log('Done. REVIEW every mirrored file before committing.');
