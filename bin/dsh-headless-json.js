#!/usr/bin/env node
/**
 * dsh-headless-json CLI entry wrapper (ESM).
 * The real logic lives in lib/cli/main.js; this file merely forwards argv and
 * maps the returned exit code onto the process.
 */

import { main } from '../lib/cli/main.js';

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((caught) => {
    process.stderr.write(`dsh-headless-json: fatal: ${caught instanceof Error ? caught.message : String(caught)}\n`);
    process.exitCode = 1;
  });