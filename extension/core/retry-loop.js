(function initRetryLoop(global) {
  const NT = global.NT || (global.NT = {});

  class RetryLoop {
    constructor({
      maxAttempts = 5,
      maxTotalMs = 30000,
      baseDelayMs = 300,
      maxDelayMs = 5000,
      multiplier = 1.6,
      jitterMs = 200
    } = {}) {
      this.maxAttempts = maxAttempts;
      this.maxTotalMs = maxTotalMs;
      this.baseDelayMs = baseDelayMs;
      this.maxDelayMs = maxDelayMs;
      this.multiplier = multiplier;
      this.jitterMs = jitterMs;
    }

    async run(task, { signal } = {}) {
      if (typeof task !== 'function') {
        throw new Error('RetryLoop task must be a function');
      }

      const start = Date.now();
      let attempt = 0;
      let lastError = null;
      let delayMs = this.baseDelayMs;

      while (attempt < this.maxAttempts) {
        attempt += 1;
        if (signal && signal.aborted) {
          throw this.buildAbortError();
        }

        try {
          return await task({ attempt, signal });
        } catch (error) {
          lastError = error;
        }

        if (attempt >= this.maxAttempts) {
          break;
        }

        const elapsed = Date.now() - start;
        if (elapsed >= this.maxTotalMs) {
          break;
        }

        const waitMs = this.applyJitter(delayMs);
        await this.sleep(waitMs, signal);
        delayMs = Math.min(delayMs * this.multiplier, this.maxDelayMs);
      }

      throw lastError || new Error('RetryLoop exhausted');
    }

    applyJitter(delayMs) {
      if (!this.jitterMs) {
        return delayMs;
      }
      const jitter = Math.floor(Math.random() * this.jitterMs);
      return Math.min(delayMs + jitter, this.maxDelayMs);
    }

    sleep(durationMs, signal) {
      return new Promise((resolve, reject) => {
        if (signal && signal.aborted) {
          reject(this.buildAbortError());
          return;
        }

        const timeoutId = global.setTimeout(() => {
          if (signal) {
            signal.removeEventListener('abort', onAbort);
          }
          resolve();
        }, durationMs);

        const onAbort = () => {
          global.clearTimeout(timeoutId);
          reject(this.buildAbortError());
        };

        if (signal) {
          signal.addEventListener('abort', onAbort, { once: true });
        }
      });
    }

    buildAbortError() {
      const error = new Error('Retry aborted');
      error.code = 'RETRY_ABORTED';
      return error;
    }
  }

  NT.RetryLoop = RetryLoop;
})(globalThis);
