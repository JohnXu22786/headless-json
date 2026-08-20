/**
 * Exit-code semantics: outcome category mapping and overrides.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_OPTIONS, normalizeOptions } from '../lib/options.js';
import { resolveOutcome, statusForKind } from '../lib/exit-code.js';

function codes(overrides = {}) {
  return { ...DEFAULT_OPTIONS.exit, ...overrides };
}

function input(kind, extra = {}) {
  return {
    lastReasonKind: kind,
    hasEvents: true,
    incomplete: false,
    undelivered: [],
    error: null,
    exitCodes: codes(),
    ...extra,
  };
}

test('statusForKind maps every documented reason kind', () => {
  assert.equal(statusForKind('completed'), 'success');
  assert.equal(statusForKind('error'), 'error');
  assert.equal(statusForKind('max-tokens'), 'timeout');
  assert.equal(statusForKind('blocked'), 'blocked');
  assert.equal(statusForKind('aborted'), 'aborted');
  assert.equal(statusForKind('interrupted'), 'interrupted');
  assert.equal(statusForKind('something-new'), 'unknown');
});

test('reason kinds produce the documented default exit codes', () => {
  assert.equal(resolveOutcome(input('completed')).exitCode, 0);
  assert.equal(resolveOutcome(input('error')).exitCode, 1);
  assert.equal(resolveOutcome(input('max-tokens')).exitCode, 2);
  assert.equal(resolveOutcome(input('blocked')).exitCode, 3);
  assert.equal(resolveOutcome(input('aborted')).exitCode, 130);
  assert.equal(resolveOutcome(input('interrupted')).exitCode, 130);
  assert.equal(resolveOutcome(input('unknown-reason')).exitCode, 1);
});

test('an empty session maps to the empty category', () => {
  const result = resolveOutcome(input(null, { hasEvents: false }));
  assert.equal(result.status, 'empty');
  assert.equal(result.exitCode, 4);
  assert.equal(result.reason, 'none');
  assert.equal(result.complete, false);
});

test('an incomplete run (events but no turn/end) is an error', () => {
  const result = resolveOutcome(input(null, { hasEvents: true, incomplete: true }));
  assert.equal(result.status, 'error');
  assert.equal(result.reason, 'incomplete');
  assert.equal(result.complete, false);
});

test('an error reason carries its structured facts', () => {
  const result = resolveOutcome(input('error', { error: { code: 'X', message: 'boom', status: 500 } }));
  assert.deepEqual(result.error, { code: 'X', message: 'boom', status: 500 });
});

test('undelivered calls ride through the outcome', () => {
  const result = resolveOutcome(input('completed', { undelivered: ['a', 'b'] }));
  assert.deepEqual(result.undelivered, ['a', 'b']);
});

test('exit codes are overridable per category', () => {
  const result = resolveOutcome(input('max-tokens', { exitCodes: codes({ timeout: 42 }) }));
  assert.equal(result.exitCode, 42);
});

test('exit codes cannot be set below zero (validated at options level)', () => {
  assert.throws(() => {
    normalizeOptions({ exit: { success: -1 } });
  });
});