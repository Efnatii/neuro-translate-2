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
global.chrome = {
  runtime: {
    getManifest() {
      return { version: '0.1.0', name: 'Neuro Translate' };
    }
  }
};
load('extension/core/redaction.js');
load('extension/ui/report-exporter.js');

const ReportExporter = global.NT.ReportExporter;
assert(ReportExporter, 'ReportExporter must be defined');

const largeText = 'x'.repeat(4000);
const patchHistory = Array.from({ length: 900 }).map((_, i) => ({
  seq: i + 1,
  ts: Date.now() + i,
  blockId: `b${i % 30}`,
  kind: i % 3 === 0 ? 'delta' : 'final',
  phase: 'execution',
  prev: { textHash: `h${i}`, textPreview: largeText },
  next: { textHash: `h${i + 1}`, textPreview: `${largeText}${i}` },
  meta: { callId: `call-${i}` }
}));

const snapshot = {
  tabId: 1,
  status: { status: 'running' },
  translationJob: {
    id: 'job-export-1',
    tabId: 1,
    status: 'running',
    totalBlocks: 120,
    completedBlocks: 60,
    failedBlocksCount: 0,
    blockSummaries: Array.from({ length: 500 }).map((_, i) => ({
      blockId: `b${i}`,
      category: 'paragraph',
      status: i % 2 === 0 ? 'DONE' : 'PENDING',
      originalLength: 100,
      translatedLength: 120,
      originalSnippet: largeText,
      translatedSnippet: largeText
    }))
  },
  translationProgress: 50,
  failedBlocksCount: 0,
  lastError: null,
  selectedCategories: ['paragraph'],
  availableCategories: ['paragraph', 'heading'],
  recentDiffItems: Array.from({ length: 400 }).map((_, i) => ({
    blockId: `b${i}`,
    category: 'paragraph',
    before: largeText,
    after: largeText
  })),
  settings: {
    userSettings: {},
    effectiveSettings: {},
    overrides: {},
    apiKey: 'sk-SECRET-AAAAABBBBBCCCCCDDDDDEEEEEFFFFF'
  },
  agentState: {
    phase: 'execution',
    reports: Array.from({ length: 300 }).map((_, i) => ({ ts: Date.now() + i, title: 'r', body: largeText })),
    toolExecutionTrace: Array.from({ length: 500 }).map((_, i) => ({ ts: Date.now() + i, tool: 'page.apply_delta', status: 'ok' })),
    patchHistory,
    rateLimitHistory: []
  },
  eventLog: {
    seq: 1000,
    items: Array.from({ length: 600 }).map((_, i) => ({ seq: i + 1, ts: Date.now() + i, level: 'info', tag: 't', message: largeText }))
  }
};

const exporter = new ReportExporter({ doc: { createElement() {}, body: {} }, win: global, chromeApi: global.chrome });
const report = exporter.buildReportJson({
  snapshot,
  includeTextMode: 'full',
  limits: { totalChars: 220000 }
});

assert(report.meta && report.meta.compacted === true, 'Large report must be compacted');
assert(Number(report.meta.totalChars || 0) <= 220000, 'Compacted report must respect total char limit');
assert(JSON.stringify(report).indexOf('sk-SECRET') === -1, 'Secrets must be redacted');

console.log('PASS: report exporter compaction');
