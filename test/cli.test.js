/**
 * CLI end-to-end tests (spawns the real binary).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { DEFAULT_OPTIONS } from '../lib/options.js';
import { Capture, metaFromHeader } from '../lib/capture.js';
import { buildReport, renderReportJson } from '../lib/report.js';
import { renderJunit } from '../lib/junit.js';
import { CaptureManager } from '../lib/manager.js';

const execFileP = promisify(execFile);
const BIN = fileURLToPath(new URL('../bin/dsh-headless-json.js', import.meta.url));

async function run(workdir, args) {
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [BIN, ...args], { cwd: workdir });
    return { code: 0, stdout, stderr };
  } catch (caught) {
    return {
      code: typeof caught.code === 'number' ? caught.code : 1,
      stdout: caught.stdout ?? '',
      stderr: caught.stderr ?? '',
    };
  }
}

function buildFixture(options, sessionId = 'session-cli-1') {
  const ref = { current: options };
  const meta = metaFromHeader({ id: sessionId, cwd: process.cwd(), createdAt: 1000 });
  const capture = new Capture(meta, ref);
  const events = [
    { type: 'turn/start', seq: 0, time: 1000, data: { turn: 0 } },
    { type: 'user/message', seq: 1, time: 1010, data: { content: [{ type: 'text', text: 'fix src/a.ts' }] } },
    { type: 'assistant/message', seq: 2, time: 1040, data: { turn: 0, step: 0, message: { content: [{ type: 'text', text: 'done' }], source: { kind: 'model', provider: 'p', model: 'm' } }, usage: { inputTokens: 4, outputTokens: 2 } } },
    { type: 'tool/call', seq: 3, time: 1050, data: { turn: 0, step: 0, callId: 'c1', name: 'bash', arguments: '{"command":"npm test"}' } },
    { type: 'tool/result', seq: 4, time: 1060, data: { turn: 0, step: 0, message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'all green' }] }], source: { kind: 'tool', callId: 'c1' } } } },
    { type: 'turn/end', seq: 5, time: 1100, data: { turn: 0, reason: { kind: 'completed' } } },
  ];
  for (const event of events) capture.ingest(event);
  return buildReport(capture.materialize(), options, 1234);
}

test('--version prints a semver', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cli-'));
  try {
    const result = await run(dir, ['--version']);
    assert.equal(result.code, 0);
    assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--help exits 0', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cli-'));
  try {
    const result = await run(dir, ['--help']);
    assert.equal(result.code, 0);
    assert.ok(result.stdout.includes('render'));
    assert.ok(result.stdout.includes('exit'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('render of a report.json round-trips to identical JSON', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cli-'));
  try {
    const options = JSON.parse(JSON.stringify(DEFAULT_OPTIONS));
    const report = buildFixture(options);
    const file = join(dir, 'report.json');
    writeFileSync(file, renderReportJson(report, options), 'utf8');
    const result = await run(dir, ['render', file]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, renderReportJson(report, options));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('render --format junit produces a suites document', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cli-'));
  try {
    const options = JSON.parse(JSON.stringify(DEFAULT_OPTIONS));
    const report = buildFixture(options);
    const file = join(dir, 'report.json');
    writeFileSync(file, renderReportJson(report, options), 'utf8');
    const result = await run(dir, ['render', file, '--format', 'junit']);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, renderJunit(report));
    assert.ok(result.stdout.includes('<testsuites'));
    assert.ok(result.stdout.includes('<testcase name="tool:bash"'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('render --format ndjson emits events plus a session_end line', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cli-'));
  try {
    const options = JSON.parse(JSON.stringify(DEFAULT_OPTIONS));
    const report = buildFixture(options);
    const file = join(dir, 'report.json');
    writeFileSync(file, renderReportJson(report, options), 'utf8');
    const result = await run(dir, ['render', file, '--format', 'ndjson']);
    assert.equal(result.code, 0);
    const lines = result.stdout.trim().split('\n');
    assert.equal(lines.length, report.events.length + 1);
    assert.equal(JSON.parse(lines[lines.length - 1]).kind, 'session_end');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a raw session jsonl input renders to junit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cli-'));
  try {
    const file = join(dir, 'session.jsonl');
    const lines = [
      JSON.stringify({ type: 'session', version: 0, id: 'session-from-log', cwd: process.cwd(), createdAt: 1000 }),
      JSON.stringify({ type: 'turn/start', seq: 0, time: 1000, data: { turn: 0 } }),
      JSON.stringify({ type: 'user/message', seq: 1, time: 1010, data: { content: [{ type: 'text', text: 'go' }] } }),
      JSON.stringify({ type: 'turn/end', seq: 2, time: 1100, data: { turn: 0, reason: { kind: 'completed' } } }),
    ];
    writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
    const result = await run(dir, ['render', file, '--format', 'junit']);
    assert.equal(result.code, 0);
    assert.ok(result.stdout.includes('<testsuite name="session-from-log"'));
    assert.ok(result.stdout.includes('tests="2"')); // run + turn-0
    assert.ok(result.stdout.includes('<testcase name="turn-0"'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exit prints and exits with the semantic code', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cli-'));
  try {
    const options = JSON.parse(JSON.stringify(DEFAULT_OPTIONS));
    const ok = buildFixture(options);
    const okFile = join(dir, 'ok.json');
    writeFileSync(okFile, renderReportJson(ok, options), 'utf8');
    const okResult = await run(dir, ['exit', okFile]);
    assert.equal(okResult.code, 0);
    assert.equal(okResult.stdout.trim(), '0');

    const failOptions = JSON.parse(JSON.stringify(DEFAULT_OPTIONS));
    const ref = { current: failOptions };
    const capture = new Capture(metaFromHeader({ id: 's-x', cwd: process.cwd(), createdAt: 1000 }), ref);
    capture.ingest({ type: 'turn/end', seq: 0, time: 1100, data: { turn: 0, reason: { kind: 'max-tokens' } } });
    const fail = buildReport(capture.materialize(), failOptions, 1234);
    const failFile = join(dir, 'fail.json');
    writeFileSync(failFile, renderReportJson(fail, failOptions), 'utf8');
    const failResult = await run(dir, ['exit', failFile]);
    assert.equal(failResult.code, 2);
    assert.equal(failResult.stdout.trim(), '2');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--set redaction overrides apply to raw inputs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cli-'));
  try {
    const file = join(dir, 'session.jsonl');
    const lines = [
      JSON.stringify({ type: 'session', version: 0, id: 'session-redact', cwd: process.cwd(), createdAt: 1000 }),
      JSON.stringify({ type: 'turn/start', seq: 0, time: 1000, data: { turn: 0 } }),
      JSON.stringify({ type: 'user/message', seq: 1, time: 1010, data: { content: [{ type: 'text', text: 'fix src/a.ts with a long explanation' }] } }),
      JSON.stringify({ type: 'turn/end', seq: 2, time: 1100, data: { turn: 0, reason: { kind: 'completed' } } }),
    ];
    writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
    const result = await run(dir, ['render', file, '--set', 'redact.text_length=3']);
    assert.equal(result.code, 0);
    assert.ok(!result.stdout.includes('fix src/a.ts'), 'text must be truncated');
    assert.ok(result.stdout.includes('[+'), 'truncation marker present');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unknown commands and malformed flags fail loudly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cli-'));
  try {
    const unknown = await run(dir, ['frobnicate']);
    assert.equal(unknown.code, 2);
    assert.ok(unknown.stderr.includes('unknown command'));

    const missing = await run(dir, ['render']);
    assert.equal(missing.code, 2);
    assert.ok(missing.stderr.includes('missing input file'));

    const badSet = await run(dir, ['render', 'x.json', '--set', 'nope.text_length=1']);
    assert.equal(badSet.code, 1);
    assert.ok(badSet.stderr.includes('unknown option section'));

    const badNestedSet = await run(dir, ['render', 'x.json', '--set', 'redact.bogus=1']);
    assert.equal(badNestedSet.code, 1);
    assert.ok(badNestedSet.stderr.includes('unknown option'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ndjson output can be re-rendered as input', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cli-'));
  try {
    const options = JSON.parse(JSON.stringify(DEFAULT_OPTIONS));
    const report = buildFixture(options);
    const file = join(dir, 'report.json');
    writeFileSync(file, renderReportJson(report, options), 'utf8');
    const ndjsonOut = join(dir, 'out.ndjson');
    const rendered = await run(dir, ['render', file, '--format', 'ndjson', '--out', ndjsonOut]);
    assert.equal(rendered.code, 0);
    const roundTrip = await run(dir, ['render', ndjsonOut, '--format', 'junit']);
    assert.equal(roundTrip.code, 0);
    assert.ok(roundTrip.stdout.includes('<testsuites'));
    assert.ok(roundTrip.stdout.includes('<testcase name="tool:bash"'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a JSON array input containing a raw/derived mix is rejected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cli-'));
  try {
    const file = join(dir, 'mixed.json');
    const mixed = [
      { type: 'turn/start', seq: 0, time: 1000, data: { turn: 0 } },
      { kind: 'turn_end', seq: 1, time: 1100, turn: 0, reason: 'completed', error: null, cause: null, latency_ms: 100, complete: true },
    ];
    writeFileSync(file, JSON.stringify(mixed), 'utf8');
    const result = await run(dir, ['render', file, '--format', 'junit']);
    assert.equal(result.code, 1);
    assert.ok(result.stderr.includes('mixes raw session events'), result.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('toggling ndjson off and on keeps a single stream file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cli-'));
  try {
    const running = testRunningCtx(dir);
    await running.ctx.emit('session/created', running.session);
    await running.ctx.emit('session/event', running.session, { type: 'turn/start', seq: 0, time: 1000, data: { turn: 0 } });

    // Enable, disable, re-enable while the session is live.
    running.manager.applyPatch({ output: { ndjson: true } });
    await tick();
    running.manager.applyPatch({ output: { ndjson: false } });
    await tick();
    running.manager.applyPatch({ output: { ndjson: true } });
    await tick();
    await running.ctx.emit('session/event', running.session, { type: 'turn/end', seq: 1, time: 1100, data: { turn: 0, reason: { kind: 'completed' } } });
    await running.ctx.emit('session/disposed', running.session);
    await running.dispose();

    const files = readdirSync(dir).filter((name) => name.endsWith('.ndjson'));
    assert.equal(files.length, 1, `expected a single stream file, got ${files.join(', ')}`);
    const lines = readFileSync(join(dir, files[0]), 'utf8').trim().split('\n');
    assert.equal(JSON.parse(lines[lines.length - 1]).kind, 'session_end', 'the single file ends with the trailer');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

function createManager(dir, ndjson) {
  const options = JSON.parse(JSON.stringify(DEFAULT_OPTIONS));
  options.output.dir = dir;
  options.output.json = false;
  options.output.junit = false;
  options.output.ndjson = ndjson;
  const listeners = new Map();
  const ctx = {
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
      return () => {};
    },
    get(name) {
      return name === 'tools' ? { register: () => () => undefined } : undefined;
    },
    sessions: { list: () => [] },
    logger() {
      return { info() {}, warn() {}, error() {}, debug() {} };
    },
    async emit(name, ...args) {
      for (const fn of listeners.get(name) ?? []) await fn(...args);
    },
    listeners,
  };
  const manager = new CaptureManager(ctx, options, ctx.logger());
  const dispose = manager.start();
  return { ctx, manager, dispose };
}

function testRunningCtx(dir) {
  const { ctx, manager, dispose } = createManager(dir, false);
  const session = { id: 'session-toggle', header: { id: 'session-toggle', cwd: process.cwd(), createdAt: 1000 } };
  return { ctx, manager, dispose, session };
}