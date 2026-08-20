/**
 * Report assembly: turns a materialized capture snapshot into the
 * transaction-level report object, and renders it to JSON.
 *
 * Key guarantees:
 *  - deterministic key order (constructed by the model factories & serializers)
 *  - deterministic event ordering (seq order)
 *  - results never depend on clock or map iteration order (sorted maps)
 *  - the report's `events` array already carries the effective redaction, so
 *    every downstream consumer (JSON file, JUnit, CLI re-render) sees one view
 */

import { basename } from 'node:path';

import { PLUGIN_NAME, readVersion } from './version.js';
import type { CaptureMeta } from './capture.js';
import { resolveOutcome } from './exit-code.js';
import type { ArtifactEntry, CaptureEvent, Report, ReportStats, ToolStat } from './model.js';
import { SCHEMA_VERSION, assertJsonSafe, round3, sortedMap } from './model.js';
import type { Options } from './options.js';
import { relativizePath } from './redact.js';
import { serializeEvent } from './serialize.js';

/** The normalized input of report assembly (capture materialize() output). */
export interface ReportInput {
  meta: CaptureMeta;
  events: CaptureEvent[];
  artifacts: ArtifactEntry[];
  typeCounts: Record<string, number>;
  chunkTotal: number;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordOf(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** Assemble the report for a capture. `generatedAt` is injectable for tests. */
export function buildReport(input: ReportInput, options: Options, generatedAt?: number): Report {
  const sorted = input.events.slice();
  sorted.sort((a, b) => a.seq - b.seq);
  const serialized = sorted.map((event) => serializeEvent(event, options));
  return buildReportFromSerialized(input.meta, serialized, {
    artifacts: input.artifacts,
    typeCounts: input.typeCounts,
    chunkTotal: input.chunkTotal,
  }, options, generatedAt);
}

/**
 * Assemble a report from already-serialized (redacted) events. Used by the
 * plugin path (via buildReport) and by the CLI when the input is an
 * already-structured stream.
 */
export function buildReportFromSerialized(
  meta: CaptureMeta,
  serializedEvents: Array<Record<string, unknown>>,
  context: {
    artifacts?: ArtifactEntry[];
    typeCounts?: Record<string, number>;
    chunkTotal?: number;
  },
  options: Options,
  generatedAt?: number,
): Report {
  const events = serializedEvents.slice();
  events.sort((a, b) => num(a['seq']) - num(b['seq']));
  const first = events[0] ?? null;
  const last = events[events.length - 1] ?? null;
  // `generated_at` is derived from the session itself (the last event time)
  // when no explicit timestamp is given, so identical runs produce identical
  // bytes without injecting a wall clock.
  const resolvedGeneratedAt = generatedAt ?? (last !== null ? num(last['time']) : meta.created_at);

  const lastTurnEnd = lastTurnEndOf(events);
  const outcome = resolveOutcome({
    lastReasonKind: lastTurnEnd === null ? null : text(lastTurnEnd['reason']),
    hasEvents: events.length > 0,
    incomplete: events.length > 0 && lastTurnEnd === null,
    undelivered: undeliveredIds(events),
    error: lastTurnEnd === null ? null : errorOf(lastTurnEnd),
    exitCodes: options.exit,
  });

  const durationMs = first !== null && last !== null ? num(last['time']) - num(first['time']) : 0;
  const stats = buildStats(events, context.typeCounts ?? {}, context.chunkTotal ?? 0, durationMs);

  // Event list trimming.
  const maxEvents = options.events.max_events;
  let kept = events;
  const total = events.length;
  let eventsTruncated: Report['events_truncated'] = null;
  if (maxEvents > 0 && total > maxEvents) {
    if (options.events.trim === 'head') {
      kept = events.slice(0, maxEvents);
    } else {
      const firstKeep = Math.max(1, Math.floor(maxEvents / 4));
      const lastKeep = maxEvents - firstKeep;
      kept = [...events.slice(0, firstKeep), ...events.slice(total - lastKeep)];
    }
    eventsTruncated = { kept: kept.length, total, dropped: total - kept.length };
  }

  const pathsMode = options.redact.paths;
  const cwd = relativizePath(meta.cwd, meta.cwd, pathsMode);
  const cwdName = basename(meta.cwd.replace(/\\/g, '/')) || meta.cwd;

  const artifacts = (context.artifacts ?? []).map((entry) => ({
    path: relativizePath(entry.path, meta.cwd, pathsMode),
    kind: entry.kind,
    size: entry.size,
    references: entry.references,
  }));

  const report: Report = {
    schema_version: SCHEMA_VERSION,
    plugin: {
      name: PLUGIN_NAME,
      version: readVersion(),
    },
    generated_at: resolvedGeneratedAt,
    session: {
      id: meta.id,
      cwd,
      cwd_name: cwdName,
      // For inputs without a session header (event streams), a zero
      // created_at falls back to the first event time so output stays
      // deterministic without a wall clock.
      created_at: meta.created_at > 0 ? meta.created_at : first !== null ? num(first['time']) : 0,
      started_at: first === null ? null : num(first['time']),
      ended_at: last === null ? null : num(last['time']),
      event_count: events.length,
      parent_session: meta.parent_session,
      agent_preset: meta.agent_preset,
      delegation_depth: meta.delegation_depth,
    },
    outcome: {
      status: outcome.status,
      exit_code: outcome.exitCode,
      reason: outcome.reason,
      complete: outcome.complete,
      undelivered_tool_calls: outcome.undelivered,
      error: outcome.error,
    },
    stats,
    events: kept,
    events_truncated: eventsTruncated,
    artifacts,
  };
  return report;
}

function lastTurnEndOf(events: Array<Record<string, unknown>>): Record<string, unknown> | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event !== undefined && event['kind'] === 'turn_end') return event;
  }
  return null;
}

