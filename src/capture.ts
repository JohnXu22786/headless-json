/**
 * Capture: ingests the raw dsh session event stream and derives the
 * structured, JSON-safe event model that every output format is built from.
 *
 * The capture is written to be defensive: every field of an incoming event is
 * read through runtime guards, so a structurally unexpected event can never
 * crash the capture or poison the outputs. Events it cannot classify still
 * count toward the type distribution and (opt-in) surface as `other` events.
 */

import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import type { Options } from './options.js';
import {
  contentText,
  countBlocks,
  isRecord,
  messageContent,
  messageModel,
  normalizeReason,
  num,
  payloadMessage,
  str,
  toolError,
  isToolError,
  type ContentBlockShape,
  type SessionHeaderShape,
} from './types.js';
import {
  evAssistantMessage,
  evOther,
  evRequestContext,
  evStepEnd,
  evStepStart,
  evTodoWrite,
  evToolCall,
  evToolResult,
  evTurnEnd,
  evTurnStart,
  evUserMessage,
  type ArtifactEntry,
  type BlockCountSummary,
  type CaptureEvent,
  type StreamSummary,
  type ToolCallEvent,
  type TodoEntry,
  type TurnErrorShape,
  type UsageSummary,
} from './model.js';
import { extractPaths } from './artifacts.js';
import { serializeEventLine } from './serialize.js';
import type { LineWriter } from './io.js';
import { truncateText } from './redact.js';

/** Immutable session identity/metadata for the capture. */
export interface CaptureMeta {
  id: string;
  cwd: string;
  created_at: number;
  parent_session: string | null;
  agent_preset: string | null;
  delegation_depth: number | null;
}

/** Build a CaptureMeta from a SessionHeader-shaped object (defensive). */
export function metaFromHeader(header: SessionHeaderShape): CaptureMeta {
  return {
    id: str(header.id, 'unknown'),
    cwd: typeof header.cwd === 'string' && header.cwd.length > 0 ? header.cwd : process.cwd(),
    created_at: num(header.createdAt, Date.now()),
    parent_session: typeof header.parentSession === 'string' ? header.parentSession : null,
    agent_preset: typeof header.agentPreset === 'string' ? header.agentPreset : null,
    delegation_depth: typeof header.delegationDepth === 'number' && Number.isFinite(header.delegationDepth) ? header.delegationDepth : null,
  };
}

/** Mutable reference to the effective options (updated by set_options). */
export interface OptionsRef {
  current: Options;
}

interface PendingTool {
  call: ToolCallEvent;
  at: number;
}

interface ChunkAgg {
  count: number;
  first: number;
  last: number;
}

interface ArtifactInternal {
  abs: string;
  kind: 'file' | 'dir' | 'missing' | 'unknown';
  size: number | null;
  count: number;
}

interface TokenMerger {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

function emptyTokens(): TokenMerger {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

function tokensToSummary(t: TokenMerger): UsageSummary {
  return {
    input: t.input,
    output: t.output,
    cache_read: t.cacheRead,
    cache_write: t.cacheWrite,
    reasoning: t.reasoning,
  };
}

function usageFromRaw(usage: Record<string, unknown>): TokenMerger {
  const tokens = emptyTokens();
  tokens.input += firstDefined(usage, ['inputTokens', 'input']);
  tokens.output += firstDefined(usage, ['outputTokens', 'output']);
  tokens.cacheRead += firstDefined(usage, ['cacheReadTokens', 'cache_read']);
  tokens.cacheWrite += firstDefined(usage, ['cacheWriteTokens', 'cache_write']);
  tokens.reasoning += firstDefined(usage, ['reasoningTokens', 'reasoning']);
  return tokens;
}

/** Read the first defined numeric alias; never double-counts same concept. */
function firstDefined(record: Record<string, unknown>, keys: readonly string[]): number {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return 0;
}

function addTokens(target: TokenMerger, source: TokenMerger): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.reasoning += source.reasoning;
}

const TODO_CAP = 100;

/**
 * One session's derived, structured view of the raw event stream.
 */
export class Capture {
  readonly meta: CaptureMeta;
  private readonly optionsRef: OptionsRef;
  private events: CaptureEvent[] = [];
  private sortedCache: CaptureEvent[] | null = null;
  private pendingTools = new Map<string, PendingTool>();
  private turnsOpen = new Map<number, number>();
  private stepsOpen = new Map<string, number>();
  private chunkAgg = new Map<string, ChunkAgg>();
  private stepUsage = new Map<string, TokenMerger>();
  private tokenSum = emptyTokens();
  private chunkTotal = 0;
  private refTime: number | null = null;
  private lastModel: { provider: string; model: string } | null = null;
  private lastTurn = 0;
  private lastStep = 0;
  private lastUsedTime = Date.now();
  private artifactMap = new Map<string, ArtifactInternal>();
  private typeCounts = new Map<string, number>();
  private counts = {
    turns: 0,
    steps: 0,
    assistantMessages: 0,
    userMessages: 0,
    toolCalls: 0,
    toolErrors: 0,
    todoWrites: 0,
    requestContexts: 0,
  };
  private streamWriter: LineWriter | null = null;
  private closed = false;

