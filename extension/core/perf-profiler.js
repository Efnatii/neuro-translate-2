/**
 * Lightweight perf profiler with durable ring buffers in storage.local.
 *
 * Tracks per-job metrics and global aggregates while keeping storage bounded.
 */
(function initPerfProfiler(global) {
  const NT = global.NT || (global.NT = {});

  class PerfProfiler extends NT.ChromeLocalStoreBase {
    constructor({
      chromeApi,
      storageKey = 'nt.perf.v1',
      jobRingLimit = 20,
      globalRingLimit = 320,
      maxJobs = 80,
      flushDebounceMs = 1200
    } = {}) {
      super({ chromeApi });
      this.KEY = storageKey;
      this.JOB_RING_LIMIT = Number.isFinite(Number(jobRingLimit)) ? Math.max(5, Math.round(Number(jobRingLimit))) : 20;
      this.GLOBAL_RING_LIMIT = Number.isFinite(Number(globalRingLimit)) ? Math.max(40, Math.round(Number(globalRingLimit))) : 320;
      this.MAX_JOBS = Number.isFinite(Number(maxJobs)) ? Math.max(20, Math.round(Number(maxJobs))) : 80;
      this.FLUSH_DEBOUNCE_MS = Number.isFinite(Number(flushDebounceMs)) ? Math.max(200, Math.round(Number(flushDebounceMs))) : 1200;
      this.state = this._defaultState();
      this.loaded = false;
      this.loadPromise = null;
      this.flushTimer = null;
      this.dirty = false;
      this.marks = {};
    }

    _defaultState() {
      return {
        v: 1,
        updatedAt: Date.now(),
        global: {
          totals: {
            applyDeltaCount: 0,
            coalescedCount: 0,
            rebindAttempts: 0,
            offscreenBytesIn: 0,
            offscreenBytesOut: 0,
            storageBytesEstimate: 0
          },
          ring: []
        },
        jobsById: {},
        recentJobs: []
      };
    }

    _cloneJson(value, fallback = null) {
      try {
        return JSON.parse(JSON.stringify(value));
      } catch (_) {
        return fallback;
      }
    }

    _toNumber(value, fallback = 0) {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : fallback;
    }

    _normalizeMetrics(input) {
      const src = input && typeof input === 'object' ? input : {};
      const lookups = Math.max(0, this._toNumber(src.memoryCacheLookups, 0));
      const hits = Math.max(0, this._toNumber(src.memoryCacheHits, 0));
      const latencySamples = Math.max(0, this._toNumber(src.deltaLatencySamples, 0));
      const latencyTotalMs = Math.max(0, this._toNumber(src.deltaLatencyTotalMs, 0));
      return {
        scanTimeMs: Math.max(0, this._toNumber(src.scanTimeMs, 0)),
        classifyTimeMs: Math.max(0, this._toNumber(src.classifyTimeMs, 0)),
        applyDeltaCount: Math.max(0, this._toNumber(src.applyDeltaCount, 0)),
        coalescedCount: Math.max(0, this._toNumber(src.coalescedCount, 0)),
        avgDeltaLatencyMs: Math.max(0, this._toNumber(src.avgDeltaLatencyMs, 0)),
        deltaLatencySamples: latencySamples,
        deltaLatencyTotalMs: latencyTotalMs,
        rebindAttempts: Math.max(0, this._toNumber(src.rebindAttempts, 0)),
        memoryCacheLookups: lookups,
        memoryCacheHits: hits,
        memoryCacheHitRate: lookups > 0 ? Number((hits / lookups).toFixed(3)) : 0,
        storageBytesEstimate: Math.max(0, this._toNumber(src.storageBytesEstimate, 0)),
        offscreenBytesIn: Math.max(0, this._toNumber(src.offscreenBytesIn, 0)),
        offscreenBytesOut: Math.max(0, this._toNumber(src.offscreenBytesOut, 0)),
        stepDurationsMs: src.stepDurationsMs && typeof src.stepDurationsMs === 'object'
          ? { ...src.stepDurationsMs }
          : {}
      };
    }

    _normalizeJobEntry(jobId, entry) {
      const src = entry && typeof entry === 'object' ? entry : {};
      return {
        jobId,
        tabId: Number.isFinite(Number(src.tabId)) ? Number(src.tabId) : null,
        status: typeof src.status === 'string' ? src.status : null,
        createdAt: Number.isFinite(Number(src.createdAt)) ? Number(src.createdAt) : Date.now(),
        updatedAt: Number.isFinite(Number(src.updatedAt)) ? Number(src.updatedAt) : Date.now(),
        metrics: this._normalizeMetrics(src.metrics)
      };
    }

    _normalizeState(raw) {
      const src = raw && typeof raw === 'object' ? raw : {};
      const out = this._defaultState();
      out.v = 1;
      out.updatedAt = Number.isFinite(Number(src.updatedAt)) ? Number(src.updatedAt) : Date.now();
      const totals = src.global && src.global.totals && typeof src.global.totals === 'object'
        ? src.global.totals
        : {};
      out.global.totals = {
        applyDeltaCount: Math.max(0, this._toNumber(totals.applyDeltaCount, 0)),
        coalescedCount: Math.max(0, this._toNumber(totals.coalescedCount, 0)),
        rebindAttempts: Math.max(0, this._toNumber(totals.rebindAttempts, 0)),
        offscreenBytesIn: Math.max(0, this._toNumber(totals.offscreenBytesIn, 0)),
        offscreenBytesOut: Math.max(0, this._toNumber(totals.offscreenBytesOut, 0)),
        storageBytesEstimate: Math.max(0, this._toNumber(totals.storageBytesEstimate, 0))
      };
      out.global.ring = Array.isArray(src.global && src.global.ring)
        ? src.global.ring.slice(-this.GLOBAL_RING_LIMIT)
        : [];

      const jobsByIdSrc = src.jobsById && typeof src.jobsById === 'object' ? src.jobsById : {};
      const ids = Object.keys(jobsByIdSrc).slice(-this.MAX_JOBS);
      ids.forEach((jobId) => {
        if (!jobId) {
          return;
        }
        out.jobsById[jobId] = this._normalizeJobEntry(jobId, jobsByIdSrc[jobId]);
      });

      out.recentJobs = Array.isArray(src.recentJobs)
        ? src.recentJobs
          .filter((row) => row && typeof row.jobId === 'string' && row.jobId)
          .slice(-this.JOB_RING_LIMIT)
          .map((row) => ({
            jobId: row.jobId,
            tabId: Number.isFinite(Number(row.tabId)) ? Number(row.tabId) : null,
            status: typeof row.status === 'string' ? row.status : null,
            updatedAt: Number.isFinite(Number(row.updatedAt)) ? Number(row.updatedAt) : Date.now()
          }))
        : [];
      return out;
    }

    async init() {
      await this._ensureLoaded();
      return this.getSnapshot();
    }

    async _ensureLoaded() {
      if (this.loaded) {
        return;
      }
      if (this.loadPromise) {
        await this.loadPromise;
        return;
      }
      this.loadPromise = (async () => {
        const payload = await this.storageGet({ [this.KEY]: null }).catch(() => ({ [this.KEY]: null }));
        const raw = payload && payload[this.KEY] && typeof payload[this.KEY] === 'object'
          ? payload[this.KEY]
          : null;
        this.state = this._normalizeState(raw);
        this.loaded = true;
      })();
      try {
        await this.loadPromise;
      } finally {
        this.loadPromise = null;
      }
    }

    mark(name) {
      const key = typeof name === 'string' ? name.trim() : '';
      const now = Date.now();
      if (key) {
        this.marks[key] = now;
      }
      return now;
    }

    measure(name, start, end) {
      const startedAt = this._resolveTs(start);
      const endedAt = this._resolveTs(end);
      if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) {
        return 0;
      }
      const duration = Math.max(0, endedAt - startedAt);
      const key = typeof name === 'string' ? name.trim() : '';
      if (key) {
        this._appendGlobalRing({
          ts: Date.now(),
          jobId: null,
          key,
          value: duration
        });
      }
      return duration;
    }

    _resolveTs(value) {
      if (Number.isFinite(Number(value))) {
        return Number(value);
      }
      if (typeof value === 'string' && value && Object.prototype.hasOwnProperty.call(this.marks, value)) {
        return Number(this.marks[value]);
      }
      return NaN;
    }

    attachJobContext(jobId, { tabId = null, status = null } = {}) {
      const key = typeof jobId === 'string' ? jobId : '';
      if (!key) {
        return;
      }
      const entry = this._getJobEntry(key);
      if (Number.isFinite(Number(tabId))) {
        entry.tabId = Number(tabId);
      }
      if (typeof status === 'string' && status) {
        entry.status = status;
      }
      entry.updatedAt = Date.now();
      this._touchRecentJob(entry);
      this._markDirty();
    }

    recordJobMetric(jobId, key, value) {
      const metricKey = typeof key === 'string' ? key.trim() : '';
      const id = typeof jobId === 'string' ? jobId : '';
      if (!id || !metricKey) {
        return;
      }
      const entry = this._getJobEntry(id);
      const metrics = entry.metrics;
      const numeric = Number(value);
      if (metricKey === 'scanTimeMs') {
        metrics.scanTimeMs = Math.max(0, Number.isFinite(numeric) ? numeric : metrics.scanTimeMs || 0);
      } else if (metricKey === 'classifyTimeMs') {
        metrics.classifyTimeMs = Math.max(0, Number.isFinite(numeric) ? numeric : metrics.classifyTimeMs || 0);
      } else if (metricKey === 'applyDeltaCount') {
        metrics.applyDeltaCount = Math.max(0, Number(metrics.applyDeltaCount || 0) + (Number.isFinite(numeric) ? numeric : 0));
        this.state.global.totals.applyDeltaCount = Math.max(0, Number(this.state.global.totals.applyDeltaCount || 0) + (Number.isFinite(numeric) ? numeric : 0));
      } else if (metricKey === 'coalescedCount') {
        metrics.coalescedCount = Math.max(0, Number.isFinite(numeric) ? numeric : metrics.coalescedCount || 0);
        this.state.global.totals.coalescedCount = Math.max(0, Number.isFinite(numeric) ? numeric : this.state.global.totals.coalescedCount || 0);
      } else if (metricKey === 'deltaLatencyMs') {
        const delta = Math.max(0, Number.isFinite(numeric) ? numeric : 0);
        metrics.deltaLatencySamples = Math.max(0, Number(metrics.deltaLatencySamples || 0) + 1);
        metrics.deltaLatencyTotalMs = Math.max(0, Number(metrics.deltaLatencyTotalMs || 0) + delta);
        metrics.avgDeltaLatencyMs = metrics.deltaLatencySamples > 0
          ? Number((metrics.deltaLatencyTotalMs / metrics.deltaLatencySamples).toFixed(2))
          : 0;
      } else if (metricKey === 'rebindAttempts') {
        metrics.rebindAttempts = Math.max(0, Number(metrics.rebindAttempts || 0) + (Number.isFinite(numeric) ? numeric : 0));
        this.state.global.totals.rebindAttempts = Math.max(0, Number(this.state.global.totals.rebindAttempts || 0) + (Number.isFinite(numeric) ? numeric : 0));
      } else if (metricKey === 'memoryCacheLookup') {
        metrics.memoryCacheLookups = Math.max(0, Number(metrics.memoryCacheLookups || 0) + (Number.isFinite(numeric) ? numeric : 0));
        metrics.memoryCacheHitRate = metrics.memoryCacheLookups > 0
          ? Number((Number(metrics.memoryCacheHits || 0) / Number(metrics.memoryCacheLookups || 0)).toFixed(3))
          : 0;
      } else if (metricKey === 'memoryCacheHit') {
        metrics.memoryCacheHits = Math.max(0, Number(metrics.memoryCacheHits || 0) + (Number.isFinite(numeric) ? numeric : 0));
        metrics.memoryCacheHitRate = metrics.memoryCacheLookups > 0
          ? Number((Number(metrics.memoryCacheHits || 0) / Number(metrics.memoryCacheLookups || 0)).toFixed(3))
          : 0;
      } else if (metricKey === 'storageBytesEstimate') {
        metrics.storageBytesEstimate = Math.max(0, Number.isFinite(numeric) ? numeric : metrics.storageBytesEstimate || 0);
        this.state.global.totals.storageBytesEstimate = metrics.storageBytesEstimate;
      } else if (metricKey === 'offscreenBytesIn') {
        metrics.offscreenBytesIn = Math.max(0, Number(metrics.offscreenBytesIn || 0) + (Number.isFinite(numeric) ? numeric : 0));
        this.state.global.totals.offscreenBytesIn = Math.max(0, Number(this.state.global.totals.offscreenBytesIn || 0) + (Number.isFinite(numeric) ? numeric : 0));
      } else if (metricKey === 'offscreenBytesOut') {
        metrics.offscreenBytesOut = Math.max(0, Number(metrics.offscreenBytesOut || 0) + (Number.isFinite(numeric) ? numeric : 0));
        this.state.global.totals.offscreenBytesOut = Math.max(0, Number(this.state.global.totals.offscreenBytesOut || 0) + (Number.isFinite(numeric) ? numeric : 0));
      } else if (metricKey.startsWith('step:')) {
        const stepName = metricKey.slice(5) || 'unknown';
        metrics.stepDurationsMs = metrics.stepDurationsMs && typeof metrics.stepDurationsMs === 'object'
          ? metrics.stepDurationsMs
          : {};
        metrics.stepDurationsMs[stepName] = Math.max(0, Number.isFinite(numeric) ? numeric : 0);
      } else {
        metrics[metricKey] = Number.isFinite(numeric) ? numeric : value;
      }

      entry.metrics = metrics;
      entry.updatedAt = Date.now();
      this._touchRecentJob(entry);
      this._appendGlobalRing({
        ts: Date.now(),
        jobId: id,
        key: metricKey,
        value: Number.isFinite(numeric) ? numeric : value
      });
      this._markDirty();
    }

    recordGlobalMetric(key, value) {
      const metricKey = typeof key === 'string' ? key.trim() : '';
      if (!metricKey) {
        return;
      }
      const numeric = Number(value);
      if (metricKey === 'storageBytesEstimate') {
        this.state.global.totals.storageBytesEstimate = Math.max(0, Number.isFinite(numeric) ? numeric : 0);
      }
      this._appendGlobalRing({
        ts: Date.now(),
        jobId: null,
        key: metricKey,
        value: Number.isFinite(numeric) ? numeric : value
      });
      this._markDirty();
    }

    _appendGlobalRing(item) {
      const row = item && typeof item === 'object' ? item : null;
      if (!row) {
        return;
      }
      const ring = Array.isArray(this.state.global.ring) ? this.state.global.ring : [];
      ring.push({
        ts: Number.isFinite(Number(row.ts)) ? Number(row.ts) : Date.now(),
        jobId: typeof row.jobId === 'string' && row.jobId ? row.jobId : null,
        key: typeof row.key === 'string' ? row.key : 'metric',
        value: row.value
      });
      this.state.global.ring = ring.slice(-this.GLOBAL_RING_LIMIT);
    }

    _getJobEntry(jobId) {
      const key = typeof jobId === 'string' ? jobId : '';
      const current = key && this.state.jobsById && this.state.jobsById[key] && typeof this.state.jobsById[key] === 'object'
        ? this.state.jobsById[key]
        : null;
      if (current) {
        return current;
      }
      const entry = this._normalizeJobEntry(key, {
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
      this.state.jobsById[key] = entry;
      this._trimJobsMap();
      return entry;
    }

    _trimJobsMap() {
      const jobs = this.state.jobsById && typeof this.state.jobsById === 'object' ? this.state.jobsById : {};
      const ids = Object.keys(jobs);
      if (ids.length <= this.MAX_JOBS) {
        return;
      }
      ids
        .map((id) => jobs[id])
        .filter(Boolean)
        .sort((a, b) => Number(a.updatedAt || 0) - Number(b.updatedAt || 0))
        .slice(0, ids.length - this.MAX_JOBS)
        .forEach((row) => {
          if (row && row.jobId) {
            delete jobs[row.jobId];
          }
        });
      this.state.jobsById = jobs;
    }

    _touchRecentJob(entry) {
      if (!entry || !entry.jobId) {
        return;
      }
      const current = Array.isArray(this.state.recentJobs) ? this.state.recentJobs.slice() : [];
      const filtered = current.filter((row) => !(row && row.jobId === entry.jobId));
      filtered.push({
        jobId: entry.jobId,
        tabId: Number.isFinite(Number(entry.tabId)) ? Number(entry.tabId) : null,
        status: typeof entry.status === 'string' ? entry.status : null,
        updatedAt: Number.isFinite(Number(entry.updatedAt)) ? Number(entry.updatedAt) : Date.now()
      });
      this.state.recentJobs = filtered.slice(-this.JOB_RING_LIMIT);
    }

    _markDirty() {
      this.state.updatedAt = Date.now();
      this.dirty = true;
      if (this.flushTimer) {
        return;
      }
      this.flushTimer = global.setTimeout(() => {
        this.flushTimer = null;
        this._flush().catch(() => {});
      }, this.FLUSH_DEBOUNCE_MS);
    }

    async _flush() {
      if (!this.dirty) {
        return;
      }
      await this._ensureLoaded();
      const payload = this._cloneJson(this.state, this._defaultState());
      await this.storageSet({ [this.KEY]: payload }).catch(() => null);
      this.dirty = false;
    }

    _computeTopOffenders(jobs) {
      const list = Array.isArray(jobs) ? jobs : [];
      return list
        .map((entry) => {
          const metrics = entry && entry.metrics && typeof entry.metrics === 'object' ? entry.metrics : {};
          const applyDeltaCount = this._toNumber(metrics.applyDeltaCount, 0);
          const avgDeltaLatencyMs = this._toNumber(metrics.avgDeltaLatencyMs, 0);
          const scanTimeMs = this._toNumber(metrics.scanTimeMs, 0);
          const classifyTimeMs = this._toNumber(metrics.classifyTimeMs, 0);
          const storageBytesEstimate = this._toNumber(metrics.storageBytesEstimate, 0);
          const score = scanTimeMs
            + classifyTimeMs
            + (avgDeltaLatencyMs * Math.max(1, applyDeltaCount / 5))
            + (storageBytesEstimate / 2048);
          return {
            jobId: entry.jobId,
            tabId: entry.tabId,
            status: entry.status || null,
            updatedAt: entry.updatedAt || null,
            score: Number(score.toFixed(2)),
            metrics: this._cloneJson(metrics, {})
          };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, 20);
    }

    getSnapshot() {
      const source = this._cloneJson(this.state, this._defaultState());
      const recent = Array.isArray(source.recentJobs) ? source.recentJobs : [];
      const jobs = recent
        .map((row) => row && row.jobId ? source.jobsById[row.jobId] : null)
        .filter(Boolean)
        .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
        .slice(0, this.JOB_RING_LIMIT);
      return {
        v: 1,
        updatedAt: source.updatedAt || Date.now(),
        global: source.global && typeof source.global === 'object'
          ? source.global
          : this._defaultState().global,
        jobs,
        topOffenders: this._computeTopOffenders(jobs)
      };
    }
  }

  NT.PerfProfiler = PerfProfiler;
})(globalThis);
