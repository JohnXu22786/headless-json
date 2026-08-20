/**
 * The three dsh tools this plugin contributes: `output_status`,
 * `output_events` and `set_options`.
 *
 * Definitions are plain data objects that satisfy the shape the dsh tools
 * registry (`ctx.tools.register`) consumes (tool schema DSL for `parameters`,
 * a raw JSON-Schema node for `output.schema`, and pure `execute`/`render`
 * callbacks). No schema library is required.
 */

import type { Capture } from './capture.js';
import type { Options } from './options.js';
import { applyPatch } from './options.js';
import { serializeEvent } from './serialize.js';
import { isRecord } from './types.js';

/** Host interface the manager implements: capture lookup + option patching. */
export interface ToolHost {
  /** Resolve the capture for a tool execution context, or null. */
  captureFor(exec: unknown): Capture | null;
  /** Current effective options. */
  options(): Options;
  /** Validate and apply an options patch; returns the new effective options. */
  applyPatch(patch: unknown): Options;
}

/** Minimal structural shape of a dsh tool definition (`ToolDefinition`). */
export interface DshToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: {
    schema: Record<string, unknown>;
    render(args: unknown, value: unknown): unknown[];
    presentationMeta?(args: unknown, value: unknown): unknown;
  };
  execute(args: unknown, exec: unknown): Promise<unknown>;
  timeoutMs?: number;
  isConcurrencySafe?(args: unknown): boolean;
}

function jsonContent(value: unknown): unknown[] {
  return [{ type: 'text', text: JSON.stringify(value) }];
}

const OBJECT_SCHEMA: Record<string, unknown> = { type: 'object', additionalProperties: true, description: 'Any JSON object.' };

/**
 * Report the live capture status of the structured CI output plugin: current
 * event/turn/tool counts, pending tool calls, redaction settings and whether
 * the NDJSON stream is active.
 */
export function defineOutputStatus(host: ToolHost): DshToolDefinition {
  return {
    name: 'output_status',
    description: 'Report the live status of the structured CI output capture for the current session (event counts, pending tool calls, redaction settings, streaming state).',
    parameters: {},
    output: {
      schema: OBJECT_SCHEMA,
      render: (_args, value) => jsonContent(value),
    },
    execute: async (_args, exec) => {
      const capture = host.captureFor(exec);
      if (capture === null) {
        throw new Error('no session context is available; dsh-headless-json cannot resolve the active capture');
      }
      return capture.statusSummary();
    },
  };
}

/** Filter params for `output_events`. */
export function defineOutputEvents(host: ToolHost): DshToolDefinition {
  return {
    name: 'output_events',
    description: 'Return the structured events captured so far for the current session, optionally filtered by kind (e.g. tool_call, tool_result, assistant_message), minimum sequence number, and a result limit.',
    parameters: {
      types: {
        type: 'array',
        items: { type: 'string' },
        description: 'Event kinds to include; omit for all.',
      },
      since: {
        type: 'integer',
        description: 'Only events with seq >= this value.',
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of events to return (default 200).',
      },
    },
    output: {
      schema: { type: 'array', items: OBJECT_SCHEMA, description: 'The requested event objects.' },
      render: (_args, value) => jsonContent(value),
      presentationMeta: (_args, value) => ({ count: Array.isArray(value) ? value.length : 0 }),
    },
    execute: async (args, exec) => {
      const capture = host.captureFor(exec);
      if (capture === null) {
        throw new Error('no session context is available; dsh-headless-json cannot resolve the active capture');
      }
      const a = isRecord(args) ? args : {};
      let types: string[] | null = null;
      if (Array.isArray(a['types'])) types = a['types'].filter((entry): entry is string => typeof entry === 'string');
      const since = typeof a['since'] === 'number' ? a['since'] : null;
      const limit = typeof a['limit'] === 'number' ? a['limit'] : null;
      const events = capture.eventsView(types, since, limit);
      return events.map((event) => serializeEvent(event, host.options()));
    },
  };
}

/** Runtime option patch for the current session's output configuration. */
export function defineSetOptions(host: ToolHost): DshToolDefinition {
  return {
    name: 'set_options',
    description:
      'Adjust the structured output configuration for the current session at runtime. Accepts partial sections: output, redact, artifacts, events, exit, capture. Returns the resulting effective settings.',
    parameters: {
      output: {
        type: 'object',
        additionalProperties: true,
        description: 'Partial output settings, e.g. { ndjson: true }.',
      },
      redact: {
        type: 'object',
        additionalProperties: true,
        description: 'Partial redaction settings, e.g. { args: "hide" } or { text_length: 1000 }.',
      },
      artifacts: {
        type: 'object',
        additionalProperties: true,
        description: 'Partial artifact settings.',
      },
      events: {
        type: 'object',
        additionalProperties: true,
        description: 'Partial event-list settings.',
      },
      exit: {
        type: 'object',
        additionalProperties: true,
        description: 'Partial exit-code overrides.',
      },
    },
    output: {
      schema: OBJECT_SCHEMA,
      render: (_args, value) => jsonContent(value),
      presentationMeta: (_args, value) => ({ applied: isRecord(value) ? value['applied'] : false }),
    },
    execute: async (args, exec) => {
      const capture = host.captureFor(exec);
      if (capture === null) {
        throw new Error('no session context is available; dsh-headless-json cannot resolve the active capture');
      }
      const a = isRecord(args) ? args : {};
      const patch: Record<string, unknown> = {};
      for (const key of ['output', 'redact', 'artifacts', 'events', 'exit'] as const) {
        if (a[key] !== undefined) patch[key] = a[key];
      }
      const effective = host.applyPatch(patch);
      return {
        applied: true,
        session_id: capture.id,
        output: effective.output,
        redact: effective.redact,
        artifacts: effective.artifacts,
        events: effective.events,
        exit: effective.exit,
      };
    },
  };
}

/** All tool definitions the bundle contributes. */
export function defineTools(host: ToolHost): DshToolDefinition[] {
  return [defineOutputStatus(host), defineOutputEvents(host), defineSetOptions(host)];
}

/** Validation wrapper for set_options patches (re-exported for CLI reuse). */
export function validateOptionsPatch(current: Options, patch: unknown): Options {
  return applyPatch(current, patch);
}