  constructor(meta: CaptureMeta, optionsRef: OptionsRef) {
    this.meta = meta;
    this.optionsRef = optionsRef;
  }

  get id(): string {
    return this.meta.id;
  }

  get eventCount(): number {
    return this.events.length;
  }

  get finalized(): boolean {
    return this.closed;
  }

  /** Assign the NDJSON writer once the manager decides streaming is active. */
  setStreamWriter(writer: LineWriter | null): void {
    this.streamWriter = writer;
  }

  /** Whether a live NDJSON writer is attached. */
  get streamActive(): boolean {
    return this.streamWriter !== null;
  }

  /** Detach and close the live writer (used when ndjson is toggled off). */
  async detachStream(): Promise<void> {
    const writer = this.streamWriter;
    if (writer === null) return;
    this.streamWriter = null;
    await writer.close();
  }

  /** Ingest one raw dsh session event (defensive; never throws). */
  ingest(raw: unknown): void {
    if (!isRecord(raw)) return;
    const type = str(raw['type'], '');
    const seq = num(raw['seq'], this.events.length);
    // A missing/malformed timestamp falls back to the previous event's time so
    // outputs stay deterministic for the same stream; the very first fallback
    // uses the capture's creation time.
    const time = num(raw['time'], this.lastUsedTime);
    this.lastUsedTime = time;
    const data = raw['data'];
    this.typeCounts.set(type, (this.typeCounts.get(type) ?? 0) + 1);
    try {
      this.route(type, seq, time, data);
    } catch (caught) {
      // A malformed event must not take down the capture; it still counts.
      this.pushAndStream(evOther(seq, time, type));
    }
  }

