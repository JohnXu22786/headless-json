# dsh-headless-json

[![CI](https://github.com/JohnXu22786/headless-json/actions/workflows/ci.yml/badge.svg)](https://github.com/JohnXu22786/headless-json/actions/workflows/ci.yml)

Structured, machine-readable CI output for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).
> **中文文档：[README.zh.md](README.zh.md)**

dsh's built-in `headless` mode prints the final assistant text and exits 0/1 —
perfect for a quick smoke test, but thin for CI. `dsh-headless-json` is a
profile bundle that turns any dsh session into a first-class CI artifact:

- a **transaction-level JSON report** (session metadata, every structured
  event, outcome, statistics),
- an **append-only NDJSON event stream** you can `tail` while the run is live,
- a **JUnit XML report** for GitLab CI / Jenkins / Azure DevOps / etc.,
- **semantic exit codes** that distinguish success, failure, timeout,
  blocking, abort and interruption,
- an **artifact manifest** of file paths referenced in the conversation,
- a **privacy layer** (text truncation, argument hiding, secret masking,
  path relativization),
- and a dual entry point: **dsh tools** inside the runtime
  (`output_status`, `output_events`, `set_options`) plus a **standalone CLI**
  for offline rendering and exit-code plumbing.

Everything is deterministic: given the same session log and the same options,
the produced bytes are identical.

---

## Contents

- [Features](#features)
- [How it works](#how-it-works)
- [Bundle layout](#bundle-layout)
- [Installation & integration](#installation--integration)
- [What a run produces](#what-a-run-produces)
- [dsh tools](#dsh-tools)
- [CLI reference](#cli-reference)
- [Configuration](#configuration)
- [Output formats](#output-formats)
  - [JSON report](#json-report)
  - [Events](#events)
  - [NDJSON stream](#ndjson-stream)
  - [JUnit XML](#junit-xml)
- [Exit code semantics](#exit-code-semantics)
- [Privacy & redaction](#privacy--redaction)
- [Artifacts](#artifacts)
- [Determinism](#determinism)
- [Development](#development)
- [Limitations & compatibility](#limitations--compatibility)

---

## Features

| Area | What you get |
| --- | --- |
| **Session event streaming** | Subscribes to the dsh session event firehose (`session/created`, `session/event`, `session/flush`, `session/disposed`) and derives one structured event per turn/step/tool call: type, model, latency, tokens, tool name, argument summary, result, error, status. |
| **JSON output** | A complete transaction-level report: session metadata + event list + outcome/exit code + statistics. Configurable incremental NDJSON stream. |
| **JUnit XML output** | Tool calls, steps and turns map to test cases, so any CI system displays a dsh run like a test run. |
| **Exit-code semantics** | Stable categories (success / error / timeout / blocked / empty / aborted / interrupted) with documented default codes, all overridable. |
| **Artifact collection** | File paths referenced in user/assistant/tool texts are collected into a manifest with existence/size when running on the same machine. |
| **Privacy switch** | Tool output truncation, argument hiding, secret masking, cwd-relative paths — configurable at mount time and at runtime via `set_options`. |
| **Toolchain** | Three dsh tools (`output_status`, `output_events`, `set_options`) plus a standalone CLI (`dsh-headless-json render|exit`). |

## How it works

The bundle is a dsh **profile bundle**: an npm package whose manifest declares

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

The patch inserts one plugin (`headless-json`) into the loader tree. The
plugin subscribes to the session service events, keeps one capture per
session, streams NDJSON lines as events arrive, and writes the JSON/JUnit
reports when the session is disposed (which happens during dsh's normal
graceful teardown).

```
dsh session event stream
        │  session/created · session/event · session/flush · session/disposed
        ▼
┌─────────────────── CaptureManager ───────────────────┐
│  per-session Capture: derive structured events       │
│  (turn/step/tool latency, tokens, model, errors)     │
│  + artifact scan + type distribution                │
└────────────┬──────────────────────────┬─────────────┘
             │ live NDJSON lines        │ on session end
             ▼                          ▼
       events.ndjson            report.json · junit.xml
```

- **Capture vs. output**: events are derived once, in memory; redaction is
  applied *at output time*, so changing options with `set_options` affects
  every subsequent write.
- **No stdout interference**: the plugin never writes to stdout, so it
  composes cleanly with the official headless runner (which owns stdout).
- **Error containment**: every listener is wrapped; a malformed event can
  never crash the tree or corrupt a report.

## Bundle layout

```
headless-json/
├── package.json              # dsh.bundle.patch manifest + bin
├── cordis.patch.yml          # loader patch (inserts the plugin row)
├── lib/                      # compiled ESM (tsc output)
├── bin/dsh-headless-json.js  # CLI entry
├── src/                      # TypeScript sources (repo only)
├── test/                     # node:test suite (repo only)
├── examples/                 # sample session log + generated outputs
├── README.md / README.zh.md
└── LICENSE                   # MIT
```

The repository tree is shown above; the published npm package ships `lib`,
`bin`, `cordis.patch.yml`, `examples`, both READMEs and `LICENSE`.

## Installation & integration

Requirements: Node.js ≥ 18, a dsh installation that composes the `sessions`
service (any base/headless profile does).

### 1. Build (only when developing from source)

```bash
npm install
npm run build        # or: npm test  (builds + runs the suite)
```

### 2. Add the bundle to a dsh profile

Using the CLI (forwards to pnpm):

```bash
dsh plugin --profile headless add /path/to/headless-json
```

or straight from this repository:

```bash
dsh plugin --profile headless add github:JohnXu22786/headless-json
```

or manually: add `dsh-headless-json` to the profile's `package.json`
dependencies and to the ordered `dsh.profile.bundles` list, then
`pnpm install` in the profile directory. dsh reconciles installed bundles
against `dsh.profile.bundles` on the next run.

### 3. Run

```bash
dsh --profile headless "run the test suite"
```

After the run completes you get, in `dsh-output/` (relative to the working
directory):

```
dsh-output/report.json    # transaction-level JSON report
dsh-output/junit.xml      # JUnit XML report
dsh-output/events.ndjson  # only when output.ndjson = true
```

### 4. Wire CI

The semantic exit code lives in the report; the CLI turns it into a process
exit:

```bash
dsh --profile headless "run the test suite"
code=$(dsh-headless-json exit dsh-output/report.json)
exit $code
```

or pipe a JUnit report straight into your CI collector:

```bash
dsh-headless-json render dsh-output/report.json --format junit --out junit.xml
```

## What a run produces

Per session, the plugin writes:

| File | When | Content |
| --- | --- | --- |
| `report.json` | session end | Full report (see [JSON report](#json-report)) |
| `junit.xml` | session end | JUnit XML (see [JUnit XML](#junit-xml)) |
| `events.ndjson` | live | One JSON object per event, appended in real time, plus a final `session_end` line |

File names honor a `{session}` placeholder (e.g.
`"json_file": "report-{session}.json"`); without it, a second session in the
same process gets a `-<id>` suffix before the extension. A session that
recorded zero events writes nothing when `output.write_empty` is false.

## dsh tools

The bundle registers three tools (via `ctx.tools.register`) visible to every
agent. They are resolved against the calling agent's session.

| Tool | Arguments | Returns |
| --- | --- | --- |
| `output_status` | none | Live capture status: event/turn/tool counts, pending tool calls, redaction settings, streaming state. |
| `output_events` | `types?` (array of kinds), `since?` (seq), `limit?` (default 200) | The requested structured events, redacted exactly like the files. |
| `set_options` | partial `output` / `redact` / `artifacts` / `events` / `exit` | The new effective options after validation. |

Example conversation:

```
set_options({ "redact": { "args": "hide" } })
→ { "applied": true, "redact": { "args": "hide", ... } }
```

## CLI reference

```
dsh-headless-json render <input> [options]   Render a report/event file
dsh-headless-json exit <input> [options]     Print the semantic exit code
dsh-headless-json --version | --help
```

`<input>` may be:

- a `report.json` produced by the plugin,
- an `events.ndjson` stream produced by the plugin,
- a raw dsh session `.jsonl` log (header line + `session/*` event lines),
- a JSON array of raw session events.

| Option | Meaning |
| --- | --- |
| `--format json\|junit\|ndjson` | Output format (default `json`). |
| `--out <file>` | Write to a file instead of stdout. |
| `--pretty` | Pretty-print the JSON report. |
| `--set <key=value>` | Override an option, e.g. `--set redact.text_length=1200`. Repeatable. |
| `--text-length <n>` | Shortcut for `--set redact.text_length=<n>`. |
| `--arg-length <n>` | Shortcut for `--set redact.arg_length=<n>`. |
| `--args full\|truncate\|hide` | Shortcut for `--set redact.args=<mode>`. |
| `--paths relative\|absolute` | Shortcut for `--set redact.paths=<mode>`. |
| `--no-secrets` | Disable secret masking. |
| `--max-events <n>` | Shortcut for `--set events.max_events=<n>`. |
| `--cwd <dir>` | Base directory used for path relativization. |
| `--include-log-only` | Surface log-only event types as `other`. |

Notes:

- `exit` prints the code and exits the process with it — the CI glue.
- Redaction `--set` overrides re-render **raw session logs** only. An
  `events.ndjson` stream and a `report.json` are already redacted (redaction
  was applied when each line/file was written at capture time) and are
  re-rendered verbatim.

## Configuration

All options are snake_case, configurable through the bundle's patch `config`
block, the `set_options` tool, or CLI `--set`. Unknown keys are tolerated in
configuration files (forward-compatible deployments); `set_options` and CLI
`--set` reject unknown keys, including unknown nested keys.

```yaml
# cordis.patch.yml (profile overlay example)
- id: headless-json
  config:
    output:
      dir: dsh-output
      json: true
      junit: true
      ndjson: true
    redact:
      text_length: 4000
      args: truncate
      paths: relative
      secrets: true
```

| Key | Default | Description |
| --- | --- | --- |
| `output.dir` | `dsh-output` | Report directory (relative to cwd). |
| `output.json` | `true` | Write `report.json`. |
| `output.junit` | `true` | Write `junit.xml`. |
| `output.ndjson` | `false` | Stream `events.ndjson` live. |
| `output.json_file` | `report.json` | JSON file name (`{session}` placeholder supported). |
| `output.junit_file` | `junit.xml` | JUnit file name. |
| `output.ndjson_file` | `events.ndjson` | NDJSON file name. |
| `output.write_empty` | `true` | Write reports for sessions with zero events. |
| `output.pretty` | `false` | Pretty-print the JSON report. |
| `redact.text_length` | `4000` | Max chars of any text value in outputs (`0` = unlimited). |
| `redact.arg_length` | `500` | Max chars of the tool-argument summary. |
| `redact.args` | `truncate` | `full` (parsed object), `truncate` (summary), `hide` (`[hidden]`). |
| `redact.paths` | `relative` | `relative` (against session cwd) or `absolute`. |
| `redact.secrets` | `true` | Mask secret-shaped strings. |
| `redact.secret_patterns` | `[]` | Extra regex source strings, applied in addition to the built-ins. |
| `artifacts.collect` | `true` | Scan texts for file-path references. |
| `artifacts.check_exists` | `true` | `stat` matched paths (only meaningful on the run machine). |
| `artifacts.max_entries` | `500` | Maximum unique artifact entries. |
| `artifacts.pattern_extras` | `[]` | Extra path regex source strings. |
| `events.max_events` | `1000` | Max events in the report's event list (`0` = unlimited). |
| `events.trim` | `balanced` | `head` keeps the first N; `balanced` keeps head+tail. |
| `events.include_log_only` | `false` | Surface log-only types (`request/header`, `session/end-seed`, …) as `other` events. |
| `exit.*` | see table | Per-category exit codes (see [Exit code semantics](#exit-code-semantics)). |
| `capture.text_cap` | `100000` | Hard cap on the chars of any single stored text. |

## Output formats

### JSON report

```
{
  "schema_version": 1,
  "plugin": { "name": "dsh-headless-json", "version": "0.1.0" },
  "generated_at": 1753000000000,          // session end time (derived, deterministic)
  "session": {
    "id": "...", "cwd": ".", "cwd_name": "repo",
    "created_at": ..., "started_at": ..., "ended_at": ...,
    "event_count": 42,
    "parent_session": null, "agent_preset": "minimal", "delegation_depth": null
  },
  "outcome": {
    "status": "success",                  // stable category
    "exit_code": 0,                       // semantic exit code
    "reason": "completed",                // raw turn/end reason kind
    "complete": true,
    "undelivered_tool_calls": [],
    "error": null                         // {code, message, status?} on error
  },
  "stats": {
    "duration_ms": 4123.5,
    "turns": 1, "steps": 2,
    "assistant_messages": 3, "user_messages": 1,
    "tool_calls": 2, "tool_errors": 0, "undelivered_tool_calls": 0,
    "chunk_count": 14,
    "tokens": { "input": 900, "output": 300, "cache_read": 0, "cache_write": 0, "reasoning": 0 },
    "events_by_type": { "assistant/message": 3, "tool/call": 2, ... },  // raw dsh types
    "by_tool": { "bash": { "calls": 2, "errors": 0, "latency_ms_total": 800, "latency_ms_max": 500 } }
  },
  "events": [ /* see below */ ],
  "events_truncated": null,               // {kept,total,dropped} when trimmed
  "artifacts": [ { "path": "src/options.ts", "kind": "file", "size": 4281, "references": 3 } ]
}
```

### Events

Every event carries `seq` (session-log sequence, the stable sort key),
`time` (unix ms) and `kind`:

| kind | extra fields |
| --- | --- |
| `turn_start` | `turn` |
| `turn_end` | `turn`, `reason`, `error` (code/message/status), `cause` (abort kind), `latency_ms`, `complete` |
| `step_start` / `step_end` | `turn`, `step`, (`latency_ms`) |
| `user_message` | `turn`, `step`, `text`, `reasoning`, `blocks` |
| `assistant_message` | `turn`, `step`, `provider`, `model`, `latency_ms`, `usage`, `text`, `reasoning`, `blocks`, `stream` (chunk count/times) |
| `tool_call` | `turn`, `step`, `call_id`, `tool`, `args_mode`, `args`, `args_summary`, `latency_ms`, `undelivered` |
| `tool_result` | `turn`, `step`, `call_id`, `tool`, `status` (`success`/`error`), `latency_ms`, `text`, `blocks`, `error` |
| `todo_write` | `count`, `todos` |
| `request_context` | `provider`, `model`, `context_window` |
| `other` | `type` (only with `events.include_log_only`) |

Tool calls and results are correlated by `call_id`; latencies are computed
from the session log timestamps. A `tool_call` whose `tool/result` never
arrived by session end is flagged `undelivered: true` and listed in
`outcome.undelivered_tool_calls`.

### NDJSON stream

One JSON object per line, in arrival order, written immediately:
the same structured events plus a final summary line:

```json
{"kind":"session_end","session_id":"...","generated_at":...,
 "outcome":{"status":"success","exit_code":0,"reason":"completed"},
 "stats":{"duration_ms":4123,"turns":1,"steps":2,"tool_calls":2,"tool_errors":0}}
```

The file is fsynced on every `session/flush` checkpoint, so consumers that
read storage after `whenIdle()` see a durable stream. A `tool_call` line is
streamed *before* its result arrives, so the `latency_ms` / `undelivered`
fields on those lines are provisional; the correlating `tool_result` line (or
the final report) carries the authoritative values.

### JUnit XML

| dsh concept | JUnit mapping |
| --- | --- |
| the whole session | `<testsuites name="dsh-headless-json">` → one `<testsuite>` with session properties (id, cwd, status, exit_code, reason, plugin version) |
| overall outcome | `<testcase name="run">` — passes only when `outcome.status === "success"`, otherwise `<error>`/`<failure>` |
| each turn | `<testcase name="turn-N">` — `completed` passes; `error`/`max-tokens` fail; `blocked`/`aborted`/`interrupted` skip |
| each step | `<testcase name="step-N">` with its duration; skipped when it never closed |
| each tool call | `<testcase name="tool:NAME">` with its duration and the result text in `<system-out>`; failed calls produce `<failure type="dsh:tool">` |

Timing is in decimal seconds, timestamps are ISO-8601 UTC, and all text is
XML-1.0-escaped (control characters replaced).

## Exit code semantics

The final `turn/end` reason maps to a stable category and a documented exit
code; every value is overridable via `exit.*`:

| Category | Final turn/end reason | Default code |
| --- | --- | --- |
| `success` | `completed` | 0 |
| `error` | `error` | 1 |
| `timeout` | `max-tokens` | 2 |
| `blocked` | `blocked` | 3 |
| `empty` | (no events at all) | 4 |
| `aborted` | `aborted` | 130 |
| `interrupted` | `interrupted` | 130 |

Sessions with events but no closing `turn/end` are reported as
`error`/`incomplete`. The 130 code intentionally follows the SIGINT
convention for user-initiated stops.

## Privacy & redaction

Defaults are conservative but usable. Everything applies at output time.

- **Text truncation** — every text/reasoning value is capped at
  `redact.text_length` with a deterministic `…[+N more chars]` marker.
- **Argument handling** — `redact.args`:
  - `full`: the parsed argument object, string values masked/truncated;
  - `truncate` (default): a masked summary capped at `redact.arg_length`;
  - `hide`: the literal string `[hidden]`.
- **Secret masking** (`redact.secrets`) — built-ins cover `sk-…` keys,
  `Bearer …` headers, PEM private keys, GitHub/Google tokens, JWTs, long hex
  values (keeps a short prefix for e.g. commit SHAs) and token-like strings.
  Turn/end error messages are treated as free text and masked too. Add your
  own with `redact.secret_patterns` (regex source strings, validated at
  configuration time).
- **Path relativization** — `redact.paths: relative` (default) strips the
  session cwd from artifact paths and renders `session.cwd` as `.`;
  `absolute` keeps full paths.

What this means in practice: the default output contains no absolute
workspace paths, no raw secret strings, and no unbounded tool output.

## Artifacts

When `artifacts.collect` is on, every user/assistant/tool text is scanned
for path-like candidates (POSIX/Windows absolute paths and
separator-containing relative paths; URLs and emails are excluded). Each
unique candidate becomes an artifact entry with a reference count; when
`artifacts.check_exists` is on (the default) and the run happens on the same
machine, `kind` (`file`/`dir`/`missing`) and `size` are filled in from the
filesystem. The manifest is bounded by `artifacts.max_entries`.

## Determinism

Given the same session events and the same effective options:

- the JSON report is **byte-identical** across runs — object key order is
  fixed by construction, events are sorted by `seq`, map-like fields are
  serialized with sorted keys, and numbers are rounded to 3 decimals;
- JUnit XML and NDJSON lines are produced from the same serialization core,
  so all three formats always agree.

`generated_at` (and the JUnit `timestamp`) are derived from the session's own
timeline — the last event time — so they never depend on a wall clock.

## Development

```bash
npm install
npm run build        # tsc -> lib/
npm test             # build + run the full suite (node:test)
npm run test:only    # run tests against the current build
npm run typecheck    # tsc --noEmit
```

The test suite covers event subscription wiring (against a minimal fake
context), capture derivation, serialization determinism, redaction, exit-code
mapping, JUnit structure/escaping, NDJSON round-tripping and the CLI
end-to-end.

## Limitations & compatibility

- **Preview APIs.** dsh is a developer preview; session event shapes and
  service semantics may evolve. The capture pipeline reads every event
  defensively (malformed input is counted, never fatal) and the session
  event vocabulary used here is documented in the published session typings.
- **Tool schema shape.** The three dsh tools are registered as plain
  definitions matching the shape `ctx.tools.register` expects; if a future
  dsh version changes the definition DSL, only `src/tools.ts` needs updating.
  When `ctx.tools` is absent from a composition, the plugin still captures
  and reports — only the tools are skipped (with a log warning).
- **Exit codes vs. dsh headless.** The official headless runner exits 0/1 by
  its own contract; this plugin does not touch `headlessIo`. Use the
  `exit` command (or read `report.json`) for the fine-grained codes.
- **Re-rendering redaction.** Only raw session logs can be re-rendered with a
  different `--set` redaction (redaction is a capture-time property of
  `report.json` and NDJSON lines).

## License

MIT — see [LICENSE](LICENSE).
