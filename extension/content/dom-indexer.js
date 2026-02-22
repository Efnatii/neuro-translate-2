/**
 * DOM text indexer for translation batches.
 *
 * Produces stable block ids and path hints for visible text nodes.
 */
(function initDomIndexer(global) {
  const NT = global.NT || (global.NT = {});

  class DomIndexer {
    constructor({ doc } = {}) {
      this.doc = doc || global.document;
      this.SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT']);
    }

    scan() {
      const blocks = [];
      const blockNodes = {};
      if (!this.doc || !this.doc.body) {
        return { blocks, blockNodes };
      }
      const walker = this.doc.createTreeWalker(
        this.doc.body,
        global.NodeFilter ? global.NodeFilter.SHOW_TEXT : 4
      );

      let index = 0;
      let node = walker.nextNode();
      while (node) {
        const rawText = typeof node.textContent === 'string' ? node.textContent : '';
        const text = rawText.replace(/\s+/g, ' ').trim();
        const parent = node.parentElement || null;
        if (this._isEligible(parent, text)) {
          const pathHint = this._pathHint(parent);
          const category = this._category(parent, pathHint, text);
          const blockId = `b${index}`;
          blocks.push({
            blockId,
            originalText: text,
            pathHint,
            category
          });
          blockNodes[blockId] = node;
          index += 1;
        }
        node = walker.nextNode();
      }

      return { blocks, blockNodes };
    }

    _isEligible(parent, text) {
      if (!parent || !text) {
        return false;
      }
      if (text.length < 2) {
        return false;
      }
      if (this.SKIP_TAGS.has(parent.tagName)) {
        return false;
      }
      const style = global.getComputedStyle ? global.getComputedStyle(parent) : null;
      if (!style) {
        return true;
      }
      if (style.display === 'none' || style.visibility === 'hidden') {
        return false;
      }
      return true;
    }

    _pathHint(element) {
      const parts = [];
      let node = element;
      let depth = 0;
      while (node && depth < 5) {
        const tag = String(node.tagName || '').toLowerCase();
        if (!tag) {
          break;
        }
        const siblingIndex = this._siblingIndex(node);
        parts.unshift(`${tag}:nth-of-type(${siblingIndex})`);
        node = node.parentElement;
        depth += 1;
      }
      return parts.join(' > ');
    }

    _siblingIndex(element) {
      if (!element || !element.parentElement) {
        return 1;
      }
      const siblings = Array.from(element.parentElement.children).filter((item) => item.tagName === element.tagName);
      const index = siblings.indexOf(element);
      return index >= 0 ? index + 1 : 1;
    }

    _category(element, pathHint, text) {
      const tag = String(element && element.tagName ? element.tagName : '').toUpperCase();
      if (tag === 'H1' || tag === 'H2' || tag === 'H3' || tag === 'H4' || tag === 'H5' || tag === 'H6') {
        return 'heading';
      }
      if (tag === 'LI' || tag === 'UL' || tag === 'OL') {
        return 'list';
      }
      if (tag === 'BUTTON') {
        return 'button';
      }
      if (tag === 'LABEL') {
        return 'label';
      }
      if (tag === 'NAV' || tag === 'MENU') {
        return 'navigation';
      }
      if (tag === 'CODE' || tag === 'PRE' || tag === 'KBD' || tag === 'SAMP') {
        return 'code';
      }
      if (tag === 'BLOCKQUOTE' || tag === 'Q') {
        return 'quote';
      }
      if (tag === 'TABLE' || tag === 'TH' || tag === 'TD' || tag === 'THEAD' || tag === 'TBODY') {
        return 'table';
      }

      const hint = String(pathHint || '').toLowerCase();
      if (hint.includes('header') || hint.includes('footer') || hint.includes('title') || hint.includes('meta')) {
        return 'meta';
      }
      if (hint.includes('nav') || hint.includes('menu')) {
        return 'navigation';
      }
      if (text.length <= 18 && /^(ok|yes|no|cancel|save|close|next|back|menu)$/i.test(text)) {
        return 'button';
      }
      return 'paragraph';
    }
  }

  NT.DomIndexer = DomIndexer;
})(globalThis);
