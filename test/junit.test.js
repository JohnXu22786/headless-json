/**
 * JUnit XML: structure, mapping, escaping and counts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_OPTIONS } from '../lib/options.js';
import { Capture, metaFromHeader } from '../lib/capture.js';
import { buildReport } from '../lib/report.js';
import { renderJunit, attr } from '../lib/junit.js';
import { formatTime, formatIsoTimestamp } from '../lib/timefmt.js';

function captureWith() {
  const ref = { current: JSON.parse(JSON.stringify(DEFAULT_OPTIONS)) };
  const meta = metaFromHeader({ id: 'session-junit-abc', cwd: process.cwd(), createdAt: 1000 });
  const capture = new Capture(meta, ref);
  return capture;
}

function raw(type, seq, time, data) {
  return { type, seq, time, data };
}

function toolResultData(callId, text, error) {
  const data = {
    turn: 0,
    step: 0,
    message: {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }],
      source: { kind: 'tool', callId },
    },
  };
  if (error !== undefined) data.error = error;
  return data;
}

function feed(capture, seqs, times, entries) {
  for (const index in entries) {
    capture.ingest(raw(entries[index].type, seqs[index], times[index], entries[index].data));
  }
}

test('a completed run yields passing testcases with correct counts', () => {
  const capture = captureWith();
  feed(
    capture,
    [0, 1, 2, 3, 4, 5, 6, 7],
    [1000, 1010, 1020, 1040, 1050, 1060, 1061, 1100],
    [
      { type: 'turn/start', data: { turn: 0 } },
      { type: 'user/message', data: { content: [{ type: 'text', text: 'go' }] } },
      { type: 'step/start', data: { turn: 0, step: 0 } },
      {
        type: 'assistant/message',
        data: { turn: 0, step: 0, message: { content: [{ type: 'text', text: 'ok' }], source: { kind: 'model', provider: 'p', model: 'm' } } },
      },
      { type: 'tool/call', data: { turn: 0, step: 0, callId: 'c1', name: 'bash', arguments: '{}' } },
      { type: 'tool/result', data: toolResultData('c1', 'output ok') },
      { type: 'step/end', data: { turn: 0, step: 0 } },
      { type: 'turn/end', data: { turn: 0, reason: { kind: 'completed' } } },
    ],
  );
  const options = JSON.parse(JSON.stringify(DEFAULT_OPTIONS));
  const report = buildReport(capture.materialize(), options);
  const xml = renderJunit(report);
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(xml.includes('<testsuites name="dsh-headless-json" tests="4" failures="0" errors="0" skipped="0"'));
  assert.ok(xml.includes('<testcase name="run" classname="outcome"'));
  assert.ok(xml.includes('<testcase name="turn-0" classname="session-abc.turn"'));
  assert.ok(xml.includes('<testcase name="step-0" classname="session-abc.turn-0"'));
  assert.ok(xml.includes('<testcase name="tool:bash" classname="session-abc.turn-0.step-0"'));
  assert.ok(xml.includes('<system-out>'), 'tool output appears in system-out');
});

test('a failing run produces error/failure elements with correct counts', () => {
  const capture = captureWith();
  feed(
    capture,
    [0, 1, 2, 3, 4, 5],
    [1000, 1010, 1020, 1030, 1040, 1100],
    [
      { type: 'turn/start', data: { turn: 0 } },
      { type: 'step/start', data: { turn: 0, step: 0 } },
      {
        type: 'assistant/message',
        data: { turn: 0, step: 0, message: { content: [{ type: 'text', text: 'x' }], source: { kind: 'model', provider: 'p', model: 'm' } } },
      },
      { type: 'tool/call', data: { turn: 0, step: 0, callId: 'bad', name: 'bash', arguments: '{}' } },
      { type: 'tool/result', data: toolResultData('bad', 'wrecked', { name: 'RateLimit', code: 'RATE_LIMIT' }) },
      { type: 'turn/end', data: { turn: 0, reason: { kind: 'error', error: { code: 'UPSTREAM', message: 'provider down' } } } },
    ],
  );
  const options = JSON.parse(JSON.stringify(DEFAULT_OPTIONS));
  const report = buildReport(capture.materialize(), options);
  const xml = renderJunit(report);
  assert.ok(xml.includes('<error type="dsh:error" message="UPSTREAM: provider down"/>'), `missing run error element\n${xml}`);
  assert.ok(xml.includes('<failure type="dsh:tool" message="RateLimit: RATE_LIMIT"/>'), `missing tool failure element\n${xml}`);
  // run error + turn error + tool failure, and the step fails to close = 4 cases: 1 failure, 2 errors, 1 skipped.
  assert.ok(xml.includes('tests="4" failures="1" errors="2" skipped="1"'));
});

test('aborted/interrupted turns map to skipped', () => {
  for (const kind of ['aborted', 'interrupted', 'blocked']) {
    const capture = captureWith();
    capture.ingest(raw('turn/start', 0, 1000, { turn: 0 }));
    capture.ingest(raw('turn/end', 1, 1100, { turn: 0, reason: { kind } }));
    const options = JSON.parse(JSON.stringify(DEFAULT_OPTIONS));
    const report = buildReport(capture.materialize(), options, 1234);
    const xml = renderJunit(report);
    assert.ok(xml.includes('<skipped '), `kind ${kind} should skip the turn`);
    // the run case fails for anything but success
    assert.ok(xml.includes(`<failure type="dsh:${report.outcome.status}"`), `run case should fail for ${kind}`);
  }
});

test('XML escaping keeps output well-formed', () => {
  const capture = captureWith();
  feed(
    capture,
    [0, 1, 2, 3],
    [1000, 1050, 1060, 1100],
    [
      { type: 'turn/start', data: { turn: 0 } },
      { type: 'tool/call', data: { turn: 0, step: 0, callId: 'c', name: 'bash', arguments: '{}' } },
      { type: 'tool/result', data: toolResultData('c', 'a < b && c > d, "quoted" and \'apos\' & more &amp; \u0000\u0001\uFFFE') },
      { type: 'turn/end', data: { turn: 0, reason: { kind: 'completed' } } },
    ],
  );
  const options = JSON.parse(JSON.stringify(DEFAULT_OPTIONS));
  const report = buildReport(capture.materialize(), options);
  const xml = renderJunit(report);
  assert.ok(!xml.includes('\u0000'), 'control characters must be replaced');
  assert.ok(xml.includes('&lt;') && xml.includes('&gt;') && xml.includes('&amp;'), 'element text must be escaped');
  assert.ok(xml.includes('&quot;') || xml.includes('\uFFFD'), 'quotes handled');
  // Round-trip sanity: no raw control bytes anywhere.
  assert.ok(!/[\u0000-\u0008]/.test(xml));
});

test('attr() escapes attribute values', () => {
  assert.equal(attr('a"b<c&d'), '"a&quot;b&lt;c&amp;d"');
  assert.equal(attr('plain'), '"plain"');
});

test('formatTime and formatIsoTimestamp are locale-stable', () => {
  assert.equal(formatTime(0), '0.000');
  assert.equal(formatTime(null), '0.000');
  assert.equal(formatTime(1234), '1.234');
  assert.equal(formatTime(1234.5678), '1.235');
  assert.match(formatIsoTimestamp(0), /^1970-01-01T00:00:00\.000Z$/);
});

test('max_events trimming is reflected consistently in JUnit', () => {
  const capture = captureWith();
  feed(
    capture,
    [0, 1, 2, 3],
    [1000, 1050, 1060, 1100],
    [
      { type: 'turn/start', data: { turn: 0 } },
      { type: 'tool/call', data: { turn: 0, step: 0, callId: 'c', name: 'bash', arguments: '{}' } },
      { type: 'tool/result', data: toolResultData('c', 'done') },
      { type: 'turn/end', data: { turn: 0, reason: { kind: 'completed' } } },
    ],
  );
  const options = JSON.parse(JSON.stringify(DEFAULT_OPTIONS));
  options.events.max_events = 1; // keep only the first event (head mode)
  options.events.trim = 'head';
  const report = buildReport(capture.materialize(), options);
  const xml = renderJunit(report);
  assert.ok(xml.includes('<testcase name="run"'), 'the run case is always present');
  // The turn never closed, so its case exists but is skipped; steps/tools that
  // were trimmed out do not appear at all.
  assert.ok(xml.includes('<testcase name="turn-0"'), 'an open turn still produces a (skipped) case');
  assert.ok(xml.includes('<skipped message="turn did not close'), 'the open turn is marked skipped');
  assert.ok(!xml.includes('name="tool:"'), 'trimmed tool events are absent from JUnit too');
  assert.ok(!xml.includes('name="step-0"'), 'trimmed step events are absent from JUnit too');
});