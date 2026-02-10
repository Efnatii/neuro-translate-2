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

const files = listJsFiles(EXTENSION_DIR);
const issues = checkSendResponse(files);

if (issues.length) {
  console.error('Found onMessage listener with sendResponse missing return true:');
  issues.forEach((issue) => {
    console.error(`- ${path.relative(ROOT, issue.file)}:${issue.line}`);
  });
  process.exit(1);
}

console.log('Smoke check passed: no sendResponse without return true detected.');
