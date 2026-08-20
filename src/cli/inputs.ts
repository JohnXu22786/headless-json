/**
 * CLI input loading: accepts any of the supported machine-readable forms and
 * normalizes them into something the report pipeline can consume.
 *
 * Supported inputs:
 *   - a dsh-headless-json JSON report (`report.json`)
 *   - a live NDJSON event stream (`events.ndjson` produced by the plugin)
 *   - a raw dsh session log (`.jsonl`, header line + `session/*` event lines,
 *     e.g. the JSONL persistence backend output)
 *   - a bare JSON array of either raw session events or capture events
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { isRecord } from '../types.js';
import type { Options } from '../options.js';
import { Capture, metaFromHeader, type CaptureMeta } from '../capture.js';
import type { ReportInput } from '../report.js';
import type { Report } from '../model.js';

export type LoadedInput =
  | { kind: 'report'; report: Report }
  | { kind: 'raw'; input: ReportInput }
  | { kind: 'derived'; meta: CaptureMeta; serialized: Array<Record<string, unknown>> };

function classifyLine(value: unknown): 'header' | 'raw' | 'derived' | 'report' | null {
  if (!isRecord(value)) return null;
  if (typeof value['schema_version'] === 'number' && Array.isArray(value['events'])) return 'report';
  if (typeof value['type'] === 'string' && value['type'] === 'session' && value['version'] !== undefined) return 'header';
  if (typeof value['type'] === 'string' && typeof value['seq'] === 'number' && value['data'] !== undefined) return 'raw';
  if (typeof value['kind'] === 'string') return 'derived';
  return null;
}

/** The trailing session_end summary line is a trailer, never an event. */
function isSessionEnd(value: unknown): boolean {
  return isRecord(value) && value['kind'] === 'session_end';
}

/** Load and classify the input file. */
export async function loadInput(filePath: string, options: Options, cwdOverride: string | null): Promise<LoadedInput> {
  const raw = await readFile(filePath, 'utf8');
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new Error(`"${filePath}" is empty`);

  // A single JSON document (a report, an event array, or a lone event) is the
  // common case; multi-line JSONL falls back to line-by-line parsing below.
  let singleDoc: unknown = null;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      singleDoc = JSON.parse(trimmed);
    } catch {
      singleDoc = null; // multi-line JSONL — handle below
    }
  }
  if (singleDoc !== null) {
    if (Array.isArray(singleDoc)) {
      return assembleCollection(singleDoc, filePath, options, cwdOverride);
    }
    const kind = classifyLine(singleDoc);
    if (kind === 'report') return { kind: 'report', report: singleDoc as Report };
    if (kind === 'raw') {
      const input = buildFromRaw([singleDoc], null, filePath, options, cwdOverride);
      return { kind: 'raw', input };
    }
    if (kind === 'derived' && !isSessionEnd(singleDoc)) {
      const meta = defaultMeta(cwdOverride);
      return { kind: 'derived', meta, serialized: [singleDoc as Record<string, unknown>] };
    }
    throw new Error(`"${filePath}" cannot be recognized as a report, an event stream, or a session log`);
  }

  // JSONL: one JSON object per line.
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  let header: Record<string, unknown> | null = null;
  const raws: unknown[] = [];
  const derived: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (caught) {
      throw new Error(`"${filePath}" line ${lines.indexOf(line) + 1} is not valid JSON: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
    const kind = classifyLine(value);
    if (kind === 'header') {
      header = value as Record<string, unknown>;
      continue;
    }
    if (kind === 'raw') {
      raws.push(value);
      continue;
    }
    if (kind === 'derived') {
      if (isSessionEnd(value)) continue;
      derived.push(value as Record<string, unknown>);
      continue;
    }
    if (kind === 'report') {
      return { kind: 'report', report: value as Report };
    }
    throw new Error(`"${filePath}" line ${lines.indexOf(line) + 1} cannot be classified`);
  }

  if (raws.length === 0 && derived.length === 0) {
    throw new Error(`"${filePath}" contains no readable events`);
  }
  if (raws.length > 0 && derived.length > 0) {
    throw new Error(`"${filePath}" mixes raw session events and already-structured events; provide one form`);
  }
  if (raws.length > 0) {
    const input = buildFromRaw(raws, header, filePath, options, cwdOverride);
    return { kind: 'raw', input };
  }
  const meta = defaultMeta(cwdOverride);
  return { kind: 'derived', meta, serialized: derived };
}

function assembleCollection(
  entries: unknown[],
  filePath: string,
  options: Options,
  cwdOverride: string | null,
): LoadedInput {
  if (entries.length === 0) throw new Error(`"${filePath}" contains an empty array`);
  const firstKind = classifyLine(entries[0]);
  if (firstKind === null) throw new Error(`"${filePath}" first array element cannot be classified`);
  // Enforce a single form per array, exactly like the JSONL branch.
  for (let index = 1; index < entries.length; index += 1) {
    const entryKind = classifyLine(entries[index]);
    if (entryKind !== firstKind) {
      throw new Error(`"${filePath}" mixes raw session events and already-structured events; provide one form`);
    }
  }
  if (firstKind === 'raw') {
    const input = buildFromRaw(entries, null, filePath, options, cwdOverride);
    return { kind: 'raw', input };
  }
  if (firstKind === 'derived') {
    const filtered = (entries as Array<Record<string, unknown>>).filter((entry) => !isSessionEnd(entry));
    if (filtered.length === 0) throw new Error(`"${filePath}" contains only session_end trailers`);
    return { kind: 'derived', meta: defaultMeta(cwdOverride), serialized: filtered };
  }
  if (firstKind === 'report') {
    return { kind: 'report', report: entries[0] as Report };
  }
  throw new Error(`"${filePath}" first array element cannot be classified`);
}

function defaultMeta(cwdOverride: string | null): CaptureMeta {
  return {
    id: 'unknown',
    cwd: cwdOverride !== null ? resolve(cwdOverride) : process.cwd(),
    // Zero means "unknown"; the report assembly falls back to the first event
    // time so output stays deterministic without a wall clock.
    created_at: 0,
    parent_session: null,
    agent_preset: null,
    delegation_depth: null,
  };
}

/** Run raw session events through the Capture pipeline. */
function buildFromRaw(
  rawEvents: unknown[],
  header: Record<string, unknown> | null,
  filePath: string,
  options: Options,
  cwdOverride: string | null,
): ReportInput {
  const optionsRef = { current: options };
  const meta = header !== null ? metaFromHeader(header) : defaultMeta(cwdOverride);
  // --cwd is authoritative for path relativization when provided.
  if (cwdOverride !== null) meta.cwd = resolve(cwdOverride);
  const capture = new Capture(meta, optionsRef);
  for (const event of rawEvents) capture.ingest(event);
  if (capture.eventCount === 0) throw new Error(`"${filePath}" contains no raw session events to ingest`);
  return capture.materialize();
}