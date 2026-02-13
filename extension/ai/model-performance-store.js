/**
 * Persistent per-model throughput and latency rolling statistics.
 *
 * `ModelPerformanceStore` keeps EWMA metrics by `modelSpec` so model-speed
 * decisions survive MV3 service-worker restarts and do not rely on process
 * memory. Data comes from real response traffic (primary source) plus rare,
 * bounded calibration benches when no throughput signal exists.
 *
 * Persistence policy:
 * - TTL bounds stale entries to 12h,
 * - writes from frequent real responses are throttled,
 * - bench timestamps gate minimum calibration interval.
 */
(function initModelPerformanceStore(global) {
  const NT = global.NT || (global.NT = {});
  const AI = NT.Internal.ai;

  class ModelPerformanceStore extends NT.LocalStore {
    constructor({ chromeApi } = {}) {
      super({ chromeApi, storeName: 'ModelPerformanceStore' });
      this.KEY = 'modelPerformance';
      this.DEFAULTS = { [this.KEY]: {} };
      this.TTL_MS = 12 * 60 * 60 * 1000;
      this.MIN_UPDATE_INTERVAL_MS = 15 * 1000;
      this.BENCH_MIN_INTERVAL_MS = 60 * 60 * 1000;
    }

    async getAll() {
      const data = await this.storageGet(this.DEFAULTS);
      return data[this.KEY] || {};
    }

    async get(modelSpec, { now } = {}) {
      if (!modelSpec) {
        return null;
      }
      const ts = typeof now === 'number' ? now : Date.now();
      const all = await this.getAll();
      const entry = all[modelSpec] || null;
      if (!entry) {
        return null;
      }
      if (entry.updatedAt && (ts - entry.updatedAt) > this.TTL_MS) {
        return null;
      }
      return entry;
    }

    _ewma(prev, next, alpha) {
      if (typeof next !== 'number' || !Number.isFinite(next) || next <= 0) {
        return prev;
      }
      if (typeof prev !== 'number' || !Number.isFinite(prev) || prev <= 0) {
        return next;
      }
      return prev * (1 - alpha) + next * alpha;
    }

    async recordSample(modelSpec, { tps, latencyMs, outputTokens, totalTokens, kind, now } = {}) {
      if (!modelSpec) {
        return;
      }
      const ts = typeof now === 'number' ? now : Date.now();
      const sampleKind = kind === 'bench' ? 'bench' : 'real';
      const data = await this.storageGet(this.DEFAULTS);
      const all = data[this.KEY] || {};
      const prev = all[modelSpec] || null;

      if (sampleKind === 'real' && prev && prev.lastWriteAt && (ts - prev.lastWriteAt) < this.MIN_UPDATE_INTERVAL_MS) {
        return;
      }

      const alpha = sampleKind === 'bench' ? 0.35 : 0.18;
      all[modelSpec] = {
        ewmaTps: this._ewma(prev ? prev.ewmaTps : null, tps, alpha),
        ewmaLatencyMs: this._ewma(prev ? prev.ewmaLatencyMs : null, latencyMs, alpha),
        samples: (prev && prev.samples ? prev.samples : 0) + 1,
        lastKind: sampleKind,
        lastOutputTokens: typeof outputTokens === 'number' ? outputTokens : (prev ? prev.lastOutputTokens : null),
        lastTotalTokens: typeof totalTokens === 'number' ? totalTokens : (prev ? prev.lastTotalTokens : null),
        updatedAt: ts,
        lastWriteAt: ts,
        lastBenchAt: prev ? (prev.lastBenchAt || null) : null
      };

      await this.storageSet({ [this.KEY]: all });
    }

    async markBenchAt(modelSpec, ts) {
      if (!modelSpec) {
        return;
      }
      const at = typeof ts === 'number' ? ts : Date.now();
      const data = await this.storageGet(this.DEFAULTS);
      const all = data[this.KEY] || {};
      const prev = all[modelSpec] || {};
      all[modelSpec] = { ...prev, lastBenchAt: at, updatedAt: at, lastWriteAt: at };
      await this.storageSet({ [this.KEY]: all });
    }

    needsBench(modelSpec, now, entry) {
      if (!modelSpec) {
        return false;
      }
      const ts = typeof now === 'number' ? now : Date.now();
      const current = entry || null;
      if (!current) {
        return true;
      }

      const stale = current.updatedAt && (ts - current.updatedAt) > this.TTL_MS;
      const hasTps = typeof current.ewmaTps === 'number' && Number.isFinite(current.ewmaTps) && current.ewmaTps > 0;
      const lastBenchAt = typeof current.lastBenchAt === 'number' ? current.lastBenchAt : null;
      const benchOldEnough = !lastBenchAt || (ts - lastBenchAt) > this.BENCH_MIN_INTERVAL_MS;
      return (!hasTps || stale) && benchOldEnough;
    }
  }

  AI.ModelPerformanceStore = ModelPerformanceStore;
})(globalThis);
