/**
 * Deterministic block classifier for translation categories.
 *
 * Classifier is intentionally rule-based (no LLM dependency) and returns
 * explainable decisions with confidence scores.
 */
(function initDomClassifier(global) {
  const NT = global.NT || (global.NT = {});

  const CATEGORY_ORDER = Object.freeze([
    'main_content',
    'headings',
    'navigation',
    'ui_controls',
    'tables',
    'code',
    'captions',
    'footer',
    'legal',
    'ads',
    'unknown'
  ]);

  const LEGACY_CATEGORY_MAP = Object.freeze({
    heading: 'headings',
    paragraph: 'main_content',
    list: 'main_content',
    quote: 'main_content',
    button: 'ui_controls',
    label: 'ui_controls',
    navigation: 'navigation',
    table: 'tables',
    code: 'code',
    meta: 'footer',
    other: 'unknown'
  });

  function normalizeCategory(input) {
    const raw = typeof input === 'string' ? input.trim().toLowerCase() : '';
    if (!raw) {
      return 'unknown';
    }
    if (CATEGORY_ORDER.includes(raw)) {
      return raw;
    }
    if (Object.prototype.hasOwnProperty.call(LEGACY_CATEGORY_MAP, raw)) {
      return LEGACY_CATEGORY_MAP[raw];
    }
    return 'unknown';
  }

  function ensureArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function normalizeFeatures(block) {
    const src = block && block.features && typeof block.features === 'object'
      ? block.features
      : {};
    const classTokens = ensureArray(src.classTokens)
      .map((token) => String(token || '').trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 12);
    const tag = String(src.tag || '').trim().toLowerCase();
    const role = String(src.role || '').trim().toLowerCase();
    const textLen = Number.isFinite(Number(src.textLen))
      ? Number(src.textLen)
      : (typeof block.originalText === 'string' ? block.originalText.length : 0);
    return {
      ...src,
      tag,
      role,
      textLen,
      classTokens
    };
  }

  function uniqueReasons(items) {
    const out = [];
    ensureArray(items).forEach((item) => {
      const reason = String(item || '').trim();
      if (!reason || out.includes(reason)) {
        return;
      }
      out.push(reason);
    });
    return out.slice(0, 16);
  }

  function summarize(byBlockId) {
    const countsByCategory = {};
    const byCategory = {};
    const confidenceList = [];
    CATEGORY_ORDER.forEach((category) => {
      countsByCategory[category] = 0;
      byCategory[category] = [];
    });
    Object.keys(byBlockId || {}).forEach((blockId) => {
      const row = byBlockId[blockId] || {};
      const category = normalizeCategory(row.category);
      const confidence = Number.isFinite(Number(row.confidence))
        ? Math.max(0, Math.min(1, Number(row.confidence)))
        : 0;
      countsByCategory[category] = (countsByCategory[category] || 0) + 1;
      byCategory[category].push(confidence);
      confidenceList.push(confidence);
    });
    const confidenceStats = {
      avg: confidenceList.length
        ? Number((confidenceList.reduce((acc, value) => acc + value, 0) / confidenceList.length).toFixed(3))
        : 0,
      min: confidenceList.length ? Number(Math.min(...confidenceList).toFixed(3)) : 0,
      max: confidenceList.length ? Number(Math.max(...confidenceList).toFixed(3)) : 0,
      byCategory: {}
    };
    CATEGORY_ORDER.forEach((category) => {
      const values = byCategory[category];
      confidenceStats.byCategory[category] = {
        count: values.length,
        avg: values.length ? Number((values.reduce((acc, value) => acc + value, 0) / values.length).toFixed(3)) : 0,
        min: values.length ? Number(Math.min(...values).toFixed(3)) : 0,
        max: values.length ? Number(Math.max(...values).toFixed(3)) : 0
      };
    });
    return {
      countsByCategory,
      confidenceStats
    };
  }

  function fnv1aHash(input) {
    const text = String(input || '');
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return hash >>> 0;
  }

  class DomClassifier {
    constructor() {
      this.categoryOrder = CATEGORY_ORDER.slice();
    }

    classifyBlocks(blocks, env) {
      const list = Array.isArray(blocks) ? blocks : [];
      const safeEnv = env && typeof env === 'object' ? env : {};
      const byBlockId = {};
      list.forEach((block, index) => {
        if (!block || typeof block !== 'object') {
          return;
        }
        const blockId = block.blockId || `b${index}`;
        byBlockId[blockId] = this._classifyOne(block, safeEnv);
      });
      return {
        byBlockId,
        summary: summarize(byBlockId)
      };
    }

    _classifyOne(block, env) {
      const features = normalizeFeatures(block);
      const reasons = [];
      const candidates = [];
      const classTokens = new Set(ensureArray(features.classTokens));
      const tokenHas = (token) => classTokens.has(String(token || '').toLowerCase());
      const tokenHasAny = (tokens) => ensureArray(tokens).some((token) => tokenHas(token));
      const tag = features.tag;
      const role = features.role;
      const textLen = Number.isFinite(Number(features.textLen)) ? Number(features.textLen) : 0;
      const docLang = typeof env.documentLang === 'string' ? env.documentLang.trim().toLowerCase() : '';

      const pushReason = (id) => {
        const reason = String(id || '').trim();
        if (!reason || reasons.includes(reason)) {
          return;
        }
        reasons.push(reason);
      };
      const addCandidate = (category, confidence, reasonId) => {
        const normalizedCategory = normalizeCategory(category);
        const safeConfidence = Math.max(0, Math.min(1, Number.isFinite(Number(confidence)) ? Number(confidence) : 0));
        candidates.push({
          category: normalizedCategory,
          confidence: safeConfidence,
          reason: reasonId
        });
        pushReason(reasonId);
      };

      if (features.isHidden) {
        addCandidate('unknown', 0.22, 'rule:hidden');
        return {
          category: 'unknown',
          confidence: 0.22,
          reasons: uniqueReasons(reasons)
        };
      }

      const isHeading = /^h[1-6]$/.test(tag);
      const isNavigation = Boolean(
        features.isInNav
        || role === 'navigation'
        || tokenHasAny(['nav', 'menu', 'breadcrumb', 'breadcrumbs'])
      );
      const isUiControl = Boolean(
        features.isEditable
        || tag === 'input'
        || tag === 'textarea'
        || tag === 'button'
        || tag === 'select'
        || tag === 'option'
        || tag === 'label'
        || role === 'button'
      );
      const isTable = Boolean(
        features.hasTableContext
        || tag === 'table'
        || tag === 'thead'
        || tag === 'tbody'
        || tag === 'tr'
        || tag === 'th'
        || tag === 'td'
        || tag === 'caption'
      );
      const isCode = Boolean(
        features.isCodeLike
        || tag === 'pre'
        || tag === 'code'
        || tag === 'kbd'
        || tag === 'samp'
      );
      const isCaption = Boolean(
        tag === 'figcaption'
        || tag === 'caption'
        || tokenHasAny(['caption', 'figcaption', 'legend'])
      );
      const isFooter = Boolean(features.isInFooter || tokenHasAny(['footer', 'copyright']));
      const isLegal = Boolean(tokenHasAny(['cookie', 'consent', 'privacy', 'terms', 'disclaimer', 'legal']));
      const isAdLike = Boolean(tokenHasAny(['ad', 'ads', 'sponsored', 'banner', 'promo', 'advert']));

      if (isNavigation) {
        if (features.isInNav || role === 'navigation') {
          pushReason('rule:isInNav');
        }
        if (tokenHas('breadcrumb') || tokenHas('breadcrumbs')) {
          pushReason('rule:classToken:breadcrumb');
        }
        if (tokenHas('nav') || tokenHas('menu')) {
          pushReason('rule:classToken:navigation');
        }
        addCandidate('navigation', 0.93, 'rule:navigation');
      }
      if (isHeading) {
        pushReason('rule:tag:heading');
        addCandidate('headings', 0.97, 'rule:headings');
      }
      if (isUiControl) {
        if (features.isEditable) {
          pushReason('rule:isEditable');
        }
        if (role === 'button') {
          pushReason('rule:role:button');
        }
        addCandidate('ui_controls', 0.94, 'rule:ui_controls');
      }
      if (isTable) {
        if (features.hasTableContext) {
          pushReason('rule:tableContext');
        }
        addCandidate('tables', 0.87, 'rule:tables');
      }
      if (isCode) {
        pushReason('rule:isCodeLike');
        addCandidate('code', 0.95, 'rule:code');
      }
      if (isCaption) {
        pushReason('rule:caption');
        addCandidate('captions', 0.81, 'rule:captions');
      }
      if (isFooter) {
        pushReason('rule:isInFooter');
        addCandidate('footer', 0.91, 'rule:footer');
      }
      if (isLegal) {
        if (tokenHas('cookie') || tokenHas('consent')) {
          pushReason('rule:legal:consent');
        }
        if (tokenHas('privacy') || tokenHas('terms')) {
          pushReason('rule:legal:policy');
        }
        addCandidate('legal', 0.92, 'rule:legal');
      }
      if (isAdLike) {
        pushReason('rule:adHeuristic');
        addCandidate('ads', 0.79, 'rule:ads');
      }
      if (features.isInMain && textLen > 48) {
        pushReason('rule:isInMain');
        pushReason('rule:textLen:content');
        addCandidate('main_content', textLen > 120 ? 0.88 : 0.76, 'rule:main_content');
      }

      if (!candidates.length) {
        const pathHint = typeof block.pathHint === 'string' ? block.pathHint.toLowerCase() : '';
        if (!textLen && !pathHint) {
          return { category: 'unknown', confidence: 0.2, reasons: ['rule:empty'] };
        }
        if (pathHint.includes('nav') || pathHint.includes('menu')) {
          return { category: 'navigation', confidence: 0.62, reasons: ['rule:pathHint:navigation'] };
        }
        if (pathHint.includes('table')) {
          return { category: 'tables', confidence: 0.62, reasons: ['rule:pathHint:tables'] };
        }
        if (pathHint.includes('footer')) {
          return { category: 'footer', confidence: 0.64, reasons: ['rule:pathHint:footer'] };
        }
        if (textLen > 80 || (docLang && features.langHint && features.langHint === docLang)) {
          return { category: 'main_content', confidence: 0.58, reasons: ['rule:fallback:main_content'] };
        }
        return { category: 'unknown', confidence: 0.35, reasons: ['rule:fallback:unknown'] };
      }

      const best = candidates
        .slice()
        .sort((left, right) => {
          if (right.confidence !== left.confidence) {
            return right.confidence - left.confidence;
          }
          return CATEGORY_ORDER.indexOf(left.category) - CATEGORY_ORDER.indexOf(right.category);
        })[0];
      return {
        category: normalizeCategory(best.category),
        confidence: Number(best.confidence.toFixed(3)),
        reasons: uniqueReasons(reasons.length ? reasons : [best.reason || 'rule:fallback'])
      };
    }

    static computeDomHash(blocks) {
      const list = Array.isArray(blocks) ? blocks : [];
      const payload = list
        .map((block, index) => {
          const row = block && typeof block === 'object' ? block : {};
          const blockId = row.blockId || `b${index}`;
          const originalText = typeof row.originalText === 'string' ? row.originalText : '';
          const pathHint = typeof row.pathHint === 'string' ? row.pathHint : '';
          const domOrder = Number.isFinite(Number(row.domOrder)) ? Number(row.domOrder) : index;
          return `${blockId}|${originalText.length}|${pathHint}|${domOrder}`;
        })
        .join('\n');
      const hash = fnv1aHash(payload).toString(16);
      return `dom:${list.length}:${hash}`;
    }

    static normalizeCategory(input) {
      return normalizeCategory(input);
    }
  }

  DomClassifier.VERSION = 'dom-classifier/1.0.0';
  DomClassifier.CATEGORIES = CATEGORY_ORDER.slice();

  NT.DomClassifier = DomClassifier;
})(globalThis);
