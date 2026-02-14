/**
 * Unified AI load scheduler with built-in token-bucket budget.
 *
 * Role:
 * - Coordinate high/low priority AI work queues and rate-limit backoff policy.
 * - Own RPM/TPM budgeting directly to avoid extra class fragmentation.
 *
 * Public contract:
 * - `reserveSlot(task)` reserves execution slot or waits in queue.
 * - `onRateLimited({ retryAfterMs, kind })` applies global backoff and bench
 *   freeze windows.
 * - `getAvailability()` returns current budget fractions for diagnostics.
 *
 * Dependencies:
 * - Optional `eventLogger` callback for compact scheduler diagnostics.
 *
 * Side effects:
 * - Uses timer scheduling (`setTimeout`/`clearTimeout`) to process queues.
 * - Emits best-effort events through injected logger callback.
 */
(function initAiLoadScheduler(global) {
  const NT = global.NT || (global.NT = {});

  class AiLoadScheduler {
    constructor({
      rpm = 60,
      tpm = 60000,
      windowMs = 60000,
      minLowRpmFraction = 0.15,
      minLowTpmFraction = 0.1,
      highBacklogLimit = 2,
      benchFreezeMs = 20 * 60 * 1000,
      eventLogger = null
    } = {}) {
      this.rpmCapacity = Number.isFinite(Number(rpm)) ? Math.max(1, Number(rpm)) : 60;
      this.tpmCapacity = Number.isFinite(Number(tpm)) ? Math.max(1, Number(tpm)) : 60000;
      this.windowMs = Number.isFinite(Number(windowMs)) ? Math.max(1000, Number(windowMs)) : 60000;
      this.rpmTokens = this.rpmCapacity;
      this.tpmTokens = this.tpmCapacity;
      this.lastRefillAt = Date.now();

      this.minLowRpmFraction = minLowRpmFraction;
      this.minLowTpmFraction = minLowTpmFraction;
      this.highBacklogLimit = highBacklogLimit;
      this.benchFreezeMs = benchFreezeMs;
      this.queueHigh = [];
      this.queueLow = [];
      this.backoffUntil = 0;
      this.benchFreezeUntil = 0;
      this.timer = null;
      this.eventLogger = typeof eventLogger === 'function' ? eventLogger : null;
      this.lastLimitLogAt = 0;
    }

    reserveSlot(task) {
      if (!task || !task.kind) {
        return Promise.reject(new Error('AiLoadScheduler task is missing kind'));
      }

      return new Promise((resolve, reject) => {
        const entry = {
          task,
          resolve,
          reject,
          enqueuedAt: Date.now()
        };

        if (task.priority === 'high') {
          this.queueHigh.push(entry);
        } else {
          this.queueLow.push(entry);
        }

        this.processQueue();
      });
    }

    onRateLimited({ retryAfterMs, kind } = {}) {
      const delay = typeof retryAfterMs === 'number' && retryAfterMs > 0 ? retryAfterMs : 30000;
      const now = Date.now();
      this.backoffUntil = Math.max(this.backoffUntil, now + delay);

      if (kind === 'BENCH') {
        this.benchFreezeUntil = Math.max(this.benchFreezeUntil, now + this.benchFreezeMs);
      }

      this.logEvent('warn', 'rate-limit', 'Rate limit backoff scheduled', {
        source: 'scheduler',
        stage: kind,
        status: 429
      });
      this.scheduleNext();
    }

    getAvailability() {
      this.refill();
      const rpmFraction = this.rpmCapacity ? this.rpmTokens / this.rpmCapacity : 0;
      const tpmFraction = this.tpmCapacity ? this.tpmTokens / this.tpmCapacity : 0;
      return {
        rpmRemaining: this.rpmTokens,
        tpmRemaining: this.tpmTokens,
        rpmFraction,
        tpmFraction
      };
    }

    canRunLow() {
      if (this.queueHigh.length > this.highBacklogLimit) {
        return false;
      }
      const availability = this.getAvailability();
      return availability.rpmFraction >= this.minLowRpmFraction && availability.tpmFraction >= this.minLowTpmFraction;
    }

    isBenchFrozen() {
      return Date.now() < this.benchFreezeUntil;
    }

    processQueue() {
      this.clearTimer();
      const now = Date.now();
      if (now < this.backoffUntil) {
        this.scheduleNext(this.backoffUntil - now);
        return;
      }

      let progressed = false;

      while (this.queueHigh.length) {
        const entry = this.queueHigh[0];
        const attempt = this.tryConsume({
          rpm: entry.task.estRpm || 1,
          tokens: entry.task.estTokens || 0
        });
        if (!attempt.allowed) {
          this.logLimit(entry.task, attempt.retryAfterMs);
          this.scheduleNext(attempt.retryAfterMs);
          return;
        }
        this.queueHigh.shift();
        entry.resolve({ reservedAt: Date.now() });
        progressed = true;
      }

      while (this.queueLow.length) {
        if (this.isBenchFrozen() || !this.canRunLow()) {
          this.scheduleNext(1000);
          return;
        }
        const entry = this.queueLow[0];
        const attempt = this.tryConsume({
          rpm: entry.task.estRpm || 1,
          tokens: entry.task.estTokens || 0
        });
        if (!attempt.allowed) {
          this.logLimit(entry.task, attempt.retryAfterMs);
          this.scheduleNext(attempt.retryAfterMs);
          return;
        }
        this.queueLow.shift();
        entry.resolve({ reservedAt: Date.now() });
        progressed = true;
      }

      if (!progressed) {
        this.scheduleNext(1000);
      }
    }

    tryConsume({ rpm = 1, tokens = 0 } = {}) {
      this.refill();
      const safeRpm = Number.isFinite(Number(rpm)) ? Math.max(1, Number(rpm)) : 1;
      const safeTokens = Number.isFinite(Number(tokens)) ? Math.max(0, Number(tokens)) : 0;

      if (this.rpmTokens >= safeRpm && this.tpmTokens >= safeTokens) {
        this.rpmTokens -= safeRpm;
        this.tpmTokens -= safeTokens;
        return { allowed: true, retryAfterMs: 0 };
      }

      const rpmDeficit = Math.max(0, safeRpm - this.rpmTokens);
      const tpmDeficit = Math.max(0, safeTokens - this.tpmTokens);
      const rpmWait = this.estimateWait(rpmDeficit, this.rpmCapacity);
      const tpmWait = this.estimateWait(tpmDeficit, this.tpmCapacity);
      return { allowed: false, retryAfterMs: Math.max(rpmWait, tpmWait) };
    }

    refill() {
      const now = Date.now();
      const elapsed = Math.max(0, now - this.lastRefillAt);
      if (!elapsed) {
        return;
      }

      const rpmRefill = (elapsed / this.windowMs) * this.rpmCapacity;
      const tpmRefill = (elapsed / this.windowMs) * this.tpmCapacity;
      this.rpmTokens = Math.min(this.rpmCapacity, this.rpmTokens + rpmRefill);
      this.tpmTokens = Math.min(this.tpmCapacity, this.tpmTokens + tpmRefill);
      this.lastRefillAt = now;
    }

    estimateWait(deficit, capacity) {
      if (!deficit || !capacity) {
        return 0;
      }
      return Math.ceil((deficit / capacity) * this.windowMs);
    }

    scheduleNext(delayMs = 1000) {
      this.clearTimer();
      this.timer = global.setTimeout(() => {
        this.timer = null;
        this.processQueue();
      }, delayMs);
    }

    clearTimer() {
      if (this.timer) {
        global.clearTimeout(this.timer);
        this.timer = null;
      }
    }

    logLimit(task, retryAfterMs) {
      const now = Date.now();
      if (now - this.lastLimitLogAt < 5000) {
        return;
      }
      this.lastLimitLogAt = now;
      this.logEvent('warn', 'rate-limit', 'Rate budget unavailable', {
        source: 'scheduler',
        stage: task.kind,
        status: retryAfterMs
      });
    }

    logEvent(level, tag, message, meta) {
      if (!this.eventLogger) {
        return;
      }
      this.eventLogger({ level, tag, message, meta });
    }
  }

  NT.AiLoadScheduler = AiLoadScheduler;
})(globalThis);
