/**
 * Exit-code semantics: map the final turn/end reason of a session to a
 * stable outcome category and a process exit code, so CI can branch on the
 * machine-readable result instead of parsing text.
 *
 * Default table (every value overridable through `options.exit`):
 *
 *   category     turn/end reason      default code   meaning
 *   success      completed            0              task finished normally
 *   error        error                1              the run failed
 *   timeout      max-tokens           2              output-token ceiling hit
 *   blocked      blocked              3              blocked by policy
 *   empty        (no turn/end)        4              nothing was recorded
 *   aborted      aborted             130              cancelled (SIGINT-style)
 *   interrupted  interrupted         130              interrupted externally
 *
 * The 130 code intentionally follows the conventional SIGINT exit status;
 * a process is "aborted" or "interrupted" for similar operational reasons.
 */

export interface ResolvedOutcome {
  /** Stable machine-readable category. */
  status: OutcomeStatus;
  /** Raw turn/end reason kind, or a synthesized marker ('none'/'incomplete'). */
  reason: string;
  /** Process exit code produced by `status`. */
  exitCode: number;
  /** Whether a final turn/end reason was observed (a structurally complete run). */
  complete: boolean;
  /** Tool-call ids without a matching tool/result by the end of the session. */
  undelivered: string[];
  /** Structured failure facts when the final reason was `error`. */
  error: { code: string; message: string; status?: number } | null;
}

/** The outcome categories this plugin distinguishes. */
export type OutcomeStatus =
  | 'success'
  | 'error'
  | 'timeout'
  | 'blocked'
  | 'empty'
  | 'aborted'
  | 'interrupted'
  | 'unknown';

export interface ResolveInput {
  /** The last turn/end reason (normalized, kind string). */
  lastReasonKind: string | null;
  /** Whether any session event was recorded at all. */
  hasEvents: boolean;
  /** Whether some turns started but none finished with a reason. */
  incomplete: boolean;
  /** Undelivered tool-call ids (no matching tool/result). */
  undelivered: string[];
  /** Structured failure facts when the final reason kind was 'error'. */
  error: { code: string; message: string; status?: number } | null;
  /** Exit code overrides (from options.exit). */
  exitCodes: {
    success: number;
    error: number;
    timeout: number;
    blocked: number;
    empty: number;
    aborted: number;
    interrupted: number;
  };
}

/** Render a final reason kind to a stable outcome status. */
export function statusForKind(kind: string): OutcomeStatus {
  switch (kind) {
    case 'completed':
      return 'success';
    case 'error':
      return 'error';
    case 'max-tokens':
      return 'timeout';
    case 'blocked':
      return 'blocked';
    case 'aborted':
      return 'aborted';
    case 'interrupted':
      return 'interrupted';
    default:
      return 'unknown';
  }
}

/** Resolve the session outcome from the summarized inputs. */
export function resolveOutcome(input: ResolveInput): ResolvedOutcome {
  const codes = input.exitCodes;

  if (input.lastReasonKind === null) {
    if (!input.hasEvents) {
      return {
        status: 'empty',
        reason: 'none',
        exitCode: codes.empty,
        complete: false,
        undelivered: input.undelivered,
        error: null,
      };
    }
    // Events exist but no turn ever closed: an incomplete/interrupted run.
    return {
      status: 'error',
      reason: 'incomplete',
      exitCode: codes.error,
      complete: false,
      undelivered: input.undelivered,
      error: input.error,
    };
  }

  const status = statusForKind(input.lastReasonKind);
  const code = defaultCodeFor(status, codes);
  const statusError = status === 'error' ? input.error : null;
  return {
    status,
    reason: input.lastReasonKind,
    exitCode: code,
    complete: true,
    undelivered: input.undelivered,
    error: statusError,
  };
}

function defaultCodeFor(status: OutcomeStatus, codes: ResolveInput['exitCodes']): number {
  switch (status) {
    case 'success':
      return codes.success;
    case 'error':
      return codes.error;
    case 'timeout':
      return codes.timeout;
    case 'blocked':
      return codes.blocked;
    case 'empty':
      return codes.empty;
    case 'aborted':
      return codes.aborted;
    case 'interrupted':
      return codes.interrupted;
    case 'unknown':
      return codes.error;
  }
}