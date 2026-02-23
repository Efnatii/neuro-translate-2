/**
 * Shared retry/backoff helpers for MV3 background/offscreen orchestration.
 *
 * This policy is technical QoS only: bounded retries with jitter and explicit
 * error classification for diagnostics and deterministic recovery flow.
 */
(function initRetryPolicy(global) {
  const NT = global.NT || (global.NT = {});

  function normalizeAttempt(value) {
    const attempt = Number(value);
    if (!Number.isFinite(attempt)) {
      return 1;
    }
    return Math.max(1, Math.floor(attempt));
  }

  function normalizeBound(value, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) {
      return fallback;
    }
    return num;
  }

  function computeBackoffMs({
    attempt = 1,
    baseMs = 500,
    maxMs = 60 * 1000,
    jitterRatio = 0.2,
    randomFn = Math.random
  } = {}) {
    const safeAttempt = normalizeAttempt(attempt);
    const safeBase = normalizeBound(baseMs, 500);
    const safeMax = normalizeBound(maxMs, 60 * 1000);
    const expo = Math.min(safeBase * (2 ** (safeAttempt - 1)), safeMax);
    const jitter = Math.max(0, Math.min(Number(jitterRatio) || 0, 0.95));
    const random = typeof randomFn === 'function' ? randomFn() : Math.random();
    const safeRandom = Number.isFinite(Number(random)) ? Number(random) : 0.5;
    const factor = jitter > 0
      ? ((1 - jitter) + (2 * jitter * Math.max(0, Math.min(1, safeRandom))))
      : 1;
    return Math.max(100, Math.round(expo * factor));
  }

  function shouldRetry({
    attempt = 0,
    maxAttempts = 3,
    firstAttemptTs = null,
    maxTotalMs = 10 * 60 * 1000,
    nowTs = Date.now()
  } = {}) {
    const safeAttempt = Math.max(0, Math.floor(Number(attempt) || 0));
    const safeMaxAttempts = Math.max(1, Math.floor(Number(maxAttempts) || 3));
    if (safeAttempt >= safeMaxAttempts) {
      return false;
    }
    const firstTs = Number(firstAttemptTs);
    if (Number.isFinite(firstTs)) {
      const safeMaxTotal = normalizeBound(maxTotalMs, 10 * 60 * 1000);
      const elapsed = Math.max(0, Number(nowTs) - firstTs);
      if (elapsed > safeMaxTotal) {
        return false;
      }
    }
    return true;
  }

  function classifyError(errorLike) {
    const src = errorLike && typeof errorLike === 'object' ? errorLike : {};
    const rawCode = src.code || src.errorCode || null;
    const rawMessage = src.message || src.error || '';
    const message = typeof rawMessage === 'string' ? rawMessage : String(rawMessage || '');
    const lowerMessage = message.toLowerCase();
    const statusCandidate = Number(src.httpStatus || src.status || (src.http && src.http.status));
    const httpStatus = Number.isFinite(statusCandidate) ? statusCandidate : null;
    const retryAfterMsCandidate = Number(src.retryAfterMs || src.retry_after_ms || src.retryAfter);
    const retryAfterMs = Number.isFinite(retryAfterMsCandidate) ? Math.max(0, Math.round(retryAfterMsCandidate)) : null;

    if (rawCode === 'TAB_GONE' || rawCode === 'TAB_UNAVAILABLE' || rawCode === 'TAB_CLOSED') {
      return { code: 'TAB_GONE', isRetryable: false, httpStatus, network: false, message };
    }
    if (rawCode === 'ABORTED' || rawCode === 'ABORT_ERR' || rawCode === 'CANCELLED') {
      return { code: 'ABORTED', isRetryable: false, httpStatus, network: false, message };
    }
    if (httpStatus === 429) {
      return { code: 'OPENAI_429', isRetryable: true, httpStatus, network: false, message, retryAfterMs };
    }
    if (httpStatus >= 500 && httpStatus < 600) {
      return { code: 'OPENAI_5XX', isRetryable: true, httpStatus, network: false, message };
    }
    if (rawCode === 'OFFSCREEN_PORT_DISCONNECTED' || rawCode === 'OFFSCREEN_UNAVAILABLE' || rawCode === 'OFFSCREEN_REQUEST_TIMEOUT') {
      return { code: 'OFFSCREEN_DISCONNECTED', isRetryable: true, httpStatus, network: false, message };
    }
    if (rawCode === 'OFFSCREEN_BACKPRESSURE') {
      const waitMs = Number(src.waitMs || src.retryAfterMs || src.retry_after_ms || src.retryAfter);
      return {
        code: 'OFFSCREEN_BACKPRESSURE',
        isRetryable: true,
        httpStatus,
        network: false,
        message,
        retryAfterMs: Number.isFinite(waitMs) ? Math.max(250, Math.round(waitMs)) : null
      };
    }
    if (rawCode === 'LEASE_EXPIRED' || rawCode === 'NO_PROGRESS_WATCHDOG') {
      return { code: String(rawCode), isRetryable: true, httpStatus, network: false, message };
    }
    if (rawCode === 'CS_NO_ACK' || rawCode === 'APPLY_ACK_TIMEOUT') {
      return { code: 'CS_NO_ACK', isRetryable: true, httpStatus, network: false, message };
    }
    if (rawCode === 'NETWORK_ERROR' || rawCode === 'FETCH_FAILED') {
      return { code: 'NETWORK_ERROR', isRetryable: true, httpStatus, network: true, message };
    }
    if (
      lowerMessage.includes('network')
      || lowerMessage.includes('fetch')
      || lowerMessage.includes('timeout')
      || lowerMessage.includes('temporarily unavailable')
    ) {
      return { code: 'NETWORK_ERROR', isRetryable: true, httpStatus, network: true, message };
    }
    if (rawCode === 'OPENAI_429' || rawCode === 'OPENAI_5XX') {
      return { code: String(rawCode), isRetryable: true, httpStatus, network: false, message, retryAfterMs };
    }
    if (rawCode === 'RATE_LIMIT_BUDGET_WAIT') {
      return { code: 'RATE_LIMIT_BUDGET_WAIT', isRetryable: true, httpStatus, network: false, message, retryAfterMs };
    }
    if (rawCode && typeof rawCode === 'string') {
      return { code: rawCode, isRetryable: false, httpStatus, network: false, message };
    }
    return { code: 'UNKNOWN_ERROR', isRetryable: false, httpStatus, network: false, message };
  }

  NT.RetryPolicy = Object.freeze({
    computeBackoffMs,
    shouldRetry,
    classifyError
  });
})(globalThis);
