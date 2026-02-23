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

function parseToolOutput(output) {
  if (typeof output !== 'string') {
    return output;
  }
  try {
    return JSON.parse(output);
  } catch (_) {
    return null;
  }
}

async function run() {
  global.NT = {};
  load('extension/ai/translation-agent.js');
  load('extension/ai/run-settings.js');
  load('extension/ai/run-settings-validator.js');
  load('extension/ai/tool-manifest.js');
  load('extension/ai/tool-policy.js');
  load('extension/ai/agent-tool-registry.js');

  const TranslationAgent = global.NT.TranslationAgent;
  const RunSettings = global.NT.RunSettings;
  const RunSettingsValidator = global.NT.RunSettingsValidator;
  const ToolManifest = global.NT.ToolManifest;
  const ToolPolicyResolver = global.NT.ToolPolicyResolver;
  const AgentToolRegistry = global.NT.AgentToolRegistry;

  assert(TranslationAgent, 'TranslationAgent must be defined');
  assert(RunSettings, 'RunSettings must be defined');
  assert(RunSettingsValidator, 'RunSettingsValidator must be defined');
  assert(ToolManifest, 'ToolManifest must be defined');
  assert(ToolPolicyResolver, 'ToolPolicyResolver must be defined');
  assert(AgentToolRegistry, 'AgentToolRegistry must be defined');

  const runSettings = new RunSettings();
  const validator = new RunSettingsValidator();

  // 1) RunSettings.diff
  const oldEff = {
    reasoning: { effort: 'medium', summary: 'auto' },
    responses: { parallel_tool_calls: true, truncation: 'auto' }
  };
  const newEff = runSettings.applyPatch(oldEff, {
    reasoning: { effort: 'low' },
    responses: { truncation: 'disabled' }
  });
  const diff = runSettings.diff(oldEff, newEff);
  assert(Array.isArray(diff.changedKeys), 'changedKeys must be array');
  assert(diff.changedKeys.includes('reasoning.effort'), 'diff must include reasoning.effort');
  assert(diff.changedKeys.includes('responses.truncation'), 'diff must include responses.truncation');

  // 2) Validator allowlist
  const allowRes = validator.validateAndNormalize({
    patch: {
      models: {
        userPriority: ['gpt-5:standard']
      }
    },
    context: {
      allowlist: ['gpt-4.1-mini:standard']
    }
  });
  assert(
    Array.isArray(allowRes.errors) && allowRes.errors.some((item) => item && item.code === 'MODEL_NOT_ALLOWED'),
    'validator must reject model outside allowlist'
  );

  // 3) Validator capabilities => tools.proposal normalized to off + warning
  const capRes = validator.validateAndNormalize({
    patch: {
      tools: {
        proposal: {
          'page.apply_delta': 'on'
        }
      }
    },
    context: {
      isToolAllowed: (name) => name !== 'page.apply_delta'
    }
  });
  assert.strictEqual(
    capRes.normalizedPatch.tools.proposal['page.apply_delta'],
    'off',
    'page.apply_delta must be downgraded to off when capability is missing'
  );
  assert(
    capRes.warnings.some((item) => item && item.code === 'missing_capability'),
    'validator must emit missing_capability warning'
  );

  // 4) AutoTune anti-flap
  const manifest = new ToolManifest();
  const resolver = new ToolPolicyResolver({ toolManifest: manifest });
  const registry = new AgentToolRegistry({
    translationAgent: new TranslationAgent({}),
    persistJobState: async () => {},
    toolManifest: manifest,
    toolPolicyResolver: resolver,
    runSettingsHelper: runSettings,
    runSettingsValidator: validator
  });
  const job = {
    id: 'job-autotune-1',
    tabId: 1,
    status: 'running',
    targetLang: 'ru',
    completedBlocks: 0,
    pendingBlockIds: [],
    failedBlockIds: [],
    blocksById: {},
    agentState: {
      reports: [],
      toolExecutionTrace: []
    }
  };
  const settings = {
    translationAgentTuning: {
      autoTuneEnabled: true,
      autoTuneMode: 'auto_apply'
    },
    translationAgentAllowedModels: ['gpt-4.1-mini:standard'],
    effectiveSettings: {
      profile: 'auto',
      effectiveProfile: 'auto',
      agent: {
        agentMode: 'agent',
        toolConfigDefault: {},
        toolConfigUser: {},
        toolConfigEffective: {}
      },
      reasoning: {
        reasoningMode: 'custom',
        reasoningEffort: 'medium',
        reasoningSummary: 'auto'
      },
      caching: {
        promptCacheRetention: 'auto',
        promptCacheKey: null,
        compatCache: true
      },
      models: {
        agentAllowedModels: ['gpt-4.1-mini:standard'],
        modelRoutingMode: 'auto',
        modelUserPriority: [],
        modelProfilePriority: []
      },
      memory: {
        enabled: true,
        maxPages: 200,
        maxBlocks: 5000,
        maxAgeDays: 30,
        gcOnStartup: true,
        ignoredQueryParams: ['utm_*', 'fbclid', 'gclid']
      }
    }
  };

  const p1 = parseToolOutput(await registry.execute({
    name: 'agent.propose_run_settings_patch',
    arguments: JSON.stringify({
      stage: 'execution',
      patch: { reasoning: { effort: 'low' } },
      reason: { short: 'lower effort' }
    }),
    job,
    blocks: [],
    settings,
    callId: 'call-propose-1'
  }));
  assert(p1 && p1.ok === true && p1.proposalId, 'first proposal must be created');

  const a1 = parseToolOutput(await registry.execute({
    name: 'agent.apply_run_settings_proposal',
    arguments: JSON.stringify({
      proposalId: p1.proposalId
    }),
    job,
    blocks: [],
    settings,
    callId: 'call-apply-1'
  }));
  assert(a1 && a1.ok === true, 'first proposal must apply');

  // bypass apply cooldown to test anti-flap specifically
  job.runSettings.autoTune.lastAppliedTs = Date.now() - 60_000;

  const p2 = parseToolOutput(await registry.execute({
    name: 'agent.propose_run_settings_patch',
    arguments: JSON.stringify({
      stage: 'execution',
      patch: { reasoning: { effort: 'medium' } },
      reason: { short: 'restore effort' }
    }),
    job,
    blocks: [],
    settings,
    callId: 'call-propose-2'
  }));
  assert(p2 && p2.ok === true && p2.proposalId, 'second proposal must be created');

  const a2 = parseToolOutput(await registry.execute({
    name: 'agent.apply_run_settings_proposal',
    arguments: JSON.stringify({
      proposalId: p2.proposalId
    }),
    job,
    blocks: [],
    settings,
    callId: 'call-apply-2'
  }));
  assert(a2 && a2.ok === false, 'second apply must be blocked by anti-flap');
  assert.strictEqual(a2.code, 'AUTOTUNE_ANTI_FLAP', 'anti-flap code must be returned');

  // 5) Persist/recompute deterministic effective
  const base = runSettings.computeBaseEffective({
    globalEffectiveSettings: settings.effectiveSettings,
    jobContext: job
  });
  const simulatedStored = {
    userOverrides: {
      responses: { truncation: 'disabled' }
    },
    agentOverrides: {
      reasoning: { effort: 'low' },
      models: {
        routingMode: 'user_priority',
        userPriority: ['gpt-4.1-mini:standard']
      }
    }
  };
  const effectiveBeforeRestart = runSettings.applyPatch(
    runSettings.applyPatch(base, simulatedStored.userOverrides),
    simulatedStored.agentOverrides
  );
  const persisted = JSON.parse(JSON.stringify(simulatedStored));
  const recomputedAfterRestart = runSettings.applyPatch(
    runSettings.applyPatch(base, persisted.userOverrides),
    persisted.agentOverrides
  );
  assert.deepStrictEqual(
    recomputedAfterRestart,
    effectiveBeforeRestart,
    'effective run settings must be deterministic after restart recompute'
  );

  console.log('PASS: autotune run settings');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
