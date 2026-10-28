import fs from 'node:fs';
import path from 'node:path';

import { log } from './log.js';

/**
 * Development-only guard: the process must be started from the project root.
 * This function lives under `src` so it is part of the build output.
 */
export function assertProjectRoot(cwd: string = process.cwd()): void {
  const pkgPath = path.join(cwd, 'package.json');

  if (!fs.existsSync(pkgPath)) {
    log.fatal('package.json not found: start SinfonIA from the project folder');
    process.exit(1);
  }
}
