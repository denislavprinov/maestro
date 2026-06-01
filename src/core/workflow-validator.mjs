// src/core/workflow-validator.mjs
// Pure, dependency-free validator for a WorkflowTemplate against an agent
// registry. Collects ALL violations (does not short-circuit) so the UI/API can
// show every problem at once. Returns { ok, errors:string[] }.
//
// Rules (CONTRACT §workflow-validator):
//   1. template is a non-null object with a non-empty steps array;
//   2. no empty steps (every step has >= 1 node);
//   3. every node has a non-blank string id, and ids are unique workflow-wide;
//   4. every node.key exists in the registry;
//   5. feedback from/to reference existing node ids;
//   6. a feedback's target step index < its source step index
//      (a same-node self-loop, from===to, is allowed; the forward graph is
//       otherwise acyclic so only back-edges are legal feedbacks);
//   7. feedback ids are unique.

/**
 * @param {object} tpl  WorkflowTemplate { steps:[[{id,key}]], feedbacks:[{id,from,to}] }
 * @param {Record<string,{key:string}>} registry  loadAgentRegistry() output
 * @returns {{ok:boolean, errors:string[]}}
 */
export function validateWorkflow(tpl, registry) {
  const errors = [];
  const reg = registry && typeof registry === 'object' ? registry : {};

  if (!tpl || typeof tpl !== 'object' || !Array.isArray(tpl.steps)) {
    return { ok: false, errors: ['workflow must be an object with a steps array'] };
  }
  if (tpl.steps.length === 0) {
    errors.push('workflow must have at least one step');
  }

  // Pass 1: nodes — shape, unique ids, known keys. Build id -> stepIndex map.
  const stepOfNode = new Map(); // nodeId -> step index
  const seenIds = new Set();
  for (let i = 0; i < tpl.steps.length; i++) {
    const group = tpl.steps[i];
    if (!Array.isArray(group) || group.length === 0) {
      errors.push(`step ${i} is empty (a step must contain at least one node)`);
      continue;
    }
    for (const node of group) {
      if (!node || typeof node !== 'object') {
        errors.push(`step ${i} contains a non-object node`);
        continue;
      }
      const id = typeof node.id === 'string' ? node.id.trim() : '';
      if (!id) {
        errors.push(`step ${i} has a node with a missing or blank id`);
        continue;
      }
      if (seenIds.has(id)) {
        errors.push(`duplicate node id "${id}"`);
      } else {
        seenIds.add(id);
        stepOfNode.set(id, i);
      }
      const key = typeof node.key === 'string' ? node.key.trim() : '';
      if (!key) {
        errors.push(`node "${id}" has a missing or blank key`);
      } else if (!Object.prototype.hasOwnProperty.call(reg, key)) {
        errors.push(`node "${id}" has key "${key}" which is not in the agent registry`);
      }
    }
  }

  // Pass 2: feedbacks — unique ids, endpoints exist, target precedes source.
  const feedbacks = Array.isArray(tpl.feedbacks) ? tpl.feedbacks : [];
  const seenFb = new Set();
  for (const fb of feedbacks) {
    if (!fb || typeof fb !== 'object') {
      errors.push('feedbacks contains a non-object entry');
      continue;
    }
    const fid = typeof fb.id === 'string' ? fb.id.trim() : '';
    if (!fid) {
      errors.push('a feedback has a missing or blank id');
    } else if (seenFb.has(fid)) {
      errors.push(`duplicate feedback id "${fid}"`);
    } else {
      seenFb.add(fid);
    }
    const from = typeof fb.from === 'string' ? fb.from.trim() : '';
    const to = typeof fb.to === 'string' ? fb.to.trim() : '';
    const hasFrom = stepOfNode.has(from);
    const hasTo = stepOfNode.has(to);
    if (!hasFrom) errors.push(`feedback "${fid || '?'}" from "${from}" does not exist`);
    if (!hasTo) errors.push(`feedback "${fid || '?'}" to "${to}" does not exist`);
    if (hasFrom && hasTo) {
      const sFrom = stepOfNode.get(from);
      const sTo = stepOfNode.get(to);
      // A same-node self-loop (from === to) is legal (the refine loop). Otherwise
      // the target step must strictly precede the source step (a back-edge).
      if (from !== to && sTo >= sFrom) {
        errors.push(
          `feedback "${fid || '?'}" target step (${sTo}) must precede its source step (${sFrom})`,
        );
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
