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
    }

    async translateBatch(inputBlocks, { tabId, jobId, batchId, targetLang = 'ru', attempt = 1 } = {}) {
      if (!this.runLlmRequest) {
        throw new Error('TRANSLATION_CALL_UNAVAILABLE');
      }
      const blocks = Array.isArray(inputBlocks) ? inputBlocks.filter((item) => item && item.blockId) : [];
      if (!blocks.length) {
        return { items: [] };
      }

      const prompt = this._buildPrompt(blocks, targetLang);
      const rawJson = await this.runLlmRequest({
        tabId,
        taskType: 'translation_batch',
        request: {
          input: prompt,
          maxOutputTokens: 2200,
          temperature: 0,
          store: false,
          background: false,
          attempt,
          jobId,
          blockId: batchId,
          hintBatchSize: blocks.length
        }
      });

      const parsed = this._parseItems(rawJson);
      const map = {};
      parsed.forEach((item) => {
        if (item && item.blockId && typeof item.text === 'string') {
          map[item.blockId] = item.text;
        }
      });

      const items = blocks.map((block) => ({
        blockId: block.blockId,
        text: Object.prototype.hasOwnProperty.call(map, block.blockId)
          ? map[block.blockId]
          : block.originalText
      }));

      return { items, rawJson };
    }

    _buildPrompt(blocks, targetLang) {
      const payload = blocks.map((block) => ({
        blockId: block.blockId,
        text: block.originalText
      }));
      return [
        `Translate every item to ${targetLang}.`,
        'Return ONLY valid JSON array with objects { "blockId": "...", "text": "..." }.',
        'Keep order and blockId unchanged.',
        JSON.stringify(payload)
      ].join('\n');
    }

    _parseItems(rawJson) {
      if (!rawJson || typeof rawJson !== 'object') {
        return [];
      }
      const outputText = this._extractOutputText(rawJson);
      if (!outputText) {
        return [];
      }
      try {
        const parsed = JSON.parse(outputText);
        return Array.isArray(parsed) ? parsed : [];
      } catch (_) {
        return [];
      }
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
  }

  NT.TranslationCall = TranslationCall;
})(globalThis);

