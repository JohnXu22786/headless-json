/**
 * Output data model: the structured event stream and the transaction-level
 * report, plus JSON-safety and canonical construction helpers.
 *
 * Serialization determinism is a guarantee: JSON objects are constructed in a
 * fixed, documented key order (the factories below), maps are serialized with
 * sorted keys, and every number is rounded before it enters an object.
 */

import type { OutcomeStatus } from './exit-code.js';

export const SCHEMA_VERSION = 1;

export type CaptureEventKind =
  | 'turn_start'
  | 'turn_end'
  | 'step_start'
  | 'step_end'
  | 'user_message'
  | 'assistant_message'
  | 'tool_call'
  | 'tool_result'
  | 'todo_write'
  | 'request_context'
  | 'other';

/** Canonical base fields of every capture event. */
export interface CaptureEventBase {
  seq: number;
  time: number;
  kind: CaptureEventKind;
}

export interface SequenceField {
  seq: number;
}

export interface TurnField {
  turn: number;
}

export interface StepField {
  step: number;
}

export interface TurnStartEvent extends CaptureEventBase, TurnField {
  kind: 'turn_start';
}

export interface TurnErrorShape {
  code: string;
  message: string;
  status?: number;
  requestId?: string;
}

export interface TurnEndEvent extends CaptureEventBase, TurnField {
  kind: 'turn_end';
  reason: string;
  /** Structured failure facts when reason is 'error'; null otherwise. */
  error: TurnErrorShape | null;
  /** Cancellation cause kind when reason is 'aborted'; null otherwise. */
  cause: string | null;
  /** Time from turn/start to turn/end in milliseconds, or null. */
  latency_ms: number | null;
  complete: boolean;
}

export interface StepStartEvent extends CaptureEventBase, TurnField, StepField {
  kind: 'step_start';
}

export interface StepEndEvent extends CaptureEventBase, TurnField, StepField {
  kind: 'step_end';
  latency_ms: number | null;
}

export interface BlockCountSummary {
  text: number;
  reasoning: number;
  image: number;
  other: number;
}

export interface UserMessageEvent extends CaptureEventBase, TurnField, StepField {
  kind: 'user_message';
  text: string;
  reasoning: string;
  blocks: BlockCountSummary;
}

export interface UsageSummary {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  reasoning: number;
}

export interface StreamSummary {
  chunk_count: number;
  first_chunk_at: number | null;
  last_chunk_at: number | null;
}

export interface AssistantMessageEvent extends CaptureEventBase, TurnField, StepField {
  kind: 'assistant_message';
  provider: string | null;
  model: string | null;
  /** Time since the last user message or turn start, in milliseconds. */
  latency_ms: number | null;
  usage: UsageSummary;
  text: string;
  reasoning: string;
  blocks: BlockCountSummary;
  stream: StreamSummary;
}

export interface ToolCallEvent extends CaptureEventBase, TurnField, StepField {
  kind: 'tool_call';
  call_id: string;
  tool: string;
  args_mode: 'full' | 'truncate' | 'hidden';
  /** Parsed arguments (full mode only; null otherwise). */
  args: unknown;
  /** String summary (truncate/hidden modes only). */
  args_summary: string;
  /** Time from tool/call to tool/result in ms; null until resolved. */
  latency_ms: number | null;
  /** True when the session ended before a matching tool/result arrived. */
  undelivered: boolean;
}

export interface ToolErrorSummary {
  name: string;
  code: string;
}

export interface ToolResultEvent extends CaptureEventBase, TurnField, StepField {
  kind: 'tool_result';
  call_id: string;
  tool: string;
  status: 'success' | 'error';
  latency_ms: number | null;
  text: string;
  blocks: BlockCountSummary;
  /** Present when the call failed. */
  error: ToolErrorSummary | null;
}

export interface TodoEntry {
  content: string;
  status: string;
}

export interface TodoWriteEvent extends CaptureEventBase {
  kind: 'todo_write';
  count: number;
  todos: TodoEntry[];
}

export interface RequestContextEvent extends CaptureEventBase {
  kind: 'request_context';
  provider: string;
  model: string;
  context_window: number | null;
}

export interface OtherEvent extends CaptureEventBase {
  kind: 'other';
  type: string;
}

export type CaptureEvent =
  | TurnStartEvent
  | TurnEndEvent
  | StepStartEvent
  | StepEndEvent
  | UserMessageEvent
  | AssistantMessageEvent
  | ToolCallEvent
  | ToolResultEvent
  | TodoWriteEvent
  | RequestContextEvent
  | OtherEvent;

/* ------------------------------------------------------------------ *
 * Factories: every function below constructs its object literal in the
 * canonical serialized key order. Do not reorder fields casually; the
 * determinism guarantee depends on it.
 * ------------------------------------------------------------------ */

export function evTurnStart(seq: number, time: number, turn: number): TurnStartEvent {
  return { seq, time, kind: 'turn_start', turn };
}

export function evTurnEnd(
  seq: number,
  time: number,
  turn: number,
  reason: string,
  error: TurnErrorShape | null,
  cause: string | null,
  latencyMs: number | null,
  complete: boolean,
): TurnEndEvent {
  return { seq, time, kind: 'turn_end', turn, reason, error, cause, latency_ms: latencyMs, complete };
}

export function evStepStart(seq: number, time: number, turn: number, step: number): StepStartEvent {
  return { seq, time, kind: 'step_start', turn, step };
}

export function evStepEnd(seq: number, time: number, turn: number, step: number, latencyMs: number | null): StepEndEvent {
  return { seq, time, kind: 'step_end', turn, step, latency_ms: latencyMs };
}

