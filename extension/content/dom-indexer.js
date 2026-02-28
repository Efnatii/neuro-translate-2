/**
 * DOM text indexer for translation batches.
 *
 * Features:
 * - Iterative traversal (no recursive stack growth).
 * - Same-origin iframe traversal (about:blank/srcdoc included when accessible).
 * - Open Shadow DOM traversal.
 * - Stable anchors (rootHint + nodePath + stableNodeKey).
 */
(function initDomIndexer(global) {
  const NT = global.NT || (global.NT = {});

  class DomIndexer {
    constructor({ doc } = {}) {
      this.doc = doc || global.document;
      this.SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT']);
      this.featuresCache = typeof global.WeakMap === 'function' ? new global.WeakMap() : null;
      this.styleCache = typeof global.WeakMap === 'function' ? new global.WeakMap() : null;
      this.defaults = {
        maxTextNodesPerScan: 5000,
        progressEveryNodes: 120,
        yieldEveryNNodes: 260,
        abortScanIfOverMs: 0
      };
    }

    scan(options = {}) {
      const startedAt = Date.now();
      const blocks = [];
      const blockNodes = {};
      const stats = this._newStats();
      const doc = this.doc;
      if (!doc || !doc.body) {
        const preRanges = [];
        this._extendStatsWithPreanalysis(stats, blocks, preRanges);
        return {
          blocks,
          blockNodes,
          preRanges,
          stats,
          scanPerf: {
            scanTimeMs: 0,
            visitedNodes: 0,
            truncated: false,
            abortedByBudget: false
          }
        };
      }

      const maxTextNodes = this._resolveMaxNodes(options.maxTextNodesPerScan);
      const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
      const progressEvery = Number.isFinite(Number(options.progressEveryNodes))
        ? Math.max(40, Math.round(Number(options.progressEveryNodes)))
        : this.defaults.progressEveryNodes;

      const frameDocSeq = { value: 1 };
      const frameLocalCounters = {};
      const visitedRoots = typeof global.WeakSet === 'function' ? new global.WeakSet() : null;
      const rootStack = [];
      const pushRoot = (entry) => {
        if (!entry || !entry.root || !entry.doc) {
          return;
        }
        if (visitedRoots && visitedRoots.has(entry.root)) {
          return;
        }
        if (visitedRoots) {
          visitedRoots.add(entry.root);
        }
        rootStack.push(entry);
      };

      pushRoot({
        root: doc.body,
        doc,
        frameId: 0,
        frameUrl: this._safeLocationHref(doc),
        rootKind: 'document',
        rootHint: 'frame:0',
        hostPath: ''
      });

      let globalOrder = 0;
      let visitedNodes = 0;
      while (rootStack.length && stats.totalTextNodes < maxTextNodes) {
        const rootCtx = rootStack.pop();
        const nodeStack = [rootCtx.root];
        if (rootCtx.rootKind === 'shadow') {
          stats.shadowDom.openRootsVisited += 1;
        } else if (rootCtx.rootKind === 'document') {
          stats.frames.scannedOk += 1;
        }

        while (nodeStack.length && stats.totalTextNodes < maxTextNodes) {
          const node = nodeStack.pop();
          visitedNodes += 1;
          if (onProgress && (visitedNodes % progressEvery) === 0) {
            onProgress({
              visitedNodes,
              blocks: blocks.length,
              frameId: rootCtx.frameId
            });
          }

          if (!node) {
            continue;
          }
          if (node.nodeType === 3) {
            const rawText = typeof node.textContent === 'string' ? node.textContent : '';
            const text = rawText.replace(/\s+/g, ' ').trim();
            const parent = node.parentElement || null;
            if (!this._isEligible(parent, text)) {
              continue;
            }
            const frameId = Number.isFinite(Number(rootCtx.frameId)) ? Number(rootCtx.frameId) : 0;
            const localIndex = Number.isFinite(Number(frameLocalCounters[frameId]))
              ? Number(frameLocalCounters[frameId])
              : 0;
            frameLocalCounters[frameId] = localIndex + 1;
            const blockId = `f${frameId}:b${localIndex}`;
            const nodePath = this._nodePath(node, rootCtx.root);
            const pathHint = this._pathHint(parent);
            const stableNodeKey = `${rootCtx.rootHint}|${nodePath}|${pathHint}`.slice(0, 260);
            const features = this._buildFeatures(parent, text, rootCtx.doc);
            const preCategory = this._derivePreCategory({
              element: parent,
              features,
              pathHint
            });
            const anchor = this._buildAnchor({
              frameId,
              rootHint: rootCtx.rootHint,
              nodePath,
              stableNodeKey
            });
            blocks.push({
              blockId,
              localBlockId: `b${localIndex}`,
              frameId,
              frameUrl: rootCtx.frameUrl || null,
              originalText: text,
              pathHint,
              domOrder: globalOrder,
              stableNodeKey,
              rootHint: rootCtx.rootHint,
              nodePath,
              anchor,
              preCategory,
              category: 'unknown',
              featuresMini: this._buildFeaturesMini(features),
              features
            });
            blockNodes[blockId] = node;
            globalOrder += 1;
            stats.totalTextNodes += 1;
            if (rootCtx.rootKind === 'shadow') {
              stats.shadowDom.textNodesFromShadow += 1;
            }
            continue;
          }
          if (node.nodeType !== 1) {
            if (node.nodeType === 11 && node.childNodes && node.childNodes.length) {
              for (let i = node.childNodes.length - 1; i >= 0; i -= 1) {
                const child = node.childNodes[i];
                if (child) {
                  nodeStack.push(child);
                }
              }
            }
            continue;
          }

          const element = node;
          const tag = String(element.tagName || '').toUpperCase();

          if (tag === 'IFRAME' || tag === 'FRAME') {
            stats.frames.totalSeen += 1;
            const framePath = this._pathHint(element);
            let childDoc = null;
            try {
              childDoc = element.contentDocument || null;
            } catch (_) {
              childDoc = null;
            }
            if (childDoc && childDoc.body) {
              const frameId = frameDocSeq.value;
              frameDocSeq.value += 1;
              pushRoot({
                root: childDoc.body,
                doc: childDoc,
                frameId,
                frameUrl: this._safeLocationHref(childDoc),
                rootKind: 'document',
                rootHint: `frame:${frameId}`,
                hostPath: framePath || ''
              });
            } else {
              stats.frames.skippedNoPerm += 1;
              if (stats.frames.skipped.length < 24) {
                stats.frames.skipped.push({
                  framePath: framePath || '',
                  reason: 'no_host_permission_or_cross_origin'
                });
              }
            }
          }

          let shadowRoot = null;
          try {
            shadowRoot = element.shadowRoot || null;
          } catch (_) {
            shadowRoot = null;
          }
          if (shadowRoot) {
            const hostPath = this._pathHint(element);
            pushRoot({
              root: shadowRoot,
              doc: rootCtx.doc,
              frameId: rootCtx.frameId,
              frameUrl: rootCtx.frameUrl,
              rootKind: 'shadow',
              rootHint: `shadow:${hostPath || 'host'}@f${rootCtx.frameId}`,
              hostPath: hostPath || ''
            });
          } else if (tag.includes('-') && stats.shadowDom.closedOrAbsentHint < 500) {
            // Closed shadow roots cannot be detected directly; keep a weak hint counter.
            stats.shadowDom.closedOrAbsentHint += 1;
          }

          const children = element.childNodes;
          if (children && children.length) {
            for (let i = children.length - 1; i >= 0; i -= 1) {
              const child = children[i];
              if (child) {
                nodeStack.push(child);
              }
            }
          }
        }
      }

      if (stats.totalTextNodes >= maxTextNodes) {
        stats.truncated = true;
      }
      stats.visitedNodes = visitedNodes;
      const preRanges = this._buildPreRanges(blocks);
      this._extendStatsWithPreanalysis(stats, blocks, preRanges);
      return {
        blocks,
        blockNodes,
        preRanges,
        stats,
        scanPerf: {
          scanTimeMs: Math.max(0, Date.now() - startedAt),
          visitedNodes,
          truncated: Boolean(stats.truncated),
          abortedByBudget: Boolean(stats.abortedByBudget)
        }
      };
    }

    async scanAsync(options = {}) {
      const startedAt = Date.now();
      const blocks = [];
      const blockNodes = {};
      const stats = this._newStats();
      const doc = this.doc;
      if (!doc || !doc.body) {
        const preRanges = [];
        this._extendStatsWithPreanalysis(stats, blocks, preRanges);
        return {
          blocks,
          blockNodes,
          preRanges,
          stats,
          scanPerf: {
            scanTimeMs: 0,
            visitedNodes: 0,
            truncated: false,
            abortedByBudget: false
          }
        };
      }

      const maxTextNodes = this._resolveMaxNodes(options.maxTextNodesPerScan);
      const yieldEveryNNodes = this._resolveYieldEvery(options.yieldEveryNNodes);
      const abortScanIfOverMs = this._resolveAbortMs(options.abortScanIfOverMs);
      const degradeOnHeavy = options.degradeOnHeavy !== false;
      const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
      const progressEvery = Number.isFinite(Number(options.progressEveryNodes))
        ? Math.max(40, Math.round(Number(options.progressEveryNodes)))
        : this.defaults.progressEveryNodes;

      const frameDocSeq = { value: 1 };
      const frameLocalCounters = {};
      const visitedRoots = typeof global.WeakSet === 'function' ? new global.WeakSet() : null;
      const rootStack = [];
      const pushRoot = (entry) => {
        if (!entry || !entry.root || !entry.doc) {
          return;
        }
        if (visitedRoots && visitedRoots.has(entry.root)) {
          return;
        }
        if (visitedRoots) {
          visitedRoots.add(entry.root);
        }
        rootStack.push(entry);
      };

      pushRoot({
        root: doc.body,
        doc,
        frameId: 0,
        frameUrl: this._safeLocationHref(doc),
        rootKind: 'document',
        rootHint: 'frame:0',
        hostPath: ''
      });

      let globalOrder = 0;
      let visitedNodes = 0;
      let budgetAborted = false;

      while (rootStack.length && stats.totalTextNodes < maxTextNodes && !budgetAborted) {
        const rootCtx = rootStack.pop();
        const nodeStack = [rootCtx.root];
        if (rootCtx.rootKind === 'shadow') {
          stats.shadowDom.openRootsVisited += 1;
        } else if (rootCtx.rootKind === 'document') {
          stats.frames.scannedOk += 1;
        }

        while (nodeStack.length && stats.totalTextNodes < maxTextNodes && !budgetAborted) {
          const node = nodeStack.pop();
          visitedNodes += 1;
          if (onProgress && (visitedNodes % progressEvery) === 0) {
            onProgress({
              visitedNodes,
              blocks: blocks.length,
              frameId: rootCtx.frameId
            });
          }

          if ((visitedNodes % yieldEveryNNodes) === 0) {
            await this._yieldToEventLoop();
          }

          if (abortScanIfOverMs > 0 && (Date.now() - startedAt) > abortScanIfOverMs) {
            const elapsedMs = Math.max(0, Date.now() - startedAt);
            if (degradeOnHeavy) {
              budgetAborted = true;
              stats.truncated = true;
              stats.abortedByBudget = true;
              stats.abortReason = 'time_budget';
              stats.abortElapsedMs = elapsedMs;
              break;
            }
            throw this._scanTooHeavyError({
              elapsedMs,
              budgetMs: abortScanIfOverMs,
              visitedNodes,
              blockCount: blocks.length
            });
          }

          if (!node) {
            continue;
          }
          if (node.nodeType === 3) {
            const rawText = typeof node.textContent === 'string' ? node.textContent : '';
            const text = rawText.replace(/\s+/g, ' ').trim();
            const parent = node.parentElement || null;
            if (!this._isEligible(parent, text)) {
              continue;
            }
            const frameId = Number.isFinite(Number(rootCtx.frameId)) ? Number(rootCtx.frameId) : 0;
            const localIndex = Number.isFinite(Number(frameLocalCounters[frameId]))
              ? Number(frameLocalCounters[frameId])
              : 0;
            frameLocalCounters[frameId] = localIndex + 1;
            const blockId = `f${frameId}:b${localIndex}`;
            const nodePath = this._nodePath(node, rootCtx.root);
            const pathHint = this._pathHint(parent);
            const stableNodeKey = `${rootCtx.rootHint}|${nodePath}|${pathHint}`.slice(0, 260);
            const features = this._buildFeatures(parent, text, rootCtx.doc);
            const preCategory = this._derivePreCategory({
              element: parent,
              features,
              pathHint
            });
            const anchor = this._buildAnchor({
              frameId,
              rootHint: rootCtx.rootHint,
              nodePath,
              stableNodeKey
            });
            blocks.push({
              blockId,
              localBlockId: `b${localIndex}`,
              frameId,
              frameUrl: rootCtx.frameUrl || null,
              originalText: text,
              pathHint,
              domOrder: globalOrder,
              stableNodeKey,
              rootHint: rootCtx.rootHint,
              nodePath,
              anchor,
              preCategory,
              category: 'unknown',
              featuresMini: this._buildFeaturesMini(features),
              features
            });
            blockNodes[blockId] = node;
            globalOrder += 1;
            stats.totalTextNodes += 1;
            if (rootCtx.rootKind === 'shadow') {
              stats.shadowDom.textNodesFromShadow += 1;
            }
            continue;
          }
          if (node.nodeType !== 1) {
            if (node.nodeType === 11 && node.childNodes && node.childNodes.length) {
              for (let i = node.childNodes.length - 1; i >= 0; i -= 1) {
                const child = node.childNodes[i];
                if (child) {
                  nodeStack.push(child);
                }
              }
            }
            continue;
          }

          const element = node;
          const tag = String(element.tagName || '').toUpperCase();

          if (tag === 'IFRAME' || tag === 'FRAME') {
            stats.frames.totalSeen += 1;
            const framePath = this._pathHint(element);
            let childDoc = null;
            try {
              childDoc = element.contentDocument || null;
            } catch (_) {
              childDoc = null;
            }
            if (childDoc && childDoc.body) {
              const frameId = frameDocSeq.value;
              frameDocSeq.value += 1;
              pushRoot({
                root: childDoc.body,
                doc: childDoc,
                frameId,
                frameUrl: this._safeLocationHref(childDoc),
                rootKind: 'document',
                rootHint: `frame:${frameId}`,
                hostPath: framePath || ''
              });
            } else {
              stats.frames.skippedNoPerm += 1;
              if (stats.frames.skipped.length < 24) {
                stats.frames.skipped.push({
                  framePath: framePath || '',
                  reason: 'no_host_permission_or_cross_origin'
                });
              }
            }
          }

          let shadowRoot = null;
          try {
            shadowRoot = element.shadowRoot || null;
          } catch (_) {
            shadowRoot = null;
          }
          if (shadowRoot) {
            const hostPath = this._pathHint(element);
            pushRoot({
              root: shadowRoot,
              doc: rootCtx.doc,
              frameId: rootCtx.frameId,
              frameUrl: rootCtx.frameUrl,
              rootKind: 'shadow',
              rootHint: `shadow:${hostPath || 'host'}@f${rootCtx.frameId}`,
              hostPath: hostPath || ''
            });
          } else if (tag.includes('-') && stats.shadowDom.closedOrAbsentHint < 500) {
            // Closed shadow roots cannot be detected directly; keep a weak hint counter.
            stats.shadowDom.closedOrAbsentHint += 1;
          }

          const children = element.childNodes;
          if (children && children.length) {
            for (let i = children.length - 1; i >= 0; i -= 1) {
              const child = children[i];
              if (child) {
                nodeStack.push(child);
              }
            }
          }
        }
      }

      if (stats.totalTextNodes >= maxTextNodes) {
        stats.truncated = true;
      }
      stats.visitedNodes = visitedNodes;
      const preRanges = this._buildPreRanges(blocks);
      this._extendStatsWithPreanalysis(stats, blocks, preRanges);
      const scanPerf = {
        scanTimeMs: Math.max(0, Date.now() - startedAt),
        visitedNodes,
        truncated: Boolean(stats.truncated),
        abortedByBudget: Boolean(stats.abortedByBudget)
      };
      return { blocks, blockNodes, preRanges, stats, scanPerf };
    }

    _newStats() {
      return {
        totalTextNodes: 0,
        truncated: false,
        visitedNodes: 0,
        abortedByBudget: false,
        abortReason: null,
        abortElapsedMs: 0,
        frames: {
          totalSeen: 1,
          scannedOk: 0,
          skippedNoPerm: 0,
          skipped: []
        },
        shadowDom: {
          openRootsVisited: 0,
          textNodesFromShadow: 0,
          closedOrAbsentHint: 0
        }
      };
    }

    _extendStatsWithPreanalysis(stats, blocks, preRanges) {
      const safeStats = stats && typeof stats === 'object' ? stats : {};
      const safeBlocks = Array.isArray(blocks) ? blocks : [];
      const safeRanges = Array.isArray(preRanges) ? preRanges : [];
      const byPreCategory = {};
      let totalChars = 0;
      safeBlocks.forEach((block) => {
        const row = block && typeof block === 'object' ? block : {};
        const preCategory = typeof row.preCategory === 'string' && row.preCategory
          ? row.preCategory
          : 'unknown';
        byPreCategory[preCategory] = Number.isFinite(Number(byPreCategory[preCategory]))
          ? Number(byPreCategory[preCategory]) + 1
          : 1;
        const text = typeof row.originalText === 'string' ? row.originalText : '';
        totalChars += text.length;
      });
      safeStats.blockCount = safeBlocks.length;
      safeStats.totalChars = totalChars;
      safeStats.byPreCategory = byPreCategory;
      safeStats.rangeCount = safeRanges.length;
      return safeStats;
    }

    _buildAnchor({ frameId, rootHint, nodePath, stableNodeKey } = {}) {
      return {
        frameId: Number.isFinite(Number(frameId)) ? Number(frameId) : 0,
        rootHint: typeof rootHint === 'string' ? rootHint : '',
        nodePath: typeof nodePath === 'string' ? nodePath : '',
        stableNodeKey: typeof stableNodeKey === 'string' ? stableNodeKey : ''
      };
    }

    _buildFeaturesMini(features) {
      const src = features && typeof features === 'object' ? features : {};
      return {
        tag: typeof src.tag === 'string' ? src.tag : '',
        role: typeof src.role === 'string' ? src.role : '',
        inputType: typeof src.inputType === 'string' ? src.inputType : '',
        hrefType: typeof src.hrefType === 'string' ? src.hrefType : 'none',
        isEditable: src.isEditable === true,
        isCodeLike: src.isCodeLike === true,
        isHidden: src.isHidden === true,
        isInNav: src.isInNav === true,
        isInFooter: src.isInFooter === true,
        isInHeader: src.isInHeader === true,
        isInMain: src.isInMain === true,
        hasTableContext: src.hasTableContext === true,
        textLen: Number.isFinite(Number(src.textLen)) ? Math.max(0, Math.round(Number(src.textLen))) : 0,
        wordCount: Number.isFinite(Number(src.wordCount)) ? Math.max(0, Math.round(Number(src.wordCount))) : 0
      };
    }

    _derivePreCategory({ element, features, pathHint } = {}) {
      const tag = features && typeof features.tag === 'string'
        ? features.tag
        : String(element && element.tagName ? element.tagName : '').toLowerCase();
      const role = features && typeof features.role === 'string'
        ? features.role
        : '';
      const safePathHint = typeof pathHint === 'string' ? pathHint.toLowerCase() : '';
      if (/^h[1-6]$/.test(tag)) {
        return 'heading';
      }
      if (features && features.isCodeLike === true) {
        return 'code';
      }
      if (tag === 'pre' || tag === 'code' || tag === 'kbd' || tag === 'samp') {
        return 'code';
      }
      if (features && features.hasTableContext === true) {
        return 'table';
      }
      if (tag === 'table' || tag === 'tr' || tag === 'th' || tag === 'td' || tag === 'caption') {
        return 'table';
      }
      if (features && features.isInNav === true) {
        return 'nav';
      }
      if (role === 'navigation' || tag === 'nav' || safePathHint.includes('nav')) {
        return 'nav';
      }
      if (features && features.isInFooter === true) {
        return 'footer';
      }
      if (features && features.isInHeader === true) {
        return 'header';
      }
      if (features && features.isEditable === true) {
        return 'button';
      }
      if (tag === 'button' || tag === 'input' || tag === 'select' || tag === 'option') {
        return 'button';
      }
      if (tag === 'label') {
        return 'label';
      }
      if (features && features.hasListContext === true) {
        return 'list';
      }
      if (tag === 'li' || tag === 'ul' || tag === 'ol') {
        return 'list';
      }
      if (features && features.isInDialog === true) {
        return 'dialog';
      }
      return 'paragraph';
    }

    _rangeContainerKey(block) {
      const row = block && typeof block === 'object' ? block : {};
      const frameId = Number.isFinite(Number(row.frameId)) ? Number(row.frameId) : 0;
      const rootHint = typeof row.rootHint === 'string' ? row.rootHint : '';
      const pathHint = typeof row.pathHint === 'string' ? row.pathHint : '';
      const parts = pathHint.split('>').map((part) => part.trim()).filter(Boolean);
      const containerHint = parts.length > 1 ? parts.slice(0, -1).join(' > ') : pathHint;
      return `${frameId}|${rootHint}|${containerHint}`;
    }

    _buildPreRanges(blocks) {
      const rows = (Array.isArray(blocks) ? blocks : [])
        .filter((item) => item && item.blockId)
        .slice()
        .sort((left, right) => {
          const a = Number.isFinite(Number(left.domOrder)) ? Number(left.domOrder) : 0;
          const b = Number.isFinite(Number(right.domOrder)) ? Number(right.domOrder) : 0;
          return a - b;
        });
      const ranges = [];
      let current = null;
      const flush = () => {
        if (!current) {
          return;
        }
        ranges.push({
          rangeId: `r${ranges.length}`,
          preCategory: current.preCategory,
          blockIds: current.blockIds.slice(),
          domOrderFrom: current.domOrderFrom,
          domOrderTo: current.domOrderTo,
          anchorHint: current.anchorHint
        });
        current = null;
      };
      rows.forEach((block) => {
        const row = block && typeof block === 'object' ? block : {};
        const preCategory = typeof row.preCategory === 'string' && row.preCategory
          ? row.preCategory
          : 'unknown';
        const domOrder = Number.isFinite(Number(row.domOrder))
          ? Number(row.domOrder)
          : 0;
        const containerKey = this._rangeContainerKey(row);
        const blockId = String(row.blockId);
        const anchorHint = row.anchor && typeof row.anchor === 'object' && typeof row.anchor.stableNodeKey === 'string'
          ? row.anchor.stableNodeKey
          : (typeof row.stableNodeKey === 'string' ? row.stableNodeKey : '');
        const canAppend = current
          && current.preCategory === preCategory
          && current.containerKey === containerKey
          && domOrder <= (current.domOrderTo + 1);
        if (!canAppend) {
          flush();
          current = {
            preCategory,
            containerKey,
            blockIds: [blockId],
            domOrderFrom: domOrder,
            domOrderTo: domOrder,
            anchorHint
          };
          return;
        }
        current.blockIds.push(blockId);
        current.domOrderTo = domOrder;
      });
      flush();
      return ranges;
    }

    _resolveMaxNodes(value) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) {
        return this.defaults.maxTextNodesPerScan;
      }
      return Math.max(200, Math.min(30000, Math.round(numeric)));
    }

    _resolveYieldEvery(value) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) {
        return this.defaults.yieldEveryNNodes;
      }
      return Math.max(40, Math.min(2500, Math.round(numeric)));
    }

    _resolveAbortMs(value) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) {
        return this.defaults.abortScanIfOverMs;
      }
      return Math.max(0, Math.min(120000, Math.round(numeric)));
    }

    async _yieldToEventLoop() {
      await new Promise((resolve) => {
        global.setTimeout(resolve, 0);
      });
    }

    _scanTooHeavyError({ elapsedMs = 0, budgetMs = 0, visitedNodes = 0, blockCount = 0 } = {}) {
      const err = new Error(`DOM scan exceeded budget (${elapsedMs}ms > ${budgetMs}ms)`);
      err.code = 'SCAN_TOO_HEAVY';
      err.elapsedMs = Math.max(0, Number(elapsedMs) || 0);
      err.budgetMs = Math.max(0, Number(budgetMs) || 0);
      err.visitedNodes = Math.max(0, Number(visitedNodes) || 0);
      err.blockCount = Math.max(0, Number(blockCount) || 0);
      return err;
    }

    _safeLocationHref(doc) {
      try {
        return doc && doc.location && typeof doc.location.href === 'string'
          ? doc.location.href
          : '';
      } catch (_) {
        return '';
      }
    }

    _nodePath(node, root) {
      const parts = [];
      let current = node;
      let guard = 0;
      while (current && current !== root && guard < 80) {
        const parent = current.parentNode;
        if (!parent || !parent.childNodes) {
          break;
        }
        let idx = 0;
        try {
          idx = Array.prototype.indexOf.call(parent.childNodes, current);
        } catch (_) {
          idx = 0;
        }
        parts.unshift(String(Math.max(0, idx)));
        current = parent;
        guard += 1;
      }
      return parts.join('/');
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
      return true;
    }

    _pathHint(element) {
      const parts = [];
      let node = element;
      let depth = 0;
      while (node && depth < 6) {
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

    _buildFeatures(element, text, ownerDoc) {
      const base = this._collectBaseFeatures(element, ownerDoc);
      const safeText = typeof text === 'string' ? text : '';
      const textLen = safeText.length;
      const words = safeText ? safeText.split(/\s+/).filter(Boolean) : [];
      const punctuationMatches = safeText.match(/[.,!?;:()[\]{}"'`~@#$%^&*+=<>/\\|-]/g) || [];
      const alphaMatches = safeText.match(/[A-Za-z]/g) || [];
      const uppercaseMatches = safeText.match(/[A-Z]/g) || [];

      return {
        ...base,
        classTokens: Array.isArray(base.classTokens) ? base.classTokens.slice(0, 6) : [],
        textLen,
        wordCount: words.length,
        punctuationRatio: textLen > 0 ? Number((punctuationMatches.length / textLen).toFixed(3)) : 0,
        uppercaseRatio: alphaMatches.length > 0 ? Number((uppercaseMatches.length / alphaMatches.length).toFixed(3)) : 0
      };
    }

    _collectBaseFeatures(element, ownerDoc) {
      if (!element) {
        return this._emptyFeatures();
      }
      if (this.featuresCache && this.featuresCache.has(element)) {
        const cached = this.featuresCache.get(element);
        return cached && typeof cached === 'object'
          ? { ...cached, classTokens: cached.classTokens ? cached.classTokens.slice(0, 6) : [] }
          : this._emptyFeatures();
      }
      const tag = String(element.tagName || '').toLowerCase();
      const style = this._getStyle(element);
      const role = this._cap(String(element.getAttribute && element.getAttribute('role') || '').toLowerCase(), 40);
      const features = {
        tag,
        role: role || '',
        ariaLabel: this._cap(this._cleanText(element.getAttribute && element.getAttribute('aria-label')), 160),
        inputType: this._resolveInputType(element, tag),
        hrefType: this._resolveHrefType(element, tag, ownerDoc),
        isEditable: this._isEditable(element, tag),
        isCodeLike: this._isCodeLike(element, tag, style),
        isHidden: this._isHidden(element, style),
        isInNav: Boolean(element.closest && element.closest('nav,[role="navigation"],menu,[aria-label*="nav" i],[class*="nav" i],[class*="menu" i]')),
        isInFooter: Boolean(element.closest && element.closest('footer,[role="contentinfo"],[class*="footer" i]')),
        isInHeader: Boolean(element.closest && element.closest('header,[role="banner"],[class*="header" i]')),
        isInMain: Boolean(element.closest && element.closest('main,article,section,[role="main"],[class*="content" i]')),
        isInDialog: Boolean(element.closest && element.closest('dialog,[role="dialog"],[aria-modal="true"],[class*="modal" i]')),
        hasListContext: Boolean(element.closest && element.closest('li,ul,ol')),
        hasTableContext: Boolean(element.closest && element.closest('table,thead,tbody,tfoot,tr,th,td,caption')),
        langHint: this._resolveLangHint(element, ownerDoc),
        classTokens: this._classTokens(element.className),
        idHint: this._cap(this._cleanText(element.id), 64),
        textLen: 0,
        wordCount: 0,
        punctuationRatio: 0,
        uppercaseRatio: 0
      };
      if (this.featuresCache) {
        this.featuresCache.set(element, { ...features, classTokens: features.classTokens.slice(0, 6) });
      }
      return features;
    }

    _emptyFeatures() {
      return {
        tag: '',
        role: '',
        ariaLabel: '',
        inputType: '',
        hrefType: 'none',
        isEditable: false,
        isCodeLike: false,
        isHidden: false,
        isInNav: false,
        isInFooter: false,
        isInHeader: false,
        isInMain: false,
        isInDialog: false,
        hasListContext: false,
        hasTableContext: false,
        langHint: '',
        classTokens: [],
        idHint: '',
        textLen: 0,
        wordCount: 0,
        punctuationRatio: 0,
        uppercaseRatio: 0
      };
    }

    _resolveInputType(element, tag) {
      if (!element) {
        return '';
      }
      if (tag === 'input') {
        return this._cap(String(element.type || 'text').toLowerCase(), 32);
      }
      if (tag === 'button' || tag === 'textarea' || tag === 'select' || tag === 'option') {
        return tag;
      }
      return '';
    }

    _resolveHrefType(element, tag, ownerDoc) {
      if (!element || (tag !== 'a' && tag !== 'area')) {
        return 'none';
      }
      const rawHref = this._cleanText(element.getAttribute && element.getAttribute('href'));
      if (!rawHref) {
        return 'none';
      }
      if (rawHref.startsWith('#')) {
        return 'anchor';
      }
      try {
        const doc = ownerDoc || this.doc;
        const baseUri = doc && doc.baseURI ? doc.baseURI : undefined;
        const url = new URL(rawHref, baseUri);
        const docHost = doc && doc.location ? doc.location.host : '';
        if (!docHost) {
          return 'nav';
        }
        return url.host && url.host !== docHost ? 'external' : 'nav';
      } catch (_) {
        return 'nav';
      }
    }

    _isEditable(element, tag) {
      if (!element) {
        return false;
      }
      if (element.isContentEditable) {
        return true;
      }
      return tag === 'input' || tag === 'textarea' || tag === 'select';
    }

    _isCodeLike(element, tag, style) {
      if (!element) {
        return false;
      }
      if (tag === 'pre' || tag === 'code' || tag === 'kbd' || tag === 'samp') {
        return true;
      }
      const classTokens = this._classTokens(element.className);
      if (classTokens.some((token) => token === 'code' || token === 'syntax' || token === 'highlight')) {
        return true;
      }
      const fontFamily = style && typeof style.fontFamily === 'string' ? style.fontFamily.toLowerCase() : '';
      return fontFamily.includes('mono') || fontFamily.includes('courier') || fontFamily.includes('consolas');
    }

    _isHidden(element, style) {
      if (!element) {
        return false;
      }
      if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) {
        return true;
      }
      if (typeof element.getBoundingClientRect !== 'function') {
        return false;
      }
      const rect = element.getBoundingClientRect();
      return !rect || rect.width <= 0 || rect.height <= 0;
    }

    _resolveLangHint(element, ownerDoc) {
      const elementLang = this._cleanText(element && element.lang ? element.lang : '');
      if (elementLang) {
        return this._cap(elementLang.toLowerCase(), 20);
      }
      const closestLang = element && element.closest ? element.closest('[lang]') : null;
      if (closestLang && closestLang.lang) {
        return this._cap(String(closestLang.lang || '').toLowerCase(), 20);
      }
      const doc = ownerDoc || this.doc;
      const docLang = doc && doc.documentElement && doc.documentElement.lang
        ? doc.documentElement.lang
        : '';
      return this._cap(String(docLang || '').toLowerCase(), 20);
    }

    _classTokens(rawClassName) {
      const safe = this._cleanText(rawClassName).toLowerCase();
      if (!safe) {
        return [];
      }
      const tokens = [];
      safe.split(/\s+/).forEach((chunk) => {
        chunk.split(/[_\-:./]+/).forEach((token) => {
          const compact = token.replace(/[^a-z0-9]/g, '').trim();
          if (!compact || compact.length < 2 || tokens.includes(compact)) {
            return;
          }
          tokens.push(compact);
        });
      });
      return tokens.slice(0, 6);
    }

    _getStyle(element) {
      if (!element || !global.getComputedStyle) {
        return null;
      }
      if (this.styleCache && this.styleCache.has(element)) {
        return this.styleCache.get(element);
      }
      const style = global.getComputedStyle(element);
      if (this.styleCache) {
        this.styleCache.set(element, style);
      }
      return style;
    }

    _cleanText(value) {
      if (typeof value !== 'string') {
        return '';
      }
      return value.replace(/\s+/g, ' ').trim();
    }

    _cap(value, maxLength) {
      const text = this._cleanText(value);
      if (!text) {
        return '';
      }
      const limit = Number.isFinite(Number(maxLength)) ? Math.max(1, Math.round(Number(maxLength))) : 120;
      return text.slice(0, limit);
    }
  }

  NT.DomIndexer = DomIndexer;
})(globalThis);
