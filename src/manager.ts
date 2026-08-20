/**
 * CaptureManager: owns the plugin lifecycle inside a dsh runtime.
 *
 * It subscribes to the session service events (`session/created`,
 * `session/event`, `session/flush`, `session/disposed`), maintains one
 * Capture per session, streams NDJSON lines live when enabled, and writes the
 * JSON/JUnit reports when a session ends.
 *
 * Every handler is error-contained: a failing listener never propagates into
 * the host tree.
 */

import { join, resolve } from 'node:path';

import type { Options } from './options.js';
import { applyDottedPath, applyPatch } from './options.js';
import type { Capture, OptionsRef } from './capture.js';
import { Capture as CaptureClass, metaFromHeader } from './capture.js';
import { LineWriter, writeFileAtomic } from './io.js';
import { buildReport, renderReportJson } from './report.js';
import { renderJunit } from './junit.js';
import { sessionEndLine } from './serialize.js';
import { defineTools, type DshToolDefinition, type ToolHost } from './tools.js';
import { isRecord } from './types.js';

/** The minimum of the plugin-context surface this plugin relies on. */
export interface PluginContext {
  on(name: string, listener: (...args: unknown[]) => unknown): () => void;
  get(name: string): unknown;
  sessions: {
    list(): unknown;
  };
  logger(name: string): Logger;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

interface ToolsRegistry {
  register(definition: DshToolDefinition): () => void;
}

/** A short, safe identifier derived from a session id. */
function shortId(sessionId: string): string {
  const cleaned = sessionId.replace(/[^a-zA-Z0-9_-]/g, '');
  const base = cleaned.length > 0 ? cleaned : 'sess';
  return base.length > 10 ? base.slice(-10) : base;
}

/** Replace an optional `{session}` placeholder in a file name. */
function applyPlaceholder(name: string, sessionId: string): string {
  return name.replace(/\{session\}/g, shortId(sessionId));
}

/** Insert `-<id>` before the extension for per-session disambiguation. */
function suffixBeforeExt(name: string, sessionId: string): string {
  const dot = name.lastIndexOf('.');
  const stem = dot <= 0 ? name : name.slice(0, dot);
  const ext = dot <= 0 ? '' : name.slice(dot);
  return `${stem}-${shortId(sessionId)}${ext}`;
}

export class CaptureManager implements ToolHost {
  readonly optionsRef: OptionsRef;
  private readonly captures = new Map<string, Capture>();
  private readonly usedNames = new Set<string>();
  private readonly captureStreamNames = new Map<string, string>();
  private readonly hooks: Array<() => void> = [];
  private readonly toolDisposers: Array<() => void> = [];
  private readonly pendingWork: Array<Promise<void>> = [];
  private readonly finalizing = new Map<string, Promise<void>>();
  private disposed = false;

  constructor(
    private readonly ctx: PluginContext,
    options: Options,
    private readonly logger: Logger,
  ) {
    this.optionsRef = { current: options };
  }

  /** Create the session subscription hooks; returns the dispose function. */
  start(): () => Promise<void> {
    this.hooks.push(
      this.ctx.on('session/created', (session) => {
        this.safe('session/created', () => this.onSessionCreated(session));
      }),
    );
    this.hooks.push(
      this.ctx.on('session/event', (session, event) => {
        this.safe('session/event', () => this.onSessionEvent(session, event));
      }),
    );
    this.hooks.push(
      this.ctx.on('session/flush', (session) => {
        // Must RETURN the promise: the store's flush checkpoint collects
        // listener results with Promise.allSettled and only then considers
        // durability satisfied.
        return this.safeP('session/flush', () => this.onSessionFlush(session));
      }),
    );
    this.hooks.push(
      this.ctx.on('session/disposed', (session) => {
        return this.safeP('session/disposed', () => this.onSessionDisposed(session));
      }),
    );
    this.registerTools();
    this.retrofitExisting();
    this.logger.info(`headless-json mounted; report directory: ${resolve(process.cwd(), this.optionsRef.current.output.dir)}`);
    return () => this.dispose();
  }

