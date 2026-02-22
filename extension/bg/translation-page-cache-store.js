/**
 * Persistent cache for already translated pages.
 *
 * Cache key combines normalized URL + target language. Entries also include a
 * page signature so stale cache can be skipped when DOM text changed.
 */
(function initTranslationPageCacheStore(global) {
  const NT = global.NT || (global.NT = {});

  class TranslationPageCacheStore extends NT.ChromeLocalStoreBase {
    constructor({ chromeApi, maxEntries = 80, maxAgeMs = 14 * 24 * 60 * 60 * 1000 } = {}) {
      super({ chromeApi });
      this.maxEntries = Number.isFinite(Number(maxEntries)) ? Math.max(10, Number(maxEntries)) : 80;
      this.maxAgeMs = Number.isFinite(Number(maxAgeMs)) ? Math.max(60 * 1000, Number(maxAgeMs)) : (14 * 24 * 60 * 60 * 1000);
      this.DEFAULTS = {
        translationPageCache: {}
      };
    }

    async getSnapshot() {
      const data = await this.storageGet(this.DEFAULTS);
      const cache = data && data.translationPageCache && typeof data.translationPageCache === 'object'
        ? { ...data.translationPageCache }
        : {};
      return { translationPageCache: cache };
    }

    buildKey({ url, targetLang } = {}) {
      const normalizedUrl = this.normalizeUrl(url);
      const lang = typeof targetLang === 'string' && targetLang.trim() ? targetLang.trim().toLowerCase() : 'ru';
      return `${lang}::${normalizedUrl}`;
    }

    normalizeUrl(url) {
      if (typeof url !== 'string' || !url) {
        return 'about:blank';
      }
      try {
        const parsed = new URL(url);
        const pathname = parsed.pathname || '/';
        return `${parsed.origin}${pathname}`;
      } catch (_) {
        return url.split('#')[0].split('?')[0];
      }
    }

    async getEntry({ url, targetLang, key } = {}) {
      const cacheKey = key || this.buildKey({ url, targetLang });
      const snapshot = await this.getSnapshot();
      return snapshot.translationPageCache[cacheKey] || null;
    }

    async putEntry({
      url,
      targetLang,
      signature,
      items,
      blockCount = 0,
      modelSpecs = [],
      profile = 'auto',
      categoryMode = 'all',
      categories = [],
      toolMode = {},
      contextSummary = ''
    } = {}) {
      const cacheKey = this.buildKey({ url, targetLang });
      if (!signature || !Array.isArray(items) || !items.length) {
        return null;
      }

      const normalizedItems = items
        .filter((item) => item && item.blockId && typeof item.text === 'string')
        .slice(0, 5000)
        .map((item) => ({
          blockId: String(item.blockId),
          text: item.text
        }));
      if (!normalizedItems.length) {
        return null;
      }

      const now = Date.now();
      const snapshot = await this.getSnapshot();
      snapshot.translationPageCache[cacheKey] = {
        key: cacheKey,
        url: this.normalizeUrl(url),
        targetLang: typeof targetLang === 'string' && targetLang ? targetLang : 'ru',
        signature,
        blockCount: Number.isFinite(Number(blockCount)) ? Number(blockCount) : normalizedItems.length,
        items: normalizedItems,
        profile: profile || 'auto',
        categoryMode: categoryMode || 'all',
        categories: Array.isArray(categories) ? categories.slice(0, 24) : [],
        toolMode: toolMode && typeof toolMode === 'object' ? { ...toolMode } : {},
        modelSpecs: Array.isArray(modelSpecs) ? modelSpecs.slice(0, 20) : [],
        contextSummary: typeof contextSummary === 'string' ? contextSummary.slice(0, 1800) : '',
        createdAt: now,
        updatedAt: now
      };

      this._pruneEntries(snapshot.translationPageCache, now);
      await this.storageSet({ translationPageCache: snapshot.translationPageCache });
      return snapshot.translationPageCache[cacheKey];
    }

    async removeEntry({ url, targetLang, key } = {}) {
      const cacheKey = key || this.buildKey({ url, targetLang });
      const snapshot = await this.getSnapshot();
      if (!Object.prototype.hasOwnProperty.call(snapshot.translationPageCache, cacheKey)) {
        return false;
      }
      delete snapshot.translationPageCache[cacheKey];
      await this.storageSet({ translationPageCache: snapshot.translationPageCache });
      return true;
    }

    async clear() {
      await this.storageSet({ translationPageCache: {} });
      return { ok: true };
    }

    _pruneEntries(cacheMap, nowTs) {
      const map = cacheMap && typeof cacheMap === 'object' ? cacheMap : {};
      const keys = Object.keys(map);
      if (!keys.length) {
        return;
      }

      keys.forEach((key) => {
        const entry = map[key];
        if (!entry || typeof entry !== 'object') {
          delete map[key];
          return;
        }
        const updatedAt = Number.isFinite(Number(entry.updatedAt)) ? Number(entry.updatedAt) : 0;
        if (updatedAt > 0 && (nowTs - updatedAt) > this.maxAgeMs) {
          delete map[key];
        }
      });

      const aliveKeys = Object.keys(map);
      if (aliveKeys.length <= this.maxEntries) {
        return;
      }

      aliveKeys
        .map((key) => ({
          key,
          updatedAt: Number.isFinite(Number(map[key] && map[key].updatedAt)) ? Number(map[key].updatedAt) : 0
        }))
        .sort((a, b) => a.updatedAt - b.updatedAt)
        .slice(0, Math.max(0, aliveKeys.length - this.maxEntries))
        .forEach((item) => {
          delete map[item.key];
        });
    }
  }

  NT.TranslationPageCacheStore = TranslationPageCacheStore;
})(globalThis);

