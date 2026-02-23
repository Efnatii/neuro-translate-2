/**
 * URL normalization helper for translation memory keys.
 *
 * Rules:
 * - Host/protocol lower-cased.
 * - `#fragment` dropped.
 * - Query string preserved except ignored tracking parameters.
 */
(function initUrlNormalizer(global) {
  const NT = global.NT || (global.NT = {});

  const DEFAULT_IGNORED_QUERY_PATTERNS = Object.freeze([
    'utm_',
    'fbclid',
    'gclid',
    'mc_cid',
    'mc_eid'
  ]);

  function normalizePatterns(input) {
    const source = Array.isArray(input) ? input : DEFAULT_IGNORED_QUERY_PATTERNS;
    const out = [];
    source.forEach((item) => {
      const token = typeof item === 'string' ? item.trim().toLowerCase() : '';
      if (!token || out.includes(token)) {
        return;
      }
      out.push(token);
    });
    return out.length ? out : DEFAULT_IGNORED_QUERY_PATTERNS.slice();
  }

  function shouldIgnoreParam(paramName, patterns) {
    const name = typeof paramName === 'string' ? paramName.trim().toLowerCase() : '';
    if (!name) {
      return false;
    }
    const safePatterns = normalizePatterns(patterns);
    return safePatterns.some((pattern) => {
      if (!pattern) {
        return false;
      }
      if (pattern.endsWith('*')) {
        return name.startsWith(pattern.slice(0, -1));
      }
      if (pattern.indexOf('*') === -1 && pattern.endsWith('_')) {
        return name.startsWith(pattern);
      }
      if (pattern.indexOf('*') === -1) {
        return name === pattern;
      }
      const escaped = pattern
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*');
      try {
        return new RegExp(`^${escaped}$`, 'i').test(name);
      } catch (_) {
        return name === pattern;
      }
    });
  }

  function sortQueryEntries(entries) {
    return entries.slice().sort((a, b) => {
      const keyA = a && a.length ? String(a[0]) : '';
      const keyB = b && b.length ? String(b[0]) : '';
      if (keyA !== keyB) {
        return keyA.localeCompare(keyB);
      }
      const valueA = a && a.length > 1 ? String(a[1]) : '';
      const valueB = b && b.length > 1 ? String(b[1]) : '';
      return valueA.localeCompare(valueB);
    });
  }

  function normalizeUrl(rawUrl, { ignoredQueryParams } = {}) {
    const source = typeof rawUrl === 'string' ? rawUrl.trim() : '';
    if (!source) {
      return '';
    }
    const patterns = normalizePatterns(ignoredQueryParams);
    try {
      const parsed = new URL(source);
      const protocol = (parsed.protocol || '').toLowerCase();
      const host = (parsed.host || '').toLowerCase();
      const pathname = parsed.pathname || '/';
      const entries = [];
      parsed.searchParams.forEach((value, key) => {
        if (shouldIgnoreParam(key, patterns)) {
          return;
        }
        entries.push([key, value]);
      });
      const sorted = sortQueryEntries(entries);
      const search = sorted
        .map((pair) => `${encodeURIComponent(pair[0])}=${encodeURIComponent(pair[1])}`)
        .join('&');
      return `${protocol}//${host}${pathname}${search ? `?${search}` : ''}`;
    } catch (_) {
      const noFragment = source.split('#')[0];
      const qIndex = noFragment.indexOf('?');
      if (qIndex < 0) {
        return noFragment;
      }
      const base = noFragment.slice(0, qIndex);
      const queryRaw = noFragment.slice(qIndex + 1);
      const pairs = queryRaw
        .split('&')
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => {
          const eq = item.indexOf('=');
          if (eq < 0) {
            return [decodeURIComponent(item), ''];
          }
          return [
            decodeURIComponent(item.slice(0, eq)),
            decodeURIComponent(item.slice(eq + 1))
          ];
        })
        .filter((pair) => !shouldIgnoreParam(pair[0], patterns));
      const sorted = sortQueryEntries(pairs);
      const search = sorted
        .map((pair) => `${encodeURIComponent(pair[0])}=${encodeURIComponent(pair[1])}`)
        .join('&');
      return `${base}${search ? `?${search}` : ''}`;
    }
  }

  NT.UrlNormalizer = {
    DEFAULT_IGNORED_QUERY_PATTERNS,
    normalizePatterns,
    shouldIgnoreParam,
    normalizeUrl
  };
})(globalThis);
