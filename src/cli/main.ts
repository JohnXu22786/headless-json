/**
 * CLI entry: render and exit commands.
 *
 *   dsh-headless-json render <input> [--format json|junit|ndjson] [--out file]
 *   dsh-headless-json exit <input>
 *
 * `render` normalizes any supported input (JSON report / NDJSON events / raw
 * session log) into the requested output format. `exit` prints the semantic
 * exit code for the run and exits the process with it — the CI glue.
 */

import { writeFile } from 'node:fs/promises';

import { DEFAULT_OPTIONS, applyDottedPath, parseScalar, type Options } from '../options.js';
import { buildReport, buildReportFromSerialized, renderReportJson } from '../report.js';
import { renderJunit } from '../junit.js';
import { sessionEndLine } from '../serialize.js';
import { readVersion } from '../version.js';
import type { Report } from '../model.js';
import { parseArgs, flagList } from './args.js';
import { loadInput, type LoadedInput } from './inputs.js';

const USAGE = `dsh-headless-json — structured CI output for dsh runs

Usage:
  dsh-headless-json render <input> [options]   Render a report/event file
  dsh-headless-json exit <input> [options]     Print the semantic exit code
  dsh-headless-json --version | --help

<input> may be:
  - a dsh-headless-json report.json
  - an events.ndjson stream produced by the plugin
  - a raw dsh session .jsonl log (header + session/* events)
  - a JSON array of raw session events

render options:
  --format json|junit|ndjson   Output format (default: json)
  --out <file>                 Write to a file instead of stdout
  --pretty                     Pretty-print the JSON report
  --set <key=value>            Override an option, e.g. redact.text_length=1200
  --text-length <n>            Shortcut for --set redact.text_length=<n>
  --arg-length <n>             Shortcut for --set redact.arg_length=<n>
  --args full|truncate|hide    Shortcut for --set redact.args=<mode>
  --paths relative|absolute    Shortcut for --set redact.paths=<mode>
  --no-secrets                 Disable secret masking (redact.secrets=false)
  --max-events <n>             Shortcut for --set events.max_events=<n>
  --cwd <dir>                  Base directory for path relativization
  --include-log-only           Surface log-only event types as 'other'

exit options:
  --set <key=value>, --cwd <dir>  (same interpretation as render)

Global:
  -h, --help                   Show this help
  -v, --version                Print the plugin version
`;

export async function main(argv: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (caught) {
    process.stderr.write(`dsh-headless-json: error: ${caught instanceof Error ? caught.message : String(caught)}\n`);
    return 2;
  }

  const flags = parsed.flags;
  if (flags['help'] === true) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (flags['version'] === true) {
    process.stdout.write(`${readVersion()}\n`);
    return 0;
  }

  const command = parsed.positional[0];
  if (command !== 'render' && command !== 'exit') {
    process.stderr.write(`dsh-headless-json: error: unknown command "${command ?? ''}" (expected render or exit)\n`);
    process.stderr.write(USAGE);
    return 2;
  }
  const file = parsed.positional[1];
  if (file === undefined) {
    process.stderr.write(`dsh-headless-json: error: missing input file for "${command}"\n`);
    return 2;
  }
  if (parsed.positional.length > 2) {
    process.stderr.write('dsh-headless-json: error: unexpected extra arguments after the input file\n');
    return 2;
  }

  try {
    const options = buildOptions(flags);
    const cwdOverride = typeof flags['cwd'] === 'string' ? flags['cwd'] : null;
    const loaded = await loadInput(file, options, cwdOverride);

    if (command === 'exit') {
      const report = await toReport(loaded, options);
      const code = typeof report.outcome?.exit_code === 'number' ? report.outcome.exit_code : 1;
      process.stdout.write(`${code}\n`);
      return code;
    }

    return await runRender(loaded, flags, options);
  } catch (caught) {
    process.stderr.write(`dsh-headless-json: error: ${caught instanceof Error ? caught.message : String(caught)}\n`);
    return 1;
  }
}

/** Build the effective options from CLI flags. */
function buildOptions(flags: ReturnType<typeof parseArgs>['flags']): Options {
  let options = DEFAULT_OPTIONS;
  const apply = (key: string, value: unknown): void => {
    options = applyDottedPath(options, key, value);
  };
  for (const expression of flagList(flags, 'set')) {
    const equals = expression.indexOf('=');
    if (equals <= 0) throw new Error(`invalid --set "${expression}": expected key=value`);
    apply(expression.slice(0, equals), parseScalar(expression.slice(equals + 1)));
  }
  const textLength = flags['text-length'];
  if (typeof textLength === 'string') apply('redact.text_length', parseScalar(textLength));
  const argLength = flags['arg-length'];
  if (typeof argLength === 'string') apply('redact.arg_length', parseScalar(argLength));
  const argsMode = flags['args'];
  if (typeof argsMode === 'string') {
    if (argsMode !== 'full' && argsMode !== 'truncate' && argsMode !== 'hide') {
      throw new Error('--args must be one of full, truncate, hide');
    }
    apply('redact.args', argsMode);
  }
  const paths = flags['paths'];
  if (typeof paths === 'string') {
    if (paths !== 'relative' && paths !== 'absolute') {
      throw new Error('--paths must be one of relative, absolute');
    }
    apply('redact.paths', paths);
  }
  if (flags['secrets'] === false) apply('redact.secrets', false);
  const maxEvents = flags['max-events'];
  if (typeof maxEvents === 'string') apply('events.max_events', parseScalar(maxEvents));
  if (flags['include-log-only'] === true) apply('events.include_log_only', true);
  return options;
}

/** Normalize the loaded input into a Report for rendering. */
async function toReport(loaded: LoadedInput, options: Options): Promise<Report> {
  if (loaded.kind === 'report') return loaded.report;
  if (loaded.kind === 'raw') return buildReport(loaded.input, options);
  return buildReportFromSerialized(loaded.meta, loaded.serialized, {}, options);
}

async function runRender(
  loaded: LoadedInput,
  flags: ReturnType<typeof parseArgs>['flags'],
  options: Options,
): Promise<number> {
  const format = typeof flags['format'] === 'string' ? flags['format'] : 'json';
  if (format === 'json' || format === 'junit' || format === 'ndjson') {
    // accepted
  } else {
    throw new Error(`--format must be one of json, junit, ndjson (got "${format}")`);
  }
  const out = typeof flags['out'] === 'string' ? flags['out'] : null;
  const report = await toReport(loaded, options);
  let output: string;

  if (format === 'ndjson') {
    const lines: string[] = [];
    for (const event of report.events) {
      lines.push(JSON.stringify(event));
    }
    lines.push(
      sessionEndLine(report.session.id, report.generated_at, report.outcome, {
        duration_ms: report.stats.duration_ms,
        turns: report.stats.turns,
        steps: report.stats.steps,
        tool_calls: report.stats.tool_calls,
        tool_errors: report.stats.tool_errors,
      }),
    );
    output = `${lines.join('\n')}\n`;
  } else if (format === 'junit') {
    output = renderJunit(report);
  } else {
    const pretty = flags['pretty'] === true;
    output = renderReportJson(report, pretty ? { ...options, output: { ...options.output, pretty: true } } : options);
  }

  if (out !== null) {
    await writeFile(out, output, 'utf8');
    return 0;
  }
  process.stdout.write(output);
  return 0;
}