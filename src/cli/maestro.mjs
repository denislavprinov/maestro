#!/usr/bin/env node
// src/cli/maestro.mjs
//
// CLI entry point. Parses flags, creates a core orchestrator, subscribes to its events,
// renders a phase tracker + streamed agent logs to the terminal, and drives interactive
// Q&A (clarify) and loop gates via node:readline. Supports --yes (auto), --mock,
// --install <dir> (delegates to scripts/install.mjs), and --ui (spawns ui/server.mjs).
//
// ESM, no external dependencies.

import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, basename } from 'node:path';
import process from 'node:process';

import { createOrchestrator } from '../core/orchestrator.mjs';
import {
  addProject,
  listProjects,
  removeProject,
  normalizeProjectPath,
} from '../core/projects.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

// ── arg parsing ────────────────────────────────────────────────────────────────

/**
 * Parse argv into a flags object. Supports "--flag value" and "--flag=value", plus the
 * boolean flags --mock, --yes/--non-interactive, --ui, -h/--help.
 */
function parseArgs(argv) {
  const out = {
    project: process.cwd(),
    prompt: null,
    file: null,
    title: null,
    extras: [],
    ui: false,
    model: undefined,
    permissionMode: undefined,
    workflow: undefined,
    mock: false,
    auto: false,
    install: null,
    sourceBranch: undefined,
    featureBranch: undefined,
    help: false,
    _: [],
  };
  const takesValue = new Set([
    '--project',
    '--prompt',
    '--file',
    '--title',
    '--extras',
    '--model',
    '--permission-mode',
    '--workflow',
    '--install',
    '--source-branch',
    '--branch',
  ]);
  const map = {
    '--project': 'project',
    '--prompt': 'prompt',
    '--file': 'file',
    '--title': 'title',
    '--extras': 'extras',
    '--model': 'model',
    '--permission-mode': 'permissionMode',
    '--workflow': 'workflow',
    '--install': 'install',
    '--source-branch': 'sourceBranch',
    '--branch': 'featureBranch',
  };

  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      out.help = true;
      continue;
    }
    if (arg === '--mock') {
      out.mock = true;
      continue;
    }
    if (arg === '--yes' || arg === '--non-interactive') {
      out.auto = true;
      continue;
    }
    if (arg === '--ui') {
      out.ui = true;
      continue;
    }

    let inlineValue;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq !== -1) {
      inlineValue = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }

    if (takesValue.has(arg)) {
      const key = map[arg];
      const value = inlineValue !== undefined ? inlineValue : argv[++i];
      if (value === undefined) {
        fail(`Flag ${arg} requires a value.`);
      }
      if (key === 'extras') {
        // Comma-separated and/or repeatable; accumulate non-empty paths.
        for (const part of String(value).split(',')) {
          const p = part.trim();
          if (p) out.extras.push(p);
        }
      } else {
        out[key] = value;
      }
      continue;
    }

    if (arg.startsWith('-')) {
      fail(`Unknown flag: ${arg}`);
    }
    out._.push(arg);
  }
  return out;
}

function fail(msg) {
  process.stderr.write(`orchestrate: ${msg}\n`);
  process.exit(2);
}

const HELP = `orchestrate — deterministic multi-agent pipeline (Plan -> Refine -> Implement -> Review)

Usage:
  maestro <subcommand> [args]
  maestro --prompt "<task>" [--project <dir>] [options]
  maestro --file <task.md> [--project <dir>] [options]
  maestro --ui
  maestro --install <targetDir> [--force]

Subcommands:
  add [name] [--path <dir>]   Register a project. Defaults: name = basename(path), path = cwd.
  list                        List registered projects (tab-separated; missing dirs are flagged).
  remove <name>               Remove a registered project by name (case-insensitive).

Options:
  --project <dir>          Target project directory (default: cwd)
  --prompt <text>          Task prompt text
  --file <md>              Markdown file used as the prompt (alternative to --prompt)
  --title <text>           Human-readable run title
  --extras <paths>         Extra files copied into the pipeline's extras/ folder
                           (comma-separated; repeatable)
  --model <m>              Claude model id
  --permission-mode <m>    Claude permission mode (default acceptEdits)
  --workflow <id>          Saved workflow id to run (default: wf_default)
  --source-branch <name>   Branch to fork the per-run worktree from (default: current HEAD)
  --branch <name>          Feature branch name (default: claude proposes one)
  --mock                   Offline mock mode (no claude, no tokens)
  --yes, --non-interactive Auto-answer clarify (first option) and gates (continue)
  --ui                     Launch the web UI (ui/server.mjs) and exit
  --install <targetDir>    Copy agents + /maestro skill into <targetDir>/.claude
  -h, --help               Show this help
`;

