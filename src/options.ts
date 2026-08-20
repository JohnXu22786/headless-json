/**
 * Plugin configuration: schema, defaults, validation and patching.
 *
 * The plugin deliberately ships zero runtime dependencies, so the "schema" is
 * a hand-written validator instead of a schema library. All keys use snake_case
 * everywhere they are user-facing (configuration, CLI `--set` paths, JSON
 * reports, NDJSON lines).
 */

export interface OutputOptions {
  /** Directory that receives the produced report files, relative to cwd. */
  dir: string;
  /** Write the transaction-level JSON report. */
  json: boolean;
  /** Write the JUnit XML report. */
  junit: boolean;
  /** Stream events to an append-only NDJSON file while the session runs. */
  ndjson: boolean;
  /** Report file name inside `dir`. */
  json_file: string;
  /** JUnit file name inside `dir`. */
  junit_file: string;
  /** NDJSON file name inside `dir`. */
  ndjson_file: string;
  /** Skip writing report files for a session that recorded zero events. */
  write_empty: boolean;
  /** Pretty-print the JSON report (2-space indent); NDJSON is always compact. */
  pretty: boolean;
}

export type ArgsMode = 'full' | 'truncate' | 'hide';
export type PathsMode = 'relative' | 'absolute';

export interface RedactOptions {
  /** Max chars of any text/reasoning value written to outputs; 0 = unlimited. */
  text_length: number;
  /** Max chars of the tool-call argument summary when `args` is truncate. */
  arg_length: number;
  /** How tool-call arguments are surfaced: full object, truncate, or hidden. */
  args: ArgsMode;
  /** Whether file paths are relativized against the session cwd. */
  paths: PathsMode;
  /** Mask secret-shaped strings (api keys, bearer tokens, long hex, …). */
  secrets: boolean;
  /** Extra secret regex patterns (regex source strings) applied in addition. */
  secret_patterns: string[];
}

export interface ArtifactOptions {
  /** Scan texts for referenced file paths and build the artifact manifest. */
  collect: boolean;
  /** `stat` matched paths to record existence/size (only valid on the run machine). */
  check_exists: boolean;
  /** Maximum number of unique artifact entries kept. */
  max_entries: number;
  /** Extra regex source strings matched as path-like text in addition to the built-ins. */
  pattern_extras: string[];
}

export interface EventsOptions {
  /** Max events kept in the JSON report's event list; 0 = unlimited. */
  max_events: number;
  /** Trim strategy when the limit is exceeded: keep head, or head+tail ("balanced"). */
  trim: 'head' | 'balanced';
  /** Also surface log-only event types (request/header, session/end-seed, …) as `other`. */
  include_log_only: boolean;
}

export interface CaptureOptions {
  /** Hard cap on the chars of any single text stored in memory. */
  text_cap: number;
}

export interface ExitOptions {
  success: number;
  error: number;
  timeout: number;
  blocked: number;
  empty: number;
  aborted: number;
  interrupted: number;
}

export interface Options {
  output: OutputOptions;
  redact: RedactOptions;
  artifacts: ArtifactOptions;
  events: EventsOptions;
  exit: ExitOptions;
  capture: CaptureOptions;
}

export const DEFAULT_OPTIONS: Options = {
  output: {
    dir: 'dsh-output',
    json: true,
    junit: true,
    ndjson: false,
    json_file: 'report.json',
    junit_file: 'junit.xml',
    ndjson_file: 'events.ndjson',
    write_empty: true,
    pretty: false,
  },
  redact: {
    text_length: 4000,
    arg_length: 500,
    args: 'truncate',
    paths: 'relative',
    secrets: true,
    secret_patterns: [],
  },
  artifacts: {
    collect: true,
    check_exists: true,
    max_entries: 500,
    pattern_extras: [],
  },
  events: {
    max_events: 1000,
    trim: 'balanced',
    include_log_only: false,
  },
  exit: {
    success: 0,
    error: 1,
    timeout: 2,
    blocked: 3,
    empty: 4,
    aborted: 130,
    interrupted: 130,
  },
  capture: {
    text_cap: 100_000,
  },
};

/** Configuration violation with a path-qualified message. */
export class ConfigError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'ConfigError';
    this.path = path;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new ConfigError(path, 'expected an object');
  return value;
}

