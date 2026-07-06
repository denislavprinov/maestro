// Stage production node_modules (express, ws — no electron) for packaging.
// electron-builder copies stage/node_modules into the app's extraResources;
// bundling apps/enable/node_modules directly would drag electron itself in.
import { rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const stage = join(appDir, 'stage');

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
copyFileSync(join(appDir, 'package.json'), join(stage, 'package.json'));
copyFileSync(join(appDir, 'package-lock.json'), join(stage, 'package-lock.json'));
execSync('npm ci --omit=dev --ignore-scripts --no-audit --no-fund', { cwd: stage, stdio: 'inherit' });
console.log('[stage] production node_modules ready at', join(stage, 'node_modules'));
