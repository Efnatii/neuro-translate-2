const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const EXTENSION_DIR = path.join(ROOT, 'extension');

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

function checkSendResponse(files) {
  const issues = [];
  files.forEach((file) => {
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    lines.forEach((line, index) => {
      if (!line.includes('onMessage.addListener')) {
        return;
      }
      const window = lines.slice(index, index + 12).join('\n');
      const hasSendResponse = window.includes('sendResponse');
      const hasReturnTrue = window.includes('return true');
      const hasReturnHandler = window.includes('return handleRuntimeMessage') || window.includes('return handleMessage');
      const hasReturnPromise = window.includes('return Promise');
      if (hasSendResponse && !(hasReturnTrue || hasReturnHandler || hasReturnPromise)) {
        issues.push({ file, line: index + 1 });
      }
    });
  });
  return issues;
}

function checkRequiredSymbols() {
  const checks = [
    {
      file: path.join(EXTENSION_DIR, 'ai', 'llm-engine.js'),
      symbols: ['class LlmEngine', 'global.NT.LlmEngine = LlmEngine']
    },
    {
      file: path.join(EXTENSION_DIR, 'ai', 'llm-client.js'),
      symbols: ['generateResponseRaw(', 'generateMinimalPingRaw(']
    },
    {
      file: path.join(EXTENSION_DIR, 'ai', 'model-rate-limit-store.js'),
      symbols: ['class ModelRateLimitStore', 'upsertFromHeaders(', 'computeAvailability(']
    }
  ];

  const missing = [];
  checks.forEach((check) => {
    const content = fs.existsSync(check.file) ? fs.readFileSync(check.file, 'utf8') : '';
    check.symbols.forEach((symbol) => {
      if (!content.includes(symbol)) {
        missing.push(`${path.relative(ROOT, check.file)} :: ${symbol}`);
      }
    });
  });

  return missing;
}

function checkBgImports() {
  const bgFile = path.join(EXTENSION_DIR, 'bg', 'background.js');
  const content = fs.existsSync(bgFile) ? fs.readFileSync(bgFile, 'utf8') : '';
  const requiredSnippets = ["'/core/nt-namespace.js'", "'/core/message-envelope.js'", "'/ai/llm-engine.js'", "'/ai/llm-client.js'"];
  return requiredSnippets
    .filter((snippet) => !content.includes(snippet))
    .map((snippet) => `${path.relative(ROOT, bgFile)} :: missing importScripts ${snippet}`);
}

function checkPopupScriptPath() {
  const popupHtml = path.join(EXTENSION_DIR, 'ui', 'popup.html');
  const content = fs.existsSync(popupHtml) ? fs.readFileSync(popupHtml, 'utf8') : '';
  if (content.includes('src="/ui/popup.js"') || content.includes('src="ui/popup.js"')) {
    return [];
  }
  return [`${path.relative(ROOT, popupHtml)} :: missing script src for ui/popup.js`];
}

const files = listJsFiles(EXTENSION_DIR);
const issues = checkSendResponse(files);
const missingSymbols = checkRequiredSymbols();
const missingBgImports = checkBgImports();
const missingPopupPath = checkPopupScriptPath();

if (issues.length || missingSymbols.length || missingBgImports.length || missingPopupPath.length) {
  if (issues.length) {
    console.error('Found onMessage listener with sendResponse missing return true:');
    issues.forEach((issue) => {
      console.error(`- ${path.relative(ROOT, issue.file)}:${issue.line}`);
    });
  }

  if (missingSymbols.length) {
    console.error('Missing required symbols:');
    missingSymbols.forEach((entry) => console.error(`- ${entry}`));
  }

  if (missingBgImports.length) {
    console.error('Missing background importScripts entries:');
    missingBgImports.forEach((entry) => console.error(`- ${entry}`));
  }

  if (missingPopupPath.length) {
    console.error('Missing popup script path entries:');
    missingPopupPath.forEach((entry) => console.error(`- ${entry}`));
  }

  process.exit(1);
}

console.log('Smoke check passed: paths and module wiring are valid after refactor.');
