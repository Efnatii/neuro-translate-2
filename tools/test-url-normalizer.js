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

function run() {
  global.NT = {};
  load('extension/core/url-normalizer.js');

  const normalizer = global.NT && global.NT.UrlNormalizer;
  assert(normalizer && typeof normalizer.normalizeUrl === 'function', 'UrlNormalizer must be available');

  const normalized = normalizer.normalizeUrl('HTTPS://Example.COM/path?utm_source=abc&b=2&a=1#fragment');
  assert.strictEqual(
    normalized,
    'https://example.com/path?a=1&b=2',
    'Must lower-case host and remove utm_* + fragment'
  );

  const withClickIds = normalizer.normalizeUrl('https://example.com/p?fbclid=123&gclid=456&q=ok');
  assert.strictEqual(
    withClickIds,
    'https://example.com/p?q=ok',
    'Must remove fbclid/gclid by default'
  );

  const customIgnored = normalizer.normalizeUrl('https://example.com/p?ref=1&x=2', {
    ignoredQueryParams: ['ref']
  });
  assert.strictEqual(
    customIgnored,
    'https://example.com/p?x=2',
    'Must support custom ignored query params'
  );

  console.log('PASS: url normalizer');
}

try {
  run();
} catch (error) {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
}
