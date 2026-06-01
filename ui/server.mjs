// ui/server.mjs
// Express static server + REST API + WebSocket bridge that drives the
// deterministic orchestrator core. Only non-builtin deps: express + ws.
//
// Run:  node ui/server.mjs   (or `npm start`)
// Env:  PORT (default 4317), MAESTRO_MOCK (forwarded to runs when ?mock or body.mock)

import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

import { createOrchestrator } from '../src/core/orchestrator.mjs';
import { listPipelines, readPipeline } from '../src/core/artifacts.mjs';
import { listProjects, addProject, removeProject, normalizeProjectPath } from '../src/core/projects.mjs';
import {
  readConfig, setStep, addCustomModel, removeCustomModel, listModels,
  PREDEFINED_MODELS, AGENT_STEPS, EFFORTS,
  readRunConfig, setNodeModel, setFeedbackCycles, setActiveWorkflow,
} from '../src/core/config.mjs';
import {
  DEFAULT_WORKFLOW, listWorkflows, readWorkflow, writeWorkflow, deleteWorkflow,
} from '../src/core/workflows.mjs';
import { validateWorkflow } from '../src/core/workflow-validator.mjs';
import { loadAgentRegistry } from '../src/core/agent-registry.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(__dirname, 'public');
const AGENTS_DIR = path.join(PROJECT_ROOT, 'agents');
const SKILLS_DIR = path.join(PROJECT_ROOT, 'skills');
const PORT = Number(process.env.PORT) || 4317;

// ---------------------------------------------------------------------------
// Run registry. Each entry holds the live orchestrator + a ring buffer of the
// events emitted so far so that a WebSocket which connects late can replay.
// ---------------------------------------------------------------------------
/**
 * @type {Map<string, {
 *   id: string,                 // runs-Map key = randomUUID()
 *   pipelineId?: string,        // short id from src/core/artifacts.mjs#shortId, set after createPipeline
 *   orch: import('events').EventEmitter,
 *   projectDir: string,
 *   title: string,
 *   status: string,
 *   startedAt: string,
 *   events: any[],
 *   pendingQuestion: any
 * }>}
 */
const runs = new Map();

const EVENT_NAMES = ['phase', 'log', 'question', 'artifact', 'state', 'done', 'error'];
const MAX_BUFFER = 5000;

// ---------------------------------------------------------------------------
// WebSocket plumbing
// ---------------------------------------------------------------------------
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

/** All currently connected sockets. */
const sockets = new Set();

wss.on('connection', (ws, req) => {
  sockets.add(ws);
  // Optional ?runId=... -> replay that run's buffered events so a reconnecting
  // client immediately sees the full state.
  let requestedRunId = null;
  try {
    const u = new URL(req.url, 'http://localhost');
    requestedRunId = u.searchParams.get('runId');
  } catch {
    requestedRunId = null;
  }

  send(ws, { type: 'hello', runs: summarizeRuns() });

  if (requestedRunId && runs.has(requestedRunId)) {
    const entry = runs.get(requestedRunId);
    for (const ev of entry.events) send(ws, ev);
  }

  ws.on('close', () => sockets.delete(ws));
  ws.on('error', () => sockets.delete(ws));
  ws.on('message', (data) => {
    // Clients may ask to (re)subscribe / replay a run's history.
    let msg = null;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg && msg.type === 'subscribe' && msg.runId && runs.has(msg.runId)) {
      const entry = runs.get(msg.runId);
      for (const ev of entry.events) send(ws, ev);
    }
  });
});

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      /* ignore individual socket failures */
    }
  }
}

/** Broadcast an already-tagged event object to every open socket. */
function broadcast(obj) {
  const text = JSON.stringify(obj);
  for (const ws of sockets) {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(text);
      } catch {
        /* ignore */
      }
    }
  }
}

