import { exec } from 'node:child_process';

export { describeError } from '../shared/errors.js';
export type { ErrorDetails } from '../shared/errors.js';

export type ExecResult = {
  code: number;
  stdout: string;
  stderr: string;
};

function getExecCode(error: unknown): number {
  if (!error) return 0;

  if (typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'number') return code;
    if (typeof code === 'string') {
      const parsed = Number.parseInt(code, 10);
      return Number.isNaN(parsed) ? 1 : parsed;
    }
  }

  return 1;
}

export function execCmd(
  cmd: string,
  timeoutMs = 8000,
  env?: Record<string, string>,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    exec(
      cmd,
      {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 5_000_000,
        env: { ...process.env, ...(env ?? {}) },
      },
      (error, stdout, stderr) => {
        resolve({
          code: getExecCode(error),
          stdout: String(stdout ?? '').trim(),
          stderr: String(stderr ?? '').trim(),
        });
      },
    );
  });
}