export function evUserMessage(
  seq: number,
  time: number,
  turn: number,
  step: number,
  text: string,
  reasoning: string,
  blocks: BlockCountSummary,
): UserMessageEvent {
  return { seq, time, kind: 'user_message', turn, step, text, reasoning, blocks };
}

export function evAssistantMessage(
  seq: number,
  time: number,
  turn: number,
  step: number,
  provider: string | null,
  model: string | null,
  latencyMs: number | null,
  usage: UsageSummary,
  text: string,
  reasoning: string,
  blocks: BlockCountSummary,
  stream: StreamSummary,
): AssistantMessageEvent {
  return {
    seq,
    time,
    kind: 'assistant_message',
    turn,
    step,
    provider,
    model,
    latency_ms: latencyMs,
    usage,
    text,
    reasoning,
    blocks,
    stream,
  };
}

export function evToolCall(
  seq: number,
  time: number,
  turn: number,
  step: number,
  callId: string,
  tool: string,
  args: unknown,
  argsSummary: string,
  argsMode: 'full' | 'truncate' | 'hidden',
): ToolCallEvent {
  return {
    seq,
    time,
    kind: 'tool_call',
    turn,
    step,
    call_id: callId,
    tool,
    args_mode: argsMode,
    args: argsMode === 'full' ? args : null,
    args_summary: argsMode === 'truncate' ? argsSummary : argsMode === 'hidden' ? '[hidden]' : '',
    latency_ms: null,
    undelivered: false,
  };
}

export function evToolResult(
  seq: number,
  time: number,
  turn: number,
  step: number,
  callId: string,
  tool: string,
  status: 'success' | 'error',
  latencyMs: number | null,
  text: string,
  blocks: BlockCountSummary,
  error: ToolErrorSummary | null,
): ToolResultEvent {
  return { seq, time, kind: 'tool_result', turn, step, call_id: callId, tool, status, latency_ms: latencyMs, text, blocks, error };
}

export function evTodoWrite(seq: number, time: number, count: number, todos: TodoEntry[]): TodoWriteEvent {
  return { seq, time, kind: 'todo_write', count, todos };
}

export function evRequestContext(
  seq: number,
  time: number,
  provider: string,
  model: string,
  contextWindow: number | null,
): RequestContextEvent {
  return { seq, time, kind: 'request_context', provider, model, context_window: contextWindow };
}

export function evOther(seq: number, time: number, type: string): OtherEvent {
  return { seq, time, kind: 'other', type };
}

/* ------------------------------------------------------------------ *
 * Report model.
 * ------------------------------------------------------------------ */

export interface ArtifactEntry {
  path: string;
  kind: 'file' | 'dir' | 'missing' | 'unknown';
  size: number | null;
  references: number;
}

export interface SessionSummary {
  id: string;
  cwd: string;
  cwd_name: string;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  event_count: number;
  parent_session: string | null;
  agent_preset: string | null;
  delegation_depth: number | null;
}

export interface TokenTotals {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  reasoning: number;
}

export interface ToolStat {
  calls: number;
  errors: number;
  latency_ms_total: number;
  latency_ms_max: number;
}

export interface ReportStats {
  duration_ms: number;
  turns: number;
  steps: number;
  assistant_messages: number;
  user_messages: number;
  tool_calls: number;
  tool_errors: number;
  undelivered_tool_calls: number;
  chunk_count: number;
  tokens: TokenTotals;
  events_by_type: Record<string, number>;
  by_tool: Record<string, ToolStat>;
}

export interface ReportOutcome {
  status: OutcomeStatus;
  exit_code: number;
  reason: string;
  complete: boolean;
  undelivered_tool_calls: string[];
  error: { code: string; message: string; status?: number; requestId?: string } | null;
}

export interface Report {
  schema_version: number;
  plugin: {
    name: string;
    version: string;
  };
  generated_at: number;
  session: SessionSummary;
  outcome: ReportOutcome;
  stats: ReportStats;
  events: Array<Record<string, unknown>>;
  events_truncated: { kept: number; total: number; dropped: number } | null;
  artifacts: ArtifactEntry[];
}

/* ------------------------------------------------------------------ *
 * JSON safety.
 * ------------------------------------------------------------------ */

export class JsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsonError';
  }
}

/**
 * Recursively verify that a value is losslessly JSON-serializable and that
 * every number is finite. Throws JsonError otherwise. Used before any output
 * is written so malformed data can never reach a file. Class instances
 * (Date, Map, Set, ...) are rejected: JSON.stringify would silently degrade
 * them into `{}` / `[]`.
 */
export function assertJsonSafe(value: unknown, path = '$'): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new JsonError(`${path}: non-finite number`);
    return;
  }
  if (typeof value === 'bigint') throw new JsonError(`${path}: bigint is not JSON-serializable`);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonSafe(entry, `${path}[${index}]`));
    return;
  }
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new JsonError(`${path}: unsupported object instance (${proto?.constructor?.name ?? 'unknown'})`);
    }
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      assertJsonSafe(entry, `${path}.${key}`);
    }
    return;
  }
  throw new JsonError(`${path}: unsupported value of type ${typeof value}`);
}

/** Round a number to 3 decimal places (millisecond precision for latencies). */
export function round3(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

/** Round a number to 3 decimal places, or null when the input is null. */
export function round3OrNull(value: number | null): number | null {
  return value === null ? null : round3(value);
}

/** Build a map object with sorted keys (deterministic JSON order). */
export function sortedMap<T>(input: Map<string, T> | Record<string, T>): Record<string, T> {
  const entries = input instanceof Map ? [...input.entries()] : Object.entries(input);
  const output: Record<string, T> = {};
  for (const [key, value] of [...entries].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    output[key] = value;
  }
  return output;
}