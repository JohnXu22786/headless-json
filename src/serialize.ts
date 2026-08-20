/**
 * Output serialization: turns a capture event into a redacted, JSON-safe,
 * deterministically-keyed object. This is the single surface where privacy
 * settings are enforced for every output format (JSON report, NDJSON lines,
 * and — indirectly — the rebuilt report used by the CLI).
 */

import type { CaptureEvent, ToolResultEvent, ToolCallEvent, AssistantMessageEvent } from './model.js';
import { round3, round3OrNull } from './model.js';
import type { Options } from './options.js';
import { redactText, summarizeArgsText, sanitizeArgsTree } from './redact.js';

/** Serialize one capture event with the configured redaction applied. */
export function serializeEvent(event: CaptureEvent, options: Options): Record<string, unknown> {
  const redact = options.redact;
  const base: Record<string, unknown> = {
    seq: event.seq,
    time: event.time,
    kind: event.kind,
  };
  switch (event.kind) {
    case 'turn_start':
      return { ...base, turn: event.turn };
    case 'turn_end':
      return {
        ...base,
        turn: event.turn,
        reason: event.reason,
        error: event.error === null
          ? null
          : {
              code: event.error.code,
              // Error messages are free text (provider failures may echo
              // credentials) and go through the same redaction pipeline.
              message: redactText(event.error.message, redact),
              ...(finiteNum(event.error.status) ? { status: event.error.status } : {}),
              ...(typeof event.error.requestId === 'string' ? { requestId: event.error.requestId } : {}),
            },
        cause: event.cause,
        latency_ms: round3OrNull(event.latency_ms),
        complete: event.complete,
      };
    case 'step_start':
      return { ...base, turn: event.turn, step: event.step };
    case 'step_end':
      return { ...base, turn: event.turn, step: event.step, latency_ms: round3OrNull(event.latency_ms) };
    case 'user_message':
      return {
        ...base,
        turn: event.turn,
        step: event.step,
        text: redactText(event.text, redact),
        reasoning: redactText(event.reasoning, redact),
        blocks: serializeBlocks(event.blocks),
      };
    case 'assistant_message':
      return serializeAssistant(event, options);
    case 'tool_call':
      return serializeToolCall(event, options);
    case 'tool_result':
      return serializeToolResult(event, options);
    case 'todo_write':
      return {
        ...base,
        count: event.count,
        todos: event.todos.map((todo) => ({ content: redactText(todo.content, redact), status: todo.status })),
      };
    case 'request_context':
      return { ...base, provider: event.provider, model: event.model, context_window: event.context_window };
    case 'other':
      return { ...base, type: event.type };
  }
}

function serializeBlocks(blocks: AssistantMessageEvent['blocks']): Record<string, number> {
  return { text: blocks.text, reasoning: blocks.reasoning, image: blocks.image, other: blocks.other };
}

function serializeAssistant(event: AssistantMessageEvent, options: Options): Record<string, unknown> {
  const usage: Record<string, number> = {
    input: round3(event.usage.input),
    output: round3(event.usage.output),
    cache_read: round3(event.usage.cache_read),
    cache_write: round3(event.usage.cache_write),
    reasoning: round3(event.usage.reasoning),
  };
  return {
    seq: event.seq,
    time: event.time,
    kind: event.kind,
    turn: event.turn,
    step: event.step,
    provider: event.provider,
    model: event.model,
    latency_ms: round3OrNull(event.latency_ms),
    usage,
    text: redactText(event.text, options.redact),
    reasoning: redactText(event.reasoning, options.redact),
    blocks: serializeBlocks(event.blocks),
    stream: {
      chunk_count: event.stream.chunk_count,
      first_chunk_at: event.stream.first_chunk_at,
      last_chunk_at: event.stream.last_chunk_at,
    },
  };
}

function serializeToolCall(event: ToolCallEvent, options: Options): Record<string, unknown> {
  const redact = options.redact;
  const args = event.args_mode === 'full' && event.args !== null ? sanitizeArgsTree(event.args, redact) : null;
  const summary =
    event.args_mode === 'hidden' ? '[hidden]' : event.args_mode === 'truncate' ? summarizeArgsText(event.args_summary, redact) : '';
  return {
    seq: event.seq,
    time: event.time,
    kind: event.kind,
    turn: event.turn,
    step: event.step,
    call_id: event.call_id,
    tool: event.tool,
    args_mode: event.args_mode,
    args,
    args_summary: summary,
    latency_ms: round3OrNull(event.latency_ms),
    undelivered: event.undelivered,
  };
}

function serializeToolResult(event: ToolResultEvent, options: Options): Record<string, unknown> {
  return {
    seq: event.seq,
    time: event.time,
    kind: event.kind,
    turn: event.turn,
    step: event.step,
    call_id: event.call_id,
    tool: event.tool,
    status: event.status,
    latency_ms: round3OrNull(event.latency_ms),
    text: redactText(event.text, options.redact),
    blocks: serializeBlocks(event.blocks),
    error: event.error === null ? null : { name: event.error.name, code: event.error.code },
  };
}

/** Serialize one event to a single NDJSON line. */
export function serializeEventLine(event: CaptureEvent, options: Options): string {
  return JSON.stringify(serializeEvent(event, options));
}

/** Build the trailing `session_end` NDJSON line written at finalize. */
export function sessionEndLine(
  sessionId: string,
  generatedAt: number,
  outcome: { status: string; exit_code: number; reason: string },
  stats: { duration_ms: number; turns: number; steps: number; tool_calls: number; tool_errors: number },
): string {
  const line = {
    kind: 'session_end',
    session_id: sessionId,
    generated_at: generatedAt,
    outcome: {
      status: outcome.status,
      exit_code: outcome.exit_code,
      reason: outcome.reason,
    },
    stats: {
      duration_ms: round3(stats.duration_ms),
      turns: stats.turns,
      steps: stats.steps,
      tool_calls: stats.tool_calls,
      tool_errors: stats.tool_errors,
    },
  };
  return JSON.stringify(line);
}

/** Finite-number guard for optional numeric fields. */
function finiteNum(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}