  private route(type: string, seq: number, time: number, data: unknown): void {
    switch (type) {
      case 'turn/start': {
        const turn = num(isRecord(data) ? data['turn'] : undefined, this.lastTurn);
        this.lastTurn = turn;
        this.turnsOpen.set(turn, time);
        // Latency of the first step of a turn is measured from turn start
        // until a user message (if any) resets the reference point.
        this.refTime = time;
        this.counts.turns += 1;
        this.pushAndStream(evTurnStart(seq, time, turn));
        return;
      }
      case 'turn/end': {
        const record = isRecord(data) ? data : {};
        const turn = num(record['turn'], this.lastTurn);
        const reason = normalizeReason(record['reason']);
        const start = this.turnsOpen.get(turn);
        const latencyMs = start === undefined ? null : time - start;
        this.turnsOpen.delete(turn);
        const error: TurnErrorShape | null =
          reason.error !== undefined
            ? {
                code: reason.error.code ?? 'UNKNOWN',
                message: reason.error.message ?? '',
                ...(reason.error.status !== undefined ? { status: reason.error.status } : {}),
                ...(reason.error.requestId !== undefined ? { requestId: reason.error.requestId } : {}),
              }
            : null;
        const cause = reason.reason?.kind ?? null;
        this.pushAndStream(evTurnEnd(seq, time, turn, reason.kind, error, cause, latencyMs, true));
        return;
      }
      case 'step/start': {
        const record = isRecord(data) ? data : {};
        const turn = num(record['turn'], this.lastTurn);
        const step = num(record['step'], this.lastStep);
        this.lastTurn = turn;
        this.lastStep = step;
        this.stepsOpen.set(`${turn}:${step}`, time);
        this.counts.steps += 1;
        this.pushAndStream(evStepStart(seq, time, turn, step));
        return;
      }
      case 'step/end': {
        const record = isRecord(data) ? data : {};
        const turn = num(record['turn'], this.lastTurn);
        const step = num(record['step'], this.lastStep);
        const start = this.stepsOpen.get(`${turn}:${step}`);
        const latencyMs = start === undefined ? null : time - start;
        this.stepsOpen.delete(`${turn}:${step}`);
        this.pushAndStream(evStepEnd(seq, time, turn, step, latencyMs));
        return;
      }
      case 'user/message': {
        const message = isRecord(data) ? data : {};
        const blocks = messageContent(message);
        const text = this.cap(contentText(blocks, 'text'));
        const reasoning = this.cap(contentText(blocks, 'reasoning'));
        this.collectArtifacts(text);
        this.refTime = time;
        this.counts.userMessages += 1;
        this.pushAndStream(evUserMessage(seq, time, this.lastTurn, this.lastStep, text, reasoning, summarizeCounts(blocks)));
        return;
      }
      case 'assistant/chunk': {
        const record = isRecord(data) ? data : {};
        const turn = num(record['turn'], this.lastTurn);
        const step = num(record['step'], this.lastStep);
        const chunk = record['chunk'];
        const key = `${turn}:${step}`;
        const agg = this.chunkAgg.get(key) ?? { count: 0, first: time, last: time };
        agg.count += 1;
        if (time < agg.first) agg.first = time;
        agg.last = time;
        this.chunkAgg.set(key, agg);
        this.chunkTotal += 1;
        if (isRecord(chunk) && chunk['type'] === 'usage' && isRecord(chunk['usage'])) {
          const merger = this.stepUsage.get(key) ?? emptyTokens();
          addTokens(merger, usageFromRaw(chunk['usage'] as Record<string, unknown>));
          this.stepUsage.set(key, merger);
        }
        return;
      }
      case 'assistant/message': {
        const record = isRecord(data) ? data : {};
        const turn = num(record['turn'], this.lastTurn);
        const step = num(record['step'], this.lastStep);
        const message = payloadMessage(data);
        const blocks = messageContent(message);
        const text = this.cap(contentText(blocks, 'text'));
        const reasoning = this.cap(contentText(blocks, 'reasoning'));
        this.collectArtifacts(text);
        const model = messageModel(message) ?? this.lastModel;
        const key = `${turn}:${step}`;
        const usageData = isRecord(record['usage']) ? (record['usage'] as Record<string, unknown>) : null;
        const stepMerger = this.stepUsage.get(key);
        const perMessage: TokenMerger = usageData !== null ? usageFromRaw(usageData) : stepMerger ?? emptyTokens();
        addTokens(this.tokenSum, perMessage);
        this.stepUsage.delete(key);
        const agg = this.chunkAgg.get(key);
        const stream: StreamSummary = agg
          ? { chunk_count: agg.count, first_chunk_at: agg.first, last_chunk_at: agg.last }
          : { chunk_count: 0, first_chunk_at: null, last_chunk_at: null };
        this.chunkAgg.delete(key);
        const latencyMs = this.refTime === null ? null : time - this.refTime;
        this.refTime = time;
        this.counts.assistantMessages += 1;
        this.pushAndStream(
          evAssistantMessage(
            seq,
            time,
            turn,
            step,
            model?.provider ?? null,
            model?.model ?? null,
            latencyMs,
            tokensToSummary(perMessage),
            text,
            reasoning,
            summarizeCounts(blocks),
            stream,
          ),
        );
        return;
      }
      case 'tool/call': {
        const record = isRecord(data) ? data : {};
        const turn = num(record['turn'], this.lastTurn);
        const step = num(record['step'], this.lastStep);
        const callId = str(record['callId'], `call-${seq}`);
        const tool = str(record['name'], 'unknown');
        const argText = str(record['arguments'], '');
        const parsed = parseArgs(argText);
        const requestedMode = this.optionsRef.current.redact.args;
        const mode = requestedMode === 'hide' ? 'hidden' : requestedMode;
        const effectiveMode = parsed === null && mode !== 'hidden' ? 'truncate' : mode;
        const argsSummary = effectiveMode === 'truncate' ? this.cap(argText) : '';
        const event = evToolCall(seq, time, turn, step, callId, tool, parsed, argsSummary, effectiveMode);
        this.pendingTools.set(callId, { call: event, at: time });
        this.counts.toolCalls += 1;
        this.pushAndStream(event);
        return;
      }
      case 'tool/result': {
        const record = isRecord(data) ? data : {};
        const turn = num(record['turn'], this.lastTurn);
        const step = num(record['step'], this.lastStep);
        const message = payloadMessage(data);
        const source = isRecord(message) ? message['source'] : undefined;
        const callIdMeta = isRecord(source) ? source['callId'] : undefined;
        const callId = typeof callIdMeta === 'string' ? callIdMeta : `call-${seq}`;
        const blocks = unwrapToolResultBlocks(messageContent(message));
        const text = this.cap(contentText(blocks, 'text'));
        const failed = isToolError(data);
        const error = failed ? toolError(data) : null;
        const pending = this.pendingTools.get(callId);
        const durationMs = pending === undefined ? null : time - pending.at;
        if (pending !== undefined) {
          pending.call.latency_ms = durationMs;
          this.pendingTools.delete(callId);
        }
        if (failed) this.counts.toolErrors += 1;
        this.collectArtifacts(text);
        this.pushAndStream(
          evToolResult(
            seq,
            time,
            turn,
            step,
            callId,
            pending?.call.tool ?? 'unknown',
            failed ? 'error' : 'success',
            durationMs,
            text,
            summarizeCounts(blocks),
            error,
          ),
        );
        return;
      }
      case 'todo/write': {
        const record = isRecord(data) ? data : {};
        const todos = Array.isArray(record['todos']) ? (record['todos'] as unknown[]) : [];
        const items: TodoEntry[] = todos.slice(0, TODO_CAP).map((todo) => {
          const t = isRecord(todo) ? todo : {};
          return { content: this.cap(str(t['content'], '')), status: str(t['status'], 'unknown') };
        });
        this.counts.todoWrites += 1;
        this.pushAndStream(evTodoWrite(seq, time, todos.length, items));
        return;
      }
      case 'request/context': {
        const record = isRecord(data) ? data : {};
        const provider = str(record['provider'], 'unknown');
        const model = str(record['model'], 'unknown');
        this.lastModel = { provider, model };
        const windowValue = record['contextWindow'];
        const window = typeof windowValue === 'number' && Number.isFinite(windowValue) ? windowValue : null;
        this.counts.requestContexts += 1;
        this.pushAndStream(evRequestContext(seq, time, provider, model, window));
        return;
      }
      default: {
        // Log-only or unknown types: counted, and surfaced when configured.
        if (this.optionsRef.current.events.include_log_only) {
          this.pushAndStream(evOther(seq, time, type));
        }
        return;
      }
    }
  }

