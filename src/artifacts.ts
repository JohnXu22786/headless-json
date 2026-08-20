/**
 * Artifact collection: locate file-like references inside captured texts.
 *
 * This is a pragmatic heuristic, not a file resolver: path-like candidates are
 * matched with regular expressions, cleaned, deduplicated, and (when running
 * on the same machine) stat()ed for existence/size. URLs, email-like strings
 * and prose fragments are rejected. The manifest is intentionally bounded.
 */

/** Max chars of a single text that path scanning will inspect. */
const SCAN_CAP = 50_000;

/** Max candidates extracted from a single text. */
const CANDIDATE_CAP = 200;

/** Leading characters that may wrap a path candidate. */
const LEADING_TRIM = /^[\s"'`([<{]/;

/** Trailing punctuation that is never part of a path. */
const TRAILING_TRIM = /[\s,;:!?)\]}>.'"`]+$/;

/** Absolute POSIX paths: /foo/bar, /tmp/x.log, /home/user/dir/.hidden. */
const ABS_POSIX_RE = /(?<![A-Za-z0-9_./~-])(\/[\w.@+-]+(?:\/[\w.@$-]+)+)/g;

/** Absolute Windows paths: C:\docs\a.txt, D:/tmp/x.log. */
const ABS_WINDOWS_RE = /(?<![A-Za-z0-9_])([A-Za-z]:[\\/][^\s"'`<>|*?]+)/g;

/** Relative paths with at least one segment boundary on either separator. */
const RELATIVE_RE = /(?<![A-Za-z0-9_./~-])([\w.@~-]+(?:[\\/][\w.@$-]+)+)/g;

/** URLs and mail addresses that must never be treated as artifacts. */
const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const MAIL_RE = /^[^@\s]+@[^@\s]+$/;

function stripWrappers(candidate: string): string {
  let value = candidate.replace(LEADING_TRIM, '');
  value = value.replace(TRAILING_TRIM, '');
  // Balanced quote/backtick/paren stripping.
  const pairs: ReadonlyArray<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ['`', '`'],
    ['(', ')'],
    ['[', ']'],
    ['<', '>'],
  ];
  let changed = true;
  while (changed && value.length > 1) {
    changed = false;
    for (const [open, close] of pairs) {
      if (value.startsWith(open) && value.endsWith(close)) {
        value = value.slice(1, -1).trim();
        changed = true;
        break;
      }
    }
  }
  return value;
}

function collectMatches(source: RegExp, text: string, targets: string[]): void {
  source.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = source.exec(text)) !== null && targets.length < CANDIDATE_CAP) {
    const raw = match[1] ?? match[0];
    const cleaned = stripWrappers(raw);
    if (cleaned.length < 2) continue;
    if (URL_RE.test(cleaned) || MAIL_RE.test(cleaned)) continue;
    targets.push(cleaned);
  }
}

/**
 * Extract cleaned path candidates from a text.
 *
 * Duplicates are intentionally preserved: the collector counts how often each
 * artifact is referenced. Extraction stops after CANDIDATE_CAP matches per
 * text so a single noisy string cannot flood the pipeline.
 */
export function extractPaths(text: string, extraPatterns: string[]): string[] {
  const targets: string[] = [];
  const limited = text.length > SCAN_CAP ? text.slice(0, SCAN_CAP) : text;
  collectMatches(ABS_POSIX_RE, limited, targets);
  collectMatches(ABS_WINDOWS_RE, limited, targets);
  collectMatches(RELATIVE_RE, limited, targets);
  for (const source of extraPatterns) {
    let re: RegExp;
    try {
      re = new RegExp(source, 'g');
    } catch (caught) {
      throw new Error(`artifacts.pattern_extras contains an invalid regular expression: ${source} (${(caught as Error).message})`);
    }
    collectMatches(re, limited, targets);
  }
  return targets;
}