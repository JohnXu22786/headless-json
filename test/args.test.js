/**
 * CLI argument-parser unit tests: --key value, --key=value, --no-key, repeatable
 * --set, short flags, and the positional/-- separator handling.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs, flagList } from '../lib/cli/args.js';

test('args: --key value and --key=value parse identically', () => {
  const a = parseArgs(['render', 'x.json', '--format', 'junit']).flags;
  const b = parseArgs(['render', 'x.json', '--format=junit']).flags;
  assert.equal(a['format'], 'junit');
  assert.equal(b['format'], 'junit');
});

test('args: --no-key sets the flag to false', () => {
  const flags = parseArgs(['render', 'x.json', '--no-secrets']).flags;
  assert.equal(flags['secrets'], false);
});

test('args: short -h and -v map to help/version', () => {
  assert.equal(parseArgs(['-h']).flags['help'], true);
  assert.equal(parseArgs(['-v']).flags['version'], true);
});

test('args: repeatable --set accumulates into a list', () => {
  const flags = parseArgs(['render', 'x', '--set', 'a=1', '--set', 'b=2']).flags;
  assert.deepEqual(flagList(flags, 'set'), ['a=1', 'b=2']);
});

test('args: -- separates flags from positional input', () => {
  const parsed = parseArgs(['render', '--', '--weird-name.json']);
  assert.deepEqual(parsed.positional, ['render', '--weird-name.json']);
});

test('args: a value flag missing its value throws', () => {
  assert.throws(() => parseArgs(['render', '--format']), /missing value/);
});
