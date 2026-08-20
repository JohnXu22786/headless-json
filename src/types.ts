/**
 * Minimal structural types for the DSH session event stream.
 *
 * These describe the *published* dsh protocol shapes (session log events,
 * messages, content blocks, token usage) that this plugin consumes. They are
 * deliberately minimal and every access is re-checked defensively at runtime
 * by the capture pipeline, so the plugin tolerates missing or extra fields on
 * any event.
 */

/** One raw entry of the append-only session log. */
export interface DshSessionEvent {
  type: string;
  seq: number;
  time: number;
  data: unknown;
  sourceEventSeqs?: number[];
  surfaceOp?: unknown;
}

/** Why a turn ended, flattened to the fields we surface. */
export interface TurnEndReasonShape {
  kind: string;
  /** Present when kind === 'error'. */
  error?: {
    code?: string;
    message?: string;
    status?: number;
    requestId?: string;
  };
  /** Present when kind === 'aborted'. */
  reason?: {
    kind?: string;
  };
}

/** Token accounting for one model call. */
export interface TokenUsageShape {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

/** Immutable session metadata found on the SessionHeader. */
export interface SessionHeaderShape {
  version?: number;
  id?: string;
  createdAt?: number;
  cwd?: string;
  parentSession?: string;
  seedLength?: number;
  origin?: string;
  delegationDepth?: number;
  agentPreset?: string;
}

/** A "tool-result" content block carries nested content plus an error flag. */
export interface ContentBlockShape {
  type: string;
  text?: unknown;
  content?: unknown;
  isError?: unknown;
  id?: unknown;
  name?: unknown;
  arguments?: unknown;
  [key: string]: unknown;
}

/** Type guard: is this value a plain object record? */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Extract the content array of a message-like object. */
export function messageContent(message: unknown): ContentBlockShape[] {
  if (!isRecord(message)) return [];
  const content = message['content'];
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is ContentBlockShape => isRecord(block));
}

/** Extract the `message` field of an event payload object. */
export function payloadMessage(data: unknown): Record<string, unknown> | null {
  if (!isRecord(data)) return null;
  const message = data['message'];
  return isRecord(message) ? message : null;
}

/**
 * Join the text (or reasoning) blocks of a message into one string.
 * Unknown / non-string block text is skipped rather than stringified so the
 * pipeline never vomits arbitrary objects into the output.
 */
export function contentText(blocks: ContentBlockShape[], want: 'text' | 'reasoning'): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type !== want) continue;
    const text = block.text;
    if (typeof text !== 'string') continue;
    parts.push(text);
  }
  return parts.join('\n');
}

/** Count content blocks by category. */
export interface BlockCounts {
  text: number;
  reasoning: number;
  image: number;
  other: number;
  total: number;
}

/** Count content blocks by category. Unknown block types count as `other`. */
export function countBlocks(blocks: readonly unknown[]): BlockCounts {
  const counts: BlockCounts = { text: 0, reasoning: 0, image: 0, other: 0, total: blocks.length };
  for (const unknownBlock of blocks) {
    const block = isRecord(unknownBlock) ? (unknownBlock as ContentBlockShape) : null;
    if (block === null) {
      counts.other += 1;
      continue;
    }
    switch (block.type) {
      case 'text':
        counts.text += 1;
        break;
      case 'reasoning':
        counts.reasoning += 1;
        break;
      case 'image':
        counts.image += 1;
        break;
      default:
        counts.other += 1;
    }
  }
  return counts;
}

/** Safe integer reading with fallback. */
export function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Safe string reading with fallback. */
export function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** Read the normalized tool result error identity `{ name, code }`. */
export function toolError(data: unknown): { name: string; code: string } {
  const error = isRecord(data) && isRecord(data['error']) ? (data['error'] as Record<string, unknown>) : null;
  const name = error ? str(error['name'], 'UNKNOWN') : 'UNKNOWN';
  const code = error ? str(error['code'], 'UNKNOWN') : 'UNKNOWN';
  return { name, code };
}

/** True when a tool-result message block (or payload) marks the call failed. */
export function isToolError(data: unknown): boolean {
  // An explicit `error: null` means "no error" — only a non-null present error
  // (or an isError content block) marks a failure.
  if (isRecord(data) && data['error'] !== undefined && data['error'] !== null) return true;
  const message = payloadMessage(data);
  if (!message) return false;
  const content = messageContent(message);
  if (content.length === 0) return false;
  const first = content[0];
  if (first?.isError === true) return true;
  // Nested tool-result blocks may carry isError on their own nested content.
  if (Array.isArray(first.content)) {
    for (const nested of first.content as unknown[]) {
      if (isRecord(nested) && nested['isError'] === true) return true;
    }
  }
  return false;
}

/** Read provider/model from an assistant message source when available. */
export function messageModel(message: Record<string, unknown> | null): { provider: string; model: string } | null {
  if (!message) return null;
  const source = message['source'];
  if (!isRecord(source)) return null;
  const provider = source['provider'];
  const model = source['model'];
  if (typeof provider !== 'string' || typeof model !== 'string') return null;
  if (provider.length === 0 || model.length === 0) return null;
  return { provider, model };
}

/** Flatten a turn/end reason payload to our minimal shape. */
export function normalizeReason(reason: unknown): TurnEndReasonShape {
  if (!isRecord(reason)) return { kind: 'unknown' };
  const kind = str(reason['kind'], 'unknown');
  const error = isRecord(reason['error']) ? (reason['error'] as Record<string, unknown>) : undefined;
  const abort = isRecord(reason['reason']) ? (reason['reason'] as Record<string, unknown>) : undefined;
  const normalized: TurnEndReasonShape = { kind };
  if (error) {
    normalized.error = {
      code: str(error['code'], 'UNKNOWN'),
      message: typeof error['message'] === 'string' ? error['message'] : '',
      ...(typeof error['status'] === 'number' ? { status: error['status'] } : {}),
      ...(typeof error['requestId'] === 'string' ? { requestId: error['requestId'] } : {}),
    };
  }
  if (abort && typeof abort['kind'] === 'string') normalized.reason = { kind: abort['kind'] };
  return normalized;
}