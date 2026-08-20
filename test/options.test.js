/**
 * Options normalization, patching and parsing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_OPTIONS, normalizeOptions, applyPatch, applyDottedPath, parseScalar, ConfigError } from '../lib/options.js';

function freshDefaults() {
  return JSON.parse(JSON.stringify(DEFAULT_OPTIONS));
}

test('normalizeOptions({}) equals the defaults', () => {
  const options = normalizeOptions({});
  assert.deepEqual(options, freshDefaults());
});

test('partial sections merge over the defaults', () => {
  const options = normalizeOptions({ redact: { text_length: 10 }, output: { ndjson: true } });
  assert.equal(options.redact.text_length, 10);
  assert.equal(options.output.ndjson, true);
  assert.equal(options.output.json, DEFAULT_OPTIONS.output.json);
  assert.equal(options.events.max_events, DEFAULT_OPTIONS.events.max_events);
});

test('unknown top-level sections and keys are tolerated in configuration', () => {
  const options = normalizeOptions({ frobnicate: true, redact: { future_key: 1 } });
  assert.deepEqual(options.redact, freshDefaults().redact);
});

test('invalid enums throw ConfigError', () => {
  assert.throws(() => normalizeOptions({ redact: { args: 'bogus' } }), ConfigError);
  assert.throws(() => normalizeOptions({ redact: { paths: 'sideways' } }), ConfigError);
  assert.throws(() => normalizeOptions({ events: { trim: 'middle' } }), ConfigError);
});

test('invalid numbers/booleans throw ConfigError', () => {
  assert.throws(() => normalizeOptions({ redact: { text_length: -1 } }), ConfigError);
  assert.throws(() => normalizeOptions({ redact: { text_length: 1.5 } }), ConfigError);
  assert.throws(() => normalizeOptions({ output: { json: 'yes' } }), ConfigError);
  assert.throws(() => normalizeOptions({ exit: { timeout: -2 } }), ConfigError);
});

test('invalid regex patterns are rejected at normalization time', () => {
  assert.throws(() => normalizeOptions({ redact: { secret_patterns: ['['] } }), ConfigError);
  assert.throws(() => normalizeOptions({ artifacts: { pattern_extras: ['('] } }), ConfigError);
  // Valid patterns are fine.
  const options = normalizeOptions({ redact: { secret_patterns: ['\\bTOKEN_[A-Z]+'] } });
  assert.deepEqual(options.redact.secret_patterns, ['\\bTOKEN_[A-Z]+']);
});

test('applyPatch validates unknown sections', () => {
  const current = normalizeOptions({});
  assert.throws(() => applyPatch(current, { bogus: {} }), ConfigError);
});

test('applyPatch merges a partial patch', () => {
  const current = normalizeOptions({ redact: { text_length: 10 } });
  const next = applyPatch(current, { redact: { args: 'hide' } });
  assert.equal(next.redact.args, 'hide');
  assert.equal(next.redact.text_length, 10);

  // The original object must not be mutated.
  assert.equal(current.redact.args, DEFAULT_OPTIONS.redact.args);
});

test('applyDottedPath sets nested values', () => {
  const current = normalizeOptions({});
  const next = applyDottedPath(current, 'redact.text_length', 88);
  assert.equal(next.redact.text_length, 88);
  assert.equal(next.redact.args, DEFAULT_OPTIONS.redact.args);
});

test('applyDottedPath rejects bad paths', () => {
  const current = normalizeOptions({});
  assert.throws(() => applyDottedPath(current, 'redact', 88), ConfigError);
  assert.throws(() => applyDottedPath(current, 'nope.text_length', 1), ConfigError);
  assert.throws(() => applyDottedPath(current, 'redact.text_length', 'x'), ConfigError);
  // Unknown nested keys are rejected in patch paths (--set / set_options).
  assert.throws(() => applyDottedPath(current, 'redact.bogus', 1), ConfigError);
  assert.throws(() => applyPatch(current, { output: { bogus: true } }), ConfigError);
});

test('patch paths are strict but configuration files are lenient', () => {
  // Configuration: unknown nested keys tolerated.
  const loose = normalizeOptions({ redact: { future_key: 1 } });
  assert.equal(loose.redact.text_length, DEFAULT_OPTIONS.redact.text_length);
  // Patch: unknown nested keys rejected.
  const current = normalizeOptions({});
  assert.throws(() => applyPatch(current, { redact: { future_key: 1 } }), ConfigError);
});

test('parseScalar types values', () => {
  assert.equal(parseScalar('true'), true);
  assert.equal(parseScalar('false'), false);
  assert.equal(parseScalar('12'), 12);
  assert.equal(parseScalar('0'), 0);
  assert.equal(parseScalar('1.5'), '1.5');
  assert.equal(parseScalar('hello'), 'hello');
  assert.equal(parseScalar('12x'), '12x');
});