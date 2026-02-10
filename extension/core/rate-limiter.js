(function initRateLimiter(global) {
  const NT = global.NT || (global.NT = {});

  class RateLimiter {
    constructor({ rpm = 60, tpm = 60000, windowMs = 60000 } = {}) {
      this.rpmCapacity = rpm;
      this.tpmCapacity = tpm;
      this.windowMs = windowMs;
      this.rpmTokens = rpm;
      this.tpmTokens = tpm;
      this.lastRefillAt = Date.now();
    }

    updateLimits({ rpm, tpm } = {}) {
      if (typeof rpm === 'number') {
        this.rpmCapacity = rpm;
        this.rpmTokens = Math.min(this.rpmTokens, rpm);
      }
      if (typeof tpm === 'number') {
        this.tpmCapacity = tpm;
        this.tpmTokens = Math.min(this.tpmTokens, tpm);
      }
    }

    tryConsume({ rpm = 1, tokens = 0 } = {}) {
      this.refill();

      if (this.rpmTokens >= rpm && this.tpmTokens >= tokens) {
        this.rpmTokens -= rpm;
        this.tpmTokens -= tokens;
        return { allowed: true, retryAfterMs: 0 };
      }

      const rpmDeficit = Math.max(0, rpm - this.rpmTokens);
      const tpmDeficit = Math.max(0, tokens - this.tpmTokens);
      const rpmWait = this.estimateWait(rpmDeficit, this.rpmCapacity);
      const tpmWait = this.estimateWait(tpmDeficit, this.tpmCapacity);
      return { allowed: false, retryAfterMs: Math.max(rpmWait, tpmWait) };
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
  }

  NT.RateLimiter = RateLimiter;
})(globalThis);
