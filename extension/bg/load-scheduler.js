(function initLoadScheduler(global) {
  class LoadScheduler {
    constructor({
      rateLimiter,
      minLowRpmFraction = 0.15,
      minLowTpmFraction = 0.1,
      highBacklogLimit = 2,
      benchFreezeMs = 20 * 60 * 1000,
      eventLogger = null
    } = {}) {
      this.rateLimiter = rateLimiter;
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
        return Promise.reject(new Error('LoadScheduler task is missing kind'));
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

    canRunLow() {
      if (this.queueHigh.length > this.highBacklogLimit) {
        return false;
      }
      if (!this.rateLimiter) {
        return true;
      }
      const availability = this.rateLimiter.getAvailability();
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
        const attempt = this.tryReserve(entry.task);
        if (!attempt.allowed) {
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
        const attempt = this.tryReserve(entry.task);
        if (!attempt.allowed) {
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

    tryReserve(task) {
      if (!this.rateLimiter) {
        return { allowed: true, retryAfterMs: 0 };
      }
      const result = this.rateLimiter.tryConsume({ rpm: task.estRpm || 1, tokens: task.estTokens || 0 });
      if (!result.allowed) {
        this.logLimit(task, result.retryAfterMs);
      }
      return result;
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

  if (!global.NT) {
    global.NT = {};
  }
  global.NT.LoadScheduler = LoadScheduler;
})(globalThis);
