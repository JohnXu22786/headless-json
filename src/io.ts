/**
 * File I/O primitives: atomic file writes and an append-only line writer used
 * for the live NDJSON stream.
 */

import { open, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FileHandle } from 'node:fs/promises';

/** Create a directory (and parents) unless it already exists. */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/**
 * Write a file atomically: write to a sibling temp file, fsync, then rename
 * over the target. A crash mid-write never leaves a truncated report behind.
 */
export async function writeFileAtomic(target: string, content: string): Promise<void> {
  await ensureDir(dirname(target));
  const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const handle = await open(tmp, 'w');
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
  }
  await rename(tmp, target);
}

/**
 * Append-only line writer backed by a persistent file handle.
 *
 * Writes are enqueued on a promise chain so ordering is preserved, and
 * `flush()` fsyncs the file so a `session/flush` checkpoint makes the stream
 * durable before consumers read storage.
 */
export class LineWriter {
  private readonly filePath: string;
  private handle: FileHandle | null = null;
  private queue: Promise<void> = Promise.resolve();
  private error: Error | null = null;
  private lineCount = 0;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  get lines(): number {
    return this.lineCount;
  }

  get path(): string {
    return this.filePath;
  }

  private async ensureOpen(): Promise<FileHandle> {
    if (this.handle !== null) return this.handle;
    await ensureDir(dirname(this.filePath));
    this.handle = await open(this.filePath, 'a');
    return this.handle;
  }

  /** Enqueue one line; resolves after the bytes are handed to the OS. */
  write(line: string): Promise<void> {
    if (this.error !== null) return Promise.reject(this.error);
    const run = async (): Promise<void> => {
      try {
        const handle = await this.ensureOpen();
        await handle.writeFile(`${line}\n`, 'utf8');
        this.lineCount += 1;
      } catch (caught) {
        this.error = caught instanceof Error ? caught : new Error(String(caught));
        throw this.error;
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Wait for all queued writes and fsync the file. */
  async flush(): Promise<void> {
    await this.queue;
    if (this.handle !== null) await this.handle.sync();
  }

  /** Flush and release the file handle. Idempotent. */
  async close(): Promise<void> {
    await this.queue;
    if (this.handle !== null) {
      const handle = this.handle;
      this.handle = null;
      await handle.sync().catch(() => undefined);
      await handle.close().catch(() => undefined);
    }
  }
}

export { writeFile }; // re-exported for callers that need a plain write