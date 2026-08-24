'use strict';
// Server-side scoring with partial credit. The client never asserts a score.
//  single      : all-or-nothing.
//  multi       : partial credit, max(0, (correct selected - wrong selected) / n_correct) * points.
//  constructed : stored verbatim; needs human grading via the grade endpoint.

function scoreItem(item, response) {
  const key = item.answer_key || [];
  if (item.kind === 'single') {
    const picked = Array.isArray(response) ? response[0] : response;
    return { awarded: key.length && picked === key[0] ? Number(item.points) : 0, gradable: true };
  }
  if (item.kind === 'multi') {
    const picked = new Set(Array.isArray(response) ? response : [response]);
    const keySet = new Set(key);
    let correct = 0, wrong = 0;
    for (const p of picked) (keySet.has(p) ? correct++ : wrong++);
    const frac = keySet.size ? Math.max(0, (correct - wrong) / keySet.size) : 0;
    return { awarded: frac * Number(item.points), gradable: true };
  }
  return { awarded: null, gradable: false }; // constructed
}

/**
 * items: all assessment items; answers: Map(item_id -> response or graded points).
 * Returns { scorePercent, passed, needsGrading, perItem: Map(item_id -> awarded|null) }.
 */
function scoreAttempt(items, answers, passPercent, manualPoints = new Map()) {
  let earned = 0, possible = 0, needsGrading = false;
  const perItem = new Map();
  for (const item of items) {
    possible += Number(item.points);
    const response = answers.get(item.id);
    if (response === undefined) { perItem.set(item.id, 0); continue; }
    const { awarded, gradable } = scoreItem(item, response);
    if (!gradable) {
      if (manualPoints.has(item.id)) {
        const pts = Math.min(Number(manualPoints.get(item.id)), Number(item.points));
        earned += pts; perItem.set(item.id, pts);
      } else {
        needsGrading = true; perItem.set(item.id, null);
      }
    } else {
      earned += awarded; perItem.set(item.id, awarded);
    }
  }
  const scorePercent = possible > 0 ? Math.round((earned / possible) * 10000) / 100 : 0;
  return {
    scorePercent,
    passed: needsGrading ? null : scorePercent >= Number(passPercent),
    needsGrading,
    perItem,
  };
}

module.exports = { scoreItem, scoreAttempt };
