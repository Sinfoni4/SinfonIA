import { afterEach, describe, expect, it, vi } from 'vitest';

import { runtimeState } from '../src/runtime/runtime.state.js';
import { startBackgroundWorkers, stopBackgroundWorkers } from '../src/runtime/runtime.workers.js';

const log = { info: vi.fn(), error: vi.fn() };

describe('background workers', () => {
  afterEach(async () => {
    await stopBackgroundWorkers();
    runtimeState.setMode('HEALTHY');
    vi.useRealTimers();
  });

  it('never overlaps a slow run and waits for it on stop', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    let finished = false;
    const run = vi.fn(
      () =>
        new Promise<Record<string, number>>((resolve) => {
          release = () => {
            finished = true;
            resolve({ done: 1 });
          };
        }),
    );

    startBackgroundWorkers([{ name: 'slow', intervalMs: 100, run }], log);
    await vi.advanceTimersByTimeAsync(350);
    expect(run).toHaveBeenCalledTimes(1);

    const stopping = stopBackgroundWorkers();
    release();
    await stopping;
    expect(finished).toBe(true);
    expect(log.info).toHaveBeenCalledWith({ job: 'slow', done: 1 }, 'Background job completed');
  });

  it('skips runs while the database circuit is open and logs failures', async () => {
    vi.useFakeTimers();
    const run = vi.fn(() => Promise.reject(new Error('boom')));
    runtimeState.setMode('CIRCUIT_OPEN');

    startBackgroundWorkers([{ name: 'failing', intervalMs: 100, run }], log);
    await vi.advanceTimersByTimeAsync(250);
    expect(run).not.toHaveBeenCalled();

    runtimeState.setMode('HEALTHY');
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      { job: 'failing', error: 'Error' },
      'Background job failed',
    );
  });
});
