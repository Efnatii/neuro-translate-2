const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FILES = [
  path.join(ROOT, 'extension', 'ui', 'popup.html'),
  path.join(ROOT, 'extension', 'ui', 'debug.html'),
  path.join(ROOT, 'extension', 'offscreen', 'offscreen.html')
];

const FORBIDDEN_PATTERNS = [
  /(src|href)\s*=\s*["']\/core\//g,
  /(src|href)\s*=\s*["']\/ui\//g,
  /(src|href)\s*=\s*["']\/offscreen\//g
];

const violations = [];

FILES.forEach((filePath) => {
  if (!fs.existsSync(filePath)) {
    violations.push(`${path.relative(ROOT, filePath)} :: missing file`);
    return;
  }
  const content = fs.readFileSync(filePath, 'utf8');
  FORBIDDEN_PATTERNS.forEach((pattern) => {
    const matches = content.match(pattern);
    if (matches && matches.length) {
      matches.forEach((match) => {
        violations.push(`${path.relative(ROOT, filePath)} :: forbidden root-absolute path ${match}`);
      });
    }
  });
});

if (violations.length) {
  console.error('Path regression check failed:');
  violations.forEach((item) => console.error(`- ${item}`));
  process.exit(1);
}

console.log('PASS: no root-absolute /core, /ui, /offscreen paths in UI/offscreen HTML.');