// ── terminal rendering ───────────────────────────────────────────────────────────

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};
const useColor = process.stdout.isTTY;
function c(name, s) {
  if (!useColor) return s;
  return `${COLORS[name] || ''}${s}${COLORS.reset}`;
}

function out(s) {
  process.stdout.write(s + '\n');
}

function phaseLabel(phase, cycle) {
  if (cycle && (phase === 'refine' || phase === 'review' || phase === 'implement' || phase === 'clarify')) {
    return `${phase} #${cycle}`;
  }
  return phase;
}

function statusMark(status) {
  if (status === 'done') return c('green', '✓');
  if (status === 'start') return c('cyan', '▶');
  return c('gray', '•');
}

const LEVEL_COLOR = { info: 'reset', debug: 'gray', warn: 'yellow', error: 'red' };

// ── interactive prompts (readline) ───────────────────────────────────────────────

function makeRl() {
  return createInterface({ input: process.stdin, output: process.stdout });
}

function question(rl, q) {
  return new Promise((res) => rl.question(q, (a) => res(a)));
}

/**
 * Ask the clarify questions interactively. Each question shows its 3 options plus a
 * "type your own" choice. Returns { answers: [{ id, choice }] }.
 */
async function askClarify(rl, questions) {
  const answers = [];
  for (const q of questions) {
    out('');
    out(c('bold', `Q: ${q.question}`));
    const opts = (q.options || []).filter((o) => o && o.trim());
    opts.forEach((o, i) => out(`  ${i + 1}) ${o}`));
    const ownIndex = opts.length + 1;
    out(`  ${ownIndex}) type your own`);
    let choice = '';
    while (!choice) {
      const raw = (await question(rl, c('cyan', 'Choose [number or text]: '))).trim();
      if (!raw) {
        // Empty input defaults to the first option.
        choice = opts[0] || '';
        if (choice) break;
        continue;
      }
      const n = Number(raw);
      if (Number.isInteger(n) && n >= 1 && n <= opts.length) {
        choice = opts[n - 1];
      } else if (Number.isInteger(n) && n === ownIndex) {
        choice = (await question(rl, c('cyan', 'Your answer: '))).trim();
      } else {
        // Treat any other free text as the answer directly.
        choice = raw;
      }
    }
    answers.push({ id: q.id, choice });
  }
  return { answers };
}

/**
 * Ask a loop gate interactively. Shows the open blocking issues and the two choices.
 * Returns { decision: "continue" | "another" }.
 */
async function askGate(rl, issues) {
  out('');
  out(c('yellow', c('bold', 'Loop gate — maximum cycles reached.')));
  out(c('yellow', 'Open critical/major issues:'));
  if (!issues || issues.length === 0) {
    out('  (none reported)');
  } else {
    for (const it of issues) {
      out(`  - ${c('red', `[${it.severity}]`)} ${it.title}${it.location ? c('gray', ` (${it.location})`) : ''}`);
      if (it.detail) out(c('gray', `      ${it.detail}`));
    }
  }
  out('  1) Don\'t have another cycle and continue');
  out('  2) I approve another cycle');
  let decision = '';
  while (!decision) {
    const raw = (await question(rl, c('cyan', 'Choose [1-2]: '))).trim();
    if (raw === '1' || /^cont/i.test(raw)) decision = 'continue';
    else if (raw === '2' || /^(another|approve)/i.test(raw)) decision = 'another';
  }
  return { decision };
}

