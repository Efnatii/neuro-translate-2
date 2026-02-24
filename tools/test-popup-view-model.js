const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');

function load(context, relativePath) {
  const fullPath = path.join(ROOT, relativePath);
  const code = fs.readFileSync(fullPath, 'utf8');
  vm.runInContext(code, context, { filename: fullPath });
}

function run() {
  const sandbox = {
    console,
    globalThis: null
  };
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  load(context, 'extension/core/nt-namespace.js');
  load(context, 'extension/ui/popup-view-model.js');

  const Vm = context.NT.PopupViewModel;
  assert(Vm, 'PopupViewModel must be available');

  const snapshot = {
    tabId: 77,
    translationProgress: 25,
    translationJob: {
      id: 'job-1',
      status: 'awaiting_categories',
      totalBlocks: 12,
      completedBlocks: 3,
      failedBlocksCount: 1,
      selectedCategories: [],
      availableCategories: ['main_content', 'ui_controls', 'ads'],
      categoryRecommendations: {
        recommended: ['main_content'],
        optional: ['ui_controls'],
        excluded: ['ads']
      },
      categoryQuestion: {
        questionRu: 'Что переводим?',
        options: [
          { id: 'main_content', titleRu: 'Основной контент', countUnits: 9 },
          { id: 'ui_controls', titleRu: 'UI', countUnits: 2 },
          { id: 'ads', titleRu: 'Реклама', countUnits: 1 }
        ]
      },
      runtime: {
        stage: 'awaiting_categories',
        leaseUntilTs: Date.now() + 5000
      },
      classification: {
        summary: {
          countsByCategory: {
            main_content: 9,
            ui_controls: 2,
            ads: 1
          }
        }
      }
    },
    agentState: {
      reports: [{ body: 'Готов к выбору категорий.' }],
      toolExecutionTrace: [{ toolName: 'agent.ui.ask_user_categories', status: 'ok', ts: Date.now() }]
    }
  };

  const vmResult = Vm.computeViewModel(snapshot, { state: 'connected', message: 'ok' });
  assert.strictEqual(vmResult.awaitingCategories, true, 'awaiting_categories should show category section');
  assert.strictEqual(vmResult.progress.done, 3, 'done count should come from job');
  assert.strictEqual(vmResult.progress.failed, 1, 'failed count should come from job');
  assert.strictEqual(vmResult.progress.pending, 8, 'pending should be total-done-failed');

  const categories = vmResult.categories && Array.isArray(vmResult.categories.items)
    ? vmResult.categories.items
    : [];
  const byId = {};
  categories.forEach((item) => {
    byId[item.id] = item;
  });

  assert(byId.main_content && byId.main_content.selected === true, 'recommended should be selected by default');
  assert(byId.ui_controls && byId.ui_controls.selected === false, 'optional should be unselected by default');
  assert(byId.ads && byId.ads.disabled === true, 'excluded should be disabled');

  const nextSnapshot = Vm.applyPatch(
    Vm.cloneJson(snapshot, {}),
    {
      patch: {
        translationJob: {
          status: 'running',
          runtime: { stage: 'translating' },
          completedBlocks: 6,
          failedBlocksCount: 1,
          totalBlocks: 12
        },
        translationProgress: 50
      }
    }
  );

  const vmAfterPatch = Vm.computeViewModel(nextSnapshot, { state: 'connected', message: 'ok' });
  assert.strictEqual(vmAfterPatch.awaitingCategories, false, 'categories section should hide after awaiting stage');
  assert.strictEqual(vmAfterPatch.stage, 'running', 'stage should map translating -> running');
  assert.strictEqual(vmAfterPatch.progress.done, 6, 'progress should update after patch');

  console.log('PASS: popup view model stage/progress/category visibility');
}

try {
  run();
} catch (error) {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
}
