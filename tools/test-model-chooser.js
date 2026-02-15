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
load('extension/ai/model-chooser.js');

const ModelChooser = global.NT.ModelChooser;
assert(ModelChooser, 'ModelChooser must be defined');

const prepared = [
  {
    modelSpec: 'model-a',
    availability: { ok: true },
    latencyMs: 600,
    tps: 20,
    capabilityRank: 70,
    cost: 2.5,
    limitRiskPenalty: 0.5,
    usagePenalty: 0.1
  },
  {
    modelSpec: 'model-b',
    availability: { ok: true },
    latencyMs: 550,
    tps: 30,
    capabilityRank: 68,
    cost: 2.2,
    limitRiskPenalty: 0.2,
    usagePenalty: 0.05
  }
];

const result1 = ModelChooser.choose({
  prepared,
  selection: { speed: true, preference: null },
  hintPrevModelSpec: null
});
const result2 = ModelChooser.choose({
  prepared,
  selection: { speed: true, preference: null },
  hintPrevModelSpec: null
});

assert(result1 && result1.chosen, 'Chooser must return chosen candidate');
assert.strictEqual(result1.chosen.modelSpec, result2.chosen.modelSpec, 'Chooser must be deterministic');
assert.strictEqual(result1.chosen.modelSpec, 'model-b', 'Expected highest score winner');

const sticky = ModelChooser.choose({
  prepared,
  selection: { speed: true, preference: null },
  hintPrevModelSpec: 'model-a'
});
assert(sticky && sticky.chosen, 'Chooser must return candidate with hint');

console.log('PASS: model chooser');

