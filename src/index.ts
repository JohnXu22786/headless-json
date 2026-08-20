/**
 * dsh-headless-json — bundle entry.
 *
 * Exports the Cordis plugin contract (`name`, `inject`, `apply`, `Config`)
 * plus the programmatic API used by host programs and the CLI.
 */

import { normalizeOptions } from './options.js';
import { CaptureManager, type PluginContext } from './manager.js';
import { PLUGIN_NAME } from './version.js';

export const name = PLUGIN_NAME;

/** The services this plugin hard-depends on before it mounts. */
export const inject = ['sessions'];

/**
 * Loader config validator. Has the z.object-like surface (`parse`,
 * `safeParse`) so the dsh loader can validate the interpolated config just as
 * it would a schema-backed plugin.
 */
export const Config = {
  parse(input: unknown) {
    return normalizeOptions(input ?? {});
  },
  safeParse(input: unknown): { success: true; data: ReturnType<typeof normalizeOptions> } | { success: false; error: Error } {
    try {
      return { success: true, data: normalizeOptions(input ?? {}) };
    } catch (caught) {
      return {
        success: false,
        error: caught instanceof Error ? caught : new Error(String(caught)),
      };
    }
  },
};

/** Apply the plugin against a dsh context. Returns the dispose function. */
export function apply(ctx: PluginContext, config: unknown): () => Promise<void> {
  const options = normalizeOptions(config ?? {});
  const logger = ctx.logger(name);
  const manager = new CaptureManager(ctx, options, logger);
  return manager.start();
}

// ------------------------------------------------------------------------
// Public programmatic API (used by the CLI and available to host programs).
// ------------------------------------------------------------------------

export { normalizeOptions, DEFAULT_OPTIONS, applyPatch, applyPatchSection, applyDottedPath, parseScalar } from './options.js';
export type { Options } from './options.js';
export { CaptureManager } from './manager.js';
export type { PluginContext, Logger } from './manager.js';
export { Capture, metaFromHeader } from './capture.js';
export type { CaptureMeta } from './capture.js';
export { buildReport, buildReportFromSerialized, renderReportJson } from './report.js';
export type { ReportInput } from './report.js';
export { renderJunit } from './junit.js';
export { resolveOutcome, statusForKind } from './exit-code.js';
export type { OutcomeStatus, ResolvedOutcome } from './exit-code.js';
export { serializeEvent } from './serialize.js';
export { LineWriter, writeFileAtomic } from './io.js';
export { PLUGIN_NAME, readVersion } from './version.js';
export { SCHEMA_VERSION, assertJsonSafe } from './model.js';
export type { CaptureEvent, CaptureEventKind, Report, ReportStats, ArtifactEntry } from './model.js';

export default { name, inject, Config, apply };