/**
 * JUnit XML rendering: maps the session's turns, steps and tool calls to test
 * cases so CI systems can display a dsh run in their usual tabular view.
 *
 * Mapping (stable and documented in the README):
 *   - one `<testcase name="run">` per session reflecting the overall outcome
 *   - one `<testcase name="turn-N">` per turn
 *   - one `<testcase name="step-N">` per step (skipped if it never closed)
 *   - one `<testcase name="tool:NAME">` per tool call
 *
 * `completed` turns pass; `error`/`max-tokens` turns fail; `blocked`,
 * `aborted` and `interrupted` turns are skipped. Failed tool calls fail their
 * case. The run case fails unless the session ended as `success`.
 */

import type { Report } from './model.js';
import { formatTime, formatIsoTimestamp } from './timefmt.js';

interface TestCase {
  name: string;
  classname: string;
  timeSeconds: string;
  result: { kind: 'pass' } | { kind: 'failure'; type: string; message: string } | { kind: 'error'; type: string; message: string } | { kind: 'skipped'; message: string };
  systemOut: string | null;
}

interface TurnGroup {
  end: Record<string, unknown> | null;
  stepsEnded: Map<string, number | null>;
  stepsStarted: Set<string>;
  tools: Array<Record<string, unknown>>;
  undelivered: Array<Record<string, unknown>>;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function shortId(sessionId: string): string {
  const parts = sessionId.split('-');
  const tail = parts[parts.length - 1] ?? sessionId;
  return tail.length > 8 ? tail.slice(0, 8) : tail;
}

function newTurnGroup(): TurnGroup {
  return { end: null, stepsEnded: new Map(), stepsStarted: new Set(), tools: [], undelivered: [] };
}

/** Build the JUnit XML document for a report. */
export function renderJunit(report: Report): string {
  const session = report.session;
  const outcome = report.outcome;
  const sessionClass = `session-${shortId(session.id)}`;

  const turnGroups = new Map<number, TurnGroup>();
  for (const event of report.events) {
    const kind = typeof event.kind === 'string' ? event.kind : '';
    if (kind === 'turn_start') {
      const turn = numOf(event.turn);
      if (!turnGroups.has(turn)) turnGroups.set(turn, newTurnGroup());
    } else if (kind === 'turn_end') {
      const turn = numOf(event.turn);
      const group = turnGroups.get(turn) ?? newTurnGroup();
      group.end = event;
      turnGroups.set(turn, group);
    } else if (kind === 'step_start') {
      const turn = numOf(event.turn);
      const group = turnGroups.get(turn) ?? newTurnGroup();
      const step = String(numOf(event.step));
      group.stepsStarted.add(step);
      turnGroups.set(turn, group);
    } else if (kind === 'step_end') {
      const turn = numOf(event.turn);
      const group = turnGroups.get(turn) ?? newTurnGroup();
      group.stepsEnded.set(String(numOf(event.step)), typeof event.latency_ms === 'number' ? event.latency_ms : null);
      turnGroups.set(turn, group);
    } else if (kind === 'tool_result') {
      const turn = numOf(event.turn);
      const group = turnGroups.get(turn) ?? newTurnGroup();
      group.tools.push(event);
      turnGroups.set(turn, group);
    } else if (kind === 'tool_call' && event.undelivered === true) {
      const turn = numOf(event.turn);
      const group = turnGroups.get(turn) ?? newTurnGroup();
      group.undelivered.push(event);
      turnGroups.set(turn, group);
    }
  }

  const cases: TestCase[] = [];
  cases.push(runTestCase(report));

  const turns = [...turnGroups.keys()].sort((a, b) => a - b);
  for (const turn of turns) {
    const group = turnGroups.get(turn);
    if (group === undefined) continue;
    cases.push(turnTestCase(turn, group, sessionClass));

    const steps = [...group.stepsStarted].sort();
    for (const step of steps) {
      const latencyMs = group.stepsEnded.get(step) ?? null;
      cases.push({
        name: `step-${step}`,
        classname: `${sessionClass}.turn-${turn}`,
        timeSeconds: formatTime(latencyMs),
        result: group.stepsEnded.has(step) ? { kind: 'pass' } : { kind: 'skipped', message: 'step did not close before the session ended' },
        systemOut: null,
      });
    }

    for (const toolEvent of group.tools) {
      cases.push(toolResultCase(toolEvent, turn, sessionClass));
    }
    for (const callEvent of group.undelivered) {
      cases.push(undeliveredCase(callEvent, turn, sessionClass));
    }
  }

  let failures = 0;
  let errors = 0;
  let skipped = 0;
  let timeTotal = 0;
  for (const testCase of cases) {
    if (testCase.result.kind === 'failure') failures += 1;
    if (testCase.result.kind === 'error') errors += 1;
    if (testCase.result.kind === 'skipped') skipped += 1;
    timeTotal += Number(testCase.timeSeconds);
  }

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    `<testsuites ` +
      `name=${attr('dsh-headless-json')} tests=${attr(String(cases.length))} failures=${attr(String(failures))} ` +
      `errors=${attr(String(errors))} skipped=${attr(String(skipped))} time=${attr(formatTime(report.stats.duration_ms))} ` +
      `timestamp=${attr(formatIsoTimestamp(report.generated_at))}>`,
  );
  lines.push(
    `  <testsuite name=${attr(session.id)} tests=${attr(String(cases.length))} failures=${attr(String(failures))} ` +
      `errors=${attr(String(errors))} skipped=${attr(String(skipped))} time=${attr(formatTime(report.stats.duration_ms))}>`,
  );
  lines.push('    <properties>');
  lines.push(`      <property name="plugin" value=${attr(report.plugin.name)}/>`);
  lines.push(`      <property name="plugin.version" value=${attr(report.plugin.version)}/>`);
  lines.push(`      <property name="schema_version" value=${attr(String(report.schema_version))}/>`);
  lines.push(`      <property name="session_id" value=${attr(session.id)}/>`);
  lines.push(`      <property name="cwd" value=${attr(session.cwd)}/>`);
  lines.push(`      <property name="status" value=${attr(outcome.status)}/>`);
  lines.push(`      <property name="exit_code" value=${attr(String(outcome.exit_code))}/>`);
  lines.push(`      <property name="reason" value=${attr(outcome.reason)}/>`);
  lines.push('    </properties>');

