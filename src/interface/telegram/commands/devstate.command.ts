import { runtimeState } from '../../../runtime/runtime.state.js';

type ReplyContext = {
  reply: (text: string) => Promise<unknown>;
};

export async function handleDevState(ctx: ReplyContext) {
  const s = runtimeState.snapshot();
  const now = Date.now();
  const secondsFromLastCheck = s.health.lastCheck
    ? Math.max(0, Math.floor((now - s.health.lastCheck) / 1000))
    : null;

  await ctx.reply(`🧭 DEV STATE

Mode: ${s.mode}
DB reachable: ${s.dbReachable}
Health Score: ${s.health.score}
DB Latency: ${s.health.latencyMs ?? 'n/a'}ms
Failures: ${s.health.failures}
Slow Queries: ${s.health.slowQueries}
Last Check: ${secondsFromLastCheck === null ? 'never' : `${secondsFromLastCheck}s ago`}
Uptime: ${Math.floor(s.uptime)}s
Last DB check: ${s.lastDbCheck ? new Date(s.lastDbCheck).toLocaleTimeString() : 'never'}`);
}
