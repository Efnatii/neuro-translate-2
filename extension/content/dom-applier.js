/**
 * Idempotent DOM translation applier.
 */
(function initDomApplier(global) {
  const NT = global.NT || (global.NT = {});

  class DomApplier {
    constructor() {
      this.currentJobId = null;
      this.records = {};
      this.visible = true;
    }

    setBlocks(jobId, blocks, blockNodes) {
      if (!jobId) {
        return;
      }
      this.currentJobId = jobId;
      this.records = {};
      const list = Array.isArray(blocks) ? blocks : [];
      list.forEach((block) => {
        if (!block || !block.blockId) {
          return;
        }
        const node = blockNodes && blockNodes[block.blockId] ? blockNodes[block.blockId] : null;
        if (!node) {
          return;
        }
        this.records[block.blockId] = {
          node,
          originalText: block.originalText || '',
          translatedText: null
        };
      });
    }

    applyBatch({ jobId, items }) {
      if (!jobId || !Array.isArray(items) || this.currentJobId !== jobId) {
        return { appliedCount: 0 };
      }
      let appliedCount = 0;
      items.forEach((item) => {
        if (!item || !item.blockId || typeof item.text !== 'string') {
          return;
        }
        const record = this.records[item.blockId];
        if (!record || !record.node) {
          return;
        }
        if (record.translatedText === item.text) {
          return;
        }
        record.translatedText = item.text;
        record.node.textContent = this.visible ? record.translatedText : record.originalText;
        appliedCount += 1;
      });
      return { appliedCount };
    }

    restoreOriginals({ jobId } = {}) {
      if (jobId && this.currentJobId && jobId !== this.currentJobId) {
        return { restored: 0 };
      }
      let restored = 0;
      Object.keys(this.records).forEach((blockId) => {
        const record = this.records[blockId];
        if (!record || !record.node) {
          return;
        }
        if (record.node.textContent !== record.originalText) {
          record.node.textContent = record.originalText;
          restored += 1;
        }
      });
      return { restored };
    }

    setVisibility(visible) {
      this.visible = Boolean(visible);
      Object.keys(this.records).forEach((blockId) => {
        const record = this.records[blockId];
        if (!record || !record.node) {
          return;
        }
        if (this.visible) {
          record.node.textContent = record.translatedText || record.originalText;
        } else {
          record.node.textContent = record.originalText;
        }
      });
      return { visible: this.visible };
    }
  }

  NT.DomApplier = DomApplier;
})(globalThis);

