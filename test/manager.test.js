/**
 * Manager integration against a minimal fake dsh context: subscription
 * wiring, lifecycle, NDJSON streaming and report file production.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { DEFAULT_OPTIONS } from '../lib/options.js';
import { CaptureManager } from '../lib/manager.js';

class FakeCtx {
  constructor() {
    this.listeners = new Map();
    this.calls = [];
  }

  on(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(fn);
    this.calls.push(['on', name]);
    return () => {
      const list = this.listeners.get(name) ?? [];
      const index = list.indexOf(fn);
      if (index >= 0) list.splice(index, 1);
    };
  }

  get() {
    return undefined; // no tools service in this composition
  }

  sessions = { list: () => [] };

  logger() {
    const recorded = [];
    return {
      info: (message) => recorded.push(['info', message]),
      warn: (message) => recorded.push(['warn', message]),
      error: (message) => recorded.push(['error', message]),
      debug: (message) => recorded.push(['debug', message]),
      recorded,
    };
  }

  async emit(name, ...args) {
    for (const fn of this.listeners.get(name) ?? []) {
      await fn(...args);
    }
  }
}

function raw(type, seq, time, data) {
  return { type, seq, time, data };
}

test('a full session lifecycle produces the expected files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-headless-json-mgr-'));
  const options = JSON.parse(JSON.stringify(DEFAULT_OPTIONS));
  options.output.dir = dir;
  options.output.ndjson = true;

  const ctx = new FakeCtx();
  const logger = ctx.logger();
  const manager = new CaptureManager(ctx, options, logger);
  const dispose = manager.start();

  try {
    // The manager subscribed to all four session events.
    for (const name of ['session/created', 'session/event', 'session/flush', 'session/disposed']) {
      assert.ok(ctx.calls.some((call) => call[0] === 'on' && call[1] === name), `missing subscription to ${name}`);
    }

    const session = { id: 'session-manager-1', header: { id: 'session-manager-1', cwd: process.cwd(), createdAt: 1000 } };
    await ctx.emit('session/created', session);
    const events = [
      raw('turn/start', 0, 1000, { turn: 0 }),
      raw('user/message', 1, 1010, { content: [{ type: 'text', text: 'run the suite' }] }),
      raw('turn/end', 2, 2000, { turn: 0, reason: { kind: 'completed' } }),
    ];
    for (const event of events) await ctx.emit('session/event', session, event);

    await ctx.emit('session/flush', session);
    assert.ok(existsSync(join(dir, 'events.ndjson')), 'NDJSON stream should exist after flush');

    const streamed = readFileSync(join(dir, 'events.ndjson'), 'utf8').trim().split('\n');
    assert.equal(streamed.length, 3, 'NDJSON should contain the live events');
    assert.equal(JSON.parse(streamed[0]).kind, 'turn_start');

    await ctx.emit('session/disposed', session);
    assert.ok(existsSync(join(dir, 'report.json')), 'report.json should be written at finalize');
    assert.ok(existsSync(join(dir, 'junit.xml')), 'junit.xml should be written at finalize');

    const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
    assert.equal(report.session.id, 'session-manager-1');
    assert.equal(report.outcome.status, 'success');
    assert.equal(report.outcome.exit_code, 0);
    assert.equal(report.events.length, 3);
    assert.equal(report.events[report.events.length - 1].kind, 'turn_end');

    const finalStream = readFileSync(join(dir, 'events.ndjson'), 'utf8').trim().split('\n');
    assert.equal(JSON.parse(finalStream[finalStream.length - 1]).kind, 'session_end');
    assert.equal(JSON.parse(finalStream[finalStream.length - 1]).outcome.exit_code, 0);
  } finally {
    await dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('empty sessions are skipped when write_empty is false', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-headless-json-mgr-'));
  const options = JSON.parse(JSON.stringify(DEFAULT_OPTIONS));
  options.output.dir = dir;
  options.output.write_empty = false;

  const ctx = new FakeCtx();
  const manager = new CaptureManager(ctx, options, ctx.logger());
  const dispose = manager.start();
  try {
    const session = { id: 'session-empty', header: { id: 'session-empty', cwd: process.cwd(), createdAt: 1000 } };
    await ctx.emit('session/created', session);
    await ctx.emit('session/disposed', session);
    assert.ok(!existsSync(join(dir, 'report.json')), 'no report for an empty session');
  } finally {
    await dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tools are registered when the registry exists', async () => {
  const registered = [];
  const ctx = new FakeCtx();
  ctx.get = (name) => (name === 'tools' ? { register: (definition) => { registered.push(definition.name); return () => undefined; } } : undefined);
  const logger = ctx.logger();
  const options = JSON.parse(JSON.stringify(DEFAULT_OPTIONS));
  options.output.json = false;
  options.output.junit = false;
  options.output.ndjson = false;
  const manager = new CaptureManager(ctx, options, logger);
  const dispose = manager.start();
  try {
    assert.deepEqual(registered.sort(), ['output_events', 'output_status', 'set_options']);
  } finally {
    await dispose();
  }
});

test('enabling ndjson mid-session via the set_options tool arms the live stream', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-headless-json-mgr-'));
  const options = JSON.parse(JSON.stringify(DEFAULT_OPTIONS));
  options.output.dir = dir;
  options.output.ndjson = false;

  const ctx = new FakeCtx();
  const definitions = [];
  ctx.get = (name) =>
    name === 'tools' ? { register: (definition) => { definitions.push(definition); return () => undefined; } } : undefined;
  const manager = new CaptureManager(ctx, options, ctx.logger());
  const dispose = manager.start();
  try {
    const session = { id: 'session-late-ndjson', header: { id: 'session-late-ndjson', cwd: process.cwd(), createdAt: 1000 } };
    await ctx.emit('session/created', session);
    await ctx.emit('session/event', session, raw('turn/start', 0, 1000, { turn: 0 }));

    // Enable through the set_options tool (the real user-facing path).
    const setOptions = definitions.find((definition) => definition.name === 'set_options');
    assert.ok(setOptions, 'set_options should be registered');
    const exec = { agent: { session: { id: 'session-late-ndjson' } } };
    await setOptions.execute({ output: { ndjson: true } }, exec);
    await ctx.emit('session/event', session, raw('user/message', 1, 1010, { content: [{ type: 'text', text: 'go' }] }));

    // Disable then re-enable through the tool too.
    await setOptions.execute({ output: { ndjson: false } }, exec);
    await setOptions.execute({ output: { ndjson: true } }, exec);

    await ctx.emit('session/event', session, raw('turn/end', 2, 1100, { turn: 0, reason: { kind: 'completed' } }));
    await ctx.emit('session/disposed', session);
    await dispose();

    const files = readdirSync(dir).filter((name) => name.endsWith('.ndjson'));
    assert.equal(files.length, 1, `expected a single stream file, got ${files.join(', ')}`);
    const lines = readFileSync(join(dir, files[0]), 'utf8').trim().split('\n');
    assert.equal(JSON.parse(lines[lines.length - 1]).kind, 'session_end', 'the single file ends with the trailer');
    assert.ok(lines.some((line) => JSON.parse(line).kind === 'user_message'), 'post-enable events are streamed');
  } finally {
    await dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});