/**
 * Background benchmark runner for latency snapshots.
 *
 * Benchmarker measures model latency with bounded retries/timeouts and persists
 * benchmark/status data. Bench calls use `AiPingCall`, so rate-limit headers are
 * captured consistently with request flow.
 *
 * It also provides optional throughput calibration for speed mode. Calibration
 * runs rarely (TTL/min-interval guarded), uses low-priority scheduler slots,
 * and records EWMA samples via `ModelPerformanceStore`.
 *
 * On 429 it also applies short cooldown in `ModelRateLimitStore` to prevent
 * repeated bench pressure on temporarily throttled models.
 */
(function initModelBenchmarker(global) {
  const NT = global.NT;
  const AI = NT.Internal.ai;

  const DEFAULT_SAMPLES = 3;
  const TIMEOUT_MS = 20000;
  const MAX_ATTEMPTS = 2;
  const JITTER_MIN_MS = 150;
  const JITTER_MAX_MS = 350;
  const QUICK_SAMPLE_TIMEOUT_MS = 1200;
  const LEASE_MS = 5 * 60 * 1000;

  class ModelBenchmarker {
    constructor({ chromeApi, pingCall, responseCall, benchmarkStore, modelRegistry, loadScheduler, rateLimitStore, perfStore, eventLogger, eventFactory }) {
      this.chromeApi = chromeApi;
      this.pingCall = pingCall;
      this.benchmarkStore = benchmarkStore;
      this.responseCall = responseCall || null;
      this.modelRegistry = modelRegistry;
      this.aiCommon = AI && AI.AiCommon ? AI.AiCommon : null;
      this.time = NT && NT.Time ? NT.Time : null;
      this.loadScheduler = loadScheduler;
      this.rateLimitStore = rateLimitStore || null;
      this.perfStore = perfStore || null;
      this.eventFactory = eventFactory || null;
      this.benchPrompt = "Respond with a single '.'";
      this.eventLogger = typeof eventLogger === 'function' ? eventLogger : null;
      const RetryLoop = NT && NT.RetryLoop ? NT.RetryLoop : null;
      this.retryLoop = RetryLoop
        ? new RetryLoop({
          maxAttempts: MAX_ATTEMPTS,
          maxTotalMs: TIMEOUT_MS * MAX_ATTEMPTS + 2000,
          baseDelayMs: 200,
          maxDelayMs: 1200,
          multiplier: 1.5,
          jitterMs: 200
        })
        : null;
      this.throughputCalibrateInFlight = false;
    }

    benchmarkSelected(modelSpecs, { force = false } = {}) {
      return this.runBenchmarks(modelSpecs, { force, reason: 'manual' });
    }

    scheduleBenchmarks(modelSpecs, { force = false, reason = 'auto' } = {}) {
      this.runBenchmarks(modelSpecs, { force, reason }).catch(() => {});
    }

    async maybeCalibrateThroughput(modelSpecs, { reason = 'auto' } = {}) {
      if (this.throughputCalibrateInFlight || !this.perfStore || !this.responseCall) {
        return;
      }

      const nowTs = this.now();
      const uniqueSpecs = this.uniqueSpecs(modelSpecs);
      const perfMap = await this.perfStore.getAll();
      const candidates = uniqueSpecs
        .filter((modelSpec) => this.perfStore.needsBench(modelSpec, nowTs, perfMap[modelSpec] || null))
        .slice(0, 2);

      if (!candidates.length) {
        return;
      }

      this.throughputCalibrateInFlight = true;
      try {
        for (const modelSpec of candidates) {
          const parsed = this.parseModelSpec(modelSpec);
          if (!parsed.id) {
            continue;
          }

          const reserved = await this.reserveBenchSlot({
            priority: 'low',
            timeoutMs: 1600,
            estTokens: 160
          });
          if (!reserved) {
            continue;
          }

          try {
            const serviceTier = this.mapServiceTier(parsed.tier);
            const result = await this.responseCall.sendBenchThroughput({
              modelSpec,
              modelId: parsed.id,
              serviceTier
            });
            await this.perfStore.markBenchAt(modelSpec, this.now());
            this.logEvent('info', 'bench.sample', 'Throughput calibration sample', {
              source: 'bench',
              stage: 'throughput',
              reason,
              modelSpec,
              tps: result && typeof result.tps === 'number' ? Number(result.tps.toFixed(2)) : null,
              latencyMs: result ? result.latencyMs : null
            });
          } catch (error) {
            await this.handleRateLimit(error, 'BENCH', modelSpec);
          }
        }
      } finally {
        this.throughputCalibrateInFlight = false;
      }
    }

    async quickPrebench(modelSpecs, { maxModels = 5, budgetMs = 3000 } = {}) {
      const hasKey = await this.hasApiKey();
      if (!hasKey) {
        this.logEvent('warn', 'bench', 'Quick prebench skipped (no API key)', { source: 'bench' });
        return { results: {}, reason: 'NO_API_KEY' };
      }

      const uniqueSpecs = this.uniqueSpecs(modelSpecs).slice(0, maxModels);
      const results = {};
      const deadline = this.now() + budgetMs;
      this.logEvent('info', 'bench', 'Quick prebench started', {
        source: 'bench',
        stage: 'quick',
        status: uniqueSpecs.length
      });

      for (const modelSpec of uniqueSpecs) {
        const now = this.now();
        if (now >= deadline) {
          break;
        }

        const parsed = this.parseModelSpec(modelSpec);
        if (!parsed.id) {
          continue;
        }

        const entry = await this.benchmarkStore.getEntry(modelSpec);
        if (this.benchmarkStore.isFresh(entry, now)) {
          results[modelSpec] = entry;
          continue;
        }
        if (!this.benchmarkStore.canAttempt(entry, now)) {
          continue;
        }

        await this.benchmarkStore.upsert(modelSpec, { lastAttemptAt: now });

        const remaining = Math.max(0, deadline - now);
        const reserved = await this.reserveBenchSlot({
          priority: 'high',
          timeoutMs: remaining,
          estTokens: this.estimateBenchTokens()
        });
        if (!reserved) {
          break;
        }

        try {
          const serviceTier = this.mapServiceTier(parsed.tier);
          const duration = await this.measureOnce({
            modelSpec,
            modelId: parsed.id,
            serviceTier,
            timeoutMs: Math.min(remaining, QUICK_SAMPLE_TIMEOUT_MS)
          });
          const patch = {
            medianMs: duration,
            p90Ms: duration,
            samples: 1,
            updatedAt: this.now(),
            lastError: null,
            quick: true
          };
          await this.benchmarkStore.upsert(modelSpec, patch);
          results[modelSpec] = patch;
          this.logEvent('info', 'bench', 'Quick bench sample recorded', {
            source: 'bench',
            modelSpec,
            latencyMs: duration,
            stage: 'quick'
          });
        } catch (error) {
          await this.benchmarkStore.upsert(modelSpec, {
            updatedAt: this.now(),
            lastError: this.normalizeError(error),
            quick: true
          });
          this.logEvent('error', 'bench', 'Quick bench sample failed', {
            source: 'bench',
            modelSpec,
            stage: 'quick',
            status: error && error.status ? error.status : null
          });
          await this.handleRateLimit(error, 'BENCH', modelSpec);
        }
      }

      this.logEvent('info', 'bench', 'Quick prebench finished', {
        source: 'bench',
        stage: 'quick',
        status: Object.keys(results).length
      });
      return { results, reason: 'QUICK_PREBENCH' };
    }

    async runBenchmarks(modelSpecs, { force = false, reason = 'auto' } = {}) {
      const hasKey = await this.hasApiKey();
      if (!hasKey) {
        await this.benchmarkStore.setStatus({
          status: 'failed',
          errorCode: 'NO_API_KEY',
          message: 'API key is missing',
          updatedAt: this.now()
        });
        this.logEvent('warn', 'bench', 'Bench skipped (no API key)', { source: 'bench' });
        return;
      }

      const uniqueSpecs = this.uniqueSpecs(modelSpecs);
      const now = this.now();
      const eligible = [];

      for (const modelSpec of uniqueSpecs) {
        const entry = await this.benchmarkStore.getEntry(modelSpec);
        if (!force) {
          if (this.benchmarkStore.isFresh(entry, now)) {
            continue;
          }
          if (!this.benchmarkStore.canAttempt(entry, now)) {
            continue;
          }
        }
        eligible.push(modelSpec);
      }

      const total = eligible.length;
      const statusBase = {
        status: total ? 'running' : 'idle',
        reason,
        total,
        completed: 0,
        startedAt: this.now(),
        updatedAt: this.now(),
        currentModelSpec: null
      };

      await this.benchmarkStore.setStatus(this.withLease(statusBase));
      this.logEvent('info', 'bench', 'Bench started', {
        source: 'bench',
        stage: reason,
        status: total
      });

      let completed = 0;

      for (const modelSpec of eligible) {
        await this.benchmarkStore.setStatus(this.withLease({
          ...statusBase,
          completed,
          currentModelSpec: modelSpec,
          updatedAt: this.now()
        }));

        const parsed = this.parseModelSpec(modelSpec);
        if (!parsed.id) {
          await this.benchmarkStore.upsert(modelSpec, {
            medianMs: null,
            p90Ms: null,
            samples: 0,
            updatedAt: this.now(),
            lastAttemptAt: this.now(),
            lastError: {
              code: 'INVALID_MODEL_SPEC',
              message: 'Model spec is missing an id'
            }
          });
          completed += 1;
          continue;
        }

        await this.benchmarkStore.upsert(modelSpec, { lastAttemptAt: this.now() });

        try {
          const samples = await this.collectSamples({ modelSpec, id: parsed.id, tier: parsed.tier });
          const medianMs = this.calculateMedian(samples);
          const p90Ms = this.calculatePercentile(samples, 0.9);
          await this.benchmarkStore.upsert(modelSpec, {
            medianMs,
            p90Ms,
            samples: samples.length,
            updatedAt: this.now(),
            lastError: null,
            quick: false
          });
          this.logEvent('info', 'bench', 'Bench completed', {
            source: 'bench',
            modelSpec,
            latencyMs: medianMs,
            stage: reason
          });
        } catch (error) {
          await this.benchmarkStore.upsert(modelSpec, {
            medianMs: null,
            p90Ms: null,
            samples: 0,
            updatedAt: this.now(),
            lastError: this.normalizeError(error),
            quick: false
          });
          this.logEvent('error', 'bench', 'Bench failed', {
            source: 'bench',
            modelSpec,
            stage: reason,
            status: error && error.status ? error.status : null
          });
          await this.handleRateLimit(error, 'BENCH', modelSpec);
        }

        completed += 1;
        await this.benchmarkStore.setStatus(this.withLease({
          ...statusBase,
          completed,
          currentModelSpec: modelSpec,
          updatedAt: this.now()
        }));
      }

      await this.benchmarkStore.setStatus({
        status: 'done',
        reason,
        total,
        completed,
        finishedAt: this.now(),
        updatedAt: this.now(),
        currentModelSpec: null,
        leaseUntilTs: null
      });
      this.logEvent('info', 'bench', 'Bench finished', {
        source: 'bench',
        stage: reason,
        status: completed
      });
    }

    async collectSamples({ modelSpec, id, tier }) {
      const samples = [];
      const serviceTier = this.mapServiceTier(tier);

      for (let index = 0; index < DEFAULT_SAMPLES; index += 1) {
        const reserved = await this.reserveBenchSlot({
          priority: 'low',
          estTokens: this.estimateBenchTokens()
        });
        if (!reserved) {
          throw new Error('BENCH_SLOT_TIMEOUT');
        }
        if (index > 0) {
          await this.delay(this.randomJitter());
        }
        const duration = await this.measureWithRetry({ modelSpec, modelId: id, serviceTier });
        samples.push(duration);
      }

      return samples;
    }

    async measureWithRetry({ modelSpec, modelId, serviceTier }) {
      if (!this.retryLoop) {
        return this.measureOnce({ modelSpec, modelId, serviceTier });
      }

      return this.retryLoop.run(() => this.measureOnce({ modelSpec, modelId, serviceTier }));
    }

    async measureOnce({ modelSpec, modelId, serviceTier, timeoutMs, signal }) {
      if (!this.pingCall || typeof this.pingCall.measureLatency !== 'function') {
        throw new Error('PING_CALL_UNAVAILABLE');
      }
      return this.pingCall.measureLatency({ modelSpec, modelId, serviceTier, timeoutMs, signal });
    }

    async hasApiKey() {
      if (!this.pingCall || !this.pingCall.llmClient || typeof this.pingCall.llmClient.hasApiKey !== 'function') {
        return false;
      }
      return this.pingCall.llmClient.hasApiKey();
    }


    uniqueSpecs(modelSpecs) {
      if (!Array.isArray(modelSpecs)) {
        return [];
      }
      const seen = new Set();
      const unique = [];

      modelSpecs.forEach((spec) => {
        if (!spec || seen.has(spec)) {
          return;
        }
        seen.add(spec);
        unique.push(spec);
      });

      return unique;
    }

    calculateMedian(samples) {
      if (!samples.length) {
        return null;
      }
      const sorted = [...samples].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      if (sorted.length % 2 === 0) {
        return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
      }
      return Math.round(sorted[mid]);
    }

    calculatePercentile(samples, percentile) {
      if (!samples.length) {
        return null;
      }
      const sorted = [...samples].sort((a, b) => a - b);
      const rank = Math.max(0, Math.ceil(percentile * sorted.length) - 1);
      return Math.round(sorted[Math.min(rank, sorted.length - 1)]);
    }

    normalizeError(error) {
      if (!error) {
        return { code: 'UNKNOWN', message: 'Unknown error' };
      }
      if (typeof error === 'string') {
        return { code: 'ERROR', message: error };
      }
      return {
        code: error.code || 'ERROR',
        message: error.message || 'Benchmark failed',
        status: error.status || null,
        retryAfterMs: error.retryAfterMs || null
      };
    }

    delay(durationMs) {
      return new Promise((resolve) => {
        global.setTimeout(resolve, durationMs);
      });
    }

    randomJitter() {
      return JITTER_MIN_MS + Math.floor(Math.random() * (JITTER_MAX_MS - JITTER_MIN_MS + 1));
    }

    parseModelSpec(modelSpec) {
      if (this.aiCommon && typeof this.aiCommon.parseModelSpec === 'function') {
        return this.aiCommon.parseModelSpec(modelSpec);
      }
      return { id: '', tier: 'standard' };
    }

    mapServiceTier(tier) {
      if (this.aiCommon && typeof this.aiCommon.mapServiceTier === 'function') {
        return this.aiCommon.mapServiceTier(tier);
      }
      return 'default';
    }

    estimateBenchTokens() {
      return Math.ceil(this.benchPrompt.length / 4) + 4;
    }

    async reserveBenchSlot({ priority, estTokens, timeoutMs } = {}) {
      if (!this.loadScheduler) {
        return true;
      }

      const task = {
        kind: 'BENCH',
        estTokens: estTokens || this.estimateBenchTokens(),
        estRpm: 1,
        priority: priority || 'low'
      };

      if (!timeoutMs) {
        await this.loadScheduler.reserveSlot(task);
        return true;
      }

      return Promise.race([
        this.loadScheduler.reserveSlot(task).then(() => true),
        new Promise((resolve) => {
          global.setTimeout(() => resolve(false), timeoutMs);
        })
      ]);
    }

    async handleRateLimit(error, kind, modelSpec) {
      if (error && error.status === 429) {
        if (this.loadScheduler) {
          this.loadScheduler.onRateLimited({ retryAfterMs: error.retryAfterMs, kind });
        }
        if (this.rateLimitStore && modelSpec) {
          const retryAfterMs = Math.min(error.retryAfterMs || 15000, 60000);
          await this.rateLimitStore.applyCooldown(modelSpec, { now: this.now(), retryAfterMs });
        }
        this.logEvent('warn', 'ai.rateLimit', 'Bench rate-limited', {
          source: 'bench',
          stage: kind,
          status: error.status,
          modelSpec
        });
      }
    }

    logEvent(level, tag, message, meta) {
      if (!this.eventLogger) {
        return;
      }
      if (this.eventFactory) {
        const event = level === 'error'
          ? this.eventFactory.error(tag, message, meta)
          : level === 'warn'
            ? this.eventFactory.warn(tag, message, meta)
            : this.eventFactory.info(tag, message, meta);
        this.eventLogger(event);
        return;
      }
      this.eventLogger({ level, tag, message, meta });
    }

    withLease(status) {
      if (status.status !== 'running') {
        return status;
      }
      return {
        ...status,
        leaseUntilTs: this.now() + LEASE_MS
      };
    }

    now() {
      return this.time && typeof this.time.now === 'function' ? this.time.now() : Date.now();
    }
  }

  AI.ModelBenchmarker = ModelBenchmarker;
})(globalThis);