  for (const testCase of cases) {
    lines.push(renderTestCase(testCase));
  }

  lines.push('  </testsuite>');
  lines.push('</testsuites>');
  return `${lines.join('\n')}\n`;
}

function runTestCase(report: Report): TestCase {
  const outcome = report.outcome;
  const timeSeconds = formatTime(report.stats.duration_ms);
  if (outcome.status === 'success') {
    return { name: 'run', classname: 'outcome', timeSeconds, result: { kind: 'pass' }, systemOut: null };
  }
  const detail = `${outcome.status}/${outcome.reason}`;
  if (outcome.status === 'error') {
    const error = outcome.error;
    const message = error !== null && error.message.length > 0 ? `${error.code}: ${error.message}` : detail;
    return { name: 'run', classname: 'outcome', timeSeconds, result: { kind: 'error', type: 'dsh:error', message }, systemOut: null };
  }
  return {
    name: 'run',
    classname: 'outcome',
    timeSeconds,
    result: { kind: 'failure', type: `dsh:${outcome.status}`, message: detail },
    systemOut: null,
  };
}

function turnTestCase(turn: number, group: TurnGroup, sessionClass: string): TestCase {
  const end = group.end;
  const timeSeconds = end === null ? '0.000' : formatTime(numOf(end.latency_ms));
  const name = `turn-${turn}`;
  const classname = `${sessionClass}.turn`;
  if (end === null) {
    return { name, classname, timeSeconds, result: { kind: 'skipped', message: 'turn did not close before the session ended' }, systemOut: null };
  }
  const reason = textOf(end.reason);
  switch (reason) {
    case 'completed':
      return { name, classname, timeSeconds, result: { kind: 'pass' }, systemOut: null };
    case 'error': {
      const error = end.error as { code?: unknown; message?: unknown } | null;
      const code = textOf(error?.code);
      const message = textOf(error?.message);
      const detail = message.length > 0 && code.length > 0 ? `${code}: ${message}` : code.length > 0 ? code : 'turn failed';
      return { name, classname, timeSeconds, result: { kind: 'error', type: 'dsh:error', message: detail }, systemOut: null };
    }
    case 'max-tokens':
      return { name, classname, timeSeconds, result: { kind: 'failure', type: 'dsh:timeout', message: 'output token ceiling reached' }, systemOut: null };
    case 'blocked':
      return { name, classname, timeSeconds, result: { kind: 'skipped', message: 'blocked by policy' }, systemOut: null };
    case 'aborted': {
      const cause = textOf(end.cause);
      return { name, classname, timeSeconds, result: { kind: 'skipped', message: cause.length > 0 ? `aborted (${cause})` : 'aborted' }, systemOut: null };
    }
    case 'interrupted':
      return { name, classname, timeSeconds, result: { kind: 'skipped', message: 'interrupted' }, systemOut: null };
    default:
      return { name, classname, timeSeconds, result: { kind: 'failure', type: 'dsh:unexpected', message: `unexpected end reason: ${reason}` }, systemOut: null };
  }
}

