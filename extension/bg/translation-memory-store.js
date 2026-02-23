/**
 * Persistent translation memory store (IndexedDB + lightweight index in storage.local).
 *
 * Stores:
 * - pages: page-level restore snapshots
 * - blocks: cross-page dedupe by (targetLang + originalHash)
 */
(function initTranslationMemoryStore(global) {
  const NT = global.NT || (global.NT = {});

  class TranslationMemoryStore extends NT.ChromeLocalStoreBase {
    constructor({
      chromeApi,
      dbName = 'nt_translation_memory',
      dbVersion = 1,
      indexKey = 'translationMemoryIndex',
      pageIndexCap = 5,
      sourcePageCap = 10
    } = {}) {
      super({ chromeApi });
      this.DB_NAME = dbName;
      this.DB_VERSION = Number.isFinite(Number(dbVersion)) ? Number(dbVersion) : 1;
      this.PAGES_STORE = 'pages';
      this.BLOCKS_STORE = 'blocks';
      this.INDEX_KEY = indexKey;
      this.PAGE_INDEX_CAP = Number.isFinite(Number(pageIndexCap)) ? Math.max(1, Number(pageIndexCap)) : 5;
      this.SOURCE_PAGE_CAP = Number.isFinite(Number(sourcePageCap)) ? Math.max(1, Number(sourcePageCap)) : 10;
      this.db = null;
      this._openingPromise = null;
    }

    async init() {
      if (!this._isIndexedDbAvailable()) {
        return { ok: false, code: 'INDEXEDDB_UNAVAILABLE' };
      }
      await this._ensureDb();
      await this._ensureIndex();
      return { ok: true };
    }

    _isIndexedDbAvailable() {
      return Boolean(global.indexedDB && typeof global.indexedDB.open === 'function');
    }

    async _ensureDb() {
      if (this.db) {
        return this.db;
      }
      if (this._openingPromise) {
        return this._openingPromise;
      }
      this._openingPromise = new Promise((resolve, reject) => {
        const request = global.indexedDB.open(this.DB_NAME, this.DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(this.PAGES_STORE)) {
            const pages = db.createObjectStore(this.PAGES_STORE, { keyPath: 'pageKey' });
            pages.createIndex('byUrl', 'url', { unique: false });
            pages.createIndex('byDomHash', 'domHash', { unique: false });
            pages.createIndex('byLastUsedAt', 'lastUsedAt', { unique: false });
          }
          if (!db.objectStoreNames.contains(this.BLOCKS_STORE)) {
            const blocks = db.createObjectStore(this.BLOCKS_STORE, { keyPath: 'blockKey' });
            blocks.createIndex('byOriginalHash', 'originalHash', { unique: false });
            blocks.createIndex('byTargetLang', 'targetLang', { unique: false });
            blocks.createIndex('byLastUsedAt', 'lastUsedAt', { unique: false });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
      });
      try {
        this.db = await this._openingPromise;
      } finally {
        this._openingPromise = null;
      }
      return this.db;
    }

    async _withStore(storeName, mode, handler) {
      const db = await this._ensureDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        let done = false;
        const finish = (value) => {
          if (done) {
            return;
          }
          done = true;
          resolve(value);
        };
        try {
          const maybe = handler(store, tx, finish);
          if (maybe && typeof maybe.then === 'function') {
            maybe.catch(reject);
          }
        } catch (error) {
          reject(error);
          return;
        }
        tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
        tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
        tx.oncomplete = () => {
          if (!done) {
            resolve(undefined);
          }
        };
      });
    }

    _now() {
      return Date.now();
    }

    _cloneJson(value, fallback = null) {
      try {
        return JSON.parse(JSON.stringify(value));
      } catch (_) {
        return fallback;
      }
    }

    _normalizeIndex(raw) {
      const source = raw && typeof raw === 'object' ? raw : {};
      const byUrlSrc = source.byUrl && typeof source.byUrl === 'object' ? source.byUrl : {};
      const byDomSrc = source.byDomHash && typeof source.byDomHash === 'object' ? source.byDomHash : {};
      const normalizeMap = (map) => {
        const out = {};
        Object.keys(map).forEach((key) => {
          const idxKey = typeof key === 'string' ? key : '';
          if (!idxKey) {
            return;
          }
          const values = Array.isArray(map[key]) ? map[key] : [];
          const normalized = [];
          values.forEach((item) => {
            const pageKey = typeof item === 'string' ? item.trim() : '';
            if (!pageKey || normalized.includes(pageKey)) {
              return;
            }
            normalized.push(pageKey);
          });
          if (normalized.length) {
            out[idxKey] = normalized.slice(0, this.PAGE_INDEX_CAP);
          }
        });
        return out;
      };
      const counters = source.counters && typeof source.counters === 'object' ? source.counters : {};
      return {
        v: 1,
        byUrl: normalizeMap(byUrlSrc),
        byDomHash: normalizeMap(byDomSrc),
        counters: {
          pages: Number.isFinite(Number(counters.pages)) ? Number(counters.pages) : 0,
          blocks: Number.isFinite(Number(counters.blocks)) ? Number(counters.blocks) : 0
        },
        lastGcAt: Number.isFinite(Number(source.lastGcAt)) ? Number(source.lastGcAt) : null,
        updatedAt: Number.isFinite(Number(source.updatedAt)) ? Number(source.updatedAt) : this._now()
      };
    }

    async _ensureIndex() {
      const data = await this.storageGet({ [this.INDEX_KEY]: null });
      const normalized = this._normalizeIndex(data && data[this.INDEX_KEY]);
      await this.storageSet({ [this.INDEX_KEY]: normalized });
      return normalized;
    }

    async getIndex() {
      const data = await this.storageGet({ [this.INDEX_KEY]: null });
      return this._normalizeIndex(data && data[this.INDEX_KEY]);
    }

    async _putIndex(index) {
      const normalized = this._normalizeIndex(index);
      normalized.updatedAt = this._now();
      await this.storageSet({ [this.INDEX_KEY]: normalized });
      return normalized;
    }

    _upsertIndexKey(map, indexKey, pageKey) {
      if (!map || typeof map !== 'object' || !indexKey || !pageKey) {
        return;
      }
      const existing = Array.isArray(map[indexKey]) ? map[indexKey] : [];
      const next = [pageKey].concat(existing.filter((item) => item !== pageKey));
      map[indexKey] = next.slice(0, this.PAGE_INDEX_CAP);
    }

    _removeIndexPageKey(map, pageKey) {
      if (!map || typeof map !== 'object' || !pageKey) {
        return;
      }
      Object.keys(map).forEach((idxKey) => {
        const values = Array.isArray(map[idxKey]) ? map[idxKey] : [];
        const filtered = values.filter((item) => item !== pageKey);
        if (filtered.length) {
          map[idxKey] = filtered.slice(0, this.PAGE_INDEX_CAP);
        } else {
          delete map[idxKey];
        }
      });
    }

    async getPage(pageKey) {
      const key = typeof pageKey === 'string' ? pageKey.trim() : '';
      if (!key) {
        return null;
      }
      await this._ensureDb();
      return this._withStore(this.PAGES_STORE, 'readonly', (store, _tx, finish) => {
        const req = store.get(key);
        req.onsuccess = () => finish(req.result || null);
      });
    }

    async getBlock(blockKey) {
      const key = typeof blockKey === 'string' ? blockKey.trim() : '';
      if (!key) {
        return null;
      }
      await this._ensureDb();
      return this._withStore(this.BLOCKS_STORE, 'readonly', (store, _tx, finish) => {
        const req = store.get(key);
        req.onsuccess = () => finish(req.result || null);
      });
    }

    async upsertPage(record, { expectedRev = null, maxRetries = 2 } = {}) {
      const source = record && typeof record === 'object' ? record : null;
      if (!source || !source.pageKey) {
        return { ok: false, code: 'BAD_PAGE_RECORD' };
      }
      const requestedExpectedRev = Number.isFinite(Number(expectedRev)) ? Number(expectedRev) : null;
      let workingExpectedRev = requestedExpectedRev;
      const safeRetries = Number.isFinite(Number(maxRetries)) ? Math.max(0, Number(maxRetries)) : 2;
      let hadConflict = false;
      for (let attempt = 0; attempt <= safeRetries; attempt += 1) {
        const now = this._now();
        const current = await this.getPage(source.pageKey);
        const currentRev = current && Number.isFinite(Number(current.rev)) ? Number(current.rev) : 0;
        if (workingExpectedRev !== null && currentRev !== workingExpectedRev) {
          hadConflict = true;
          if (attempt >= safeRetries) {
            return {
              ok: false,
              code: 'REV_CONFLICT',
              expectedRev: requestedExpectedRev,
              currentRev
            };
          }
          workingExpectedRev = currentRev;
          continue;
        }
        const next = {
          ...(current && typeof current === 'object' ? current : {}),
          ...(this._cloneJson(source, {}) || {}),
          pageKey: String(source.pageKey),
          url: typeof source.url === 'string' ? source.url : (current && typeof current.url === 'string' ? current.url : ''),
          domHash: typeof source.domHash === 'string' ? source.domHash : (current && typeof current.domHash === 'string' ? current.domHash : ''),
          domSigVersion: typeof source.domSigVersion === 'string' ? source.domSigVersion : (current && typeof current.domSigVersion === 'string' ? current.domSigVersion : 'v1'),
          targetLang: typeof source.targetLang === 'string' ? source.targetLang : (current && typeof current.targetLang === 'string' ? current.targetLang : 'ru'),
          createdAt: current && Number.isFinite(Number(current.createdAt)) ? Number(current.createdAt) : now,
          updatedAt: now,
          lastUsedAt: now,
          rev: currentRev + 1
        };
        if (!next.blocks || typeof next.blocks !== 'object' || Array.isArray(next.blocks)) {
          next.blocks = {};
        }
        if (!next.categories || typeof next.categories !== 'object' || Array.isArray(next.categories)) {
          next.categories = {};
        }
        await this._withStore(this.PAGES_STORE, 'readwrite', (store, _tx, finish) => {
          const req = store.put(next);
          req.onsuccess = () => finish(true);
        });
        const index = await this.getIndex();
        if (next.url) {
          this._upsertIndexKey(index.byUrl, next.url, next.pageKey);
        }
        if (next.domHash) {
          this._upsertIndexKey(index.byDomHash, next.domHash, next.pageKey);
        }
        await this._putIndex(index);
        return { ok: true, page: next, rev: next.rev, hadConflict };
      }
      return { ok: false, code: 'REV_CONFLICT' };
    }

    async upsertBlock(record) {
      const source = record && typeof record === 'object' ? record : null;
      if (!source || !source.blockKey) {
        return { ok: false, code: 'BAD_BLOCK_RECORD' };
      }
      const now = this._now();
      const current = await this.getBlock(source.blockKey);
      const currentUpdatedAt = current && Number.isFinite(Number(current.updatedAt))
        ? Number(current.updatedAt)
        : 0;
      const sourceUpdatedAt = Number.isFinite(Number(source.updatedAt))
        ? Number(source.updatedAt)
        : now;
      const preferIncoming = !current || sourceUpdatedAt >= currentUpdatedAt;
      const next = {
        ...(current && typeof current === 'object' ? current : {}),
        ...(this._cloneJson(source, {}) || {}),
        blockKey: String(source.blockKey),
        originalHash: typeof source.originalHash === 'string' ? source.originalHash : (current && typeof current.originalHash === 'string' ? current.originalHash : ''),
        targetLang: typeof source.targetLang === 'string' ? source.targetLang : (current && typeof current.targetLang === 'string' ? current.targetLang : 'ru'),
        translatedText: preferIncoming
          ? (typeof source.translatedText === 'string' ? source.translatedText : (current && typeof current.translatedText === 'string' ? current.translatedText : ''))
          : (current && typeof current.translatedText === 'string' ? current.translatedText : ''),
        qualityTag: preferIncoming
          ? (source.qualityTag === 'proofread' ? 'proofread' : (source.qualityTag === 'raw' ? 'raw' : (current && current.qualityTag ? current.qualityTag : 'raw')))
          : (current && current.qualityTag ? current.qualityTag : 'raw'),
        modelUsed: preferIncoming
          ? (typeof source.modelUsed === 'string' ? source.modelUsed : (current && typeof current.modelUsed === 'string' ? current.modelUsed : null))
          : (current && typeof current.modelUsed === 'string' ? current.modelUsed : null),
        routeUsed: preferIncoming
          ? (typeof source.routeUsed === 'string' ? source.routeUsed : (current && typeof current.routeUsed === 'string' ? current.routeUsed : null))
          : (current && typeof current.routeUsed === 'string' ? current.routeUsed : null),
        createdAt: current && Number.isFinite(Number(current.createdAt)) ? Number(current.createdAt) : now,
        updatedAt: preferIncoming ? sourceUpdatedAt : currentUpdatedAt,
        lastUsedAt: now
      };
      const sourcePageKeys = [];
      const pushSourcePage = (value) => {
        const key = typeof value === 'string' ? value.trim() : '';
        if (!key || sourcePageKeys.includes(key)) {
          return;
        }
        sourcePageKeys.push(key);
      };
      (Array.isArray(current && current.sourcePageKeys) ? current.sourcePageKeys : []).forEach(pushSourcePage);
      (Array.isArray(source.sourcePageKeys) ? source.sourcePageKeys : []).forEach(pushSourcePage);
      next.sourcePageKeys = sourcePageKeys.slice(0, this.SOURCE_PAGE_CAP);

      await this._withStore(this.BLOCKS_STORE, 'readwrite', (store, _tx, finish) => {
        const req = store.put(next);
        req.onsuccess = () => finish(true);
      });
      return { ok: true, block: next };
    }

    async removePage(pageKey) {
      const key = typeof pageKey === 'string' ? pageKey.trim() : '';
      if (!key) {
        return { ok: false, removed: false };
      }
      await this._withStore(this.PAGES_STORE, 'readwrite', (store, _tx, finish) => {
        const req = store.delete(key);
        req.onsuccess = () => finish(true);
      });
      const index = await this.getIndex();
      this._removeIndexPageKey(index.byUrl, key);
      this._removeIndexPageKey(index.byDomHash, key);
      await this._putIndex(index);
      return { ok: true, removed: true };
    }

    async removePagesByUrl(normalizedUrl, { targetLang = null } = {}) {
      const url = typeof normalizedUrl === 'string' ? normalizedUrl.trim() : '';
      if (!url) {
        return { ok: false, removed: 0 };
      }
      const index = await this.getIndex();
      const pageKeys = Array.isArray(index.byUrl[url]) ? index.byUrl[url].slice() : [];
      let removed = 0;
      for (let i = 0; i < pageKeys.length; i += 1) {
        const key = pageKeys[i];
        const page = await this.getPage(key);
        if (!page) {
          continue;
        }
        if (targetLang && String(page.targetLang || '').toLowerCase() !== String(targetLang || '').toLowerCase()) {
          continue;
        }
        await this.removePage(key);
        removed += 1;
      }
      return { ok: true, removed };
    }

    async clearAll() {
      await this._withStore(this.PAGES_STORE, 'readwrite', (store, _tx, finish) => {
        const req = store.clear();
        req.onsuccess = () => finish(true);
      });
      await this._withStore(this.BLOCKS_STORE, 'readwrite', (store, _tx, finish) => {
        const req = store.clear();
        req.onsuccess = () => finish(true);
      });
      await this._putIndex({
        v: 1,
        byUrl: {},
        byDomHash: {},
        counters: { pages: 0, blocks: 0 },
        lastGcAt: this._now()
      });
      return { ok: true, cleared: true };
    }

    async findBestPage({ pageKey, normalizedUrl, domHash } = {}) {
      const exactKey = typeof pageKey === 'string' ? pageKey.trim() : '';
      if (exactKey) {
        const exact = await this.getPage(exactKey);
        if (exact) {
          return { page: exact, matchType: 'exact_page_key' };
        }
      }

      const index = await this.getIndex();
      const byUrl = typeof normalizedUrl === 'string' && normalizedUrl
        ? (Array.isArray(index.byUrl[normalizedUrl]) ? index.byUrl[normalizedUrl] : [])
        : [];
      const fromUrl = [];
      for (let i = 0; i < byUrl.length; i += 1) {
        const row = await this.getPage(byUrl[i]);
        if (!row) {
          continue;
        }
        fromUrl.push(row);
      }
      if (fromUrl.length) {
        const sameDom = typeof domHash === 'string' && domHash
          ? fromUrl.find((row) => row && row.domHash === domHash)
          : null;
        if (sameDom) {
          return { page: sameDom, matchType: 'url_dom_match' };
        }
        fromUrl.sort((a, b) => Number(b && b.updatedAt || 0) - Number(a && a.updatedAt || 0));
        return { page: fromUrl[0], matchType: 'url_fallback' };
      }

      const byDom = typeof domHash === 'string' && domHash
        ? (Array.isArray(index.byDomHash[domHash]) ? index.byDomHash[domHash] : [])
        : [];
      for (let i = 0; i < byDom.length; i += 1) {
        const row = await this.getPage(byDom[i]);
        if (row) {
          return { page: row, matchType: 'dom_hash_fallback' };
        }
      }
      return { page: null, matchType: 'miss' };
    }

    async touchPage(pageKey) {
      const page = await this.getPage(pageKey);
      if (!page) {
        return { ok: false, touched: false };
      }
      page.lastUsedAt = this._now();
      await this.upsertPage(page);
      return { ok: true, touched: true };
    }

    async touchBlock(blockKey) {
      const block = await this.getBlock(blockKey);
      if (!block) {
        return { ok: false, touched: false };
      }
      block.lastUsedAt = this._now();
      await this.upsertBlock(block);
      return { ok: true, touched: true };
    }

    async _collectMeta(storeName) {
      await this._ensureDb();
      return this._withStore(storeName, 'readonly', (store, _tx, finish) => {
        const rows = [];
        const req = store.openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) {
            finish(rows);
            return;
          }
          const value = cursor.value || {};
          rows.push(value);
          cursor.continue();
        };
      });
    }

    async getStats() {
      const pages = await this._collectMeta(this.PAGES_STORE);
      const blocks = await this._collectMeta(this.BLOCKS_STORE);
      const index = await this.getIndex();
      const now = this._now();
      const latestPageUsedAt = pages.reduce((max, row) => Math.max(max, Number(row && row.lastUsedAt || 0)), 0);
      const latestBlockUsedAt = blocks.reduce((max, row) => Math.max(max, Number(row && row.lastUsedAt || 0)), 0);
      return {
        ok: true,
        counters: {
          pages: pages.length,
          blocks: blocks.length,
          indexUrlKeys: Object.keys(index.byUrl || {}).length,
          indexDomKeys: Object.keys(index.byDomHash || {}).length
        },
        latest: {
          pageLastUsedAgoMs: latestPageUsedAt ? Math.max(0, now - latestPageUsedAt) : null,
          blockLastUsedAgoMs: latestBlockUsedAt ? Math.max(0, now - latestBlockUsedAt) : null
        },
        lastGcAt: index.lastGcAt || null
      };
    }

    async runGc({ maxPages = 200, maxBlocks = 5000, maxAgeDays = 30, yieldEvery = 80 } = {}) {
      const safeMaxPages = Number.isFinite(Number(maxPages)) ? Math.max(10, Number(maxPages)) : 200;
      const safeMaxBlocks = Number.isFinite(Number(maxBlocks)) ? Math.max(50, Number(maxBlocks)) : 5000;
      const safeMaxAgeDays = Number.isFinite(Number(maxAgeDays)) ? Math.max(1, Number(maxAgeDays)) : 30;
      const safeYieldEvery = Number.isFinite(Number(yieldEvery)) ? Math.max(10, Number(yieldEvery)) : 80;
      const now = this._now();
      const maxAgeMs = safeMaxAgeDays * 24 * 60 * 60 * 1000;

      const pages = await this._collectMeta(this.PAGES_STORE);
      const blocks = await this._collectMeta(this.BLOCKS_STORE);
      const stalePageKeys = [];
      pages.forEach((row) => {
        const ts = Number.isFinite(Number(row && row.lastUsedAt))
          ? Number(row.lastUsedAt)
          : Number(row && row.updatedAt || row && row.createdAt || 0);
        if (!ts || (now - ts) > maxAgeMs) {
          if (row && row.pageKey) {
            stalePageKeys.push(String(row.pageKey));
          }
        }
      });

      const staleBlockKeys = [];
      blocks.forEach((row) => {
        const ts = Number.isFinite(Number(row && row.lastUsedAt))
          ? Number(row.lastUsedAt)
          : Number(row && row.updatedAt || row && row.createdAt || 0);
        if (!ts || (now - ts) > maxAgeMs) {
          if (row && row.blockKey) {
            staleBlockKeys.push(String(row.blockKey));
          }
        }
      });

      const pageRowsByLru = pages
        .map((row) => ({
          pageKey: row && row.pageKey ? String(row.pageKey) : '',
          lru: Number(row && row.lastUsedAt || row && row.updatedAt || row && row.createdAt || 0)
        }))
        .filter((row) => row.pageKey)
        .sort((a, b) => a.lru - b.lru);
      const blockRowsByLru = blocks
        .map((row) => ({
          blockKey: row && row.blockKey ? String(row.blockKey) : '',
          lru: Number(row && row.lastUsedAt || row && row.updatedAt || row && row.createdAt || 0)
        }))
        .filter((row) => row.blockKey)
        .sort((a, b) => a.lru - b.lru);

      const overPage = Math.max(0, pageRowsByLru.length - safeMaxPages);
      const overBlock = Math.max(0, blockRowsByLru.length - safeMaxBlocks);
      const removePageKeys = new Set(stalePageKeys.concat(pageRowsByLru.slice(0, overPage).map((row) => row.pageKey)));
      const removeBlockKeys = new Set(staleBlockKeys.concat(blockRowsByLru.slice(0, overBlock).map((row) => row.blockKey)));

      let removedPages = 0;
      let removedBlocks = 0;

      const pageKeyList = Array.from(removePageKeys);
      for (let i = 0; i < pageKeyList.length; i += 1) {
        await this.removePage(pageKeyList[i]);
        removedPages += 1;
        if ((i + 1) % safeYieldEvery === 0) {
          await new Promise((resolve) => global.setTimeout(resolve, 0));
        }
      }

      const blockKeyList = Array.from(removeBlockKeys);
      if (blockKeyList.length) {
        await this._withStore(this.BLOCKS_STORE, 'readwrite', (store, _tx, finish) => {
          let idx = 0;
          const step = () => {
            if (idx >= blockKeyList.length) {
              finish(true);
              return;
            }
            store.delete(blockKeyList[idx]);
            idx += 1;
            if (idx % safeYieldEvery === 0) {
              global.setTimeout(step, 0);
            } else {
              step();
            }
          };
          step();
        });
        removedBlocks = blockKeyList.length;
      }

      const finalPages = await this._collectMeta(this.PAGES_STORE);
      const finalBlocks = await this._collectMeta(this.BLOCKS_STORE);
      const index = await this.getIndex();
      index.counters = {
        pages: finalPages.length,
        blocks: finalBlocks.length
      };
      index.lastGcAt = now;
      await this._putIndex(index);

      return {
        ok: true,
        removedPages,
        removedBlocks,
        remainingPages: finalPages.length,
        remainingBlocks: finalBlocks.length,
        maxAgeDays: safeMaxAgeDays
      };
    }
  }

  NT.TranslationMemoryStore = TranslationMemoryStore;
})(globalThis);