function summarizeRuns() {
  return [...runs.values()].map((r) => ({
    runId: r.id,
    pipelineId: r.pipelineId || null,
    projectDir: r.projectDir,
    title: r.title,
    status: r.status,
    startedAt: r.startedAt,
    pendingQuestion: r.pendingQuestion || null,
  }));
}

// ---------------------------------------------------------------------------
// Wire a core orchestrator's events onto the WebSocket, tagged with runId.
// ---------------------------------------------------------------------------
function subscribe(orch, name, handler) {
  // Support a Node EventEmitter (`.on`), an `.addListener` alias, or an
  // EventTarget-style (`.addEventListener`) "EventEmitter-like" object.
  if (typeof orch.on === 'function') {
    orch.on(name, handler);
  } else if (typeof orch.addListener === 'function') {
    orch.addListener(name, handler);
  } else if (typeof orch.addEventListener === 'function') {
    orch.addEventListener(name, (ev) => handler(ev && ev.detail !== undefined ? ev.detail : ev));
  }
}

function wireRun(entry) {
  const { id, orch } = entry;

  const record = (event) => {
    const tagged = { runId: id, ...event };
    entry.events.push(tagged);
    if (entry.events.length > MAX_BUFFER) entry.events.splice(0, entry.events.length - MAX_BUFFER);
    broadcast(tagged);
    return tagged;
  };

  for (const name of EVENT_NAMES) {
    subscribe(orch, name, (payload) => {
      const event = { type: name, ...(payload && typeof payload === 'object' ? payload : { value: payload }) };

      if (name === 'question') {
        entry.pendingQuestion = event;
      }
      if (name === 'done') {
        entry.status = (payload && payload.status) || 'done';
        entry.pendingQuestion = null;
      }
      if (name === 'error') {
        entry.status = 'error';
        entry.pendingQuestion = null;
      }
      if (name === 'phase') {
        entry.status = 'running';
      }
      if (name === 'state' && payload && typeof payload === 'object') {
        // Mirror status from the snapshot when present. (Pending questions are
        // cleared explicitly on answer/done/error, not from state snapshots.)
        if (payload.status) entry.status = payload.status;
        // Capture the on-disk pipeline short id the orchestrator stamps onto
        // state.id after createPipeline. Guard so null in pre-createPipeline
        // snapshots cannot overwrite a previously-captured value.
        if (typeof payload.id === 'string' && payload.id) entry.pipelineId = payload.id;
      }

      record(event);
    });
  }
}

// ---------------------------------------------------------------------------
// Express middleware + static
// ---------------------------------------------------------------------------
app.use(express.json({ limit: '8mb' }));
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

function badRequest(res, message) {
  res.status(400).json({ error: message });
}

// Single source of truth for path normalization lives in the core registry.
function resolveProjectDir(input) {
  return normalizeProjectPath(input);
}

