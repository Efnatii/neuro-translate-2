/**
 * DOM signature helper used for page-level translation memory keys.
 *
 * Signature is intentionally text-content agnostic: it uses structural hints
 * (`category`, `pathHint`, stable node key, length bucket) to survive minor
 * text edits while still changing when structure/order changes.
 */
(function initDomSignature(global) {
  const NT = global.NT || (global.NT = {});

  const DOM_SIG_VERSION = 'v1';

  function normalizeCategory(value) {
    const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return raw || 'other';
  }

  function bucketCharCount(length) {
    const numeric = Number.isFinite(Number(length)) ? Math.max(0, Number(length)) : 0;
    if (numeric <= 12) {
      return 's';
    }
    if (numeric <= 32) {
      return 'm';
    }
    if (numeric <= 80) {
      return 'l';
    }
    if (numeric <= 180) {
      return 'xl';
    }
    if (numeric <= 420) {
      return 'xxl';
    }
    return 'huge';
  }

  function buildDomSignatureString(scanResult, { version = DOM_SIG_VERSION } = {}) {
    const blocks = Array.isArray(scanResult)
      ? scanResult
      : (scanResult && Array.isArray(scanResult.blocks) ? scanResult.blocks : []);
    const rows = blocks
      .map((block, index) => {
        if (!block || typeof block !== 'object') {
          return null;
        }
        const category = normalizeCategory(block.category || block.pathHint);
        const pathHint = typeof block.pathHint === 'string' && block.pathHint
          ? block.pathHint
          : 'unknown';
        const stableNodeKey = typeof block.stableNodeKey === 'string' && block.stableNodeKey
          ? block.stableNodeKey
          : (typeof block.blockId === 'string' && block.blockId ? block.blockId : `i${index}`);
        const charCount = Number.isFinite(Number(block.charCount))
          ? Number(block.charCount)
          : (typeof block.originalText === 'string' ? block.originalText.length : 0);
        const bucket = bucketCharCount(charCount);
        return `${index}|${category}|${pathHint}|${stableNodeKey}|${bucket}`;
      })
      .filter(Boolean);
    return `${version}\n${rows.join('\n')}`;
  }

  function fallbackHash(text) {
    const src = typeof text === 'string' ? text : String(text || '');
    let hash = 2166136261;
    for (let i = 0; i < src.length; i += 1) {
      hash ^= src.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return `f${(hash >>> 0).toString(16).padStart(8, '0')}`;
  }

  async function hashTextSha256(text) {
    const src = typeof text === 'string' ? text : String(text || '');
    const cryptoObj = global.crypto || null;
    if (!cryptoObj || !cryptoObj.subtle || typeof cryptoObj.subtle.digest !== 'function' || typeof TextEncoder !== 'function') {
      return fallbackHash(src);
    }
    try {
      const encoded = new TextEncoder().encode(src);
      const digest = await cryptoObj.subtle.digest('SHA-256', encoded);
      const bytes = Array.from(new Uint8Array(digest));
      const hex = bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
      return `s${hex}`;
    } catch (_) {
      return fallbackHash(src);
    }
  }

  async function buildDomSignature(scanResult, { version = DOM_SIG_VERSION } = {}) {
    const signature = buildDomSignatureString(scanResult, { version });
    const domHash = await hashTextSha256(signature);
    const blocks = Array.isArray(scanResult)
      ? scanResult
      : (scanResult && Array.isArray(scanResult.blocks) ? scanResult.blocks : []);
    return {
      domHash,
      domSigVersion: version,
      signaturePreview: signature.slice(0, 260),
      signatureLength: signature.length,
      blockCount: blocks.length
    };
  }

  NT.DomSignature = {
    DOM_SIG_VERSION,
    normalizeCategory,
    bucketCharCount,
    buildDomSignatureString,
    hashTextSha256,
    buildDomSignature,
    fallbackHash
  };
})(globalThis);
