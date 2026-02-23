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
load('extension/content/diff-highlighter.js');

const DiffHighlighter = global.NT.DiffHighlighter;
assert(DiffHighlighter, 'DiffHighlighter must be defined');

const highlighter = new DiffHighlighter();
const original = 'Hello world';
const translated = 'Hello <script>alert(1)</script> world';
const result = highlighter.buildDiff(original, translated);

assert(result && typeof result.html === 'string', 'buildDiff must return html');
assert(result.html.includes('<mark class="nt-diff-ins">'), 'Inserted/replaced fragment must be wrapped in mark');
assert(!result.html.includes('<script>'), 'Unsafe html from translated text must not be emitted as raw HTML');
assert(result.html.includes('&lt;script&gt;'), 'Escaped HTML should be preserved safely');
assert(result.stats && result.stats.compared === true, 'Diff stats should indicate compared=true');

console.log('PASS: diff highlighter');
