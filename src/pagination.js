'use strict';
// Cursor pagination over the stable sort key (created_at, id). Never LIMIT/OFFSET.
// Default page 50, max 200; a larger limit is a 422, not a silent clamp.

const { ApiProblem } = require('./problems');

function parseLimit(q) {
  if (q.limit === undefined) return 50;
  const n = Number(q.limit);
  if (!Number.isInteger(n) || n < 1) throw new ApiProblem('validation-error', 'limit must be a positive integer.');
  if (n > 200) throw new ApiProblem('validation-error', 'limit must be at most 200.');
  return n;
}

function encodeCursor(row) {
  // cursor_ts is selected as microsecond-precise text (+00). Date#toISOString
  // truncates to milliseconds, which makes the boundary row repeat on the next
  // page — found under test, do not "simplify" this back.
  return Buffer.from(JSON.stringify({ c: row.cursor_ts, i: row.id })).toString('base64url');
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const { c, i } = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!c || !i) throw new Error('bad');
    return { createdAt: c, id: i };
  } catch (_) {
    throw new ApiProblem('validation-error', 'cursor is not a valid pagination cursor.');
  }
}

/**
 * Fetch limit+1 rows using: WHERE ... AND (created_at, id) > ($cursorTime, $cursorId)
 * Returns { data, has_more, next_cursor } and strips the sentinel row.
 */
function packPage(rows, limit) {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? encodeCursor(data[data.length - 1]) : null;
  for (const r of data) delete r.cursor_ts; // internal, never serialized
  return { data, has_more: hasMore, next_cursor: nextCursor };
}

module.exports = { parseLimit, decodeCursor, packPage };
