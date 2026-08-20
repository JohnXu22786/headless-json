/**
 * Privacy redaction: truncation, secret masking, argument summarization and
 * path relativization.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_OPTIONS } from '../lib/options.js';
import { truncateText, maskSecrets, redactText, summarizeArgsText, sanitizeArgsTree, relativizePath } from '../lib/redact.js';

function redactOptions(overrides = {}) {
  return { ...JSON.parse(JSON.stringify(DEFAULT_OPTIONS.redact)), ...overrides };
}

test('truncateText short text is untouched', () => {
  assert.equal(truncateText('hello', 100), 'hello');
  assert.equal(truncateText('hello', 0), 'hello');
});

test('truncateText marks the removal deterministically', () => {
  const result = truncateText('a'.repeat(50), 10);
  assert.equal(result.slice(0, 10), 'a'.repeat(10));
  assert.ok(result.includes('[+40 more chars]'));
  assert.equal(truncateText('a'.repeat(50), 10), result); // stable
});

test('maskSecrets masks credential-shaped strings', () => {
  const options = redactOptions();
  assert.notEqual(maskSecrets('key is sk-abcdefghijklmnop123456789', options).includes('sk-abcdefghijklmnop'), true);
  assert.ok(maskSecrets('key is sk-abcdefghijklmnop123456789', options).includes('[REDACTED]'));
  assert.ok(maskSecrets('Bearer eyJhbGciOiJIUzI1NiJ9.x.y', options).includes('[REDACTED]'));
  assert.ok(maskSecrets('-----BEGIN PRIVATE KEY-----x-----END PRIVATE KEY-----', options).length < 30);
});

test('long hex values keep a short debuggable prefix', () => {
  const options = redactOptions();
  const masked = maskSecrets(`commit ${'a'.repeat(40)}`, options);
  assert.ok(!masked.includes('a'.repeat(32)), 'full long hex must not survive');
  assert.ok(masked.includes('aaaaaaaa'), 'prefix should be preserved');
});

test('maskSecrets can be disabled', () => {
  const options = redactOptions({ secrets: false });
  assert.equal(maskSecrets('sk-abcdefghijklmnop123456789', options), 'sk-abcdefghijklmnop123456789');
});

test('custom secret patterns are applied', () => {
  const options = redactOptions({ secret_patterns: ['\\bSECRET_[A-Z0-9_]+'] });
  const masked = maskSecrets('token SECRET_XYZ_123', options);
  assert.ok(masked.includes('[REDACTED]'));
  assert.ok(!masked.includes('SECRET_XYZ_123'));
});

test('custom invalid patterns throw', () => {
  const options = redactOptions({ secret_patterns: ['['] });
  assert.throws(() => maskSecrets('x', options));
});

test('a secret at the truncation boundary does not leak its head', () => {
  const options = redactOptions({ text_length: 12 });
  const text = 'begin sk-abcdefghijklmnop123456789 end';
  const result = redactText(text, options);
  assert.ok(!result.includes('sk-ab'), 'the secret must be masked before truncation');
  assert.ok(result.includes('[+'), 'the truncation marker survives');
});

test('redactText truncates then masks', () => {
  const options = redactOptions({ text_length: 20 });
  const text = `sk-abcdefghijklmnop123456789 and then ${'z'.repeat(40)}`;
  const result = redactText(text, options);
  assert.ok(!result.includes('sk-abcdefghijklmnop'));
  assert.ok(result.includes('[+'), 'truncation marker survives masking');
  assert.ok(result.startsWith('[REDACTED]'), 'the secret is masked before truncation');
});

test('summarizeArgsText caps argument text', () => {
  const options = redactOptions({ arg_length: 8 });
  const summary = summarizeArgsText('{"command":"this is long"}', options);
  assert.ok(summary.length < 30);
});

test('summarizeArgsText masks before truncation so secrets cannot straddle the boundary', () => {
  const options = redactOptions({ arg_length: 20 });
  const summary = summarizeArgsText('{"password":"sk-abcdefghijklmnop123456789","x":' + '"y".repeat(500) + "}', options);
  assert.ok(!summary.includes('sk-ab'));
  assert.ok(summary.includes('[+'), 'truncation marker survives');
});

test('sanitizeArgsTree masks and truncates nested strings and keys', () => {
  const options = redactOptions({ text_length: 10 });
  const tree = {
    command: 'ls',
    secret: 'sk-abcdefghijklmnop123456789',
    ['sk-abcdefghijklmnop123456789']: 'leaky key',
    nested: { deep: 'y'.repeat(100) },
  };
  const sanitized = sanitizeArgsTree(tree, options);
  assert.equal(sanitized.command, 'ls');
  assert.ok(!sanitized.secret.includes('sk-abcdefghijklmnop'));
  assert.ok(sanitized.nested.deep.includes('[+'), 'long strings carry the truncation marker');
  const keys = Object.keys(sanitized);
  assert.ok(!keys.some((key) => key.includes('sk-abcdefghijklmnop')), 'secret-shaped keys must be masked');
  assert.ok(JSON.stringify(sanitized).length < JSON.stringify(tree).length);
});

test('relativizePath produces relative or absolute output', () => {
  const cwd = '/home/ci/project';
  assert.equal(relativizePath('/home/ci/project/src/x.ts', cwd, 'relative'), 'src/x.ts');
  assert.equal(relativizePath('/home/ci/project', cwd, 'relative'), '.');
  assert.equal(relativizePath('/home/ci/project/src/x.ts', cwd, 'absolute'), '/home/ci/project/src/x.ts');
  assert.equal(relativizePath('/other/place/y.ts', cwd, 'relative'), '/other/place/y.ts');
});

test('relativizePath normalizes windows separators', () => {
  const cwd = 'C:\\Users\\ci\\repo';
  assert.equal(relativizePath('C:\\Users\\ci\\repo\\src\\a.ts', cwd, 'relative'), 'src/a.ts');
  assert.equal(relativizePath('C:\\Users\\ci\\repo\\src\\a.ts', cwd, 'absolute'), 'C:/Users/ci/repo/src/a.ts');
});