  /** Wrap a handler so listener errors never escape into the tree. */
  private safe(label: string, fn: () => void): void {
    try {
      fn();
    } catch (caught) {
      this.logger.warn(`headless-json: ${label} handler failed: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
  }

  /**
   * Like safe(), but forwards the handler's promise so the emitter can await
   * it (required by the session/flush durability checkpoint). A synchronous
   * throw is converted into a rejected promise.
   */
  private safeP(label: string, fn: () => Promise<void> | undefined): Promise<void> | undefined {
    try {
      const result = fn();
      if (result === undefined) return undefined;
      return result.catch((caught: unknown) => {
        this.logger.warn(`headless-json: ${label} handler failed: ${caught instanceof Error ? caught.message : String(caught)}`);
      });
    } catch (caught) {
      this.logger.warn(`headless-json: ${label} handler failed: ${caught instanceof Error ? caught.message : String(caught)}`);
      return undefined;
    }
  }

  private ensureCapture(session: unknown): Capture | null {
    const like = isRecord(session) ? (session as Record<string, unknown>) : {};
    const id = typeof like['id'] === 'string' ? like['id'] : null;
    if (id === null || id.length === 0) return null;
    const existing = this.captures.get(id);
    if (existing !== undefined) return existing;
    const header = isRecord(like['header']) ? (like['header'] as Record<string, unknown>) : {};
    const meta = metaFromHeader(header);
    if (meta.id === 'unknown') {
      // The header may omit its id; the session object always carries one.
      meta.id = id;
    }
    const capture = new CaptureClass(meta, this.optionsRef);
    this.captures.set(id, capture);
    if (this.optionsRef.current.output.ndjson) {
      this.attachStream(capture, id);
    }
    this.logger.debug(`headless-json: capture created for session ${id}`);
    return capture;
  }

  /**
   * Open (or resume) the NDJSON writer for one capture.
   *
   * Each capture keeps exactly one stream file for its whole lifetime: if the
   * capture already has an active writer, or has owned one before (its stream
   * name is recorded), that writer is resumed so toggling ndjson on/off can
   * never split the stream or leak a file handle.
   */
  private attachStream(capture: Capture, sessionId: string): void {
    if (capture.finalized || capture.streamActive) return;
    const owned = this.captureStreamNames.get(capture.id);
    const base = applyPlaceholder(this.optionsRef.current.output.ndjson_file, sessionId);
    let name = owned ?? base;
    if (owned === undefined && this.usedNames.has(name)) name = suffixBeforeExt(base, sessionId);
    if (owned === undefined) {
      this.usedNames.add(name);
      this.captureStreamNames.set(capture.id, name);
    }
    const dir = resolve(process.cwd(), this.optionsRef.current.output.dir);
    capture.setStreamWriter(new LineWriter(join(dir, name)));
  }

  /** Disable live streaming for a capture: detach and close its writer. */
  private async detachStream(capture: Capture): Promise<void> {
    if (!capture.streamActive) return;
    await capture.detachStream();
  }

  /** Sessions that existed before the plugin mounted are picked up lazily. */
  private retrofitExisting(): void {
    let listed: unknown[] = [];
    try {
      const sessions = this.ctx.sessions.list();
      if (Array.isArray(sessions)) listed = sessions;
    } catch (caught) {
      this.logger.warn(`headless-json: could not list existing sessions: ${caught instanceof Error ? caught.message : String(caught)}`);
      return;
    }
    for (const session of listed) {
      this.ensureCapture(session);
    }
  }

  private onSessionCreated(session: unknown): void {
    this.ensureCapture(session);
  }

  private onSessionEvent(session: unknown, event: unknown): void {
    const id = this.sessionIdOf(session);
    const capture = id === null ? undefined : this.captures.get(id);
    if (capture === undefined) return;
    capture.ingest(event);
  }

  private onSessionFlush(session: unknown): Promise<void> | undefined {
    const id = this.sessionIdOf(session);
    const capture = id === null ? undefined : this.captures.get(id);
    if (capture === undefined) return undefined;
    const work = capture.flushStream();
    this.pendingWork.push(work);
    return work;
  }

  private onSessionDisposed(session: unknown): Promise<void> | undefined {
    const id = this.sessionIdOf(session);
    const capture = id === null ? undefined : this.captures.get(id);
    if (capture === undefined) return undefined;
    const work = this.finalizeCapture(capture);
    this.pendingWork.push(work);
    return work;
  }

  private sessionIdOf(session: unknown): string | null {
    const like = isRecord(session) ? (session as Record<string, unknown>) : {};
    return typeof like['id'] === 'string' ? like['id'] : null;
  }

  /** Finalize one capture: materialize, write reports, close the stream.
   *
   * Re-entrant/concurrent calls (e.g. a session/disposed handler while the
   * plugin disposer loops) are coalesced onto a single in-flight promise so
   * reports are written exactly once.
   */
  finalizeCapture(capture: Capture): Promise<void> {
    if (capture.finalized) return Promise.resolve();
    const inFlight = this.finalizing.get(capture.id);
    if (inFlight !== undefined) return inFlight;
    const work = this.doFinalize(capture).finally(() => {
      this.finalizing.delete(capture.id);
    });
    this.finalizing.set(capture.id, work);
    return work;
  }

  private async doFinalize(capture: Capture): Promise<void> {
    const options = this.optionsRef.current;
    const materialized = capture.materialize();
    const report = buildReport(materialized, options);
    const empty = report.events.length === 0;
    if (empty && !options.output.write_empty) {
      await capture.closeStream(null);
      this.logger.debug(`headless-json: skipped empty report for session ${capture.id}`);
      return;
    }
    const dir = resolve(process.cwd(), options.output.dir);
    const sessionId = capture.id;
    try {
      if (options.output.ndjson) {
        if (capture.eventCount === 0) this.attachStream(capture, sessionId);
        const trailer = sessionEndLine(sessionId, report.generated_at, report.outcome, {
          duration_ms: report.stats.duration_ms,
          turns: report.stats.turns,
          steps: report.stats.steps,
          tool_calls: report.stats.tool_calls,
          tool_errors: report.stats.tool_errors,
        });
        await capture.closeStream(trailer);
      } else {
        await capture.closeStream(null);
      }
      if (options.output.json) {
        const name = applyPlaceholder(options.output.json_file, sessionId);
        const finalName = this.reserveName(name, sessionId);
        await writeFileAtomic(join(dir, finalName), renderReportJson(report, options));
      }
      if (options.output.junit) {
        const name = applyPlaceholder(options.output.junit_file, sessionId);
        const finalName = this.reserveName(name, sessionId);
        await writeFileAtomic(join(dir, finalName), renderJunit(report));
      }
      this.logger.info(
        `headless-json: session ${sessionId} ended (${report.outcome.status}, exit ${report.outcome.exit_code}); ${report.events.length} events -> ${dir}`,
      );
    } catch (caught) {
      this.logger.warn(`headless-json: could not write reports for session ${sessionId}: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
  }

  private reserveName(baseName: string, sessionId: string): string {
    if (this.usedNames.has(baseName)) return suffixBeforeExt(baseName, sessionId);
    this.usedNames.add(baseName);
    return baseName;
  }

  private registerTools(): void {
    let registry: ToolsRegistry | null = null;
    try {
      const tools = this.ctx.get('tools');
      if (tools !== undefined && tools !== null && typeof tools === 'object' && typeof (tools as { register?: unknown })['register'] === 'function') {
        registry = tools as unknown as ToolsRegistry;
      }
    } catch {
      registry = null;
    }
    if (registry === null) {
      this.logger.warn('headless-json: ctx.tools is not available in this composition; the output_status/output_events/set_options tools are not registered');
      return;
    }
    const host: ToolHost = {
      captureFor: (exec) => this.captureFor(exec),
      options: () => this.optionsRef.current,
      // Delegate to the manager method so that toggling output.ndjson through
      // the set_options tool also arms/disarms the live stream writer.
      applyPatch: (patch) => this.applyPatch(patch),
    };
    for (const definition of defineTools(host)) {
      try {
        const disposer = registry.register(definition);
        this.toolDisposers.push(disposer);
      } catch (caught) {
        this.logger.warn(`headless-json: could not register tool ${definition.name}: ${caught instanceof Error ? caught.message : String(caught)}`);
      }
    }
  }

  /** ToolHost: resolve the capture behind a tool execution context. */
  captureFor(exec: unknown): Capture | null {
    const record = isRecord(exec) ? exec : {};
    const agent = isRecord(record['agent']) ? record['agent'] : null;
    const session = agent !== null && isRecord(agent['session']) ? (agent['session'] as Record<string, unknown>) : null;
    const id = session !== null && typeof session['id'] === 'string' ? session['id'] : null;
    if (id !== null) {
      const capture = this.captures.get(id);
      if (capture !== undefined) return capture;
    }
    // Fallback: with exactly one active capture, it is unambiguous.
    const active = [...this.captures.values()].filter((candidate) => !candidate.finalized);
    return active.length === 1 ? active[0] ?? null : null;
  }

  /** ToolHost: current options. */
  options(): Options {
    return this.optionsRef.current;
  }

  /** ToolHost: validate and apply an options patch (set_options tool). */
  applyPatch(patch: unknown): Options {
    const before = this.optionsRef.current;
    const next = applyPatch(before, patch);
    this.optionsRef.current = next;
    // Toggling the live NDJSON stream mid-session: enabling arms the writer
    // for active captures without one; disabling stops and closes it. A writer
    // owner keeps the same file across toggles.
    if (next.output.ndjson !== before.output.ndjson) {
      if (next.output.ndjson) {
        for (const capture of this.captures.values()) {
          if (!capture.finalized) this.attachStream(capture, capture.id);
        }
      } else {
        for (const capture of this.captures.values()) {
          void this.detachStream(capture).catch(() => undefined);
        }
      }
    }
    return next;
  }

  /** Apply a dotted-path option assignment (CLI --set). */
  setOptionPath(dottedKey: string, value: unknown): Options {
    const next = applyDottedPath(this.optionsRef.current, dottedKey, value);
    this.optionsRef.current = next;
    return next;
  }

  /** Tear down: unsubscribe, unregister tools, finalize every capture. */
  private async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const hook of this.hooks) {
      try {
        hook();
      } catch (caught) {
        this.logger.warn(`headless-json: hook disposal failed: ${caught instanceof Error ? caught.message : String(caught)}`);
      }
    }
    for (const disposer of this.toolDisposers) {
      try {
        disposer();
      } catch (caught) {
        this.logger.warn(`headless-json: tool disposal failed: ${caught instanceof Error ? caught.message : String(caught)}`);
      }
    }
    this.hooks.length = 0;
    this.toolDisposers.length = 0;
    await Promise.allSettled(this.pendingWork);
    this.pendingWork.length = 0;
    for (const capture of this.captures.values()) {
      if (capture.finalized) continue;
      try {
        await this.finalizeCapture(capture);
      } catch (caught) {
        this.logger.warn(`headless-json: dispose finalize failed for ${capture.id}: ${caught instanceof Error ? caught.message : String(caught)}`);
      }
    }
  }
}