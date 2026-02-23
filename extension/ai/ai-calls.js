/**
 * Shared AI call hierarchy for raw response/ping execution.
 *
 * `AiCallBase` unifies cross-cutting concerns for network calls: persistence of
 * rate-limit headers, compact event emission via `EventFactory`, and consistent
 * success/error wrapping around raw client methods.
 *
 * MV3 note: SW restarts can happen between attempts, so header snapshots and
 * event diagnostics must be emitted on each call outcome.
 *
 * `AiResponseCall` additionally records real throughput samples into
 * `ModelPerformanceStore` (best-effort) so speed-mode scoring can prioritize
 * effective tokens/sec from actual traffic instead of ping-only latency.
 *
 * Request flow also reserves/release per-model TPM/RPM budget with lease-bound
 * reservations in `ModelRateLimitStore`, ensuring availability checks include
 * concurrent in-flight pressure in near real time.
 */
(function initAiCalls(global) {
  const NT = global.NT || (global.NT = {});

  class AiCallBase {
    constructor({ llmClient, rateLimitStore, eventFactory, eventLogger, perfStore, time } = {}) {
      this.llmClient = llmClient;
      this.rateLimitStore = rateLimitStore;
      this.eventFactory = eventFactory || null;
      this.eventLogger = typeof eventLogger === 'function' ? eventLogger : null;
      this.perfStore = perfStore || null;
      this.time = time || (global.NT && global.NT.Time ? global.NT.Time : null);
    }

    _now() {
      return this.time && typeof this.time.now === 'function' ? this.time.now() : Date.now();
    }

    async _saveHeaders(modelSpec, headers) {
      if (!this.rateLimitStore || !headers || !modelSpec) {
        return;
      }
      try {
        await this.rateLimitStore.upsertFromHeaders(modelSpec, headers, { receivedAt: this._now() });
      } catch (error) {
        // ignore header persistence errors
      }
    }

    _emit(event) {
      if (!this.eventLogger || !event) {
        return;
      }
      try {
        this.eventLogger(event);
      } catch (error) {
        // ignore logger errors
      }
    }

    _buildEvent(level, tag, message, meta) {
      if (this.eventFactory) {
        if (level === 'error') {
          return this.eventFactory.error(tag, message, meta);
        }
        if (level === 'warn') {
          return this.eventFactory.warn(tag, message, meta);
        }
        return this.eventFactory.info(tag, message, meta);
      }
      return { ts: this._now(), level, tag, message, meta };
    }

    async _callRaw({ modelSpec, successTag, stage, rawFn }) {
      const startedAt = this._now();
      try {
        const response = await rawFn();
        await this._saveHeaders(modelSpec, response && response.headers ? response.headers : null);
        this._emit(this._buildEvent('info', successTag, 'ok', {
          modelSpec,
          stage,
          latencyMs: this._now() - startedAt,
          status: response ? response.status : null
        }));
        return response;
      } catch (error) {
        await this._saveHeaders(modelSpec, error && error.headers ? error.headers : null);
        const tag = error && error.status === 429
          ? (NT.EventTypes ? NT.EventTypes.Tags.AI_RATE_LIMIT : 'ai.rateLimit')
          : (NT.EventTypes ? NT.EventTypes.Tags.AI_REQUEST : 'ai.request');
        this._emit(this._buildEvent('warn', tag, error && error.message ? error.message : 'AI call failed', {
          modelSpec,
          stage,
          status: error && error.status ? error.status : null,
          retryAfterMs: error && error.retryAfterMs ? error.retryAfterMs : null
        }));
        throw error;
      }
    }
  }

  class AiPingCall extends AiCallBase {
    measureLatency({ modelSpec, modelId, serviceTier, timeoutMs, signal } = {}) {
      const controller = new AbortController();
      const abortSignal = controller.signal;
      const startedAt = this._now();
      const timeout = typeof timeoutMs === 'number' ? timeoutMs : 20000;

      const forwardAbort = () => controller.abort();
      if (signal) {
        if (signal.aborted) {
          controller.abort();
        } else {
          signal.addEventListener('abort', forwardAbort, { once: true });
        }
      }

      const timeoutId = global.setTimeout(() => controller.abort(), timeout);

      return this._callRaw({
        modelSpec,
        successTag: NT.EventTypes ? NT.EventTypes.Tags.BENCH_SAMPLE : 'bench.sample',
        stage: 'ping',
        rawFn: async () => this.llmClient.generateMinimalPingRaw({ modelId, serviceTier, signal: abortSignal })
      }).then(() => this._now() - startedAt)
        .finally(() => {
          global.clearTimeout(timeoutId);
          if (signal) {
            try {
              signal.removeEventListener('abort', forwardAbort);
            } catch (error) {
              // ignore listener cleanup errors
            }
          }
        });
    }
  }

  class AiResponseCall extends AiCallBase {
    _extractUsageMetrics(json) {
      const usage = json && json.usage ? json.usage : null;
      const outputTokens = usage && Number.isFinite(Number(usage.output_tokens))
        ? Number(usage.output_tokens)
        : usage && Number.isFinite(Number(usage.outputTokens))
          ? Number(usage.outputTokens)
          : usage && Number.isFinite(Number(usage.completion_tokens))
            ? Number(usage.completion_tokens)
            : null;
      const inputTokens = usage && Number.isFinite(Number(usage.input_tokens))
        ? Number(usage.input_tokens)
        : usage && Number.isFinite(Number(usage.prompt_tokens))
          ? Number(usage.prompt_tokens)
          : null;
      const totalTokens = usage && Number.isFinite(Number(usage.total_tokens))
        ? Number(usage.total_tokens)
        : (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);
      return { outputTokens, inputTokens, totalTokens };
    }

    _estimateOutputTokens(json) {
      const outputText = json && typeof json.output_text === 'string'
        ? json.output_text
        : null;
      if (!outputText) {
        return null;
      }
      return Math.max(1, Math.ceil(outputText.length / 4));
    }

    async _recordPerf(modelSpec, metrics) {
      if (!this.perfStore || !modelSpec || !metrics || typeof metrics.tps !== 'number' || metrics.tps <= 0) {
        return;
      }
      try {
        await this.perfStore.recordSample(modelSpec, metrics);
      } catch (error) {
        // ignore perf persistence errors
      }
    }

    async reserveBudget(modelSpec, meta) {
      if (!this.rateLimitStore || !modelSpec || !meta || !meta.requestId || typeof meta.estTokens !== 'number') {
        return;
      }
      try {
        await this.rateLimitStore.reserve(modelSpec, {
          id: meta.requestId,
          tokens: meta.estTokens,
          requests: 1,
          leaseMs: 120000,
          now: this._now()
        });
      } catch (error) {
        // ignore reservation errors; request still can proceed
      }
    }

    async releaseBudget(modelSpec, meta) {
      if (!this.rateLimitStore || !modelSpec || !meta || !meta.requestId) {
        return;
      }
      try {
        await this.rateLimitStore.release(modelSpec, meta.requestId);
      } catch (error) {
        // ignore release errors
      }
    }

    send({ modelSpec, modelId, serviceTier, input, maxOutputTokens, temperature, store, background, signal, meta, responsesOptions, stream = false, onEvent = null } = {}) {
      const startedAt = this._now();
      const requestMeta = meta && typeof meta === 'object' ? { ...meta } : {};
      return this.reserveBudget(modelSpec, requestMeta)
        .then(() => this._callRaw({
          modelSpec,
          successTag: NT.EventTypes ? NT.EventTypes.Tags.AI_RESPONSE : 'ai.response',
          stage: 'request',
          rawFn: async () => {
            if (stream === true && typeof this.llmClient.generateResponseStreamRaw === 'function') {
              return this.llmClient.generateResponseStreamRaw({
                modelId,
                serviceTier,
                input,
                maxOutputTokens,
                temperature,
                store,
                background,
                signal,
                meta: requestMeta,
                responsesOptions,
                onEvent
              });
            }
            return this.llmClient.generateResponseRaw({
              modelId,
              serviceTier,
              input,
              maxOutputTokens,
              temperature,
              store,
              background,
              signal,
              meta: requestMeta,
              responsesOptions
            });
          }
        }))
        .then(async (response) => {
          const endedAt = this._now();
          const latencyMs = Math.max(1, endedAt - startedAt);
          const usage = this._extractUsageMetrics(response ? response.json : null);
          let outputTokens = usage.outputTokens;
          let usageEstimated = false;
          if (outputTokens === null) {
            outputTokens = this._estimateOutputTokens(response ? response.json : null);
            usageEstimated = outputTokens !== null;
          }
          const elapsedSec = Math.max(0.05, latencyMs / 1000);
          const tps = outputTokens !== null ? outputTokens / elapsedSec : null;
          await this._recordPerf(modelSpec, {
            tps,
            latencyMs,
            outputTokens,
            totalTokens: usage.totalTokens,
            kind: 'real',
            now: endedAt
          });
          this._emit(this._buildEvent('info', NT.EventTypes ? NT.EventTypes.Tags.AI_RESPONSE : 'ai.response', 'response metrics', {
            modelSpec,
            status: response ? response.status : null,
            latencyMs,
            outputTokens,
            tps: typeof tps === 'number' ? Number(tps.toFixed(2)) : null,
            usageEstimated
          }));
          return response;
        })
        .finally(() => this.releaseBudget(modelSpec, requestMeta));
    }

    async sendBenchThroughput({ modelSpec, modelId, serviceTier, signal } = {}) {
      const startedAt = this._now();
      const response = await this._callRaw({
        modelSpec,
        successTag: NT.EventTypes ? NT.EventTypes.Tags.BENCH_SAMPLE : 'bench.sample',
        stage: 'throughput_bench',
        rawFn: async () => this.llmClient.generateResponseRaw({
          modelId,
          serviceTier,
          input: "Output exactly 128 tokens of the letter 'x' separated by spaces. No extra text.",
          maxOutputTokens: 140,
          temperature: 0,
          store: false,
          background: false,
          signal,
          meta: {
            requestId: `bench:${modelSpec}:${startedAt}`,
            timeoutMs: 45000
          }
        })
      });

      const endedAt = this._now();
      const latencyMs = Math.max(1, endedAt - startedAt);
      const usage = this._extractUsageMetrics(response ? response.json : null);
      const outputTokens = usage.outputTokens;
      const elapsedSec = Math.max(0.05, latencyMs / 1000);
      const tps = outputTokens !== null ? outputTokens / elapsedSec : null;
      await this._recordPerf(modelSpec, {
        tps,
        latencyMs,
        outputTokens,
        totalTokens: usage.totalTokens,
        kind: 'bench',
        now: endedAt
      });
      return { response, tps, latencyMs, outputTokens };
    }
  }

  NT.AiCallBase = AiCallBase;
  NT.AiPingCall = AiPingCall;
  NT.AiResponseCall = AiResponseCall;
})(globalThis);