  /** Push an event onto the list and stream it live when NDJSON is active. */
  private pushAndStream(event: CaptureEvent): void {
    this.events.push(event);
    this.sortedCache = null;
    const writer = this.streamWriter;
    if (writer === null) return;
    // Serialization is isolated from the event model: a line that cannot be
    // serialized (e.g. pathological input) drops only the line, never the
    // in-memory event or any downstream report.
    let line: string;
    try {
      line = serializeEventLine(event, this.optionsRef.current);
    } catch {
      return;
    }
    writer.write(line).catch(() => {
      // Streaming failures are contained; the in-memory capture is unaffected.
      this.streamWriter = null;
    });
  }

  private cap(text: string): string {
    const cap = this.optionsRef.current.capture.text_cap;
    return truncateText(text, cap);
  }

  /** Scan a text for artifact candidates and update the manifest. */
  private collectArtifacts(text: string): void {
    const options = this.optionsRef.current;
    if (!options.artifacts.collect) return;
    if (text.length === 0) return;
    let candidates: string[];
    try {
      candidates = extractPaths(text, options.artifacts.pattern_extras);
    } catch {
      return;
    }
    const cwd = this.meta.cwd;
    const maxEntries = options.artifacts.max_entries;
    for (const candidate of candidates) {
      const key = candidate.replace(/\\/g, '/');
      const existing = this.artifactMap.get(key);
      if (existing !== undefined) {
        existing.count += 1;
        continue;
      }
      if (this.artifactMap.size >= maxEntries) continue;
      const abs = isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
      let kind: 'file' | 'dir' | 'missing' | 'unknown' = 'unknown';
      let size: number | null = null;
      if (options.artifacts.check_exists) {
        try {
          const stat = statSync(abs);
          kind = stat.isDirectory() ? 'dir' : 'file';
          size = stat.size;
        } catch (caught) {
          const code = (caught as NodeJS.ErrnoException).code;
          kind = code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unknown';
        }
      }
      this.artifactMap.set(key, { abs, kind, size, count: 1 });
    }
  }

  /** The captured events in stable seq order. */
  private sortedEvents(): CaptureEvent[] {
    if (this.sortedCache === null) {
      const sorted = this.events.slice();
      sorted.sort((a, b) => a.seq - b.seq);
      this.sortedCache = sorted;
    }
    return this.sortedCache;
  }