// ── subcommands ──────────────────────────────────────────────────────────────────

/** Spawn the web UI server and inherit its stdio. Resolves when it exits. */
function launchUi() {
  const server = join(REPO_ROOT, 'ui', 'server.mjs');
  out(c('cyan', `Launching web UI: node ${server}`));
  const child = spawn(process.execPath, [server], { stdio: 'inherit' });
  return new Promise((res) => {
    child.on('exit', (code) => res(code ?? 0));
    child.on('error', (err) => {
      process.stderr.write(`Failed to launch UI: ${err.message}\n`);
      res(1);
    });
  });
}

/** Delegate to scripts/install.mjs, forwarding the target dir and any passthrough args. */
function runInstall(targetDir, passthrough) {
  const script = join(REPO_ROOT, 'scripts', 'install.mjs');
  const args = [script, targetDir, ...passthrough];
  const child = spawn(process.execPath, args, { stdio: 'inherit' });
  return new Promise((res) => {
    child.on('exit', (code) => res(code ?? 0));
    child.on('error', (err) => {
      process.stderr.write(`Failed to run install: ${err.message}\n`);
      res(1);
    });
  });
}

// ── project registry subcommands ──────────────────────────────────────────────

/** Parse a tiny argv slice for the `add` subcommand. Supports --path/--path=<dir>. */
function parseAddArgs(argv) {
  const positionals = [];
  let pathArg = null;
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let inline;
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq !== -1) {
      inline = a.slice(eq + 1);
      a = a.slice(0, eq);
    }
    if (a === '--path') {
      const v = inline !== undefined ? inline : argv[++i];
      if (v === undefined) fail('Flag --path requires a value.');
      pathArg = v;
    } else if (a.startsWith('-')) {
      fail(`Unknown flag: ${a}`);
    } else {
      positionals.push(a);
    }
  }
  return { name: positionals[0], path: pathArg };
}

async function cmdAdd(argv) {
  const { name: rawName, path: rawPath } = parseAddArgs(argv);
  // Always route through normalizeProjectPath so display, storage, and
  // basename() all see exactly the same string addProject will persist.
  const target = normalizeProjectPath(rawPath) || resolve(process.cwd());
  const name = (rawName && rawName.trim()) || basename(target);
  try {
    await addProject({ name, path: target });
    out(`Added project "${name}" -> ${target}`);
    return 0;
  } catch (err) {
    process.stderr.write(`maestro: ${err?.message || err}\n`);
    return 1;
  }
}

async function cmdList() {
  const items = await listProjects();
  if (items.length === 0) {
    out('No projects registered. Use `maestro add` to register one.');
    return 0;
  }
  for (const p of items) {
    const tail = p.exists ? '' : `\t${c('gray', '[missing]')}`;
    out(`${p.name}\t${p.path}${tail}`);
  }
  return 0;
}

async function cmdRemove(argv) {
  const name = (argv[0] || '').trim();
  if (!name) fail('Usage: maestro remove <name>');
  const before = await listProjects();
  const after = await removeProject(name);
  if (after.length === before.length) {
    out(`No project named "${name}"`);
    return 1;
  }
  out(`Removed project "${name}"`);
  return 0;
}

// ── main ──────────────────────────────────────────────────────────────────────────

const SUBCOMMANDS = new Set(['add', 'list', 'remove']);

