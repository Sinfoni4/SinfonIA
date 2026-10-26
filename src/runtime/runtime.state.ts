export type RuntimeMode = 'HEALTHY' | 'DEGRADED' | 'CIRCUIT_OPEN';

export interface RuntimeHealthMetrics {
  score: number;
  latencyMs: number | null;
  failures: number;
  slowQueries: number;
  lastCheck: number;
}

class RuntimeState {
  private mode: RuntimeMode = 'DEGRADED';
  private dbReachable = false;
  private lastDbCheck: number | null = null;
  private health: RuntimeHealthMetrics = {
    score: 100,
    latencyMs: null,
    failures: 0,
    slowQueries: 0,
    lastCheck: Date.now(),
  };

  private clampScore(value: number): number {
    return Math.max(0, Math.min(100, value));
  }

  setDatabaseReachable(value: boolean) {
    this.dbReachable = value;
    this.lastDbCheck = Date.now();
  }

  setMode(nextMode: RuntimeMode) {
    if (this.mode === nextMode) return;
    this.mode = nextMode;

    console.log(`🧠 RUNTIME MODE → ${nextMode}`);

    if (nextMode === 'HEALTHY') {
      console.log('💚 Runtime HEALTHY');
      return;
    }
    if (nextMode === 'DEGRADED') {
      console.log('⚠️ Runtime DEGRADED');
      return;
    }
    console.log('🛑 Circuit breaker OPEN');
  }

  updateHealthScore(metrics: Partial<RuntimeHealthMetrics>) {
    const prev = this.health;
    let nextScore = prev.score;

    if (typeof metrics.failures === 'number') {
      if (metrics.failures > prev.failures) {
        nextScore -= 30;
      } else if (metrics.failures < prev.failures) {
        nextScore += 2;
      } else if (metrics.failures === 0) {
        nextScore += 2;
      }
    }

    if (typeof metrics.latencyMs === 'number') {
      if (metrics.latencyMs > 1000) {
        nextScore -= 20;
      } else if (metrics.latencyMs > 500) {
        nextScore -= 10;
      } else if (metrics.latencyMs < 150) {
        nextScore += 2;
      }
    }

    this.health = {
      ...prev,
      ...metrics,
      score: this.clampScore(nextScore),
      lastCheck: metrics.lastCheck ?? Date.now(),
    };
  }

  isDatabaseReachable() {
    return this.dbReachable;
  }

  getMode(): RuntimeMode {
    return this.mode;
  }

  getHealth(): RuntimeHealthMetrics {
    return this.health;
  }

  snapshot() {
    return {
      mode: this.mode,
      dbReachable: this.dbReachable,
      lastDbCheck: this.lastDbCheck,
      health: this.health,
      uptime: process.uptime(),
    };
  }
}

export const runtimeState = new RuntimeState();
