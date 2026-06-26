// ui/public/results-view.mjs
// Pure shaping helpers for the run Results view. ESM so both the browser (app.js)
// and node:test can import them. No DOM here — keep it unit-testable.

/** Human-readable summary chips from a Layer-1 results object. */
export function summaryChips(results) {
  const s = (results && results.summary) || {};
  const chips = [];
  if (s.filesNew) chips.push(`${s.filesNew} new`);
  if (s.filesChanged) chips.push(`${s.filesChanged} changed`);
  if (s.filesDeleted) chips.push(`${s.filesDeleted} deleted`);
  chips.push(`+${s.linesAdded || 0} / −${s.linesRemoved || 0}`);
  chips.push(s.blockingIssues ? `${s.blockingIssues} to check` : 'Clean');
  return chips;
}

/**
 * Merge Layer-1 review checks with Layer-2 agent diffFindings. Review checks come
 * first and are never dropped; agent findings are tagged origin:'agent' (+ isNew).
 */
export function mergeFindings(checks, diffFindings) {
  const reviewSide = (checks || []).map((c) => ({ ...c, origin: c.origin || 'review' }));
  const agentSide = (diffFindings || []).map((f) => ({
    severity: f.severity, title: f.title, detail: f.detail,
    location: f.file ? `${f.file}${f.line != null ? ':' + f.line : ''}` : '',
    origin: 'agent', isNew: f.newVsReview === true,
  }));
  return [...reviewSide, ...agentSide];
}
