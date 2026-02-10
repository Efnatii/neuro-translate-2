(function initHtml(global) {
  const NT = global.NT || (global.NT = {});

  class Html {
    static escape(value) {
      const text = value === null || value === undefined ? '' : String(value);
      return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    static safeText(value, fallback = '') {
      if (value === null || value === undefined) {
        return fallback;
      }
      return String(value);
    }
  }

  NT.Html = Html;
})(globalThis);
