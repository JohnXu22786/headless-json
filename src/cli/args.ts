/**
 * CLI argument parsing. Zero dependencies; supports:
 *   - `--key value` / `--key=value` / `--no-key`
 *   - repeatable flags (`--set a=1 --set b=2`)
 *   - positional arguments
 */

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean | string[]>;
}

/** Flags that consume the next token as their value. */
const VALUE_FLAGS = new Set([
  'format',
  'out',
  'cwd',
  'text-length',
  'arg-length',
  'args',
  'paths',
  'set',
  'max-events',
]);

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};

  const setFlag = (key: string, value: string | boolean): void => {
    const existing = flags[key];
    if (key === 'set' && typeof existing === 'string') {
      flags[key] = [existing, value as string];
    } else if (Array.isArray(existing) && key === 'set') {
      existing.push(value as string);
    } else {
      flags[key] = value;
    }
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (token === '--') {
      positional.push(...argv.slice(index + 1));
      break;
    }
    if (token.startsWith('--no-')) {
      setFlag(token.slice(5), false);
      continue;
    }
    if (token.startsWith('--')) {
      const equals = token.indexOf('=');
      if (equals !== -1) {
        setFlag(token.slice(2, equals), token.slice(equals + 1));
        continue;
      }
      const key = token.slice(2);
      if (VALUE_FLAGS.has(key)) {
        const value = argv[index + 1];
        if (value === undefined) throw new Error(`missing value for --${key}`);
        setFlag(key, value);
        index += 1;
      } else {
        setFlag(key, true);
      }
      continue;
    }
    if (token.startsWith('-') && token.length > 1) {
      const key = token.slice(1);
      if (key === 'h' || key === '-help') {
        setFlag('help', true);
      } else if (key === 'v') {
        setFlag('version', true);
      } else if (key === 'o') {
        const value = argv[index + 1];
        if (value === undefined) throw new Error(`missing value for -${key}`);
        setFlag('out', value);
        index += 1;
      } else {
        throw new Error(`unknown option: ${token}`);
      }
      continue;
    }
    positional.push(token);
  }
  return { positional, flags };
}

/** Read a flag as array (repeatable flags). */
export function flagList(flags: ParsedArgs['flags'], key: string): string[] {
  const value = flags[key];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return [value];
  return [];
}