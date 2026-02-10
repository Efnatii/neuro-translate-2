(function initTime(global) {
  const NT = global.NT || (global.NT = {});

  class Time {
    static now() {
      return Date.now();
    }

    static clamp(value, minValue, maxValue) {
      if (typeof value !== 'number') {
        return typeof minValue === 'number' ? minValue : 0;
      }
      const min = typeof minValue === 'number' ? minValue : value;
      const max = typeof maxValue === 'number' ? maxValue : value;
      return Math.min(Math.max(value, min), max);
    }

    static formatTime(timestamp, { fallback = '—', locale } = {}) {
      if (typeof timestamp !== 'number') {
        return fallback;
      }
      const date = new Date(timestamp);
      if (Number.isNaN(date.getTime())) {
        return fallback;
      }
      return locale ? date.toLocaleTimeString(locale) : date.toLocaleTimeString();
    }
  }

  NT.Time = Time;
})(globalThis);