function intValue(value: unknown, path: string, min: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new ConfigError(path, `expected an integer >= ${min}`);
  }
  return value;
}

function boolValue(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new ConfigError(path, 'expected a boolean');
  return value;
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new ConfigError(path, 'expected a non-empty string');
  return value;
}

function enumValue<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ConfigError(path, `expected one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new ConfigError(path, 'expected an array of strings');
  }
  return value.slice();
}

/** Validate that every regex source string compiles, so a bad pattern is a
 * config error at the source instead of a runtime failure mid-capture. */
function regexArray(value: unknown, path: string): string[] {
  const sources = stringArray(value, path);
  for (const source of sources) {
    try {
      // eslint-disable-next-line no-new
      new RegExp(source);
    } catch (caught) {
      throw new ConfigError(`${path}[?]`, `invalid regular expression "${source}": ${caught instanceof Error ? caught.message : String(caught)}`);
    }
  }
  return sources;
}

function parseSection(
  input: Record<string, unknown>,
  defaults: Record<string, unknown>,
  path: string,
  validators: Record<string, (value: unknown, elementPath: string) => unknown>,
  exact: boolean,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...defaults };
  for (const [key, value] of Object.entries(input)) {
    const validator = validators[key];
    if (validator === undefined) {
      // Configuration files tolerate unknown keys (forward-compatible
      // deployments); patches (--set / set_options) reject them.
      if (exact) throw new ConfigError(`${path}.${key}`, 'unknown option');
      continue;
    }
    if (value === undefined) continue;
    result[key] = validator(value, `${path}.${key}`);
  }
  return result;
}

const PATH_VALIDATORS = {
  dir: (v: unknown, p: string) => stringValue(v, p),
  json: (v: unknown, p: string) => boolValue(v, p),
  junit: (v: unknown, p: string) => boolValue(v, p),
  ndjson: (v: unknown, p: string) => boolValue(v, p),
  json_file: (v: unknown, p: string) => stringValue(v, p),
  junit_file: (v: unknown, p: string) => stringValue(v, p),
  ndjson_file: (v: unknown, p: string) => stringValue(v, p),
  write_empty: (v: unknown, p: string) => boolValue(v, p),
  pretty: (v: unknown, p: string) => boolValue(v, p),
};

const REDACT_VALIDATORS = {
  text_length: (v: unknown, p: string) => intValue(v, p, 0),
  arg_length: (v: unknown, p: string) => intValue(v, p, 0),
  args: (v: unknown, p: string) => enumValue(v, p, ['full', 'truncate', 'hide'] as const),
  paths: (v: unknown, p: string) => enumValue(v, p, ['relative', 'absolute'] as const),
  secrets: (v: unknown, p: string) => boolValue(v, p),
  secret_patterns: (v: unknown, p: string) => regexArray(v, p),
};

const ARTIFACT_VALIDATORS = {
  collect: (v: unknown, p: string) => boolValue(v, p),
  check_exists: (v: unknown, p: string) => boolValue(v, p),
  max_entries: (v: unknown, p: string) => intValue(v, p, 0),
  pattern_extras: (v: unknown, p: string) => regexArray(v, p),
};

const EVENTS_VALIDATORS = {
  max_events: (v: unknown, p: string) => intValue(v, p, 0),
  trim: (v: unknown, p: string) => enumValue(v, p, ['head', 'balanced'] as const),
  include_log_only: (v: unknown, p: string) => boolValue(v, p),
};

const EXIT_VALIDATORS: Record<string, (value: unknown, path: string) => unknown> = {};
for (const key of ['success', 'error', 'timeout', 'blocked', 'empty', 'aborted', 'interrupted'] as const) {
  EXIT_VALIDATORS[key] = (v: unknown, p: string) => intValue(v, p, 0);
}

const CAPTURE_VALIDATORS = {
  text_cap: (v: unknown, p: string) => intValue(v, p, 1),
};

/** Validate an arbitrary input object and return a complete effective Options.
 *
 * `exact` (used by patches — the set_options tool and CLI --set) rejects
 * unknown keys; loose configuration files tolerate them.
 */
export function normalizeOptions(input: unknown, exact = false): Options {
  const root = requireRecord(input, 'config');
  const outputInput = requireRecord(root['output'], 'output');
  const redactInput = requireRecord(root['redact'], 'redact');
  const artifactsInput = requireRecord(root['artifacts'], 'artifacts');
  const eventsInput = requireRecord(root['events'], 'events');
  const exitInput = requireRecord(root['exit'], 'exit');
  const captureInput = requireRecord(root['capture'], 'capture');
  const output = parseSection(outputInput, DEFAULT_OPTIONS.output as unknown as Record<string, unknown>, 'output', PATH_VALIDATORS, exact);
  const redact = parseSection(redactInput, DEFAULT_OPTIONS.redact as unknown as Record<string, unknown>, 'redact', REDACT_VALIDATORS, exact);
  const artifacts = parseSection(artifactsInput, DEFAULT_OPTIONS.artifacts as unknown as Record<string, unknown>, 'artifacts', ARTIFACT_VALIDATORS, exact);
  const events = parseSection(eventsInput, DEFAULT_OPTIONS.events as unknown as Record<string, unknown>, 'events', EVENTS_VALIDATORS, exact);
  const exit = parseSection(exitInput, DEFAULT_OPTIONS.exit as unknown as Record<string, unknown>, 'exit', EXIT_VALIDATORS, exact);
  const capture = parseSection(captureInput, DEFAULT_OPTIONS.capture as unknown as Record<string, unknown>, 'capture', CAPTURE_VALIDATORS, exact);
  return {
    output: output as unknown as OutputOptions,
    redact: redact as unknown as RedactOptions,
    artifacts: artifacts as unknown as ArtifactOptions,
    events: events as unknown as EventsOptions,
    exit: exit as unknown as ExitOptions,
    capture: capture as unknown as CaptureOptions,
  };
}

/** Top-level option sections accepted by `set_options` and CLI `--set`. */
const SECTIONS = ['output', 'redact', 'artifacts', 'events', 'exit', 'capture'] as const;

/**
 * Apply a partial patch (which may itself be a partial section) on top of the
 * current options and return the new options. Throws ConfigError for unknown
 * sections/keys or invalid values.
 */
export function applyPatch(current: Options, patch: unknown): Options {
  const patchObj = requireRecord(patch, 'patch');
  const root: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patchObj)) {
    if (!(SECTIONS as readonly string[]).includes(key)) {
      throw new ConfigError(key, 'unknown option section');
    }
    root[key] = value === undefined ? undefined : value;
  }
  return normalizeOptions(
    {
      output: { ...current.output, ...(root['output'] === undefined ? {} : root['output']) },
      redact: { ...current.redact, ...(root['redact'] === undefined ? {} : root['redact']) },
      artifacts: { ...current.artifacts, ...(root['artifacts'] === undefined ? {} : root['artifacts']) },
      events: { ...current.events, ...(root['events'] === undefined ? {} : root['events']) },
      exit: { ...current.exit, ...(root['exit'] === undefined ? {} : root['exit']) },
      capture: { ...current.capture, ...(root['capture'] === undefined ? {} : root['capture']) },
    },
    true,
  );
}

/** Apply a dotted path assignment such as `redact.text_length=200`. */
export function applyDottedPath(current: Options, dottedKey: string, value: unknown): Options {
  const parts = dottedKey.split('.');
  if (parts.length < 2 || parts[0] === undefined || parts[1] === undefined) {
    throw new ConfigError(dottedKey, 'expected a dotted path like "redact.text_length"');
  }
  const section = parts[0];
  const key = parts.slice(1).join('.');
  if (!(SECTIONS as readonly string[]).includes(section)) throw new ConfigError(section, 'unknown option section');
  const sectionObj = (current as unknown as Record<string, Record<string, unknown>>)[section] ?? {};
  const patchedSection = { [key]: value };
  const merged: Record<string, unknown> = { ...sectionObj, ...patchedSection };
  return applyPatchBound(current, section, merged);
}

/** Apply a possibly nested partial object for one section. */
export function applyPatchSection(current: Options, section: (typeof SECTIONS)[number], input: unknown): Options {
  return applyPatchBound(current, section, input);
}

function applyPatchBound(current: Options, section: string, input: unknown): Options {
  const root: Record<string, unknown> = { [section]: input };
  return applyPatch(current, root);
}

/** Parse a scalar CLI value: booleans and integers become typed, else string. */
export function parseScalar(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+$/.test(raw)) {
    const asNumber = Number(raw);
    if (Number.isSafeInteger(asNumber)) return asNumber;
  }
  return raw;
}