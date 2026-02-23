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

async function run() {
  global.NT = {};
  load('extension/core/dom-signature.js');

  const domSig = global.NT && global.NT.DomSignature;
  assert(domSig && typeof domSig.buildDomSignature === 'function', 'DomSignature must be available');

  const blocksA = [
    { blockId: 'b1', category: 'heading', pathHint: 'h1.main', stableNodeKey: 'n1', originalText: 'Title One', charCount: 9 },
    { blockId: 'b2', category: 'paragraph', pathHint: 'p.intro', stableNodeKey: 'n2', originalText: 'Hello world here', charCount: 16 },
    { blockId: 'b3', category: 'button', pathHint: '.cta', stableNodeKey: 'n3', originalText: 'Open', charCount: 4 }
  ];
  const blocksB = [
    { blockId: 'b1', category: 'heading', pathHint: 'h1.main', stableNodeKey: 'n1', originalText: 'Another title', charCount: 12 },
    { blockId: 'b2', category: 'paragraph', pathHint: 'p.intro', stableNodeKey: 'n2', originalText: 'Different paragraph text', charCount: 24 },
    { blockId: 'b3', category: 'button', pathHint: '.cta', stableNodeKey: 'n3', originalText: 'Click', charCount: 5 }
  ];
  const blocksReordered = [
    blocksA[1],
    blocksA[0],
    blocksA[2]
  ];

  const sigA = await domSig.buildDomSignature(blocksA);
  const sigB = await domSig.buildDomSignature(blocksB);
  const sigReordered = await domSig.buildDomSignature(blocksReordered);

  assert(sigA && typeof sigA.domHash === 'string', 'Signature A hash expected');
  assert(sigB && typeof sigB.domHash === 'string', 'Signature B hash expected');
  assert(sigReordered && typeof sigReordered.domHash === 'string', 'Signature reordered hash expected');

  assert.strictEqual(
    sigA.domHash,
    sigB.domHash,
    'Same structural block layout must produce identical domHash even with minor text changes'
  );
  assert.notStrictEqual(
    sigA.domHash,
    sigReordered.domHash,
    'Reordered DOM blocks must produce different domHash'
  );

  console.log('PASS: dom signature/hash');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