function toolResultCase(event: Record<string, unknown>, turn: number, sessionClass: string): TestCase {
  const tool = textOf(event.tool);
  const step = numOf(event.step);
  const timeSeconds = formatTime(numOf(event.latency_ms));
  const classname = `${sessionClass}.turn-${turn}.step-${step}`;
  const systemOut = textOf(event.text);
  if (event.status === 'error') {
    const error = event.error as { name?: unknown; code?: unknown } | null;
    const errorName = textOf(error?.name);
    const errorCode = textOf(error?.code);
    const message = errorCode.length > 0 ? `${errorName}: ${errorCode}` : 'tool call failed';
    return { name: `tool:${tool}`, classname, timeSeconds, result: { kind: 'failure', type: 'dsh:tool', message }, systemOut };
  }
  return { name: `tool:${tool}`, classname, timeSeconds, result: { kind: 'pass' }, systemOut };
}

function undeliveredCase(event: Record<string, unknown>, turn: number, sessionClass: string): TestCase {
  const tool = textOf(event.tool);
  const step = numOf(event.step);
  const classname = `${sessionClass}.turn-${turn}.step-${step}`;
  return {
    name: `tool:${tool}`,
    classname,
    timeSeconds: '0.000',
    result: { kind: 'failure', type: 'dsh:undelivered', message: 'tool result never arrived before the session ended' },
    systemOut: null,
  };
}

function renderTestCase(testCase: TestCase): string {
  const lines: string[] = [];
  const open = `    <testcase name=${attr(testCase.name)} classname=${attr(testCase.classname)} time=${attr(testCase.timeSeconds)}`;
  lines.push(`${open}>`);
  if (testCase.result.kind === 'failure') {
    lines.push(`      <failure type=${attr(testCase.result.type)} message=${attr(testCase.result.message)}/>`);
  } else if (testCase.result.kind === 'error') {
    lines.push(`      <error type=${attr(testCase.result.type)} message=${attr(testCase.result.message)}/>`);
  } else if (testCase.result.kind === 'skipped') {
    lines.push(`      <skipped message=${attr(testCase.result.message)}/>`);
  }
  if (testCase.systemOut !== null && testCase.systemOut.length > 0) {
    lines.push('      <system-out>');
    lines.push(`        ${escapeText(testCase.systemOut)}`);
    lines.push('      </system-out>');
  }
  lines.push('    </testcase>');
  return lines.join('\n');
}

/** Escape and XML-1.0-sanitize an attribute value. */
export function attr(value: string): string {
  return `"${escapeXml(value)}"`;
}

/** Escape and XML-1.0-sanitize element text. */
export function escapeText(value: string): string {
  return escapeXml(value);
}

function escapeXml(value: string): string {
  const banned = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
  return value
    .replace(banned, '\uFFFD')
    .replace(lone, '\uFFFD')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}