  /** Mark tool calls that never received a result as undelivered. */
  private markUndelivered(): void {
    for (const pending of this.pendingTools.values()) {
      pending.call.undelivered = true;
    }
  }

  /** Flush any pending NDJSON writes (session/flush checkpoint). */
  async flushStream(): Promise<void> {
    await this.streamWriter?.flush();
  }

  /**
   * Finalize the capture: mark undelivered calls and produce the materialized
   * snapshot consumed by report writers and the CLI. Safe to call repeatedly.
   */
  materialize(): {
    meta: CaptureMeta;
    events: CaptureEvent[];
    artifacts: ArtifactEntry[];
    typeCounts: Record<string, number>;
    chunkTotal: number;
  } {
    this.markUndelivered();
    const events = this.sortedEvents();
    const artifacts: ArtifactEntry[] = [];
    for (const [key, entry] of this.artifactMap) {
      artifacts.push({ path: key, kind: entry.kind, size: entry.size, references: entry.count });
    }
    artifacts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const typeCounts: Record<string, number> = {};
    for (const [type, count] of [...this.typeCounts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
      typeCounts[type] = count;
    }
    return {
      meta: this.meta,
      events,
      artifacts,
      typeCounts,
      chunkTotal: this.chunkTotal,
    };
  }

  /** Write the trailing session_end line (if any) and close the NDJSON writer. */
  async closeStream(trailerLine: string | null): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const writer = this.streamWriter;
    if (writer !== null) {
      if (trailerLine !== null) await writer.write(trailerLine).catch(() => undefined);
      await writer.close();
      this.streamWriter = null;
    }
  }

  /** Undelivered tool-call ids in seq order (never throws). */
  undeliveredCallIds(): string[] {
    const events = this.sortedEvents();
    const results = new Set<string>();
    const calls: string[] = [];
    for (const event of events) {
      if (event.kind === 'tool_result') results.add(event.call_id);
      if (event.kind === 'tool_call') calls.push(event.call_id);
    }
    return calls.filter((callId) => !results.has(callId));
  }

  /** Live status summary for the output_status tool. */
  statusSummary(): Record<string, unknown> {
    return {
      active: !this.closed,
      session_id: this.meta.id,
      cwd: this.meta.cwd,
      events: this.eventCount,
      turns: this.counts.turns,
      steps: this.counts.steps,
      assistant_messages: this.counts.assistantMessages,
      user_messages: this.counts.userMessages,
      tool_calls: this.counts.toolCalls,
      tool_errors: this.counts.toolErrors,
      undelivered_tool_calls: this.undeliveredCallIds().length,
      pending_tool_calls: this.pendingTools.size,
      tokens: tokensToSummary(this.tokenSum),
      redact: {
        text_length: this.optionsRef.current.redact.text_length,
        args: this.optionsRef.current.redact.args,
        paths: this.optionsRef.current.redact.paths,
        secrets: this.optionsRef.current.redact.secrets,
      },
      ndjson: this.streamWriter !== null,
    };
  }

  /** Filtered event view for the output_events tool. */
  eventsView(types: string[] | null, since: number | null, limit: number | null): CaptureEvent[] {
    let result = this.sortedEvents();
    if (types !== null && types.length > 0) {
      const wanted = new Set(types);
      result = result.filter((event) => wanted.has(event.kind));
    }
    if (since !== null) {
      result = result.filter((event) => event.seq >= since);
    }
    const max = limit === null ? 200 : limit;
    if (result.length > max) result = result.slice(0, max);
    return result;
  }
}

function summarizeCounts(blocks: ContentBlockShape[]): BlockCountSummary {
  const counts = countBlocks(blocks);
  return { text: counts.text, reasoning: counts.reasoning, image: counts.image, other: counts.other };
}

/**
 * A tool-result message wraps its real content blocks inside a single
 * `tool-result` shell block; descend into it so the result text is readable.
 */
function unwrapToolResultBlocks(blocks: ContentBlockShape[]): ContentBlockShape[] {
  if (blocks.length === 1) {
    const shell = blocks[0];
    if (shell !== undefined && shell.type === 'tool-result' && Array.isArray(shell.content)) {
      return shell.content.filter((block): block is ContentBlockShape => isRecord(block));
    }
  }
  return blocks;
}

function parseArgs(argText: string): unknown {
  if (argText.trim() === '') return {};
  try {
    return JSON.parse(argText);
  } catch {
    return null;
  }
}