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

function classifyOne(classifier, features, originalText = 'sample text') {
  const out = classifier.classifyBlocks([
    {
      blockId: 'b1',
      originalText,
      pathHint: 'body > div',
      domOrder: 0,
      features
    }
  ], { documentLang: 'en' });
  return out.byBlockId.b1;
}

async function run() {
  global.NT = {};
  load('extension/content/dom-classifier.js');

  const DomClassifier = global.NT && global.NT.DomClassifier;
  assert(DomClassifier, 'DomClassifier must be defined');
  const classifier = new DomClassifier();

  const nav = classifyOne(classifier, {
    tag: 'a',
    role: 'navigation',
    isInNav: true,
    classTokens: ['menu'],
    textLen: 8
  }, 'Home');
  assert.strictEqual(nav.category, 'navigation', 'nav/menu should classify as navigation');

  const h1 = classifyOne(classifier, {
    tag: 'h1',
    classTokens: ['title'],
    textLen: 24
  }, 'Main title');
  assert.strictEqual(h1.category, 'headings', 'H1 should classify as headings');

  const control = classifyOne(classifier, {
    tag: 'button',
    role: 'button',
    isEditable: false,
    classTokens: ['cta'],
    textLen: 4
  }, 'Save');
  assert.strictEqual(control.category, 'ui_controls', 'button/input should classify as ui_controls');

  const table = classifyOne(classifier, {
    tag: 'td',
    hasTableContext: true,
    classTokens: ['cell'],
    textLen: 18
  }, 'Cell value');
  assert.strictEqual(table.category, 'tables', 'table cell should classify as tables');

  const code = classifyOne(classifier, {
    tag: 'code',
    isCodeLike: true,
    classTokens: ['snippet'],
    textLen: 42
  }, 'const x = 1;');
  assert.strictEqual(code.category, 'code', 'pre/code should classify as code');

  const footer = classifyOne(classifier, {
    tag: 'div',
    isInFooter: true,
    classTokens: ['footer', 'copyright'],
    textLen: 36
  }, 'Copyright 2026');
  assert.strictEqual(footer.category, 'footer', 'footer token/context should classify as footer');

  const legal = classifyOne(classifier, {
    tag: 'div',
    classTokens: ['privacy', 'terms'],
    textLen: 48
  }, 'Privacy policy and terms');
  assert.strictEqual(legal.category, 'legal', 'legal tokens should classify as legal');

  const explainable = classifyOne(classifier, {
    tag: 'a',
    classTokens: ['breadcrumb'],
    textLen: 12
  }, 'Section');
  assert.strictEqual(explainable.category, 'navigation', 'breadcrumb token should classify as navigation');
  assert(
    Array.isArray(explainable.reasons) && explainable.reasons.includes('rule:classToken:breadcrumb'),
    'reasons must include matched rule id'
  );

  const hidden = classifyOne(classifier, {
    tag: 'span',
    isHidden: true,
    textLen: 10
  }, 'Hidden');
  assert.strictEqual(hidden.category, 'unknown', 'hidden block should classify as unknown');
  assert(hidden.confidence <= 0.3, 'hidden block should have low confidence');

  console.log('PASS: dom classifier');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
