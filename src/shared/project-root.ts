import fs from 'node:fs';
import path from 'node:path';

/**
 * Development-only guard: the process must be started from the project root.
 * This function lives under `src` so it is part of the build output.
 */
export function assertProjectRoot(cwd: string = process.cwd()): void {
  const pkgPath = path.join(cwd, 'package.json');

  if (!fs.existsSync(pkgPath)) {
    console.error('❌ package.json not found.');
    console.error('👉 Move into the project folder before starting SinfonIA.');
    process.exit(1);
  }
}
