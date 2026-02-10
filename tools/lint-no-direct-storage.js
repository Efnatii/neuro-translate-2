const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const EXTENSION_DIR = path.join(ROOT, 'extension');

const PATTERNS = [
  'chrome.storage.local.get',
  'chrome.storage.local.set',
  'chromeApi.storage.local.get',
  'chromeApi.storage.local.set'
];

const FORBIDDEN_SNIPPETS = [
  'get(null'
];

const ALLOWED = new Set([
  'extension/core/chrome-local-store-base.js',
  'extension/core/settings-store.js',
  'extension/bg/event-log-store.js',
  'extension/bg/tab-state-store.js',
  'extension/ai/model-benchmark-store.js',
  'extension/ai/model-rate-limit-store.js',
  'extension/ai/llm-client.js'
]);

function listJsFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  entries.forEach((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listJsFiles(fullPath));
      return;
    }
    if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(fullPath);
    }
  });
  return files;
}

const violations = [];
listJsFiles(EXTENSION_DIR).forEach((file) => {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  if (ALLOWED.has(rel)) {
    return;
  }

  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    PATTERNS.forEach((pattern) => {
      if (line.includes(pattern)) {
        violations.push(`${rel}:${index + 1} -> ${pattern}`);
      }
    });
    FORBIDDEN_SNIPPETS.forEach((snippet) => {
      if (line.includes(snippet)) {
        violations.push(`${rel}:${index + 1} -> forbidden snippet: ${snippet}`);
      }
    });
  });
});

if (violations.length) {
  console.error('Direct storage access is forbidden outside whitelisted store files:');
  violations.forEach((entry) => console.error(`- ${entry}`));
  process.exit(1);
}

console.log('PASS: no direct storage access outside whitelisted store files.');