function errorOf(event: Record<string, unknown>): { code: string; message: string; status?: number } | null {
  const error = recordOf(event['error']);
  if (Object.keys(error).length === 0) return null;
  const result: { code: string; message: string; status?: number } = {
    code: text(error['code']),
    message: text(error['message']),
  };
  if (typeof error['status'] === 'number') result.status = error['status'];
  return result;
}

function undeliveredIds(events: Array<Record<string, unknown>>): string[] {
  const results = new Set<string>();
  const calls: string[] = [];
  for (const event of events) {
    if (event['kind'] === 'tool_result' && typeof event['call_id'] === 'string') results.add(event['call_id']);
    if (event['kind'] === 'tool_call' && typeof event['call_id'] === 'string') calls.push(event['call_id']);
  }
  return calls.filter((callId) => !results.has(callId));
}

function buildStats(
  events: Array<Record<string, unknown>>,
  typeCounts: Record<string, number>,
  chunkTotal: number,
  durationMs: number,
): ReportStats {
  let turns = 0;
  let steps = 0;
  let assistantMessages = 0;
  let userMessages = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  let undelivered = 0;
  const tokens = { input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0 };
  const byTool = new Map<string, ToolStat>();

  for (const event of events) {
    const kind = event['kind'];
    const tool = text(event['tool']);
    switch (kind) {
      case 'turn_start':
        turns += 1;
        break;
      case 'step_start':
        steps += 1;
        break;
      case 'assistant_message': {
        assistantMessages += 1;
        const usage = recordOf(event['usage']);
        tokens.input += num(usage['input']);
        tokens.output += num(usage['output']);
        tokens.cache_read += num(usage['cache_read']);
        tokens.cache_write += num(usage['cache_write']);
        tokens.reasoning += num(usage['reasoning']);
        break;
      }
      case 'user_message':
        userMessages += 1;
        break;
      case 'tool_call': {
        toolCalls += 1;
        if (event['undelivered'] === true) undelivered += 1;
        const stat = byTool.get(tool) ?? { calls: 0, errors: 0, latency_ms_total: 0, latency_ms_max: 0 };
        stat.calls += 1;
        byTool.set(tool, stat);
        break;
      }
      case 'tool_result': {
        if (event['status'] === 'error') toolErrors += 1;
        const stat = byTool.get(tool) ?? { calls: 0, errors: 0, latency_ms_total: 0, latency_ms_max: 0 };
        if (event['status'] === 'error') stat.errors += 1;
        const latency = typeof event['latency_ms'] === 'number' ? event['latency_ms'] : null;
        if (latency !== null) {
          stat.latency_ms_total += latency;
          if (latency > stat.latency_ms_max) stat.latency_ms_max = latency;
        }
        byTool.set(tool, stat);
        break;
      }
      default:
        break;
    }
  }

  const roundedByTool: Record<string, ToolStat> = {};
  for (const [key, stat] of [...byTool.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    roundedByTool[key] = {
      calls: stat.calls,
      errors: stat.errors,
      latency_ms_total: round3(stat.latency_ms_total),
      latency_ms_max: round3(stat.latency_ms_max),
    };
  }

  return {
    duration_ms: round3(Math.max(0, durationMs)),
    turns,
    steps,
    assistant_messages: assistantMessages,
    user_messages: userMessages,
    tool_calls: toolCalls,
    tool_errors: toolErrors,
    undelivered_tool_calls: undelivered,
    chunk_count: chunkTotal,
    tokens: {
      input: tokens.input,
      output: tokens.output,
      cache_read: tokens.cache_read,
      cache_write: tokens.cache_write,
      reasoning: tokens.reasoning,
    },
    events_by_type: sortedMap(typeCounts),
    by_tool: roundedByTool,
  };
}

/** Render the report as a JSON string (compact or pretty). */
export function renderReportJson(report: Report, options: Options): string {
  assertJsonSafe(report);
  return options.output.pretty ? JSON.stringify(report, null, 2) : JSON.stringify(report);
}