/**
 * Serialization determinism, event output shapes, NDJSON line writer, and
 * JSON-safety guards.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { DEFAULT_OPTIONS } from '../lib/options.js';
import { Capture, metaFromHeader } from '../lib/capture.js';
import { buildReport, renderReportJson } from '../lib/report.js';
import { serializeEvent, serializeEventLine } from '../lib/serialize.js';
import { LineWriter } from '../lib/io.js';
import { assertJsonSafe, JsonError, SCHEMA_VERSION } from '../lib/model.js';

let fixtureSeq = 100;
function raw(type, time, data) {
  const seq = fixtureSeq++;
  return { type, seq, time, data };
}

function message(text) {
  return { content: [{ type: 'text', text }] };
}

function buildFixtureCapture(options) {
  const ref = { current: options };
  const meta = metaFromHeader({ id: 'session-det-1', cwd: process.cwd(), createdAt: 1000 });
  const capture = new Capture(meta, ref);
  const events = [
    raw('turn/start', 1000, { turn: 0 }),
    raw('user/message', 1010, message('task: run the tests')),
    raw('step/start', 1020, { turn: 0, step: 0 }),
    raw('request/context', 1021, { provider: 'deepseek', model: 'deepseek-chat' }),
    raw('assistant/message', 1040, {
      turn: 0,
      step: 0,
      message: { content: [{ type: 'text', text: 'running tests now' }], source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' } },
      usage: { inputTokens: 7, outputTokens: 3 },
    }),
    raw('tool/call', 1050, { turn: 0, step: 0, callId: 'c1', name: 'bash', arguments: '{"command":"npm test"}' }),
    raw('tool/result', 1060, {
      turn: 0,
      step: 0,
      message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }], source: { kind: 'tool', callId: 'c1' } },
    }),
    raw('step/end', 1061, { turn: 0, step: 0 }),
    raw('turn/end', 1100, { turn: 0, reason: { kind: 'completed' } }),
  ];
  for (const event of events) capture.ingest(event);
  return { capture, ref };
}

test('serialized event field order is stable and documented', () => {
  const options = JSON.parse(JSON.stringify(DEFAULT_OPTIONS));
  const { capture } = buildFixtureCapture(options);
  const materialized = capture.materialize();
  const report = buildReport(materialized, options);
  // turn_end object key order is fixed by construction.
  const turnEnd = report.events.find((event) => event.kind === 'turn_end');
  assert.deepEqual(Object.keys(turnEnd), ['seq', 'time', 'kind', 'turn', 'reason', 'error', 'cause', 'latency_ms', 'complete']);
  const toolCall = report.events.find((event) => event.kind === 'tool_call');
  assert.deepEqual(Object.keys(toolCall), [
    'seq',
    'time',
    'kind',
    'turn',
    'step',
    'call_id',
    'tool',
    'args_mode',
    'args',
    'args_summary',
    'latency_ms',
    'undelivered',
  ]);
});

test('identical inputs produce byte-identical reports', () => {
  const options = JSON.parse(JSON.stringify(DEFAULT_OPTIONS));
  const first = buildReport(buildSecondFixture(options).capture.materialize(), options, 1234);
  const second = buildReport(buildSecondFixture(options).capture.materialize(), options, 1234);
  assert.equal(renderReportJson(first, options), renderReportJson(second, options));
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test('derived generated_at is deterministic without a wall clock', async () => {
  // The default generated_at is the last event time, so two renders of the
  // same input are byte-identical even without an injected timestamp.
  const options = JSON.parse(JSON.stringify(DEFAULT_OPTIONS));
  const input = buildSecondFixture(options).capture.materialize();
  const first = renderReportJson(buildReport(input, options), options);
  await new Promise((resolve) => setTimeout(resolve, 25));
  const input2 = buildSecondFixture(options).capture.materialize();
  const second = renderReportJson(buildReport(input2, options), options);
  assert.equal(first, second);
});

function buildSecondFixture(options) {
  const ref = { current: options };
  const meta = metaFromHeader({ id: 'session-det-1', cwd: process.cwd(), createdAt: 1000 });
  const capture = new Capture(meta, ref);
  const events = [
    { type: 'turn/start', seq: 100, time: 1000, data: { turn: 0 } },
    { type: 'user/message', seq: 101, time: 1010, data: message('task: run the tests') },
    { type: 'step/start', seq: 102, time: 1020, data: { turn: 0, step: 0 } },
    { type: 'request/context', seq: 103, time: 1021, data: { provider: 'deepseek', model: 'deepseek-chat' } },
    {
      type: 'assistant/message',
      seq: 104,
      time: 1040,
      data: {
        turn: 0,
        step: 0,
        message: { content: [{ type: 'text', text: 'running tests now' }], source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' } },
        usage: { inputTokens: 7, outputTokens: 3 },
      },
    },
    { type: 'tool/call', seq: 105, time: 1050, data: { turn: 0, step: 0, callId: 'c1', name: 'bash', arguments: '{"command":"npm test"}' } },
    {
      type: 'tool/result',
      seq: 106,
      time: 1060,
      data: {
        turn: 0,
        step: 0,
        message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }], source: { kind: 'tool', callId: 'c1' } },
      },
    },
    { type: 'step/end', seq: 107, time: 1061, data: { turn: 0, step: 0 } },
    { type: 'turn/end', seq: 108, time: 1100, data: { turn: 0, reason: { kind: 'completed' } } },
  ];
  for (const event of events) capture.ingest(event);
  return { capture, ref };
}

test('max_events trims the event list deterministically', () => {
  const options = JSON.parse(JSON.stringify(DEFAULT_OPTIONS));
  options.events.max_events = 3;
  const { capture } = buildFixtureCapture(options);
  const report = buildReport(capture.materialize(), options);
  assert.equal(report.events.length, 3);
  assert.equal(report.events_truncated.total, 9);
  assert.equal(report.events_truncated.dropped, 6);
  assert.equal(report.events[0].kind, 'turn_start');
  assert.equal(report.events[report.events.length - 1].kind, 'turn_end');
});

test('reports are lossless-JSON safe by construction', () => {
  const options = JSON.parse(JSON.stringify(DEFAULT_OPTIONS));
  const { capture } = buildFixtureCapture(options);
  const report = buildReport(capture.materialize(), options);
  assert.doesNotThrow(() => assertJsonSafe(report));
  void renderReportJson(report, options);
});

test('serializeEvent applies argument redaction per mode', () => {
  const options = JSON.parse(JSON.stringify(DEFAULT_OPTIONS));
  const base = { kind: 'tool_call', seq: 1, time: 1000, turn: 0, step: 0, call_id: 'c', tool: 'bash', args: null, args_summary: '', latency_ms: null, undelivered: false };

  const full = serializeEvent({ ...base, args_mode: 'full', args: { command: 'ls', token: 'sk-abcdefghijklmnop123456789' } }, options);
  assert.equal(full.args.command, 'ls');
  assert.ok(!JSON.stringify(full.args).includes('sk-abcdefghijklmnop'), 'full mode still masks secrets');
  assert.equal(full.args_mode, 'full');

  const truncate = serializeEvent({ ...base, args_mode: 'truncate', args_summary: '{"command":"ls","token":"sk-abcdefghijklmnop123456789"}' }, options);
  assert.equal(truncate.args, null);
  assert.ok(typeof truncate.args_summary === 'string');
  assert.ok(!truncate.args_summary.includes('sk-abcdefghijklmnop'), 'summaries mask secrets');

  const hidden = serializeEvent({ ...base, args_mode: 'hidden' }, options);
  assert.equal(hidden.args, null);
  assert.equal(hidden.args_summary, '[hidden]');
  assert.equal(hidden.args_mode, 'hidden');
});

test('serializeEventLine round-trips through JSON', () => {
  const options = JSON.parse(JSON.stringify(DEFAULT_OPTIONS));
  const { capture } = buildFixtureCapture(options);
  for (const event of capture.materialize().events) {
    const line = serializeEventLine(event, options);
    const parsed = JSON.parse(line);
    assert.equal(parsed.kind, event.kind);
    assert.equal(parsed.seq, event.seq);
  }
});

test('LineWriter preserves order, flushes and closes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-headless-json-test-'));
  try {
    const file = join(dir, 'events.ndjson');
    const writer = new LineWriter(file);
    await writer.write('{"a":1}');
    await writer.write('{"a":2}');
    await writer.flush();
    await writer.write('{"a":3}');
    await writer.close();
    await writer.close(); // idempotent
    const content = readFileSync(file, 'utf8');
    assert.equal(content, '{"a":1}\n{"a":2}\n{"a":3}\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('assertJsonSafe rejects non-finite and exotic values', () => {
  assert.throws(() => assertJsonSafe({ x: Number.NaN }), JsonError);
  assert.throws(() => assertJsonSafe([undefined]), JsonError);
  assert.throws(() => assertJsonSafe({ d: new Date() }), JsonError);
  assert.doesNotThrow(() => assertJsonSafe({ x: [1, 'two', null, true] }));
});

test('schema_version is 1', () => {
  assert.equal(SCHEMA_VERSION, 1);
});