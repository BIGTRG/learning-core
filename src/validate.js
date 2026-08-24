'use strict';
// Tiny schema validator — the same schema objects feed the OpenAPI generator,
// so spec and validation cannot drift.

const { ApiProblem } = require('./problems');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(path, msg) {
  throw new ApiProblem('validation-error', `${path}: ${msg}`);
}

function check(value, schema, path = 'body') {
  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'must be an object');
    for (const k of schema.required || []) {
      if (value[k] === undefined) fail(`${path}.${k}`, 'is required');
    }
    for (const [k, v] of Object.entries(value)) {
      const prop = (schema.properties || {})[k];
      if (!prop) {
        if (schema.additionalProperties === false) fail(`${path}.${k}`, 'is not a recognised field');
        continue;
      }
      check(v, prop, `${path}.${k}`);
    }
    return value;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) fail(path, 'must be an array');
    if (schema.minItems && value.length < schema.minItems) fail(path, `must have at least ${schema.minItems} items`);
    if (schema.maxItems && value.length > schema.maxItems) fail(path, `must have at most ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => check(v, schema.items, `${path}[${i}]`));
    return value;
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') fail(path, 'must be a string');
    if (schema.minLength && value.length < schema.minLength) fail(path, `must be at least ${schema.minLength} characters`);
    if (schema.maxLength && value.length > schema.maxLength) fail(path, `must be at most ${schema.maxLength} characters`);
    if (schema.format === 'uuid' && !UUID_RE.test(value)) fail(path, 'must be a UUID');
    if (schema.enum && !schema.enum.includes(value)) fail(path, `must be one of: ${schema.enum.join(', ')}`);
    return value;
  }
  if (schema.type === 'integer') {
    if (!Number.isInteger(value)) fail(path, 'must be an integer');
    if (schema.minimum !== undefined && value < schema.minimum) fail(path, `must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) fail(path, `must be <= ${schema.maximum}`);
    return value;
  }
  if (schema.type === 'number') {
    if (typeof value !== 'number' || Number.isNaN(value)) fail(path, 'must be a number');
    if (schema.minimum !== undefined && value < schema.minimum) fail(path, `must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) fail(path, `must be <= ${schema.maximum}`);
    return value;
  }
  if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') fail(path, 'must be a boolean');
    return value;
  }
  return value; // untyped: accepted as-is (jsonb blocks)
}

module.exports = { check, UUID_RE };
