/**
 * Privacy redaction: text truncation, secret masking, tool-argument
 * summarization and path relativization.
 *
 * Redaction is applied at *output time* (serialization), never at capture
 * time, so `set_options` can change the effective privacy level for the next
 * file write. The live NDJSON stream is redacted when each line is written,
 * so lines already streamed keep the level that was active at that moment.
 */

import type { RedactOptions } from './options.js';

/** Truncate a string with a deterministic marker when it exceeds max chars. */
export function truncateText(text: string, max: number): string {
  if (max <= 0 || text.length <= max) return text;
  const keep = Math.max(0, max);
  return `${text.slice(0, keep)}…[+${text.length - keep} more chars]`;
}

/** Built-in secret patterns, applied before any custom patterns. */
const BUILTIN_SECRET_PATTERNS: readonly { re: RegExp; replacement: (match: string) => string }[] = [
  // DeepSeek / OpenAI style project keys.
  { re: /sk-[A-Za-z0-9_-]{8,}/g, replacement: () => '[REDACTED]' },
  // Bearer authorization headers.
  { re: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, replacement: () => '[REDACTED]' },
  // PEM private key blocks.
  { re: /-----BEGIN(?: [A-Z ]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z ]+)? PRIVATE KEY-----/g, replacement: () => '[REDACTED:PRIVATE-KEY]' },
  // GitHub tokens.
  { re: /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/g, replacement: () => '[REDACTED]' },
  // Google API keys.
  { re: /\bAIza[0-9A-Za-z_-]{20,}/g, replacement: () => '[REDACTED]' },
  // JSON Web Tokens.
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, replacement: () => '[REDACTED]' },
  // Long hex strings (32+ hex digits). Prefix-8 is kept for debuggability
  // (e.g. commit SHAs), the rest is masked.
  {
    re: /[0-9a-fA-F]{32,}/g,
    replacement: (match) => (match.length > 40 ? `[REDACTED:HEX:${match.slice(0, 8)}]` : `${match.slice(0, 8)}…[REDACTED-${match.length - 8}]`),
  },
];

/** Long token-like strings (no spaces, mixed-case alphanumerics) get masked. */
const TOKEN_LIKE_RE = /[A-Za-z0-9+/_-]{40,}/g;

function isTokenLike(match: string): boolean {
  if (TOKEN_LIKE_RE.lastIndex !== 0) TOKEN_LIKE_RE.lastIndex = 0;
  TOKEN_LIKE_RE.lastIndex = 0;
  const found = TOKEN_LIKE_RE.exec(match);
  if (found === null || found[0] !== match) return false;
  const hasLower = /[a-z]/.test(match);
  const hasUpper = /[A-Z]/.test(match);
  const hasDigit = /[0-9]/.test(match);
  if (!(hasLower && hasUpper && hasDigit)) return false;
  // Avoid masking long sentences/words that merely look dense.
  return !/['.\s]/.test(match);
}

function applyBuiltinSecrets(text: string): string {
  let result = text;
  for (const pattern of BUILTIN_SECRET_PATTERNS) {
    result = result.replace(pattern.re, pattern.replacement);
  }
  result = result.replace(TOKEN_LIKE_RE, (match) => {
    if (!isTokenLike(match)) return match;
    return `[REDACTED:TOKEN:${match.slice(0, 6)}]`;
  });
  return result;
}

function compileCustomPatterns(patterns: string[]): RegExp[] {
  const compiled: RegExp[] = [];
  for (const source of patterns) {
    try {
      compiled.push(new RegExp(source, 'g'));
    } catch (caught) {
      throw new Error(`redact.secret_patterns contains an invalid regular expression: ${source} (${(caught as Error).message})`);
    }
  }
  return compiled;
}

/** Mask secret-shaped strings in text. */
export function maskSecrets(text: string, options: RedactOptions): string {
  if (!options.secrets) return text;
  let result = applyBuiltinSecrets(text);
  if (options.secret_patterns.length > 0) {
    for (const re of compileCustomPatterns(options.secret_patterns)) {
      result = result.replace(re, '[REDACTED]');
    }
  }
  return result;
}

/** Truncate then mask: the standard text pipeline at output time.
 *
 * Masking runs FIRST so a secret straddling the truncation boundary can never
 * survive with its head characters intact; then the truncation marker is
 * appended to the (already masked) text. */
export function redactText(text: string, options: RedactOptions): string {
  const masked = options.secrets ? maskSecrets(text, options) : text;
  return truncateText(masked, options.text_length);
}

/** Summarize a tool-call argument JSON text into a compact form.
 *
 * Masking runs first (same rationale as redactText: a secret straddling the
 * summary boundary must not survive with its head characters intact), then
 * the summary is truncated to the configured length. */
export function summarizeArgsText(argText: string, options: RedactOptions): string {
  const masked = options.secrets ? maskSecrets(argText, options) : argText;
  return truncateText(masked, options.arg_length);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Deep-copy a parsed argument tree for `full` mode, truncating and masking
 * every key and string value inside so no huge or sensitive data can leak to
 * outputs.
 */
export function sanitizeArgsTree(value: unknown, options: RedactOptions): unknown {
  if (Array.isArray(value)) return value.map((entry) => sanitizeArgsTree(entry, options));
  if (isRecord(value)) {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const maskedKey = options.secrets ? maskSecrets(key, options) : key;
      const keyOut = truncateText(maskedKey, options.arg_length);
      output[keyOut] = sanitizeArgsTree(entry, options);
    }
    return output;
  }
  if (typeof value === 'string') {
    const masked = options.secrets ? maskSecrets(value, options) : value;
    return truncateText(masked, options.text_length);
  }
  return value;
}

/** Relativize a file path against cwd, or keep it absolute. */
export function relativizePath(path: string, cwd: string, mode: 'relative' | 'absolute'): string {
  const posix = path.replace(/\\/g, '/');
  const posixCwd = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  if (mode === 'absolute') return posix;
  if (posix === posixCwd) return '.';
  // Case-insensitive prefix comparison is only correct on case-insensitive
  // filesystems (Windows); on POSIX the comparison is case-sensitive.
  if (process.platform === 'win32') {
    const lower = posix.toLowerCase();
    const lowerCwd = posixCwd.toLowerCase();
    if (lower.startsWith(`${lowerCwd}/`)) return posix.slice(posixCwd.length + 1);
  } else if (posix.startsWith(`${posixCwd}/`)) {
    return posix.slice(posixCwd.length + 1);
  }
  return posix;
}