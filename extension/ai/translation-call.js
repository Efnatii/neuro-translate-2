/**
 * Thin translation wrapper over background LLM request execution.
 *
 * The call accepts block arrays and returns normalized translated items in
 * deterministic order.
 */
(function initTranslationCall(global) {
  const NT = global.NT || (global.NT = {});

  class TranslationCall {
    constructor({ runLlmRequest } = {}) {
      this.runLlmRequest = typeof runLlmRequest === 'function' ? runLlmRequest : null;
      this.responseCache = new Map();
      this.CACHE_TTL_MS = 15 * 60 * 1000;
      this.MAX_CACHE_ENTRIES = 200;
    }

    async translateBatch(inputBlocks, {
      tabId,
      jobId,
      batchId,
      targetLang = 'ru',
      attempt = 1,
      agentContext = null,
      signal = null,
      cacheEnabled = true
    } = {}) {
      if (!this.runLlmRequest) {
        throw new Error('TRANSLATION_CALL_UNAVAILABLE');
      }
      const blocks = Array.isArray(inputBlocks) ? inputBlocks.filter((item) => item && item.blockId) : [];
      if (!blocks.length) {
        return { items: [] };
      }

      const prompt = this._buildPrompt(blocks, targetLang, agentContext);
      const requestInput = this._buildRequestInput(prompt, agentContext);
      const agentRoute = this._resolveAgentRoute(agentContext);
      const requestCacheEnabled = cacheEnabled !== false;
      const cacheKey = requestCacheEnabled
        ? this._buildCacheKey({
          prompt,
          targetLang,
          agentContext,
          agentRoute
        })
        : null;
      if (requestCacheEnabled && cacheKey) {
        const cached = this._getCached(cacheKey);
        if (cached) {
          return cached;
        }
      }
      const agentProfile = agentContext && typeof agentContext.profile === 'string'
        ? agentContext.profile
        : null;
      const rawJson = await this.runLlmRequest({
        tabId,
        taskType: 'translation_batch',
        request: {
          input: requestInput,
          maxOutputTokens: 2200,
          temperature: 0,
          store: false,
          background: false,
          signal,
          attempt,
          jobId,
          blockId: batchId,
          hintBatchSize: blocks.length,
          agentRoute,
          agentProfile
        }
      });

      const parsedPayload = this._parsePayload(rawJson);
      const parsed = parsedPayload.items;
      const map = {};
      parsed.forEach((item) => {
        if (item && item.blockId && typeof item.text === 'string') {
          const key = String(item.blockId);
          if (key) {
            map[key] = item.text;
          }
        }
      });

      const items = blocks.map((block) => ({
        blockId: block.blockId,
        text: Object.prototype.hasOwnProperty.call(map, block.blockId)
          ? map[block.blockId]
          : block.originalText
      }));
      const report = this._normalizeReport(parsedPayload.report, {
        items,
        blocks,
        reportFormat: agentContext && agentContext.reportFormat ? agentContext.reportFormat : null,
        ntMeta: rawJson && rawJson.__nt && typeof rawJson.__nt === 'object' ? rawJson.__nt : null
      });
      const responsePayload = {
        items,
        rawJson,
        report
      };
      if (requestCacheEnabled && cacheKey) {
        this._setCached(cacheKey, responsePayload);
      }

      return responsePayload;
    }

    _buildPrompt(blocks, targetLang, agentContext) {
      const payload = blocks.map((block) => ({
        blockId: block.blockId,
        text: block.originalText,
        category: block.category || null,
        pathHint: block.pathHint || null
      }));
      const context = agentContext && typeof agentContext === 'object' ? agentContext : null;
      const glossary = context && Array.isArray(context.glossary) ? context.glossary : [];
      const glossaryText = glossary.length
        ? glossary
          .slice(0, 24)
          .map((item) => `${item.term}:${item.hint || 'n/a'}`)
          .join(', ')
        : 'none';
      const batchGuidance = context && typeof context.batchGuidance === 'string' && context.batchGuidance
        ? context.batchGuidance
        : 'Translate accurately while preserving meaning.';
      const contextSummary = context && typeof context.contextSummary === 'string'
        ? context.contextSummary
        : '';
      const reportDigest = context && typeof context.reportDigest === 'string'
        ? context.reportDigest
        : '';
      const selectedCategories = context && Array.isArray(context.selectedCategories)
        ? context.selectedCategories.join(', ')
        : '';
      const style = context && typeof context.style === 'string' && context.style ? context.style : 'balanced';
      return [
        `Translate every item to ${targetLang}.`,
        `Style: ${style}.`,
        `Instructions: ${batchGuidance}`,
        `Selected categories: ${selectedCategories || 'all'}`,
        `Glossary: ${glossaryText}`,
        `Context summary: ${contextSummary || 'n/a'}`,
        `Recent report digest: ${reportDigest || 'n/a'}`,
        'Return ONLY valid JSON object:',
        '{',
        '  "items": [{ "blockId": "...", "text": "..." }],',
        '  "report": {',
        '    "summary": "short status summary",',
        '    "quality": "ok|needs_review",',
        '    "notes": ["optional note"]',
        '  }',
        '}',
        'Notes:',
        '- Keep blockId unchanged and include all input blocks.',
        '- If uncertain, set quality="needs_review" and add concise notes.',
        '- Keep report summary short and actionable.',
        '- Do not include markdown fences.',
        JSON.stringify(payload)
      ].join('\n');
    }

    _buildRequestInput(prompt, agentContext) {
      const userPrompt = typeof prompt === 'string' ? prompt : '';
      const context = agentContext && typeof agentContext === 'object' ? agentContext : null;
      const systemPrompt = context && typeof context.systemPrompt === 'string' && context.systemPrompt.trim()
        ? context.systemPrompt.trim()
        : '';
      const userMessage = {
        role: 'user',
        content: [{ type: 'input_text', text: userPrompt }]
      };
      if (!systemPrompt) {
        return [userMessage];
      }
      return [
        {
          role: 'system',
          content: [{ type: 'input_text', text: systemPrompt }]
        },
        userMessage
      ];
    }

    _parsePayload(rawJson) {
      const payload = { items: [], report: null };
      if (!rawJson || typeof rawJson !== 'object') {
        return payload;
      }
      const outputText = this._extractOutputText(rawJson);
      if (!outputText) {
        return payload;
      }
      try {
        const parsed = JSON.parse(outputText);
        return this._normalizeParsedPayload(parsed, payload);
      } catch (_) {
        const fenced = outputText.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (!fenced || !fenced[1]) {
          return payload;
        }
        try {
          const parsed = JSON.parse(fenced[1].trim());
          return this._normalizeParsedPayload(parsed, payload);
        } catch (_) {
          return payload;
        }
      }
    }

    _normalizeParsedPayload(parsed, fallback) {
      const out = fallback && typeof fallback === 'object'
        ? fallback
        : { items: [], report: null };
      if (Array.isArray(parsed)) {
        out.items = this._normalizeItems(parsed);
        return out;
      }
      if (!parsed || typeof parsed !== 'object') {
        return out;
      }
      out.items = this._normalizeItems(Array.isArray(parsed.items) ? parsed.items : []);
      out.report = parsed.report && typeof parsed.report === 'object'
        ? parsed.report
        : null;
      return out;
    }

    _normalizeItems(items) {
      const seen = new Set();
      return (Array.isArray(items) ? items : [])
        .map((item) => {
          if (!item || typeof item !== 'object' || !item.blockId) {
            return null;
          }
          const blockId = String(item.blockId || '').trim();
          if (!blockId || seen.has(blockId)) {
            return null;
          }
          const rawText = typeof item.text === 'string'
            ? item.text
            : (typeof item.translation === 'string' ? item.translation : (typeof item.translatedText === 'string' ? item.translatedText : ''));
          seen.add(blockId);
          return {
            blockId,
            text: String(rawText || '')
          };
        })
        .filter(Boolean);
    }

    _normalizeReport(rawReport, { items, blocks, reportFormat, ntMeta } = {}) {
      const parsed = rawReport && typeof rawReport === 'object' ? rawReport : {};
      const translatedCount = Array.isArray(items) ? items.length : 0;
      const sourceCount = Array.isArray(blocks) ? blocks.length : translatedCount;
      const missing = Math.max(0, sourceCount - translatedCount);

      const summaryRaw = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
      const summary = summaryRaw
        ? summaryRaw.slice(0, 300)
        : `Batch translated ${translatedCount}/${sourceCount} blocks${missing > 0 ? `, fallback ${missing}` : ''}.`;

      const qualityRaw = typeof parsed.quality === 'string' ? parsed.quality.trim().toLowerCase() : '';
      const quality = this._normalizeQuality(qualityRaw, { missing });
      const notesSource = Array.isArray(parsed.notes)
        ? parsed.notes
        : (typeof parsed.notes === 'string' && parsed.notes ? [parsed.notes] : []);
      const notes = notesSource
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .slice(0, 8)
        .map((item) => item.slice(0, 220));

      const normalized = {
        summary,
        quality,
        notes,
        meta: this._normalizeReportMeta(ntMeta)
      };
      if (reportFormat && typeof reportFormat === 'object') {
        normalized.format = reportFormat;
      }
      return normalized;
    }

    _normalizeReportMeta(ntMeta) {
      const raw = ntMeta && typeof ntMeta === 'object' ? ntMeta : {};
      const meta = { cached: false };
      if (typeof raw.chosenModelSpec === 'string' && raw.chosenModelSpec) {
        meta.chosenModelSpec = raw.chosenModelSpec;
      }
      if (typeof raw.policy === 'string' && raw.policy) {
        meta.policy = raw.policy;
      }
      if (typeof raw.reason === 'string' && raw.reason) {
        meta.reason = raw.reason;
      }
      if (typeof raw.requestId === 'string' && raw.requestId) {
        meta.requestId = raw.requestId;
      }
      if (typeof raw.taskType === 'string' && raw.taskType) {
        meta.taskType = raw.taskType;
      }
      if (Number.isFinite(Number(raw.attempt))) {
        meta.attempt = Number(raw.attempt);
      }
      const usage = this._normalizeUsageMeta(raw.usage);
      if (usage) {
        meta.usage = usage;
      }
      const rate = this._normalizeRateMeta(raw.rate);
      if (rate) {
        meta.rate = rate;
      }
      if (raw.requestOptions && typeof raw.requestOptions === 'object') {
        meta.requestOptions = this._sanitizeRequestOptionsMeta(raw.requestOptions);
      }
      return meta;
    }

    _sanitizeRequestOptionsMeta(rawOptions) {
      const src = rawOptions && typeof rawOptions === 'object' ? rawOptions : {};
      const out = {};
      if (src.reasoning && typeof src.reasoning === 'object') {
        out.reasoning = {
          effort: src.reasoning.effort || null,
          summary: src.reasoning.summary || null
        };
      }
      if (Object.prototype.hasOwnProperty.call(src, 'prompt_cache_retention')) {
        out.prompt_cache_retention = src.prompt_cache_retention || null;
      }
      if (Object.prototype.hasOwnProperty.call(src, 'prompt_cache_key')) {
        out.prompt_cache_key = src.prompt_cache_key || null;
      }
      if (Object.prototype.hasOwnProperty.call(src, 'tool_choice')) {
        out.tool_choice = src.tool_choice || null;
      }
      if (Object.prototype.hasOwnProperty.call(src, 'parallel_tool_calls')) {
        out.parallel_tool_calls = src.parallel_tool_calls;
      }
      if (Object.prototype.hasOwnProperty.call(src, 'max_tool_calls')) {
        out.max_tool_calls = src.max_tool_calls;
      }
      return out;
    }

    _normalizeUsageMeta(rawUsage) {
      if (!rawUsage || typeof rawUsage !== 'object') {
        return null;
      }
      const pickNumber = (...keys) => {
        for (let i = 0; i < keys.length; i += 1) {
          const value = rawUsage[keys[i]];
          if (Number.isFinite(Number(value))) {
            return Number(value);
          }
        }
        return null;
      };
      const inputTokens = pickNumber('inputTokens', 'input_tokens', 'prompt_tokens');
      const outputTokens = pickNumber('outputTokens', 'output_tokens', 'completion_tokens');
      let totalTokens = pickNumber('totalTokens', 'total_tokens');
      if (totalTokens === null && (inputTokens !== null || outputTokens !== null)) {
        totalTokens = Number(inputTokens || 0) + Number(outputTokens || 0);
      }
      if (inputTokens === null && outputTokens === null && totalTokens === null) {
        return null;
      }
      return {
        inputTokens,
        outputTokens,
        totalTokens
      };
    }

    _normalizeRateMeta(rawRate) {
      if (!rawRate || typeof rawRate !== 'object') {
        return null;
      }
      return {
        remainingRequests: rawRate.remainingRequests === undefined ? null : rawRate.remainingRequests,
        remainingTokens: rawRate.remainingTokens === undefined ? null : rawRate.remainingTokens,
        limitRequests: rawRate.limitRequests === undefined ? null : rawRate.limitRequests,
        limitTokens: rawRate.limitTokens === undefined ? null : rawRate.limitTokens,
        resetRequestsAt: rawRate.resetRequestsAt || null,
        resetTokensAt: rawRate.resetTokensAt || null,
        reservedRequests: rawRate.reservedRequests === undefined ? null : rawRate.reservedRequests,
        reservedTokens: rawRate.reservedTokens === undefined ? null : rawRate.reservedTokens,
        cooldownUntilTs: rawRate.cooldownUntilTs || null
      };
    }

    _normalizeQuality(rawQuality, { missing } = {}) {
      if (rawQuality === 'ok' || rawQuality === 'needs_review') {
        return rawQuality;
      }
      if (rawQuality.includes('review') || rawQuality.includes('warn') || rawQuality.includes('fail') || rawQuality.includes('error') || rawQuality.includes('issue')) {
        return 'needs_review';
      }
      if (Number(missing || 0) > 0) {
        return 'needs_review';
      }
      return 'ok';
    }

    _buildCacheKey({ prompt, targetLang, agentContext, agentRoute } = {}) {
      const context = agentContext && typeof agentContext === 'object' ? agentContext : {};
      const policy = context.modelPolicy && typeof context.modelPolicy === 'object'
        ? context.modelPolicy
        : {};
      const src = [
        `lang=${targetLang || 'ru'}`,
        `route=${agentRoute || 'none'}`,
        `profile=${context.profile || 'auto'}`,
        `style=${context.style || 'balanced'}`,
        `policyMode=${policy.mode || 'auto'}`,
        `policySpeed=${policy.speed === false ? 'off' : 'on'}`,
        `policyPreference=${policy.preference || 'none'}`,
        `policyRouteOverride=${policy.allowRouteOverride === false ? 'off' : 'on'}`,
        `system=${typeof context.systemPrompt === 'string' ? context.systemPrompt : ''}`,
        `format=${JSON.stringify(context.reportFormat || null)}`,
        `prompt=${prompt || ''}`
      ].join('\n');
      return `tr:${src.length}:${this._hashText(src)}`;
    }

    _hashText(text) {
      const src = typeof text === 'string' ? text : String(text || '');
      let hash = 0;
      for (let i = 0; i < src.length; i += 1) {
        hash = ((hash << 5) - hash) + src.charCodeAt(i);
        hash |= 0;
      }
      return Math.abs(hash);
    }

    _getCached(key) {
      if (!key || !this.responseCache || !this.responseCache.size) {
        return null;
      }
      const now = Date.now();
      const entry = this.responseCache.get(key);
      if (!entry) {
        return null;
      }
      if (!Number.isFinite(Number(entry.expiresAt)) || Number(entry.expiresAt) <= now) {
        this.responseCache.delete(key);
        return null;
      }
      entry.lastAccessAt = now;
      const cached = this._cloneCacheValue(entry.value);
      if (cached && cached.report && typeof cached.report === 'object') {
        const reportMeta = cached.report.meta && typeof cached.report.meta === 'object'
          ? cached.report.meta
          : {};
        cached.report = {
          ...cached.report,
          meta: {
            ...reportMeta,
            cached: true
          }
        };
      }
      return cached;
    }

    _setCached(key, value) {
      if (!key || !value || !this.responseCache) {
        return;
      }
      const now = Date.now();
      this.responseCache.set(key, {
        value: this._cloneCacheValue(value),
        createdAt: now,
        lastAccessAt: now,
        expiresAt: now + this.CACHE_TTL_MS
      });
      this._pruneCache(now);
    }

    _pruneCache(nowTs) {
      const now = Number.isFinite(Number(nowTs)) ? Number(nowTs) : Date.now();
      if (!this.responseCache || !this.responseCache.size) {
        return;
      }
      for (const [key, entry] of this.responseCache.entries()) {
        if (!entry || !Number.isFinite(Number(entry.expiresAt)) || Number(entry.expiresAt) <= now) {
          this.responseCache.delete(key);
        }
      }
      if (this.responseCache.size <= this.MAX_CACHE_ENTRIES) {
        return;
      }
      const rows = Array.from(this.responseCache.entries())
        .map(([key, entry]) => ({
          key,
          lastAccessAt: Number.isFinite(Number(entry && entry.lastAccessAt)) ? Number(entry.lastAccessAt) : 0
        }))
        .sort((a, b) => a.lastAccessAt - b.lastAccessAt);
      const toDrop = this.responseCache.size - this.MAX_CACHE_ENTRIES;
      rows.slice(0, toDrop).forEach((row) => {
        this.responseCache.delete(row.key);
      });
    }

    _cloneCacheValue(value) {
      if (!value || typeof value !== 'object') {
        return value;
      }
      return {
        items: Array.isArray(value.items)
          ? value.items.map((item) => ({
            blockId: item && item.blockId ? String(item.blockId) : '',
            text: item && typeof item.text === 'string' ? item.text : ''
          }))
          : [],
        rawJson: value.rawJson && typeof value.rawJson === 'object'
          ? { ...value.rawJson }
          : value.rawJson || null,
        report: value.report && typeof value.report === 'object'
          ? {
            ...value.report,
            notes: Array.isArray(value.report.notes) ? value.report.notes.slice() : [],
            meta: value.report.meta && typeof value.report.meta === 'object'
              ? {
                ...value.report.meta,
                usage: value.report.meta.usage && typeof value.report.meta.usage === 'object'
                  ? { ...value.report.meta.usage }
                  : value.report.meta.usage,
                rate: value.report.meta.rate && typeof value.report.meta.rate === 'object'
                  ? { ...value.report.meta.rate }
                  : value.report.meta.rate
              }
              : value.report.meta
          }
          : null
      };
    }

    _extractOutputText(rawJson) {
      if (typeof rawJson.output_text === 'string' && rawJson.output_text) {
        return rawJson.output_text;
      }
      if (!Array.isArray(rawJson.output)) {
        return '';
      }
      for (const outputItem of rawJson.output) {
        if (!outputItem || !Array.isArray(outputItem.content)) {
          continue;
        }
        for (const contentItem of outputItem.content) {
          if (contentItem && typeof contentItem.text === 'string' && contentItem.text) {
            return contentItem.text;
          }
        }
      }
      return '';
    }

    _resolveAgentRoute(agentContext) {
      const context = agentContext && typeof agentContext === 'object' ? agentContext : {};
      const modelPolicy = context.modelPolicy && typeof context.modelPolicy === 'object'
        ? context.modelPolicy
        : null;
      if (modelPolicy && modelPolicy.allowRouteOverride === false) {
        return null;
      }
      if (context.modelRouterEnabled === false) {
        return null;
      }
      if (context.routeHint === 'strong' || context.routeHint === 'fast') {
        return context.routeHint;
      }
      const style = typeof context.style === 'string' ? context.style : '';
      if (style === 'technical' || style === 'literal') {
        return 'strong';
      }
      const counts = context.batchCategoryCounts && typeof context.batchCategoryCounts === 'object'
        ? context.batchCategoryCounts
        : {};
      if ((counts.code || 0) > 0 || (counts.table || 0) > 0 || (counts.heading || 0) > 0) {
        return 'strong';
      }
      return 'fast';
    }
  }

  NT.TranslationCall = TranslationCall;
})(globalThis);
