/**
 * Capture pipeline: raw dsh session events -> structured events, stats,
 * artifacts, undelivered calls and outcome mapping.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_OPTIONS } from '../lib/options.js';
import { Capture, metaFromHeader } from '../lib/capture.js';
import { buildReport } from '../lib/report.js';
import { serializeEvent } from '../lib/serialize.js';

function options() {
  return { current: JSON.parse(JSON.stringify(DEFAULT_OPTIONS)) };
}

function makeCapture(options) {
  const ref = { current: options ?? JSON.parse(JSON.stringify(DEFAULT_OPTIONS)) };
  const meta = metaFromHeader({ id: 'session-test-1', cwd: process.cwd(), createdAt: 1000, agentPreset: 'minimal' });
  return { capture: new Capture(meta, ref), ref, meta };
}

function raw(type, seq, time, data) {
  return { type, seq, time, data };
}

function textMessage(text) {
  return { content: [{ type: 'text', text }] };
}

function toolCallData(turn, step, callId, name, args) {
  return { turn, step, callId, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) };
}

function toolResultData(turn, step, callId, resultText, error) {
  const data = {
    turn,
    step,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool-result',
          toolCallId: callId,
          content: [{ type: 'text', text: resultText }],
        },
      ],
      source: { kind: 'tool', callId },
    },
  };
  if (error !== undefined) data.error = error;
  return data;
}

function successfulRunEvents() {
  return [
    raw('turn/start', 0, 1000, { turn: 0 }),
    raw('user/message', 1, 1010, textMessage('fix the bug in src/main.ts, see /tmp/x.log')),
    raw('step/start', 2, 1020, { turn: 0, step: 0 }),
    raw('request/context', 3, 1021, { provider: 'deepseek', model: 'deepseek-chat', contextWindow: 64000 }),
    raw('assistant/chunk', 4, 1030, { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'hel' } }),
    raw('assistant/chunk', 5, 1031, { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'lo' } }),
    raw('assistant/message', 6, 1040, {
      turn: 0,
      step: 0,
      message: {
        content: [{ type: 'text', text: 'hello from the model' }],
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
      },
      usage: { inputTokens: 10, outputTokens: 5 },
    }),
    raw('tool/call', 7, 1050, toolCallData(0, 0, 'call_1', 'bash', { command: 'ls -la' })),
    raw('tool/result', 8, 1060, toolResultData(0, 0, 'call_1', 'total 0')),
    raw('step/end', 9, 1061, { turn: 0, step: 0 }),
    raw('turn/end', 10, 1100, { turn: 0, reason: { kind: 'completed' } }),
  ];
}

test('a successful run derives structured events with full fidelity', () => {
  const { capture } = makeCapture();
  for (const event of successfulRunEvents()) capture.ingest(event);

  const materialized = capture.materialize();
  const kinds = materialized.events.map((event) => event.kind);
  assert.deepEqual(kinds, [
    'turn_start',
    'user_message',
    'step_start',
    'request_context',
    'assistant_message',
    'tool_call',
    'tool_result',
    'step_end',
    'turn_end',
  ]);

  const assistant = materialized.events.find((event) => event.kind === 'assistant_message');
  assert.equal(assistant.provider, 'deepseek');
  assert.equal(assistant.model, 'deepseek-chat');
  assert.equal(assistant.text, 'hello from the model');
  assert.equal(assistant.latency_ms, 30); // 1040 - 1010 (last user message)
  assert.deepEqual(assistant.usage, { input: 10, output: 5, cache_read: 0, cache_write: 0, reasoning: 0 });
  assert.deepEqual(assistant.stream, { chunk_count: 2, first_chunk_at: 1030, last_chunk_at: 1031 });

  const toolCall = materialized.events.find((event) => event.kind === 'tool_call');
  assert.equal(toolCall.tool, 'bash');
  assert.equal(toolCall.args_mode, 'truncate'); // default redaction
  assert.equal(toolCall.latency_ms, 10); // 1060 - 1050, backfilled
  assert.equal(toolCall.undelivered, false);

  const toolResult = materialized.events.find((event) => event.kind === 'tool_result');
  assert.equal(toolResult.status, 'success');
  assert.equal(toolResult.latency_ms, 10);
  assert.equal(toolResult.text, 'total 0');

  const turnEnd = materialized.events.find((event) => event.kind === 'turn_end');
  assert.equal(turnEnd.reason, 'completed');
  assert.equal(turnEnd.latency_ms, 100); // 1100 - 1000
  assert.equal(turnEnd.error, null);
  assert.equal(turnEnd.cause, null);

  const stepEnd = materialized.events.find((event) => event.kind === 'step_end');
  assert.equal(stepEnd.latency_ms, 41); // 1061 - 1020
});

test('request_context sets the fallback model for later messages', () => {
  const { capture } = makeCapture();
  capture.ingest(raw('request/context', 0, 1000, { provider: 'p', model: 'm1' }));
  capture.ingest(
    raw('assistant/message', 1, 1005, {
      turn: 0,
      step: 0,
      message: { content: [{ type: 'text', text: 'x' }], source: { kind: 'model', provider: 'p', model: 'm1' } },
    }),
  );
  const materialized = capture.materialize();
  const assistant = materialized.events.find((event) => event.kind === 'assistant_message');
  assert.equal(assistant.provider, 'p');
  assert.equal(assistant.model, 'm1');
});

test('chunk usage is used when the message carries none', () => {
  const { capture } = makeCapture();
  capture.ingest(
    raw('assistant/chunk', 0, 1000, {
      turn: 0,
      step: 0,
      chunk: { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } },
    }),
  );
  capture.ingest(
    raw('assistant/message', 1, 1005, {
      turn: 0,
      step: 0,
      message: { content: [{ type: 'text', text: 'x' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    }),
  );
  const materialized = capture.materialize();
  const assistant = materialized.events.find((event) => event.kind === 'assistant_message');
  assert.deepEqual(assistant.usage, { input: 3, output: 4, cache_read: 0, cache_write: 0, reasoning: 0 });
});

test('artifacts are collected, de-duplicated, counted and stat\'d', () => {
  const { capture } = makeCapture();
  capture.ingest(raw('turn/start', 0, 1000, { turn: 0 }));
  capture.ingest(raw('user/message', 1, 1001, textMessage('edit src/index.ts and also src/index.ts and /tmp/log.txt')));
  capture.ingest(raw('user/message', 2, 1002, textMessage('then check ./README.md and https://example.com/x')));
  const materialized = capture.materialize();
  const paths = materialized.artifacts.map((entry) => entry.path);
  assert.ok(paths.includes('src/index.ts'), `missing src/index.ts in ${paths}`);
  assert.ok(paths.includes('/tmp/log.txt'), `missing /tmp/log.txt in ${paths}`);
  assert.ok(paths.includes('README.md') || paths.includes('./README.md'), `mis-named README in ${paths}`);
  assert.ok(!paths.some((path) => path.includes('https://')), 'URLs must not be artifacts');
  const doubled = materialized.artifacts.find((entry) => entry.path === 'src/index.ts');
  assert.equal(doubled.references, 2);
});

test('an undelivered tool call is flagged and reported', () => {
  const { capture } = makeCapture();
  capture.ingest(raw('turn/start', 0, 1000, { turn: 0 }));
  capture.ingest(raw('tool/call', 1, 1050, toolCallData(0, 0, 'call_9', 'bash', { command: 'sleep' })));
  capture.ingest(raw('turn/end', 2, 1200, { turn: 0, reason: { kind: 'completed' } }));
  const materialized = capture.materialize();
  const call = materialized.events.find((event) => event.kind === 'tool_call');
  assert.equal(call.undelivered, true);
  assert.equal(call.latency_ms, null);
  const report = buildReport(materialized, JSON.parse(JSON.stringify(DEFAULT_OPTIONS)));
  assert.deepEqual(report.outcome.undelivered_tool_calls, ['call_9']);
  assert.equal(report.stats.undelivered_tool_calls, 1);
});

test('a failed tool call is surfaced with its error identity', () => {
  const { capture } = makeCapture();
  capture.ingest(raw('turn/start', 0, 1000, { turn: 0 }));
  capture.ingest(raw('tool/call', 1, 1050, toolCallData(0, 0, 'call_2', 'bash', { command: 'rm -rf' })));
  capture.ingest(
    raw('tool/result', 2, 1060, toolResultData(0, 0, 'call_2', 'permission denied', { name: 'ProcessOutputError', code: 'EXIT_1' })),
  );
  capture.ingest(raw('turn/end', 3, 1100, { turn: 0, reason: { kind: 'completed' } }));
  const materialized = capture.materialize();
  const result = materialized.events.find((event) => event.kind === 'tool_result');
  assert.equal(result.status, 'error');
  assert.deepEqual(result.error, { name: 'ProcessOutputError', code: 'EXIT_1' });
  const report = buildReport(materialized, JSON.parse(JSON.stringify(DEFAULT_OPTIONS)));
  assert.equal(report.stats.tool_errors, 1);
  // A failed tool call does not fail a completed turn.
  assert.equal(report.outcome.status, 'success');
});

test('turn/end error maps to the error outcome with exit code 1', () => {
  const { capture } = makeCapture();
  capture.ingest(raw('turn/start', 0, 1000, { turn: 0 }));
  capture.ingest(
    raw('turn/end', 1, 1100, { turn: 0, reason: { kind: 'error', error: { code: 'RATE_LIMITED', message: 'slow down', status: 429 } } }),
  );
  const materialized = capture.materialize();
  const report = buildReport(materialized, JSON.parse(JSON.stringify(DEFAULT_OPTIONS)));
  assert.equal(report.outcome.status, 'error');
  assert.equal(report.outcome.exit_code, 1);
  assert.equal(report.outcome.reason, 'error');
  assert.equal(report.outcome.complete, true);
  assert.deepEqual(report.outcome.error, { code: 'RATE_LIMITED', message: 'slow down', status: 429 });
});

test('aborted turns carry their cancel cause', () => {
  const { capture } = makeCapture();
  capture.ingest(raw('turn/start', 0, 1000, { turn: 0 }));
  capture.ingest(raw('turn/end', 1, 1100, { turn: 0, reason: { kind: 'aborted', reason: { kind: 'user' } } }));
  const materialized = capture.materialize();
  const turnEnd = materialized.events.find((event) => event.kind === 'turn_end');
  assert.equal(turnEnd.cause, 'user');
  const report = buildReport(materialized, JSON.parse(JSON.stringify(DEFAULT_OPTIONS)));
  assert.equal(report.outcome.status, 'aborted');
  assert.equal(report.outcome.exit_code, 130);
});

test('malformed events never crash the capture and still count', () => {
  const { capture } = makeCapture();
  capture.ingest(raw('turn/start', 0, 1000, { turn: 'not-a-number' }));
  capture.ingest(raw('weird/type', 1, 1005, 'plain string data'));
  capture.ingest(null);
  capture.ingest('garbage');
  const materialized = capture.materialize();
  assert.equal(materialized.events.length, 1); // turn_start; unknown types are counted but not surfaced by default
  const report = buildReport(materialized, JSON.parse(JSON.stringify(DEFAULT_OPTIONS)));
  assert.ok(['turn/start', 'weird/type'].every((type) => report.stats.events_by_type[type] === 1));
  assert.equal(report.outcome.status, 'error'); // events exist but no turn closed
  assert.equal(report.outcome.reason, 'incomplete');
});

test('an empty session yields the empty outcome', () => {
  const { capture } = makeCapture();
  const materialized = capture.materialize();
  const report = buildReport(materialized, JSON.parse(JSON.stringify(DEFAULT_OPTIONS)));
  assert.equal(report.outcome.status, 'empty');
  assert.equal(report.outcome.exit_code, 4);
  assert.equal(report.outcome.reason, 'none');
});

test('include_log_only surfaces unknown types as other events', () => {
  const opts = JSON.parse(JSON.stringify(DEFAULT_OPTIONS));
  opts.events.include_log_only = true;
  const { capture } = makeCapture(opts);
  capture.ingest(raw('request/header', 0, 1000, { header: { system: 'S' }, reason: 'initial' }));
  capture.ingest(raw('session/end-seed', 1, 1001, {}));
  const materialized = capture.materialize();
  const others = materialized.events.filter((event) => event.kind === 'other');
  assert.deepEqual(others.map((event) => event.type), ['request/header', 'session/end-seed']);
});

test('NaN protocol fields are nulled and never poison the report', () => {
  const { capture } = makeCapture();
  capture.ingest(raw('request/context', 0, 1000, { provider: 'p', model: 'm', contextWindow: Number.NaN }));
  capture.ingest(raw('turn/start', 1, 1001, { turn: 0 }));
  capture.ingest(
    raw('turn/end', 2, 1100, { turn: 0, reason: { kind: 'error', error: { code: 'E', message: 'x', status: Number.NaN } } }),
  );
  const materialized = capture.materialize();
  const report = buildReport(materialized, JSON.parse(JSON.stringify(DEFAULT_OPTIONS)));
  assert.equal(report.session.started_at, 1000);
  assert.doesNotThrow(() => JSON.stringify(report));
  const contextEvent = report.events.find((event) => event.kind === 'request_context');
  assert.equal(contextEvent.context_window, null);
  assert.equal(report.outcome.error.status, undefined);
});

test('a user-message-free turn measures assistant latency from turn start', () => {
  const { capture } = makeCapture();
  capture.ingest(raw('turn/start', 0, 1000, { turn: 0 }));
  capture.ingest(
    raw('assistant/message', 1, 1400, {
      turn: 0,
      step: 0,
      message: { content: [{ type: 'text', text: 'x' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    }),
  );
  const materialized = capture.materialize();
  const assistant = materialized.events.find((event) => event.kind === 'assistant_message');
  assert.equal(assistant.latency_ms, 400);
});

test('an explicit null tool error is not treated as a failure', () => {
  const { capture } = makeCapture();
  capture.ingest(raw('tool/call', 0, 1000, toolCallData(0, 0, 'c9', 'bash', {})));
  capture.ingest(
    raw('tool/result', 1, 1100, {
      turn: 0,
      step: 0,
      message: {
        content: [{ type: 'tool-result', toolCallId: 'c9', content: [{ type: 'text', text: 'ok' }] }],
        source: { kind: 'tool', callId: 'c9' },
      },
      error: null,
    }),
  );
  capture.ingest(raw('turn/end', 2, 1200, { turn: 0, reason: { kind: 'completed' } }));
  const materialized = capture.materialize();
  const result = materialized.events.find((event) => event.kind === 'tool_result');
  assert.equal(result.status, 'success');
  assert.equal(result.error, null);
  const report = buildReport(materialized, JSON.parse(JSON.stringify(DEFAULT_OPTIONS)));
  assert.equal(report.stats.tool_errors, 0);
});

test('turn/end error messages are redacted in every output', () => {
  const { capture } = makeCapture();
  capture.ingest(
    raw('turn/end', 0, 1100, { turn: 0, reason: { kind: 'error', error: { code: 'AUTH', message: 'failed with sk-abcdefghijklmnop123456789' } } }),
  );
  const materialized = capture.materialize();
  const report = buildReport(materialized, JSON.parse(JSON.stringify(DEFAULT_OPTIONS)));
  assert.ok(!report.outcome.error.message.includes('sk-abcdefghijklmnop'));
  assert.ok(report.outcome.error.message.includes('[REDACTED]'));
  const turnEnd = report.events.find((event) => event.kind === 'turn_end');
  assert.ok(!JSON.stringify(turnEnd).includes('sk-abcdefghijklmnop'));
});