// ---------------------------------------------------------------------------
// POST /api/run  -> start a new orchestration run
// body: { projectDir, prompt?, promptMarkdown?, title?, mock? }
// ---------------------------------------------------------------------------
app.post('/api/run', async (req, res) => {
  try {
    const body = req.body || {};
    const projectDir = resolveProjectDir(body.projectDir);
    if (!projectDir) return badRequest(res, 'projectDir is required');

    // prompt OR promptMarkdown. promptMarkdown is treated as the prompt text.
    const prompt = typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt : undefined;
    const promptMarkdown =
      typeof body.promptMarkdown === 'string' && body.promptMarkdown.trim() ? body.promptMarkdown : undefined;
    const effectivePrompt = prompt || promptMarkdown;
    if (!effectivePrompt) return badRequest(res, 'prompt or promptMarkdown is required');

    if (!fs.existsSync(projectDir)) {
      try {
        await fsp.mkdir(projectDir, { recursive: true });
      } catch (err) {
        return badRequest(res, `cannot create projectDir: ${err.message}`);
      }
    }

    const mock = !!body.mock || isTruthy(process.env.MAESTRO_MOCK ?? process.env.ORCH_MOCK);

    // Optional workflowId selects a saved (or built-in default) topology. The
    // orchestrator resolves topology + per-project run-config into an executable
    // plan at run start; here we only normalize + reject an unknown id up front
    // so the client gets a clean 400 instead of a mid-run error event.
    const workflowId =
      typeof body.workflowId === 'string' && body.workflowId.trim() ? body.workflowId.trim() : 'wf_default';
    if (!(await readWorkflow(workflowId))) return badRequest(res, `unknown workflowId "${workflowId}"`);

    const runId = randomUUID();
    const title = (typeof body.title === 'string' && body.title.trim()) || effectivePrompt.slice(0, 80);

    // Materialize any uploaded extra files to a temp dir; the orchestrator's
    // createPipeline copies them into <pipeline>/extras/.
    const extras = await writeExtras(runId, body.extras);

    const orch = createOrchestrator({
      projectDir,
      prompt: effectivePrompt,
      title,
      extras,
      agentsDir: AGENTS_DIR,
      workflowId,
      claude: { permissionMode: 'acceptEdits', mock },
    });

    const entry = {
      id: runId,
      orch,
      projectDir,
      title,
      status: 'starting',
      startedAt: new Date().toISOString(),
      events: [],
      pendingQuestion: null,
    };
    runs.set(runId, entry);
    wireRun(entry);

    // Fire-and-forget; all progress is surfaced through events.
    Promise.resolve()
      .then(() => orch.run())
      .catch((err) => {
        const event = { runId, type: 'error', message: err && err.message ? err.message : String(err) };
        entry.status = 'error';
        entry.events.push(event);
        broadcast(event);
      });

    res.json({ runId });
  } catch (err) {
    res.status(500).json({ error: err && err.message ? err.message : String(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/answer  -> resolve a pending question for a run
// body: { runId, id, payload }
// ---------------------------------------------------------------------------
app.post('/api/answer', (req, res) => {
  const { runId, id, payload } = req.body || {};
  if (!runId || !runs.has(runId)) return badRequest(res, 'unknown runId');
  if (!id) return badRequest(res, 'question id is required');
  const entry = runs.get(runId);
  try {
    entry.orch.answer(id, payload);
    if (entry.pendingQuestion && entry.pendingQuestion.id === id) entry.pendingQuestion = null;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err && err.message ? err.message : String(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/stop  -> abort a run
// body: { runId }
// ---------------------------------------------------------------------------
app.post('/api/stop', (req, res) => {
  const { runId } = req.body || {};
  if (!runId || !runs.has(runId)) return badRequest(res, 'unknown runId');
  const entry = runs.get(runId);
  try {
    entry.orch.stop();
    entry.status = 'stopped';
    entry.pendingQuestion = null;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err && err.message ? err.message : String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/runs?projectDir  -> history of saved pipelines
// ---------------------------------------------------------------------------
app.get('/api/runs', async (req, res) => {
  const projectDir = resolveProjectDir(req.query.projectDir);
  if (!projectDir) return badRequest(res, 'projectDir is required');
  try {
    const pipelines = (await Promise.resolve(listPipelines(projectDir))) || [];
    // Also expose any live (in-memory) runs for this project that may not yet
    // be on disk, so the UI history reflects an active run too.
    const live = [...runs.values()]
      .filter((r) => r.projectDir === projectDir)
      .map((r) => ({
        // Surface the on-disk pipeline id as `id` once createPipeline has run, so
        // renderHistory's dedup-by-id merges this entry with its disk twin. The
        // UUID stays on `runId` because WS / answer / stop route by runs-Map key.
        id: r.pipelineId || r.id,
        runId: r.id,
        title: r.title,
        status: r.status,
        live: true,
      }));
    res.json({ pipelines, live });
  } catch (err) {
    res.status(500).json({ error: err && err.message ? err.message : String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/runs/:id?projectDir  -> saved pipeline markdown + state
// ---------------------------------------------------------------------------
app.get('/api/runs/:id', async (req, res) => {
  const projectDir = resolveProjectDir(req.query.projectDir);
  if (!projectDir) return badRequest(res, 'projectDir is required');
  const id = req.params.id;
  try {
    const data = await Promise.resolve(readPipeline(projectDir, id));
    if (!data) return res.status(404).json({ error: 'pipeline not found' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err && err.message ? err.message : String(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/install  -> copy agents + skill into <projectDir>/.claude
// body: { projectDir }
// ---------------------------------------------------------------------------
app.post('/api/install', async (req, res) => {
  const projectDir = resolveProjectDir((req.body || {}).projectDir);
  if (!projectDir) return badRequest(res, 'projectDir is required');
  try {
    const result = await installAgents(projectDir);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err && err.message ? err.message : String(err) });
  }
});

// ---------------------------------------------------------------------------
// Project registry: GET list / POST add / DELETE remove. Thin delegation to
// src/core/projects.mjs (which owns validation + persistence).
// ---------------------------------------------------------------------------
app.get('/api/projects', async (_req, res) => {
  try {
    res.json({ projects: await listProjects() });
  } catch (err) {
    res.status(500).json({ error: err && err.message ? err.message : String(err) });
  }
});

app.post('/api/projects', async (req, res) => {
  const body = req.body || {};
  try {
    const projects = await addProject({ name: body.name, path: body.path });
    res.json({ projects });
  } catch (err) {
    // addProject only throws on validation (empty/duplicate/not-a-directory), so
    // a thrown error here is a client error -> 400. (A rare write-time I/O error
    // would also surface as 400; acceptable for this single-user local tool.)
    return badRequest(res, err && err.message ? err.message : String(err));
  }
});

app.delete('/api/projects', async (req, res) => {
  const name = typeof req.query.name === 'string' ? req.query.name : '';
  if (!name.trim()) return badRequest(res, 'name is required');
  try {
    res.json({ projects: await removeProject(name) });
  } catch (err) {
    res.status(500).json({ error: err && err.message ? err.message : String(err) });
  }
});

// ---------------------------------------------------------------------------
// Per-project model/effort config + custom-model registry. Validation lives in
// src/core/config.mjs; these routes are thin delegation (mirror /api/projects).
// ---------------------------------------------------------------------------
app.get('/api/config', async (req, res) => {
  const raw = req.query.projectDir;
  // No project selected yet (e.g. a fresh clone): still return the built-in
  // models so the picker is never empty. Custom models are per-project, so the
  // project-less response carries only the predefined Opus/Sonnet/Haiku set.
  if (raw == null || raw === '') {
    const models = PREDEFINED_MODELS.map((m) => ({ ...m, custom: false }));
    return res.json({ config: { steps: {}, customModels: [] }, models, steps: AGENT_STEPS, efforts: EFFORTS });
  }
  const projectDir = resolveProjectDir(raw);
  if (!projectDir) return badRequest(res, 'projectDir is required');
  try {
    // readRunConfig returns the full per-project config: legacy steps/customModels
    // PLUS the run-config workflows{} (node model/effort, feedback cycles) and
    // activeWorkflowId. It is a superset of readConfig, so the client keeps using
    // config.steps unchanged while gaining config.workflows / config.activeWorkflowId.
    const [config, models] = await Promise.all([readRunConfig(projectDir), listModels(projectDir)]);
    res.json({ config, models, steps: AGENT_STEPS, efforts: EFFORTS });
  } catch (err) {
    res.status(500).json({ error: err && err.message ? err.message : String(err) });
  }
});

app.post('/api/config', async (req, res) => {
  const body = req.body || {};
  const projectDir = resolveProjectDir(body.projectDir);
  if (!projectDir) return badRequest(res, 'projectDir is required');
  try {
    const config = await setStep(projectDir, body.step, { model: body.model, effort: body.effort });
    res.json({ config });
  } catch (err) {
    // setStep throws only on validation (unknown step/model/effort) -> client error.
    return badRequest(res, err && err.message ? err.message : String(err));
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/config -> write run-config: per-node model/effort, per-feedback
// cycle counts, and the active workflow id. Keyed by workflowId + node/feedback
// instance ids (see RunConfig in the design). Legacy per-role `steps` are
// written via POST /api/config and are left untouched here. NOTE: the run-config
// setters do NOT reject unknown models/efforts, and setFeedbackCycles COERCES
// maxCycles to >= 1 (it never throws) — so the try/catch below guards I/O, not
// validation. (Optional hardening: validate model/effort in setNodeModel via
// listModels + EFFORTS, mirroring setStep at config.mjs:141-153.)
// body: { projectDir, workflowId, nodes?:{[id]:{model,effort}}, feedbacks?:{[id]:{maxCycles}}, activeWorkflowId? }
// ---------------------------------------------------------------------------
app.patch('/api/config', async (req, res) => {
  const body = req.body || {};
  const projectDir = resolveProjectDir(body.projectDir);
  if (!projectDir) return badRequest(res, 'projectDir is required');
  const workflowId = typeof body.workflowId === 'string' ? body.workflowId.trim() : '';
  try {
    if (body.nodes && typeof body.nodes === 'object') {
      if (!workflowId) return badRequest(res, 'workflowId is required to set node config');
      for (const [nodeId, sel] of Object.entries(body.nodes)) {
        await setNodeModel(projectDir, workflowId, nodeId, {
          model: sel && sel.model, effort: sel && sel.effort,
        });
      }
    }
    if (body.feedbacks && typeof body.feedbacks === 'object') {
      if (!workflowId) return badRequest(res, 'workflowId is required to set feedback config');
      for (const [fbId, sel] of Object.entries(body.feedbacks)) {
        await setFeedbackCycles(projectDir, workflowId, fbId, sel && sel.maxCycles);
      }
    }
    if (typeof body.activeWorkflowId === 'string' && body.activeWorkflowId.trim()) {
      await setActiveWorkflow(projectDir, body.activeWorkflowId.trim());
    }
    const config = await readRunConfig(projectDir);
    res.json({ config });
  } catch (err) {
    // The config.mjs setters throw only on validation (unknown model/effort,
    // maxCycles < 1) -> client error, mirroring POST /api/config.
    return badRequest(res, err && err.message ? err.message : String(err));
  }
});

app.post('/api/config/models', async (req, res) => {
  const body = req.body || {};
  const projectDir = resolveProjectDir(body.projectDir);
  if (!projectDir) return badRequest(res, 'projectDir is required');
  try {
    await addCustomModel(projectDir, { id: body.id, label: body.label });
    res.json({ models: await listModels(projectDir) });
  } catch (err) {
    // addCustomModel throws only on validation (empty/duplicate/shadow) -> 400.
    return badRequest(res, err && err.message ? err.message : String(err));
  }
});

app.delete('/api/config/models', async (req, res) => {
  const projectDir = resolveProjectDir(req.query.projectDir);
  if (!projectDir) return badRequest(res, 'projectDir is required');
  const id = typeof req.query.id === 'string' ? req.query.id : '';
  if (!id.trim()) return badRequest(res, 'id is required');
  try {
    const config = await removeCustomModel(projectDir, id);
    res.json({ config, models: await listModels(projectDir) });
  } catch (err) {
    res.status(500).json({ error: err && err.message ? err.message : String(err) });
  }
});

// ---------------------------------------------------------------------------
// Workflow templates (global store at ~/.maestro/workflows). Topology only;
// model/effort/cycles live in per-project run-config. CRUD mirrors the
// /api/projects + /api/config delegation pattern: thin handlers, validation and
// atomic persistence owned by src/core/workflows.mjs + workflow-validator.mjs.
// ---------------------------------------------------------------------------
app.get('/api/workflows', async (_req, res) => {
  try {
    // The built-in default is never persisted to the user store; callers
    // prepend it (CONTRACT: GET -> { workflows: [DEFAULT_WORKFLOW, ...listWorkflows()] }).
    res.json({ workflows: [DEFAULT_WORKFLOW, ...(await listWorkflows())] }); // CONV-1: await
  } catch (err) {
    res.status(500).json({ error: err && err.message ? err.message : String(err) });
  }
});

app.get('/api/workflows/:id', async (req, res) => {
  try {
    const tpl = await readWorkflow(req.params.id); // CONV-1: await; returns DEFAULT_WORKFLOW for "wf_default"
    if (!tpl) return res.status(404).json({ error: 'workflow not found' });
    res.json(tpl);
  } catch (err) {
    res.status(500).json({ error: err && err.message ? err.message : String(err) });
  }
});

app.post('/api/workflows', async (req, res) => {
  const body = req.body || {};
  // Build the candidate template from the editor payload (topology only).
  const tpl = {
    name: typeof body.name === 'string' ? body.name.trim() : '',
    steps: Array.isArray(body.steps) ? body.steps : [],
    feedbacks: Array.isArray(body.feedbacks) ? body.feedbacks : [],
  };
  if (!tpl.name) return badRequest(res, 'name is required');
  try {
    const registry = loadAgentRegistry(AGENTS_DIR);
    const { ok, errors } = validateWorkflow(tpl, registry);
    if (!ok) return res.status(400).json({ error: 'invalid workflow', errors });
    // writeWorkflow stamps id/createdAt/updatedAt and writes atomically (temp+rename).
    const workflow = await writeWorkflow(tpl); // CONV-1: await
    res.status(201).json({ workflow });
  } catch (err) {
    res.status(500).json({ error: err && err.message ? err.message : String(err) });
  }
});

app.delete('/api/workflows/:id', async (req, res) => {
  const id = req.params.id;
  // The built-in default is not in the user store and must never be deleted.
  if (id === 'wf_default') return badRequest(res, 'the default workflow cannot be deleted');
  try {
    const removed = await deleteWorkflow(id); // CONV-1: await
    if (!removed) return res.status(404).json({ error: 'workflow not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err && err.message ? err.message : String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/agents -> the agent registry for the Composer palette. Scanned from
// agents/*.meta.json by src/core/agent-registry.mjs and returned as an array in
// palette render order (.order ascending). The client builds draggable pills
// (colored dot + displayName + icon) from this.
// ---------------------------------------------------------------------------
app.get('/api/agents', (_req, res) => {
  try {
    const registry = loadAgentRegistry(AGENTS_DIR); // { [key]: AgentMeta }, sorted by .order
    res.json({ agents: Object.values(registry) });
  } catch (err) {
    res.status(500).json({ error: err && err.message ? err.message : String(err) });
  }
});

// ---------------------------------------------------------------------------
// Install logic (mirrors scripts/install.mjs): copy agents/*.md and
// skills/maestro/** into <projectDir>/.claude/...
// ---------------------------------------------------------------------------
async function installAgents(projectDir) {
  const claudeDir = path.join(projectDir, '.claude');
  const agentsTarget = path.join(claudeDir, 'agents');
  const skillTarget = path.join(claudeDir, 'skills', 'maestro');
  await fsp.mkdir(agentsTarget, { recursive: true });
  await fsp.mkdir(skillTarget, { recursive: true });

  const copied = [];

  // Copy agents/*.md
  if (fs.existsSync(AGENTS_DIR)) {
    const entries = await fsp.readdir(AGENTS_DIR);
    for (const name of entries) {
      if (!name.endsWith('.md')) continue;
      const from = path.join(AGENTS_DIR, name);
      const to = path.join(agentsTarget, name);
      await fsp.copyFile(from, to);
      copied.push(path.relative(projectDir, to));
    }
  }

  // Copy skills/maestro/** recursively
  const skillSrc = path.join(SKILLS_DIR, 'maestro');
  if (fs.existsSync(skillSrc)) {
    await copyDir(skillSrc, skillTarget, projectDir, copied);
    // Personalize the copied SKILL.md so /maestro targets this repo's path.
    await rewriteSkillRepoPath(skillTarget, PROJECT_ROOT);
  }

  return {
    ok: true,
    target: claudeDir,
    copied,
    hint: 'Open Claude Code in this folder and run: /maestro <prompt>',
  };
}

/**
 * Rewrite the `<MAESTRO_REPO>` placeholder in an installed SKILL.md to this repo's
 * absolute path. Best-effort; never throws.
 */
async function rewriteSkillRepoPath(skillTarget, repoRoot) {
  const skillMd = path.join(skillTarget, 'SKILL.md');
  try {
    const original = await fsp.readFile(skillMd, 'utf8');
    const rewritten = original.split('<MAESTRO_REPO>').join(repoRoot);
    if (rewritten !== original) await fsp.writeFile(skillMd, rewritten, 'utf8');
  } catch {
    /* no SKILL.md or unreadable — skip */
  }
}

async function copyDir(srcDir, destDir, baseForRel, copiedOut) {
  await fsp.mkdir(destDir, { recursive: true });
  const entries = await fsp.readdir(srcDir, { withFileTypes: true });
  for (const ent of entries) {
    const from = path.join(srcDir, ent.name);
    const to = path.join(destDir, ent.name);
    if (ent.isDirectory()) {
      await copyDir(from, to, baseForRel, copiedOut);
    } else if (ent.isFile()) {
      await fsp.copyFile(from, to);
      copiedOut.push(path.relative(baseForRel, to));
    }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
/**
 * Decode uploaded extra files ([{ name, dataBase64 }]) to a per-run temp dir and
 * return absolute paths. Filenames are reduced to their basename to prevent
 * path traversal. Returns [] when nothing usable was provided.
 * @param {string} runId
 * @param {Array<{name?:string, dataBase64?:string}>} list
 * @returns {Promise<string[]>}
 */
async function writeExtras(runId, list) {
  if (!Array.isArray(list) || list.length === 0) return [];
  const dir = path.join(os.tmpdir(), `orchestrator-extras-${runId}`);
  await fsp.mkdir(dir, { recursive: true });
  const out = [];
  let i = 0;
  for (const item of list) {
    i += 1;
    if (!item || typeof item !== 'object') continue;
    const data = typeof item.dataBase64 === 'string' ? item.dataBase64 : '';
    if (!data) continue;
    // Sanitize to a bare filename; fall back to a generated name.
    let name = path.basename(String(item.name || '').trim());
    if (!name || name === '.' || name === '..') name = `extra-${i}`;
    const dest = path.join(dir, name);
    try {
      await fsp.writeFile(dest, Buffer.from(data, 'base64'));
      out.push(dest);
    } catch {
      /* skip a file we cannot decode/write */
    }
  }
  return out;
}

function isTruthy(v) {
  if (v === undefined || v === null) return false;
  const s = String(v).toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

// SPA fallback: any unmatched GET that is not an /api or /ws path serves
// index.html. Implemented as middleware (not a route pattern) so it does not
// depend on path-to-regexp wildcard syntax, which differs between Express 4
// and Express 5.
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  if (req.path.startsWith('/api/') || req.path.startsWith('/ws')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'), (err) => {
    if (err) next();
  });
});

// Only bind a port when run directly (`node ui/server.mjs`). When imported by a
// test, skip listening so the test can mount `app` on its own ephemeral port.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  server.on('error', (err) => {
    console.error(`[maestro-ui] server error: ${err && err.message ? err.message : err}`);
  });

  server.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    console.log(`[maestro-ui] listening on ${url}`);
    console.log(`[maestro-ui] WebSocket on ws://localhost:${PORT}/ws`);
  });
}

export { app, server, runs };
export const _testing = { wireRun };
