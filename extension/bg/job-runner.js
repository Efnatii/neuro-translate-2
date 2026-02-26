/**
 * Scheduler step runner for translation jobs.
 *
 * Keeps durable runtime lease/retry/watchdog state in each job record and
 * delegates heavy execution to TranslationOrchestrator.
 */
(function initJobRunner(global) {
  const NT = global.NT || (global.NT = {});

  class JobRunner {
    constructor({
      chromeApi,
      jobStore,
      translationOrchestrator,
      perfProfiler,
      offscreenExecutor,
      retryPolicy,
      ownerInstanceId,
      leaseMs = 60 * 1000,
      maxAttempts = 4,
      maxTotalMs = 20 * 60 * 1000,
      watchdogNoProgressMs = 2 * 60 * 1000
    } = {}) {
      this.chromeApi = chromeApi || null;
      this.jobStore = jobStore || null;
      this.translationOrchestrator = translationOrchestrator || null;
      this.perfProfiler = perfProfiler || null;
      this.offscreenExecutor = offscreenExecutor || null;
      this.retryPolicy = retryPolicy || (NT.RetryPolicy || null);
      this.ownerInstanceId = ownerInstanceId || `sw-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      this.leaseMs = Math.max(15 * 1000, Number(leaseMs) || (60 * 1000));
      this.maxAttempts = Math.max(1, Number(maxAttempts) || 4);
      this.maxTotalMs = Math.max(30 * 1000, Number(maxTotalMs) || (20 * 60 * 1000));
      this.watchdogNoProgressMs = Math.max(30 * 1000, Number(watchdogNoProgressMs) || (2 * 60 * 1000));
      this.backoffBaseMs = 1000;
      this.backoffMaxMs = 60 * 1000;
      this.backoffJitter = 0.2;
    }

    _isTerminalStatus(status) {
      const value = String(status || '').toLowerCase();
      return value === 'done' || value === 'failed' || value === 'cancelled';
    }

    _runtimeStatusFromJob(jobStatus) {
      const status = String(jobStatus || '').toLowerCase();
      if (status === 'done') return 'DONE';
      if (status === 'failed') return 'FAILED';
      if (status === 'cancelled') return 'CANCELLED';
      if (status === 'awaiting_categories') return 'IDLE';
      if (status === 'planning') return 'RUNNING';
      if (status === 'preparing') return 'QUEUED';
      if (status === 'running' || status === 'completing') return 'RUNNING';
      return 'IDLE';
    }

    _runtimeStageFromJob(job) {
      const status = String(job && job.status ? job.status : '').toLowerCase();
      if (status === 'preparing') {
        return 'scanning';
      }
      if (status === 'planning') {
        return 'planning';
      }
      if (status === 'awaiting_categories') {
        return 'awaiting_categories';
      }
      if (status === 'done' || status === 'failed' || status === 'cancelled') {
        return 'execution';
      }
      const phase = job && job.agentState && typeof job.agentState.phase === 'string'
        ? String(job.agentState.phase).toLowerCase()
        : '';
      if (phase.includes('proofread')) {
        return 'proofreading';
      }
      if (phase.includes('planning') || phase.includes('awaiting_categories') || phase.includes('planned')) {
        return 'planning';
      }
      return 'execution';
    }

    _normalizeRuntime(job) {
      const now = Date.now();
      const src = job && job.runtime && typeof job.runtime === 'object'
        ? job.runtime
        : {};
      const retrySrc = src.retry && typeof src.retry === 'object' ? src.retry : {};
      const leaseSrc = src.lease && typeof src.lease === 'object' ? src.lease : {};
      const watchdogSrc = src.watchdog && typeof src.watchdog === 'object' ? src.watchdog : {};
      const hasLeaseUntil = Object.prototype.hasOwnProperty.call(leaseSrc, 'leaseUntilTs');
      const hasHeartbeat = Object.prototype.hasOwnProperty.call(leaseSrc, 'heartbeatTs');
      const runtime = {
        ownerInstanceId: src.ownerInstanceId || this.ownerInstanceId,
        status: src.status || this._runtimeStatusFromJob(job && job.status),
        stage: src.stage || this._runtimeStageFromJob(job),
        lease: {
          leaseUntilTs: hasLeaseUntil
            ? (Number.isFinite(Number(leaseSrc.leaseUntilTs)) ? Number(leaseSrc.leaseUntilTs) : null)
            : (Number.isFinite(Number(job && job.leaseUntilTs)) ? Number(job.leaseUntilTs) : null),
          heartbeatTs: hasHeartbeat
            ? (Number.isFinite(Number(leaseSrc.heartbeatTs)) ? Number(leaseSrc.heartbeatTs) : now)
            : (Number.isFinite(Number(job && job.updatedAt)) ? Number(job.updatedAt) : now),
          op: leaseSrc.op || null,
          opId: leaseSrc.opId || null
        },
        retry: {
          attempt: Math.max(0, Number(retrySrc.attempt) || 0),
          maxAttempts: Math.max(1, Number(retrySrc.maxAttempts) || this.maxAttempts),
          nextRetryAtTs: Number.isFinite(Number(retrySrc.nextRetryAtTs))
            ? Number(retrySrc.nextRetryAtTs)
            : 0,
          firstAttemptTs: Number.isFinite(Number(retrySrc.firstAttemptTs))
            ? Number(retrySrc.firstAttemptTs)
            : null,
          lastError: retrySrc.lastError && typeof retrySrc.lastError === 'object'
            ? { ...retrySrc.lastError }
            : null
        },
        watchdog: {
          lastProgressTs: Number.isFinite(Number(watchdogSrc.lastProgressTs))
            ? Number(watchdogSrc.lastProgressTs)
            : now,
          lastProgressKey: typeof watchdogSrc.lastProgressKey === 'string'
            ? watchdogSrc.lastProgressKey
            : ''
        }
      };
      job.runtime = runtime;
      return runtime;
    }

    _progressKey(job, stage) {
      const completed = Number.isFinite(Number(job && job.completedBlocks)) ? Number(job.completedBlocks) : 0;
      const failed = job && Array.isArray(job.failedBlockIds) ? job.failedBlockIds.length : 0;
      const pending = job && Array.isArray(job.pendingBlockIds) ? job.pendingBlockIds.length : 0;
      let lastAppliedSeq = 0;
      const history = job && job.agentState && Array.isArray(job.agentState.patchHistory)
        ? job.agentState.patchHistory
        : [];
      if (history.length) {
        const tail = history[history.length - 1];
        if (tail && Number.isFinite(Number(tail.seq))) {
          lastAppliedSeq = Number(tail.seq);
        }
      }
      return `${completed}:${failed}:${pending}:${lastAppliedSeq}:${stage || 'execution'}`;
    }

    _appendRuntimeWarning(job, warning) {
      if (!job || typeof job !== 'object') {
        return;
      }
      if (!job.agentState || typeof job.agentState !== 'object') {
        job.agentState = {};
      }
      const list = Array.isArray(job.agentState.warnings) ? job.agentState.warnings : [];
      const item = warning && typeof warning === 'object' ? warning : {};
      list.push({
        ts: Date.now(),
        code: item.code || 'WARNING',
        message: item.message || '',
        stage: item.stage || null
      });
      job.agentState.warnings = list.slice(-40);
    }

    async _isTabAvailable(tabId) {
      if (!this.chromeApi || !this.chromeApi.tabs || typeof this.chromeApi.tabs.get !== 'function') {
        return true;
      }
      const numericTabId = Number(tabId);
      if (!Number.isFinite(numericTabId)) {
        return false;
      }
      return new Promise((resolve) => {
        try {
          this.chromeApi.tabs.get(numericTabId, (tab) => {
            const lastError = this.chromeApi && this.chromeApi.runtime ? this.chromeApi.runtime.lastError : null;
            if (lastError || !tab) {
              resolve(false);
              return;
            }
            resolve(true);
          });
        } catch (_) {
          resolve(false);
        }
      });
    }

    async _persist(job, { setActive = true, clearActive = false } = {}) {
      if (!job || !job.id) {
        return null;
      }
      if (job.runtime && job.runtime.lease && Object.prototype.hasOwnProperty.call(job.runtime.lease, 'leaseUntilTs')) {
        job.leaseUntilTs = job.runtime.lease.leaseUntilTs;
      }
      if (this.translationOrchestrator && typeof this.translationOrchestrator._saveJob === 'function') {
        await this.translationOrchestrator._saveJob(job, { setActive, clearActive });
        return job;
      }
      if (this.jobStore && typeof this.jobStore.upsertJob === 'function') {
        await this.jobStore.upsertJob(job);
        if (setActive && this.jobStore && typeof this.jobStore.setActiveJob === 'function') {
          await this.jobStore.setActiveJob(job.tabId, job.id);
        }
        if (clearActive && this.jobStore && typeof this.jobStore.clearActiveJob === 'function') {
          await this.jobStore.clearActiveJob(job.tabId, job.id);
        }
      }
      return job;
    }

    async _failJob(job, error) {
      const err = error && typeof error === 'object'
        ? error
        : { code: 'TRANSLATION_FAILED', message: 'Job failed' };
      if (this.translationOrchestrator && typeof this.translationOrchestrator._markFailed === 'function') {
        await this.translationOrchestrator._markFailed(job, err);
        return;
      }
      job.status = 'failed';
      job.lastError = { code: err.code || 'TRANSLATION_FAILED', message: err.message || 'Job failed' };
      if (job.runtime && typeof job.runtime === 'object') {
        job.runtime.status = 'FAILED';
        job.runtime.lease = {
          leaseUntilTs: null,
          heartbeatTs: Date.now(),
          op: null,
          opId: null
        };
      }
      await this._persist(job, { setActive: false, clearActive: true });
    }

    async _nudgePreparingJob(job, runtime) {
      if (!this.translationOrchestrator) {
        return { ok: false, skipped: true };
      }
      if (typeof this.translationOrchestrator._ensureContentRuntime === 'function') {
        const injected = await this.translationOrchestrator._ensureContentRuntime(job.tabId);
        if (!injected || injected.ok !== true) {
          return { ok: false, error: injected && injected.error ? injected.error : { code: 'INJECT_FAILED', message: 'Failed to inject content runtime' } };
        }
      }
      const protocol = NT.TranslationProtocol || {};
      if (typeof this.translationOrchestrator._sendToTab === 'function') {
        const sent = await this.translationOrchestrator._sendToTab(job.tabId, {
          type: protocol.BG_START_JOB,
          jobId: job.id,
          targetLang: job.targetLang || 'ru',
          mode: typeof this.translationOrchestrator._normalizeDisplayMode === 'function'
            ? this.translationOrchestrator._normalizeDisplayMode(job.displayMode, true)
            : 'translated',
          compareDiffThreshold: typeof this.translationOrchestrator._normalizeCompareDiffThreshold === 'function'
            ? this.translationOrchestrator._normalizeCompareDiffThreshold(job.compareDiffThreshold)
            : 8000
        });
        if (!sent || !sent.ok) {
          return {
            ok: false,
            error: {
              code: 'CS_NO_ACK',
              message: sent && sent.error && sent.error.message
                ? sent.error.message
                : 'Failed to send BG_START_JOB'
            }
          };
        }
      }
      const now = Date.now();
      runtime.lease.heartbeatTs = now;
      runtime.lease.op = 'scanning';
      runtime.lease.opId = job.id;
      job.scanRequestedAt = now;
      job.scanNudgeTs = now;
      job.message = 'Ожидаю результат сканирования после восстановления';
      return { ok: true };
    }

    async _scheduleRetry(job, runtime, classified, overrideCode) {
      const now = Date.now();
      const retry = runtime.retry || {};
      const nextAttempt = Math.max(0, Number(retry.attempt) || 0) + 1;
      const classifiedRetryAfterMs = classified && Number.isFinite(Number(classified.retryAfterMs))
        ? Math.max(250, Math.min(Number(classified.retryAfterMs), this.backoffMaxMs))
        : null;
      const computedBackoffMs = this.retryPolicy && typeof this.retryPolicy.computeBackoffMs === 'function'
        ? this.retryPolicy.computeBackoffMs({
          attempt: nextAttempt,
          baseMs: this.backoffBaseMs,
          maxMs: this.backoffMaxMs,
          jitterRatio: this.backoffJitter
        })
        : 1000;
      const backoffMs = classifiedRetryAfterMs !== null ? classifiedRetryAfterMs : computedBackoffMs;
      runtime.status = 'QUEUED';
      runtime.retry.attempt = nextAttempt;
      runtime.retry.maxAttempts = Math.max(1, Number(retry.maxAttempts) || this.maxAttempts);
      runtime.retry.nextRetryAtTs = now + backoffMs;
      runtime.retry.firstAttemptTs = Number.isFinite(Number(retry.firstAttemptTs))
        ? Number(retry.firstAttemptTs)
        : now;
      runtime.retry.lastError = {
        code: overrideCode || (classified && classified.code) || 'RETRY_SCHEDULED',
        message: classified && classified.message ? classified.message : 'Recovery scheduled'
      };
      runtime.lease = {
        leaseUntilTs: null,
        heartbeatTs: now,
        op: 'recovery',
        opId: job.id
      };
      runtime.stage = this._runtimeStageFromJob(job);
      job.message = `Планировщик: повтор через ${Math.round(backoffMs)}мс (${runtime.retry.lastError.code})`;
      if (job.status === 'running' || job.status === 'completing') {
        job.status = 'preparing';
      }
      this._appendRuntimeWarning(job, {
        code: runtime.retry.lastError.code,
        message: job.message,
        stage: runtime.stage
      });
      if (this.offscreenExecutor && typeof this.offscreenExecutor.cancelByJobId === 'function') {
        await this.offscreenExecutor.cancelByJobId(job.id, { maxRequests: 20 }).catch(() => ({ ok: false }));
      }
      await this._persist(job, { setActive: true });
      return { ok: true, requeued: true, hasMoreWork: true };
    }

    async _handleRecovery(job, runtime, errorLike) {
      const classified = this.retryPolicy && typeof this.retryPolicy.classifyError === 'function'
        ? this.retryPolicy.classifyError(errorLike || {})
        : {
          code: (errorLike && errorLike.code) || 'RECOVERY_ERROR',
          isRetryable: false,
          message: errorLike && errorLike.message ? errorLike.message : 'Recovery error'
        };
      const retryState = runtime.retry || {};
      const canRetry = Boolean(classified.isRetryable) && Boolean(
        this.retryPolicy && typeof this.retryPolicy.shouldRetry === 'function'
          ? this.retryPolicy.shouldRetry({
            attempt: Number(retryState.attempt) || 0,
            maxAttempts: Number(retryState.maxAttempts) || this.maxAttempts,
            firstAttemptTs: retryState.firstAttemptTs || Date.now(),
            maxTotalMs: this.maxTotalMs
          })
          : false
      );
      if (canRetry) {
        return this._scheduleRetry(job, runtime, classified);
      }
      const requestedCode = errorLike && errorLike.code ? String(errorLike.code) : classified.code;
      const terminalCode = requestedCode === 'LEASE_EXPIRED'
        ? 'LEASE_EXPIRED_NO_RECOVERY'
        : (requestedCode === 'NO_PROGRESS_WATCHDOG' ? 'NO_PROGRESS_WATCHDOG' : (classified.code || 'RECOVERY_FAILED'));
      await this._failJob(job, {
        code: terminalCode,
        message: classified.message || (errorLike && errorLike.message) || 'Recovery failed'
      });
      return { ok: false, terminal: true };
    }

    _recordStepDuration(job, stage, startedAt) {
      if (!this.perfProfiler || typeof this.perfProfiler.recordJobMetric !== 'function' || !job || !job.id) {
        return;
      }
      const started = Number(startedAt);
      if (!Number.isFinite(started)) {
        return;
      }
      const durationMs = Math.max(0, Date.now() - started);
      if (typeof this.perfProfiler.attachJobContext === 'function') {
        this.perfProfiler.attachJobContext(job.id, {
          tabId: Number.isFinite(Number(job.tabId)) ? Number(job.tabId) : null,
          status: typeof job.status === 'string' ? job.status : null
        });
      }
      const stepStage = typeof stage === 'string' && stage ? stage : 'execution';
      this.perfProfiler.recordJobMetric(job.id, `step:${stepStage}`, durationMs);
    }

    async step(jobInput, { reason = 'scheduler' } = {}) {
      if (!jobInput || !jobInput.id || !this.jobStore || typeof this.jobStore.getJob !== 'function') {
        return { ok: false, error: 'INVALID_JOB' };
      }
      const startedAt = Date.now();
      const job = await this.jobStore.getJob(jobInput.id).catch(() => null);
      if (!job) {
        return { ok: false, error: 'JOB_NOT_FOUND' };
      }
      const finalize = (result, stageOverride = null) => {
        const stage = typeof stageOverride === 'string' && stageOverride
          ? stageOverride
          : (job.runtime && typeof job.runtime.stage === 'string' ? job.runtime.stage : null);
        this._recordStepDuration(job, stage, startedAt);
        return result;
      };
      const now = Date.now();
      const runtime = this._normalizeRuntime(job);
      runtime.ownerInstanceId = this.ownerInstanceId;
      runtime.stage = this._runtimeStageFromJob(job);

      if (this._isTerminalStatus(job.status)) {
        runtime.status = this._runtimeStatusFromJob(job.status);
        runtime.lease = {
          leaseUntilTs: null,
          heartbeatTs: now,
          op: null,
          opId: null
        };
        await this._persist(job, { setActive: false, clearActive: true });
        return finalize({ ok: true, terminal: true }, runtime.stage);
      }

      if (job.status === 'awaiting_categories') {
        runtime.status = 'IDLE';
        runtime.stage = 'awaiting_categories';
        runtime.lease = {
          leaseUntilTs: null,
          heartbeatTs: now,
          op: null,
          opId: null
        };
        await this._persist(job, { setActive: true });
        return finalize({ ok: true, hasMoreWork: false }, 'awaiting_categories');
      }

      const progressKey = this._progressKey(job, runtime.stage);
      if (progressKey !== runtime.watchdog.lastProgressKey) {
        runtime.watchdog.lastProgressKey = progressKey;
        runtime.watchdog.lastProgressTs = now;
      } else if ((now - (Number(runtime.watchdog.lastProgressTs) || now)) > this.watchdogNoProgressMs) {
        const recovered = await this._handleRecovery(job, runtime, {
          code: 'NO_PROGRESS_WATCHDOG',
          message: 'Прогресс задачи не изменяется слишком долго'
        });
        return finalize(recovered, runtime.stage);
      }

      if (runtime.retry && Number.isFinite(Number(runtime.retry.nextRetryAtTs)) && Number(runtime.retry.nextRetryAtTs) > now) {
        runtime.status = 'QUEUED';
        runtime.lease = {
          leaseUntilTs: null,
          heartbeatTs: now,
          op: 'backoff',
          opId: job.id
        };
        await this._persist(job, { setActive: true });
        return finalize({ ok: true, hasMoreWork: false }, runtime.stage);
      }

      const leaseUntil = Number(runtime.lease && runtime.lease.leaseUntilTs);
      if (Number.isFinite(leaseUntil) && leaseUntil > 0 && leaseUntil < now) {
        const recovered = await this._handleRecovery(job, runtime, {
          code: 'LEASE_EXPIRED',
          message: 'Lease выполнения истёк'
        });
        return finalize(recovered, runtime.stage);
      }

      const tabReady = await this._isTabAvailable(job.tabId);
      if (!tabReady) {
        await this._failJob(job, {
          code: 'TAB_GONE',
          message: 'Вкладка закрыта или недоступна'
        });
        return finalize({ ok: false, terminal: true }, runtime.stage);
      }

      if (!runtime.retry.firstAttemptTs) {
        runtime.retry.firstAttemptTs = now;
      }
      runtime.status = 'RUNNING';
      runtime.lease = {
        leaseUntilTs: now + this.leaseMs,
        heartbeatTs: now,
        op: runtime.stage === 'planning' ? 'planning' : (runtime.stage === 'proofreading' ? 'proofreading' : 'execution'),
        opId: job.currentBatchId || job.id
      };
      await this._persist(job, { setActive: true });

      if (job.status === 'running' || job.status === 'completing') {
        const processing = this.translationOrchestrator && this.translationOrchestrator.processingJobs instanceof Set
          ? this.translationOrchestrator.processingJobs.has(job.id)
          : false;
        if (!processing && this.translationOrchestrator && typeof this.translationOrchestrator._processJob === 'function') {
          this.translationOrchestrator._processJob(job.id).catch(() => {});
        }
        return finalize({ ok: true, hasMoreWork: true, reason }, runtime.stage);
      }

      if (job.status === 'preparing') {
        const baselineScanTs = Number.isFinite(Number(job.scanRequestedAt))
          ? Number(job.scanRequestedAt)
          : (Number.isFinite(Number(job.createdAt)) ? Number(job.createdAt) : now);
        const lastNudgeTs = Number.isFinite(Number(job.scanNudgeTs))
          ? Number(job.scanNudgeTs)
          : 0;
        const idleForMs = now - baselineScanTs;
        const nudgeCooldownMs = 4000;
        if (!job.scanReceived && idleForMs > 8000 && (now - lastNudgeTs) >= nudgeCooldownMs) {
          const nudged = await this._nudgePreparingJob(job, runtime);
          if (!nudged || nudged.ok !== true) {
            const recovered = await this._handleRecovery(job, runtime, nudged && nudged.error ? nudged.error : {
              code: 'CS_NO_ACK',
              message: 'Не удалось переподключить content runtime'
            });
            return finalize(recovered, 'scanning');
          }
          await this._persist(job, { setActive: true });
        }
        return finalize({ ok: true, hasMoreWork: true, reason }, 'scanning');
      }

      if (job.status === 'planning') {
        const orchestrator = this.translationOrchestrator;
        const planningAgent = orchestrator && orchestrator.translationAgent && typeof orchestrator.translationAgent === 'object'
          ? orchestrator.translationAgent
          : null;
        if (!planningAgent || typeof planningAgent.runPlanning !== 'function') {
          const recovered = await this._handleRecovery(job, runtime, {
            code: 'PLANNING_RUNNER_UNAVAILABLE',
            message: 'Planning runner unavailable'
          });
          return finalize(recovered, 'planning');
        }

        const blocks = Object.keys(job.blocksById || {})
          .map((id) => (job.blocksById ? job.blocksById[id] : null))
          .filter((item) => item && item.blockId);
        if (!blocks.length) {
          const recovered = await this._handleRecovery(job, runtime, {
            code: 'PLANNING_NO_BLOCKS',
            message: 'Planning requires scanned blocks'
          });
          return finalize(recovered, 'planning');
        }

        let planningSettings = {};
        if (orchestrator && typeof orchestrator._readAgentSettings === 'function') {
          planningSettings = await orchestrator._readAgentSettings().catch(() => ({}));
        }
        planningSettings = {
          ...(planningSettings && typeof planningSettings === 'object' ? planningSettings : {}),
          translationCategoryMode: 'auto',
          translationCategoryList: []
        };
        if (orchestrator && typeof orchestrator._ensureJobRunSettings === 'function') {
          orchestrator._ensureJobRunSettings(job, { settings: planningSettings });
        }

        if ((!job.agentState || typeof job.agentState !== 'object') && orchestrator && typeof orchestrator._prepareAgentJob === 'function') {
          const prepared = await orchestrator._prepareAgentJob({
            job,
            blocks,
            settings: planningSettings
          });
          if (!prepared || !prepared.agentState) {
            const recovered = await this._handleRecovery(job, runtime, {
              code: 'PREPARE_AGENT_STATE_FAILED',
              message: 'Failed to prepare planning agent state'
            });
            return finalize(recovered, 'planning');
          }
        }

        let planningResult = null;
        try {
          planningResult = await planningAgent.runPlanning({
            job,
            blocks,
            settings: planningSettings
          });
        } catch (error) {
          const recovered = await this._handleRecovery(job, runtime, {
            code: error && error.code ? error.code : 'PLANNING_FAILED',
            message: error && error.message ? error.message : 'Planning loop failed'
          });
          return finalize(recovered, 'planning');
        }

        if (planningResult && planningResult.ok === false) {
          const recovered = await this._handleRecovery(job, runtime, planningResult.error || {
            code: 'PLANNING_FAILED',
            message: 'Planning loop reported failure'
          });
          return finalize(recovered, 'planning');
        }

        const latest = await this.jobStore.getJob(job.id).catch(() => null);
        if (!latest || this._isTerminalStatus(latest.status)) {
          return finalize({ ok: true, hasMoreWork: false }, 'planning');
        }
        if (latest.status === 'awaiting_categories') {
          const latestRuntime = this._normalizeRuntime(latest);
          latestRuntime.status = 'IDLE';
          latestRuntime.stage = 'awaiting_categories';
          latestRuntime.lease = {
            leaseUntilTs: null,
            heartbeatTs: Date.now(),
            op: null,
            opId: null
          };
          await this._persist(latest, { setActive: true });
          return finalize({ ok: true, hasMoreWork: false }, 'awaiting_categories');
        }
        if (latest.status === 'planning') {
          const latestRuntime = this._normalizeRuntime(latest);
          const renewNow = Date.now();
          latestRuntime.status = 'RUNNING';
          latestRuntime.stage = 'planning';
          latestRuntime.lease = {
            leaseUntilTs: renewNow + this.leaseMs,
            heartbeatTs: renewNow,
            op: 'planning',
            opId: latest.id
          };
          await this._persist(latest, { setActive: true });
          return finalize({ ok: true, hasMoreWork: true }, 'planning');
        }

        return finalize({ ok: true, hasMoreWork: false }, 'planning');
      }

      return finalize({ ok: true, hasMoreWork: false }, runtime.stage);
    }
  }

  NT.JobRunner = JobRunner;
})(globalThis);
