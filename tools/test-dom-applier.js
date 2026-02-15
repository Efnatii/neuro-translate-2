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
load('extension/content/dom-applier.js');

const DomApplier = global.NT.DomApplier;
assert(DomApplier, 'DomApplier must be defined');

const nodeA = { textContent: 'Hello' };
const nodeB = { textContent: 'World' };

const blocks = [
  { blockId: 'b0', originalText: 'Hello' },
  { blockId: 'b1', originalText: 'World' }
];
const blockNodes = { b0: nodeA, b1: nodeB };

const applier = new DomApplier();
applier.setBlocks('job-1', blocks, blockNodes);

let result = applier.applyBatch({
  jobId: 'job-1',
  items: [
    { blockId: 'b0', text: 'Privet' },
    { blockId: 'b1', text: 'Mir' }
  ]
});
assert.strictEqual(result.appliedCount, 2, 'First apply should update both nodes');
assert.strictEqual(nodeA.textContent, 'Privet');
assert.strictEqual(nodeB.textContent, 'Mir');

result = applier.applyBatch({
  jobId: 'job-1',
  items: [
    { blockId: 'b0', text: 'Privet' },
    { blockId: 'b1', text: 'Mir' }
  ]
});
assert.strictEqual(result.appliedCount, 0, 'Second apply with same data must be idempotent');

applier.setVisibility(false);
assert.strictEqual(nodeA.textContent, 'Hello');
assert.strictEqual(nodeB.textContent, 'World');
applier.setVisibility(true);
assert.strictEqual(nodeA.textContent, 'Privet');
assert.strictEqual(nodeB.textContent, 'Mir');

const restored = applier.restoreOriginals({ jobId: 'job-1' });
assert.strictEqual(restored.restored >= 1, true, 'Restore must modify at least one node');
assert.strictEqual(nodeA.textContent, 'Hello');
assert.strictEqual(nodeB.textContent, 'World');

console.log('PASS: dom applier');

