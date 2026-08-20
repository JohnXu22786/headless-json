/**
 * Static version metadata. The version is read from the package manifest at
 * runtime so it can never drift from the published package.
 */

import { readFileSync } from 'node:fs';

export const PLUGIN_NAME = 'dsh-headless-json';

let cachedVersion: string | null = null;

export function readVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  try {
    const url = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(url, 'utf8')) as { version?: string };
    cachedVersion = typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : '0.0.0';
  } catch {
    cachedVersion = '0.0.0';
  }
  return cachedVersion;
}