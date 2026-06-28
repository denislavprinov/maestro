// src/core/builtin-workflows.mjs
// Built-in workflow topologies seeded into the `workflows` DB table on migration.
// Pure data, ZERO imports (db.mjs imports this; a cycle would otherwise form).

/** AI-Enablement Onboarding pipeline (design 2026-06-28). Topology only; per-node
 *  model/effort/cycles come from run-config at resolve time. The evaluator→infra
 *  feedback edge re-runs infra→tests→evaluate in fix-mode on a blocking verdict. */
export const ONBOARDING_WORKFLOW = Object.freeze({
  id: 'wf_onboarding',
  name: 'AI-Enablement Onboarding',
  version: 1,
  domain: 'coding',
  steps: [
    [{ id: 's_clarify', key: 'onboardingClarifier' }],
    [{ id: 's_analyze', key: 'onboardingAnalyzer' }],
    [{ id: 's_infra',   key: 'projectOnboarding' }],   // PR #50 agent = infra-gen
    [{ id: 's_tests',   key: 'onboardingTests' }],
    [{ id: 's_eval',    key: 'onboardingEvaluator' }],
    [{ id: 's_canary',  key: 'onboardingCanary' }],
  ],
  feedbacks: [
    { id: 'fb_onboard_eval', from: 's_eval', to: 's_infra' }, // step4 → step2 (back-edge)
  ],
  createdAt: '1970-01-01T00:00:00.000Z',
  updatedAt: '1970-01-01T00:00:00.000Z',
});

export const BUILTIN_SEED_WORKFLOWS = [ONBOARDING_WORKFLOW];
