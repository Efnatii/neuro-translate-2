(function initAiCommon(global) {
  const NT = global.NT || (global.NT = {});

  const ModelTier = Object.freeze({
    FLEX: 'flex',
    STANDARD: 'standard',
    PRIORITY: 'priority'
  });

  function normalizeTier(tier) {
    const value = String(tier || '').trim().toLowerCase();

    if (value === ModelTier.FLEX) {
      return ModelTier.FLEX;
    }

    if (value === ModelTier.PRIORITY) {
      return ModelTier.PRIORITY;
    }

    return ModelTier.STANDARD;
  }

  function parseModelSpec(spec) {
    if (typeof spec !== 'string') {
      return { id: '', tier: ModelTier.STANDARD };
    }

    const [idPart, tierPart] = spec.split(':');
    return {
      id: (idPart || '').trim(),
      tier: normalizeTier(tierPart)
    };
  }

  function formatModelSpec(id, tier) {
    return `${id}:${normalizeTier(tier)}`;
  }

  function mapServiceTier(tier) {
    const normalized = normalizeTier(tier);
    if (normalized === ModelTier.FLEX) {
      return 'flex';
    }
    if (normalized === ModelTier.PRIORITY) {
      return 'priority';
    }
    return 'default';
  }

  function buildRegistryEntry({ id, tier, inputPrice, outputPrice, cachedInputPrice }) {
    const inputValue = typeof inputPrice === 'number' ? inputPrice : null;
    const outputValue = typeof outputPrice === 'number' ? outputPrice : null;
    const CapabilityRank = NT.CapabilityRank || null;
    const capabilityRank = CapabilityRank ? CapabilityRank.rank(id) : 0;
    const specialized = CapabilityRank ? CapabilityRank.isDeepResearch(id) : false;

    return {
      id,
      tier,
      family: resolveFamily(id),
      specialized,
      notes: resolveNotes(id, { specialized }),
      capabilityRank,
      inputPrice: inputValue,
      outputPrice: outputValue,
      cachedInputPrice: cachedInputPrice ?? null,
      sum_1M: inputValue !== null && outputValue !== null ? inputValue + outputValue : null
    };
  }

  function createModelRegistry() {
    const models = [
      { id: 'gpt-5.2', tier: ModelTier.FLEX, inputPrice: 0.875, outputPrice: 7.0, cachedInputPrice: 0.0875 },
      { id: 'gpt-5.1', tier: ModelTier.FLEX, inputPrice: 0.625, outputPrice: 5.0, cachedInputPrice: 0.0625 },
      { id: 'gpt-5', tier: ModelTier.FLEX, inputPrice: 0.625, outputPrice: 5.0, cachedInputPrice: 0.0625 },
      { id: 'gpt-5-mini', tier: ModelTier.FLEX, inputPrice: 0.125, outputPrice: 1.0, cachedInputPrice: 0.0125 },
      { id: 'gpt-5-nano', tier: ModelTier.FLEX, inputPrice: 0.025, outputPrice: 0.2, cachedInputPrice: 0.0025 },
      { id: 'o3', tier: ModelTier.FLEX, inputPrice: 1.0, outputPrice: 4.0, cachedInputPrice: 0.25 },
      { id: 'o4-mini', tier: ModelTier.FLEX, inputPrice: 0.55, outputPrice: 2.2, cachedInputPrice: 0.138 },
      { id: 'gpt-5.2', tier: ModelTier.STANDARD, inputPrice: 1.75, outputPrice: 14.0, cachedInputPrice: 0.175 },
      { id: 'gpt-5.1', tier: ModelTier.STANDARD, inputPrice: 1.25, outputPrice: 10.0, cachedInputPrice: 0.125 },
      { id: 'gpt-5', tier: ModelTier.STANDARD, inputPrice: 1.25, outputPrice: 10.0, cachedInputPrice: 0.125 },
      { id: 'gpt-5-mini', tier: ModelTier.STANDARD, inputPrice: 0.25, outputPrice: 2.0, cachedInputPrice: 0.025 },
      { id: 'gpt-5-nano', tier: ModelTier.STANDARD, inputPrice: 0.05, outputPrice: 0.4, cachedInputPrice: 0.005 },
      { id: 'gpt-5.2-chat-latest', tier: ModelTier.STANDARD, inputPrice: 1.75, outputPrice: 14.0, cachedInputPrice: 0.175 },
      { id: 'gpt-5.1-chat-latest', tier: ModelTier.STANDARD, inputPrice: 1.25, outputPrice: 10.0, cachedInputPrice: 0.125 },
      { id: 'gpt-5-chat-latest', tier: ModelTier.STANDARD, inputPrice: 1.25, outputPrice: 10.0, cachedInputPrice: 0.125 },
      { id: 'gpt-5.2-pro', tier: ModelTier.STANDARD, inputPrice: 21.0, outputPrice: 168.0, cachedInputPrice: null },
      { id: 'gpt-5-pro', tier: ModelTier.STANDARD, inputPrice: 15.0, outputPrice: 120.0, cachedInputPrice: null },
      { id: 'gpt-4.1', tier: ModelTier.STANDARD, inputPrice: 2.0, outputPrice: 8.0, cachedInputPrice: 0.5 },
      { id: 'gpt-4.1-mini', tier: ModelTier.STANDARD, inputPrice: 0.4, outputPrice: 1.6, cachedInputPrice: 0.1 },
      { id: 'gpt-4.1-nano', tier: ModelTier.STANDARD, inputPrice: 0.1, outputPrice: 0.4, cachedInputPrice: 0.025 },
      { id: 'gpt-4o', tier: ModelTier.STANDARD, inputPrice: 2.5, outputPrice: 10.0, cachedInputPrice: 1.25 },
      { id: 'gpt-4o-2024-05-13', tier: ModelTier.STANDARD, inputPrice: 5.0, outputPrice: 15.0, cachedInputPrice: null },
      { id: 'gpt-4o-mini', tier: ModelTier.STANDARD, inputPrice: 0.15, outputPrice: 0.6, cachedInputPrice: 0.075 },
      { id: 'o1', tier: ModelTier.STANDARD, inputPrice: 15.0, outputPrice: 60.0, cachedInputPrice: 7.5 },
      { id: 'o1-pro', tier: ModelTier.STANDARD, inputPrice: 150.0, outputPrice: 600.0, cachedInputPrice: null },
      { id: 'o3-pro', tier: ModelTier.STANDARD, inputPrice: 20.0, outputPrice: 80.0, cachedInputPrice: null },
      { id: 'o3', tier: ModelTier.STANDARD, inputPrice: 2.0, outputPrice: 8.0, cachedInputPrice: 0.5 },
      { id: 'o3-deep-research', tier: ModelTier.STANDARD, inputPrice: 10.0, outputPrice: 40.0, cachedInputPrice: 2.5 },
      { id: 'o4-mini', tier: ModelTier.STANDARD, inputPrice: 1.1, outputPrice: 4.4, cachedInputPrice: 0.275 },
      { id: 'o4-mini-deep-research', tier: ModelTier.STANDARD, inputPrice: 2.0, outputPrice: 8.0, cachedInputPrice: 0.5 },
      { id: 'o3-mini', tier: ModelTier.STANDARD, inputPrice: 1.1, outputPrice: 4.4, cachedInputPrice: 0.55 },
      { id: 'o1-mini', tier: ModelTier.STANDARD, inputPrice: 1.1, outputPrice: 4.4, cachedInputPrice: 0.55 },
      { id: 'gpt-5.2', tier: ModelTier.PRIORITY, inputPrice: 3.5, outputPrice: 28.0, cachedInputPrice: 0.35 },
      { id: 'gpt-5.1', tier: ModelTier.PRIORITY, inputPrice: 2.5, outputPrice: 20.0, cachedInputPrice: 0.25 },
      { id: 'gpt-5', tier: ModelTier.PRIORITY, inputPrice: 2.5, outputPrice: 20.0, cachedInputPrice: 0.25 },
      { id: 'gpt-5-mini', tier: ModelTier.PRIORITY, inputPrice: 0.45, outputPrice: 3.6, cachedInputPrice: 0.045 },
      { id: 'gpt-4.1', tier: ModelTier.PRIORITY, inputPrice: 3.5, outputPrice: 14.0, cachedInputPrice: 0.875 },
      { id: 'gpt-4.1-mini', tier: ModelTier.PRIORITY, inputPrice: 0.7, outputPrice: 2.8, cachedInputPrice: 0.175 },
      { id: 'gpt-4.1-nano', tier: ModelTier.PRIORITY, inputPrice: 0.2, outputPrice: 0.8, cachedInputPrice: 0.05 },
      { id: 'gpt-4o', tier: ModelTier.PRIORITY, inputPrice: 4.25, outputPrice: 17.0, cachedInputPrice: 2.125 },
      { id: 'gpt-4o-2024-05-13', tier: ModelTier.PRIORITY, inputPrice: 8.75, outputPrice: 26.25, cachedInputPrice: null },
      { id: 'gpt-4o-mini', tier: ModelTier.PRIORITY, inputPrice: 0.25, outputPrice: 1.0, cachedInputPrice: 0.125 },
      { id: 'o3', tier: ModelTier.PRIORITY, inputPrice: 3.5, outputPrice: 14.0, cachedInputPrice: 0.875 },
      { id: 'o4-mini', tier: ModelTier.PRIORITY, inputPrice: 2.0, outputPrice: 8.0, cachedInputPrice: 0.5 }
    ];

    const entries = models.map(buildRegistryEntry);
    const byKey = {};

    entries.forEach((entry) => {
      const key = formatModelSpec(entry.id, entry.tier);
      byKey[key] = entry;
    });

    return {
      entries,
      byKey
    };
  }

  function resolveFamily(id) {
    const normalized = String(id || '').toLowerCase();
    if (normalized.startsWith('gpt')) {
      return 'gpt';
    }
    if (normalized.startsWith('o')) {
      return 'o';
    }
    return 'gpt';
  }

  function resolveNotes(id, { specialized }) {
    const notes = [];
    const CapabilityRank = NT.CapabilityRank || null;
    const normalized = String(id || '').toLowerCase();

    if (normalized.startsWith('gpt-5.2')) {
      notes.push('flagship');
    }

    if (CapabilityRank) {
      if (CapabilityRank.isPro(id)) {
        notes.push('pro');
      }
      if (CapabilityRank.isMini(id)) {
        notes.push('mini');
      }
      if (CapabilityRank.isNano(id)) {
        notes.push('nano');
      }
      if (CapabilityRank.isChatLatest(id)) {
        notes.push('chat-latest');
      }
    }

    if (normalized.startsWith('o')) {
      notes.push('reasoning');
    }

    if (specialized) {
      notes.push('deep-research');
    }

    return notes.join(', ');
  }

  function buildModelOptions(registry) {
    return registry.entries.map((entry) => ({
      value: formatModelSpec(entry.id, entry.tier),
      label: `${entry.id} (${entry.tier.toUpperCase()})`,
      tier: entry.tier,
      tierLabel: entry.tier.toUpperCase(),
      inputPrice: entry.inputPrice,
      outputPrice: entry.outputPrice,
      cachedInputPrice: entry.cachedInputPrice,
      sum_1M: entry.sum_1M
    }));
  }

  NT.AiCommon = {
    ModelTier,
    parseModelSpec,
    formatModelSpec,
    mapServiceTier,
    createModelRegistry,
    buildModelOptions
  };
})(globalThis);
