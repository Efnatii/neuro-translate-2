(function initModelBenchmarker(global) {
  const DEFAULT_SAMPLES = 3;
  const TIMEOUT_MS = 20000;
  const MAX_ATTEMPTS = 2;
  const JITTER_MIN_MS = 150;
  const JITTER_MAX_MS = 350;

  class ModelBenchmarker {
    constructor({ chromeApi, llmClient, benchmarkStore, modelRegistry }) {
      this.chromeApi = chromeApi;
      this.llmClient = llmClient;
      this.benchmarkStore = benchmarkStore;
      this.modelRegistry = modelRegistry;
    }

    async benchmarkSelected(modelSpecs, { force = false } = {}) {
      const hasKey = await this.llmClient.hasApiKey();
      if (!hasKey) {
        await this.benchmarkStore.setStatus({
          status: 'failed',
          errorCode: 'NO_API_KEY',
          message: 'API key is missing',
          updatedAt: Date.now()
        });
        return;
      }

      const uniqueSpecs = this.uniqueSpecs(modelSpecs);
      const total = uniqueSpecs.length;
      const statusBase = {
        status: 'running',
        total,
        completed: 0,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        currentModelSpec: null
      };

      await this.benchmarkStore.setStatus(statusBase);

      let completed = 0;

      for (const modelSpec of uniqueSpecs) {
        const shouldSkip = !force && await this.benchmarkStore.get(modelSpec);
        if (shouldSkip) {
          completed += 1;
          await this.benchmarkStore.setStatus({
            ...statusBase,
            completed,
            currentModelSpec: modelSpec,
            updatedAt: Date.now()
          });
          continue;
        }

        await this.benchmarkStore.setStatus({
          ...statusBase,
          completed,
          currentModelSpec: modelSpec,
          updatedAt: Date.now()
        });

        const parsed = this.parseModelSpec(modelSpec);
        if (!parsed.id) {
          await this.benchmarkStore.upsert(modelSpec, {
            medianMs: null,
            p90Ms: null,
            samples: 0,
            updatedAt: Date.now(),
            lastError: {
              code: 'INVALID_MODEL_SPEC',
              message: 'Model spec is missing an id'
            }
          });
          completed += 1;
          continue;
        }

        try {
          const samples = await this.collectSamples(parsed);
          const medianMs = this.calculateMedian(samples);
          const p90Ms = this.calculatePercentile(samples, 0.9);
          await this.benchmarkStore.upsert(modelSpec, {
            medianMs,
            p90Ms,
            samples: samples.length,
            updatedAt: Date.now(),
            lastError: null
          });
        } catch (error) {
          await this.benchmarkStore.upsert(modelSpec, {
            medianMs: null,
            p90Ms: null,
            samples: 0,
            updatedAt: Date.now(),
            lastError: this.normalizeError(error)
          });
        }

        completed += 1;
        await this.benchmarkStore.setStatus({
          ...statusBase,
          completed,
          currentModelSpec: modelSpec,
          updatedAt: Date.now()
        });
      }

      await this.benchmarkStore.setStatus({
        status: 'done',
        total,
        completed,
        finishedAt: Date.now(),
        updatedAt: Date.now(),
        currentModelSpec: null
      });
    }

    async collectSamples({ id, tier }) {
      const samples = [];
      const serviceTier = this.mapServiceTier(tier);

      for (let index = 0; index < DEFAULT_SAMPLES; index += 1) {
        if (index > 0) {
          await this.delay(this.randomJitter());
        }
        const duration = await this.measureWithRetry({ modelId: id, serviceTier });
        samples.push(duration);
      }

      return samples;
    }

    async measureWithRetry({ modelId, serviceTier }) {
      let lastError = null;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
          return await this.measureOnce({ modelId, serviceTier });
        } catch (error) {
          lastError = error;
        }
      }

      throw lastError;
    }

    async measureOnce({ modelId, serviceTier }) {
      const controller = new AbortController();
      const timeoutId = global.setTimeout(() => controller.abort(), TIMEOUT_MS);
      const startedAt = Date.now();

      try {
        await this.llmClient.generateMinimalPing({ modelId, serviceTier, signal: controller.signal });
        return Date.now() - startedAt;
      } finally {
        global.clearTimeout(timeoutId);
      }
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

    parseModelSpec(modelSpec) {
      const AiCommon = global.NT && global.NT.AiCommon ? global.NT.AiCommon : null;
      if (AiCommon && typeof AiCommon.parseModelSpec === 'function') {
        return AiCommon.parseModelSpec(modelSpec);
      }

      const [idPart, tierPart] = String(modelSpec || '').split(':');
      return { id: idPart || '', tier: tierPart || 'standard' };
    }

    mapServiceTier(tier) {
      const normalized = String(tier || '').trim().toLowerCase();
      if (normalized === 'flex') {
        return 'flex';
      }
      if (normalized === 'priority') {
        return 'priority';
      }
      return 'default';
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
        status: error.status || null
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
  }

  if (!global.NT) {
    global.NT = {};
  }
  global.NT.ModelBenchmarker = ModelBenchmarker;
})(globalThis);
