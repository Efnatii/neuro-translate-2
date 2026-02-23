/**
 * Recursive redaction helper for debug/export payloads.
 */
(function initRedaction(global) {
  const NT = global.NT || (global.NT = {});

  class Redaction {
    static redactDeep(input, rules = {}) {
      const opts = {
        mask: typeof rules.mask === 'string' ? rules.mask : '[REDACTED]',
        maskHeader: typeof rules.maskHeader === 'string' ? rules.maskHeader : '[REDACTED_HEADER]',
        keyPattern: rules.keyPattern instanceof RegExp
          ? rules.keyPattern
          : /(authorization|api[-_]?key|token|cookie|set-cookie|bearer|x-api-key|x-nt-token|proxy[-_]?token|secret|password|session|sess)/i,
        secretPatterns: Array.isArray(rules.secretPatterns)
          ? rules.secretPatterns.filter((pattern) => pattern instanceof RegExp)
          : [
            /sk-[A-Za-z0-9_-]{20,}/g,
            /sess-[A-Za-z0-9_-]{12,}/g,
            /\bBearer\s+[A-Za-z0-9._-]{20,}\b/gi,
            /\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g,
            /\bAIza[0-9A-Za-z_-]{20,}\b/g
          ]
      };
      const seen = new WeakMap();
      const visit = (value, path = [], parentKey = '') => {
        if (value === null || value === undefined) {
          return value;
        }
        if (typeof value === 'string') {
          return Redaction._redactString(value, opts);
        }
        if (typeof value === 'number' || typeof value === 'boolean') {
          return value;
        }
        if (typeof value !== 'object') {
          return String(value);
        }
        if (seen.has(value)) {
          return seen.get(value);
        }
        if (Array.isArray(value)) {
          const outArr = [];
          seen.set(value, outArr);
          value.forEach((item, idx) => {
            outArr.push(visit(item, path.concat([String(idx)]), parentKey));
          });
          return outArr;
        }

        const outObj = {};
        seen.set(value, outObj);
        const inHeadersScope = /(?:^|\.)(headers?|requestHeaders|responseHeaders)$/i.test(path.join('.'));
        Object.keys(value).forEach((key) => {
          const nextPath = path.concat([key]);
          const lowered = String(key || '').toLowerCase();
          const raw = value[key];
          if (opts.keyPattern.test(lowered)) {
            outObj[key] = opts.mask;
            return;
          }
          if (inHeadersScope || /^(authorization|cookie|set-cookie|x-api-key|x-nt-token|proxy-authorization)$/i.test(lowered)) {
            outObj[key] = opts.maskHeader;
            return;
          }
          outObj[key] = visit(raw, nextPath, key);
        });
        return outObj;
      };

      return visit(input, [], '');
    }

    static _redactString(value, opts) {
      let out = String(value || '');
      opts.secretPatterns.forEach((pattern) => {
        out = out.replace(pattern, opts.mask);
      });
      out = out.replace(/(authorization\s*:\s*)([^\s,;]+)/gi, `$1${opts.mask}`);
      out = out.replace(/(cookie\s*:\s*)([^\n]+)/gi, `$1${opts.mask}`);
      out = out.replace(/(set-cookie\s*:\s*)([^\n]+)/gi, `$1${opts.mask}`);
      out = out.replace(/(api[_-]?key\s*[=:]\s*)([^\s,;]+)/gi, `$1${opts.mask}`);
      out = out.replace(/([?&](?:api[_-]?key|token|access[_-]?token|session|sess|key)=)([^&#]+)/gi, `$1${opts.mask}`);
      out = out.replace(/(x-nt-token\s*:\s*)([^\s,;]+)/gi, `$1${opts.mask}`);
      return out;
    }
  }

  NT.Redaction = Redaction;
  NT.redactDeep = function redactDeep(input, rules) {
    return Redaction.redactDeep(input, rules);
  };
})(globalThis);
