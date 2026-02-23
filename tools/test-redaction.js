const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');

function load(relativePath) {
  const fullPath = path.join(ROOT, relativePath);
  const code = fs.readFileSync(fullPath, 'utf8');
  vm.runInThisContext(code, { filename: fullPath });
}

global.NT = {};
load('extension/core/redaction.js');

const redactDeep = global.NT.redactDeep;
assert(typeof redactDeep === 'function', 'redactDeep must be defined');

const input = {
  headers: {
    Authorization: 'Bearer sk-1234567890ABCDEFGHIJKLmnopqrst',
    'x-api-key': 'live_key_12345678901234567890',
    cookie: 'sid=abcdef'
  },
  payload: {
    apiKey: 'sk-abcdef1234567890ABCDE1234567890',
    nestedToken: 'token-value-123',
    safe: 'hello world'
  },
  text: 'debug body sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA and Bearer veryLongSensitiveBearerToken1234567890',
  url: 'https://example.test/path?token=abc123&key=xyz789&safe=ok',
  sessionLike: 'sess-1234567890ABCDEABCDE',
  responseHeaders: {
    etag: 'abc',
    'set-cookie': 'foo=bar'
  }
};

const out = redactDeep(input);
assert(out.headers.Authorization === '[REDACTED]', 'Authorization must be redacted by key');
assert(out.headers['x-api-key'] === '[REDACTED]', 'x-api-key must be redacted by key');
assert(out.payload.apiKey === '[REDACTED]', 'apiKey must be redacted by key');
assert(out.payload.nestedToken === '[REDACTED]', 'token-like keys must be redacted');
assert(!String(out.text || '').includes('sk-AAAA'), 'Secret patterns in strings must be redacted');
assert(!String(out.text || '').toLowerCase().includes('bearer verylong'), 'Bearer token patterns in strings must be redacted');
assert(String(out.url || '').includes('token=[REDACTED]'), 'Query token param must be redacted');
assert(String(out.url || '').includes('key=[REDACTED]'), 'Query key param must be redacted');
assert(!String(out.sessionLike || '').includes('sess-'), 'Session-like token patterns in strings must be redacted');
assert(out.responseHeaders.etag === '[REDACTED_HEADER]', 'raw response headers must be masked');

console.log('PASS: redaction');