async function main() {
  const sub = process.argv[2];
  if (SUBCOMMANDS.has(sub)) {
    const rest = process.argv.slice(3);
    if (sub === 'add') return cmdAdd(rest);
    if (sub === 'list') return cmdList();
    if (sub === 'remove') return cmdRemove(rest);
  }

  const flags = parseArgs(process.argv.slice(2));

  if (flags.help) {
    process.stdout.write(HELP);
    return 0;
  }

  if (flags.install) {
    // Forward --force (and any other extra tokens) to the installer.
    const passthrough = [];
    if (process.argv.includes('--force')) passthrough.push('--force');
    return runInstall(flags.install, passthrough);
  }

  if (flags.ui) {
    return launchUi();
  }

  if (flags.mock) {
    process.env.MAESTRO_MOCK = '1';
  }

  if (!flags.prompt && !flags.file) {
    // Allow a bare positional prompt: `orchestrate "do the thing"`.
    if (flags._.length) {
      flags.prompt = flags._.join(' ');
    } else {
      fail('Provide a task with --prompt "<text>" or --file <markdown>. See --help.');
    }
  }

  const projectDir = resolve(flags.project);
  // Resolve extras against the shell cwd so relative paths are unambiguous.
  const extras = (flags.extras || []).map((p) => resolve(process.cwd(), p));
  const orch = createOrchestrator({
    projectDir,
    prompt: flags.prompt || undefined,
    promptFile: flags.file || undefined,
    title: flags.title || undefined,
    extras,
    workflowId: flags.workflow || undefined,
    branch: { source: flags.sourceBranch, feature: flags.featureBranch },
    claude: {
      permissionMode: flags.permissionMode,
      model: flags.model,
      mock: flags.mock,
    },
    auto: flags.auto,
  });

  const rl = flags.auto ? null : makeRl();
  let answering = false; // serialize interactive prompts vs. log rendering

  // ── event wiring ──────────────────────────────────────────────────────────────
  orch.on('phase', ({ phase, cycle, status }) => {
    out(`${statusMark(status)} ${c('bold', phaseLabel(phase, cycle))} ${c('gray', status)}`);
  });

  orch.on('log', ({ source, level, text }) => {
    if (answering) return; // avoid interleaving with an open question prompt
    const color = LEVEL_COLOR[level] || 'reset';
    out(c('gray', `  [${source}] `) + c(color, text));
  });

  orch.on('artifact', ({ kind, path }) => {
    out(c('gray', `  ↳ ${kind}: ${path}`));
  });

  orch.on('error', ({ message }) => {
    process.stderr.write(c('red', `Error: ${message}`) + '\n');
  });

  orch.on('question', async ({ id, kind, questions, issues }) => {
    if (flags.auto || !rl) return; // auto mode resolves internally
    answering = true;
    try {
      if (kind === 'clarify') {
        const payload = await askClarify(rl, questions || []);
        orch.answer(id, payload);
      } else if (kind === 'gate') {
        const payload = await askGate(rl, issues || []);
        orch.answer(id, payload);
      }
    } catch (err) {
      process.stderr.write(`Failed to read answer: ${err?.message || err}\n`);
    } finally {
      answering = false;
    }
  });

  out(c('bold', `orchestrator — project: ${projectDir}`));
  if (flags.mock) out(c('yellow', 'mock mode: no claude will be spawned'));

  // Allow Ctrl-C to stop the run gracefully (stops the orchestrator first).
  let stopping = false;
  const onSigint = () => {
    if (stopping) process.exit(130);
    stopping = true;
    out(c('yellow', '\nStopping…'));
    orch.stop();
  };
  process.on('SIGINT', onSigint);

  let result;
  try {
    result = await orch.run();
  } finally {
    if (rl) rl.close();
    process.removeListener('SIGINT', onSigint);
  }

  out('');
  if (result?.status === 'done') {
    out(c('green', c('bold', 'Pipeline complete.')));
  } else if (result?.status === 'stopped') {
    out(c('yellow', 'Pipeline stopped.'));
  } else {
    out(c('red', `Pipeline ended with status: ${result?.status || 'unknown'}`));
  }
  if (result?.pipelineDir) {
    out(`Pipeline directory: ${c('bold', result.pipelineDir)}`);
  }
  return result?.status === 'done' ? 0 : 1;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    process.stderr.write(`orchestrate: fatal: ${err?.stack || err?.message || err}\n`);
    process.exit(1);
  });
