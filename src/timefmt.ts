/**
 * Time formatting helpers shared by JUnit output. Independent of any
 * locale so output is bit-stable across machines.
 */

/** Milliseconds to decimal seconds with exactly 3 fraction digits. */
export function formatTime(milliseconds: number | null): string {
  const ms = typeof milliseconds === 'number' && Number.isFinite(milliseconds) ? milliseconds : 0;
  return (ms / 1000).toFixed(3);
}

/** Unix milliseconds to ISO-8601 UTC timestamp with milliseconds. */
export function formatIsoTimestamp(unixMs: number): string {
  return new Date(unixMs).toISOString();
}