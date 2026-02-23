/**
 * Alarm-driven scheduler for MV3 background orchestration.
 *
 * Uses one periodic alarm (`nt.tick`) plus one optional one-shot wake alarm
 * (`nt.wake`) to avoid per-job alarm spam and in-memory setInterval loops.
 */
(function initScheduler(global) {
  const NT = global.NT || (global.NT = {});

  class Scheduler {
    constructor({
      chromeApi,
      jobStore,
      jobQueue,
      jobRunner,
      activeTabIdProvider,
      onBeforeTick,
      onAfterTick,
      eventFactory,
      eventLogFn,
      maxJobsPerTick = 3,
      maxMsPerTick = 1500
    } = {}) {
      this.chromeApi = chromeApi || null;
      this.jobStore = jobStore || null;
      this.jobQueue = jobQueue || null;
      this.jobRunner = jobRunner || null;
      this.activeTabIdProvider = typeof activeTabIdProvider === 'function' ? activeTabIdProvider : null;
      this.onBeforeTick = typeof onBeforeTick === 'function' ? onBeforeTick : null;
      this.onAfterTick = typeof onAfterTick === 'function' ? onAfterTick : null;
      this.eventFactory = eventFactory || null;
      this.log = typeof eventLogFn === 'function' ? eventLogFn : null;

      this.maxJobsPerTick = Math.max(1, Number(maxJobsPerTick) || 3);
      this.maxMsPerTick = Math.max(200, Number(maxMsPerTick) || 1500);
      this.tickAlarmName = 'nt.tick';
      this.wakeAlarmName = 'nt.wake';
      this.tickPeriodMinutes = 0.5;
      this.wakeDelayMs = 200;
      this._tickInFlight = false;
      this._wakeScheduledFor = 0;
    }

    _emit(level, tag, message, meta) {
      if (!this.log) {
        return;
      }
      if (this.eventFactory && typeof this.eventFactory[level] === 'function') {
        this.log(this.eventFactory[level](tag, message, meta));
        return;
      }
      this.log({ level, tag, message, meta });
    }

    _alarmsApi() {
      return this.chromeApi && this.chromeApi.alarms ? this.chromeApi.alarms : null;
    }

    _alarmsGetAll() {
      const alarms = this._alarmsApi();
      if (!alarms || typeof alarms.getAll !== 'function') {
        return Promise.resolve([]);
      }
      return new Promise((resolve) => {
        try {
          const maybePromise = alarms.getAll((list) => resolve(Array.isArray(list) ? list : []));
          if (maybePromise && typeof maybePromise.then === 'function') {
            maybePromise.then((list) => resolve(Array.isArray(list) ? list : [])).catch(() => resolve([]));
          }
        } catch (_) {
          resolve([]);
        }
      });
    }

    _alarmsCreate(name, options) {
      const alarms = this._alarmsApi();
      if (!alarms || typeof alarms.create !== 'function') {
        return Promise.resolve(false);
      }
      try {
        const maybePromise = alarms.create(name, options || {});
        if (maybePromise && typeof maybePromise.then === 'function') {
          return maybePromise.then(() => true).catch(() => false);
        }
        return Promise.resolve(true);
      } catch (_) {
        return Promise.resolve(false);
      }
    }

    async ensureAlarms() {
      const alarms = await this._alarmsGetAll();
      const hasTick = alarms.some((alarm) => alarm && alarm.name === this.tickAlarmName);
      let ensured = hasTick;
      if (!hasTick) {
        ensured = await this._alarmsCreate(this.tickAlarmName, { periodInMinutes: this.tickPeriodMinutes });
        this._emit('info', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.BG_START : 'bg.start', 'Создан alarm nt.tick', {
          alarm: this.tickAlarmName,
          periodInMinutes: this.tickPeriodMinutes
        });
      }
      return { ok: Boolean(ensured), hasTick: Boolean(ensured) };
    }

    async kickNow({ delayMs = this.wakeDelayMs, reason = 'manual' } = {}) {
      const now = Date.now();
      const delay = Math.max(50, Number(delayMs) || this.wakeDelayMs);
      const when = now + delay;
      if (this._wakeScheduledFor && this._wakeScheduledFor <= when) {
        return { ok: true, skipped: true };
      }
      const created = await this._alarmsCreate(this.wakeAlarmName, { when });
      if (created) {
        this._wakeScheduledFor = when;
      }
      this._emit('info', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.BG_START : 'bg.start', 'Запланирован wake alarm', {
        alarm: this.wakeAlarmName,
        reason,
        when
      });
      return { ok: created };
    }

    async onAlarm(alarm) {
      const name = alarm && alarm.name ? alarm.name : null;
      if (name !== this.tickAlarmName && name !== this.wakeAlarmName) {
        return { ok: true, ignored: true };
      }
      if (name === this.wakeAlarmName) {
        this._wakeScheduledFor = 0;
      }
      return this.tick(`alarm:${name}`);
    }

    _pickJobs(jobs) {
      const source = Array.isArray(jobs) ? jobs.slice() : [];
      return source.sort((a, b) => {
        const aStatus = String((a && a.status) || '').toLowerCase();
        const bStatus = String((b && b.status) || '').toLowerCase();
        const order = (status) => {
          if (status === 'running' || status === 'completing') return 0;
          if (status === 'preparing') return 1;
          if (status === 'awaiting_categories') return 2;
          return 3;
        };
        const byStatus = order(aStatus) - order(bStatus);
        if (byStatus !== 0) {
          return byStatus;
        }
        const aUpdated = Number.isFinite(Number(a && a.updatedAt)) ? Number(a.updatedAt) : 0;
        const bUpdated = Number.isFinite(Number(b && b.updatedAt)) ? Number(b.updatedAt) : 0;
        return aUpdated - bUpdated;
      });
    }

    _isTerminalStatus(status) {
      const value = String(status || '').toLowerCase();
      return value === 'done' || value === 'failed' || value === 'cancelled';
    }

    _retryMeta(job) {
      const runtime = job && job.runtime && typeof job.runtime === 'object' ? job.runtime : {};
      const retry = runtime.retry && typeof runtime.retry === 'object' ? runtime.retry : {};
      return {
        nextRetryAtTs: Number.isFinite(Number(retry.nextRetryAtTs)) ? Number(retry.nextRetryAtTs) : 0,
        lastErrorCode: retry.lastError && retry.lastError.code ? String(retry.lastError.code) : null
      };
    }

    async _resolveActiveTabId() {
      if (!this.activeTabIdProvider) {
        return null;
      }
      try {
        const out = await this.activeTabIdProvider();
        return Number.isFinite(Number(out)) ? Number(out) : null;
      } catch (_) {
        return null;
      }
    }

    _supportsQueueMode() {
      return Boolean(
        this.jobQueue
        && typeof this.jobQueue.syncFromJobs === 'function'
        && typeof this.jobQueue.dequeueNext === 'function'
        && typeof this.jobQueue.markDone === 'function'
      );
    }

    async _runQueueTick({ reason, startedAt, activeJobs }) {
      const queue = this.jobQueue;
      const activeTabId = await this._resolveActiveTabId();
      if (Number.isFinite(Number(activeTabId)) && typeof queue.setActiveTab === 'function') {
        await queue.setActiveTab(activeTabId).catch(() => null);
      }
      await queue.syncFromJobs(activeJobs, { activeTabId }).catch(() => null);

      let processed = 0;
      let pendingWork = false;
      let nextWakeAtTs = null;

      while (processed < this.maxJobsPerTick) {
        if ((Date.now() - startedAt) >= this.maxMsPerTick) {
          pendingWork = true;
          break;
        }

        const next = await queue.dequeueNext({
          now: Date.now(),
          activeTabId
        }).catch(() => ({ jobId: null, nextAtTs: null }));
        if (!next || !next.jobId) {
          if (Number.isFinite(Number(next && next.nextAtTs))) {
            nextWakeAtTs = Number(next.nextAtTs);
          }
          break;
        }

        const jobId = String(next.jobId);
        if (!jobId) {
          continue;
        }

        if (typeof queue.markRunning === 'function') {
          await queue.markRunning(jobId, Date.now() + Math.max(15 * 1000, this.maxMsPerTick * 2)).catch(() => null);
        }

        const stepResult = await this.jobRunner.step({ id: jobId }, {
          reason,
          startedAt,
          maxMsPerTick: this.maxMsPerTick
        }).catch((error) => ({
          ok: false,
          error
        }));
        processed += 1;

        const refreshed = this.jobStore && typeof this.jobStore.getJob === 'function'
          ? await this.jobStore.getJob(jobId).catch(() => null)
          : null;
        if (!refreshed || this._isTerminalStatus(refreshed.status)) {
          await queue.markDone(jobId).catch(() => null);
          continue;
        }

        const retryMeta = this._retryMeta(refreshed);
        const lowerStatus = String(refreshed.status || '').toLowerCase();
        if (lowerStatus === 'awaiting_categories') {
          await queue.markWaiting(jobId, Number.MAX_SAFE_INTEGER, 'AWAITING_CATEGORIES').catch(() => null);
          continue;
        }
        if (retryMeta.nextRetryAtTs > Date.now()) {
          await queue.markWaiting(jobId, retryMeta.nextRetryAtTs, retryMeta.lastErrorCode || 'RETRY_BACKOFF').catch(() => null);
          nextWakeAtTs = nextWakeAtTs === null
            ? retryMeta.nextRetryAtTs
            : Math.min(nextWakeAtTs, retryMeta.nextRetryAtTs);
          continue;
        }
        await queue.enqueue(jobId, 0, 'READY', {
          tabId: Number.isFinite(Number(refreshed.tabId)) ? Number(refreshed.tabId) : null
        }).catch(() => null);
        pendingWork = pendingWork || Boolean(stepResult && stepResult.hasMoreWork !== false);
      }

      const stats = typeof queue.stats === 'function' ? await queue.stats().catch(() => null) : null;
      if (stats) {
        if (Number(stats.queuedCount || 0) > 0 || Number(stats.runningCount || 0) > 0) {
          pendingWork = true;
        }
        if (!nextWakeAtTs && Number.isFinite(Number(stats.nextAtTs))) {
          nextWakeAtTs = Number(stats.nextAtTs);
        }
      }

      return {
        processed,
        pendingWork,
        nextWakeAtTs,
        queueStats: stats
      };
    }

    async tick(reason = 'manual') {
      if (this._tickInFlight) {
        return { ok: true, skipped: 'tick_in_flight' };
      }
      this._tickInFlight = true;
      const startedAt = Date.now();
      let processed = 0;
      let pendingWork = false;
      try {
        if (this.onBeforeTick) {
          const beforeResult = await this.onBeforeTick({ reason, startedAt }).catch(() => null);
          if (beforeResult && beforeResult.hasWork === true) {
            pendingWork = true;
          }
        }
        if (!this.jobStore || typeof this.jobStore.listActiveJobs !== 'function' || !this.jobRunner || typeof this.jobRunner.step !== 'function') {
          return { ok: false, error: 'SCHEDULER_DEPENDENCIES_UNAVAILABLE' };
        }
        const activeJobs = await this.jobStore.listActiveJobs();
        if (this._supportsQueueMode()) {
          const queueRun = await this._runQueueTick({
            reason,
            startedAt,
            activeJobs
          });
          processed = Number(queueRun.processed || 0);
          pendingWork = pendingWork || Boolean(queueRun.pendingWork);
          if (!pendingWork && Number.isFinite(Number(queueRun.nextWakeAtTs))) {
            const waitMs = Math.max(100, Number(queueRun.nextWakeAtTs) - Date.now());
            await this.kickNow({
              delayMs: Math.min(waitMs, 30 * 1000),
              reason: 'waiting_backoff'
            }).catch(() => ({ ok: false }));
          }
        } else {
          const queue = this._pickJobs(activeJobs);
          for (let idx = 0; idx < queue.length; idx += 1) {
            if (processed >= this.maxJobsPerTick) {
              pendingWork = true;
              break;
            }
            if ((Date.now() - startedAt) >= this.maxMsPerTick) {
              pendingWork = true;
              break;
            }
            const job = queue[idx];
            if (!job || !job.id) {
              continue;
            }
            const stepResult = await this.jobRunner.step(job, {
              reason,
              startedAt,
              maxMsPerTick: this.maxMsPerTick
            }).catch((error) => ({
              ok: false,
              error
            }));
            processed += 1;
            if (stepResult && stepResult.hasMoreWork) {
              pendingWork = true;
            }
          }
        }
      } finally {
        this._tickInFlight = false;
      }
      if (this.onAfterTick) {
        await this.onAfterTick({
          reason,
          startedAt,
          elapsedMs: Date.now() - startedAt,
          processed,
          pendingWork
        }).catch(() => {});
      }
      if (pendingWork) {
        await this.kickNow({ delayMs: this.wakeDelayMs, reason: 'pending_work' }).catch(() => ({ ok: false }));
      }
      return {
        ok: true,
        processed,
        pendingWork,
        elapsedMs: Date.now() - startedAt
      };
    }
  }

  NT.Scheduler = Scheduler;
})(globalThis);
