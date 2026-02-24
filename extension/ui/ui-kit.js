(function initUiKit(global) {
  const NT = global.NT || (global.NT = {});

  function createElement(tagName, options = {}) {
    const el = global.document.createElement(String(tagName || 'div'));
    if (options.className) {
      el.className = String(options.className);
    }
    if (options.text !== undefined && options.text !== null) {
      el.textContent = String(options.text);
    }
    if (options.attrs && typeof options.attrs === 'object') {
      Object.keys(options.attrs).forEach((key) => {
        const value = options.attrs[key];
        if (value === null || value === undefined) {
          return;
        }
        el.setAttribute(key, String(value));
      });
    }
    if (Array.isArray(options.children)) {
      options.children.forEach((child) => {
        if (!child) {
          return;
        }
        el.appendChild(child);
      });
    }
    return el;
  }

  function clearNode(el) {
    if (!el) {
      return;
    }
    while (el.firstChild) {
      el.removeChild(el.firstChild);
    }
  }

  function setText(el, value, fallback = '') {
    if (!el) {
      return;
    }
    const next = value === null || value === undefined || value === ''
      ? String(fallback)
      : String(value);
    if (el.textContent !== next) {
      el.textContent = next;
    }
  }

  function setHidden(el, hidden) {
    if (!el) {
      return;
    }
    el.hidden = hidden === true;
  }

  function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function createBadge(text, tone = 'neutral') {
    return createElement('span', {
      className: `nt-badge nt-badge--${tone}`,
      text: text || ''
    });
  }

  class RenderScheduler {
    constructor() {
      this._tasks = [];
      this._scheduled = false;
    }

    queueRender(fn) {
      if (typeof fn !== 'function') {
        return;
      }
      this._tasks.push(fn);
      if (this._scheduled) {
        return;
      }
      this._scheduled = true;
      const flush = () => {
        this._scheduled = false;
        const queue = this._tasks.slice();
        this._tasks.length = 0;
        for (let i = 0; i < queue.length; i += 1) {
          try {
            queue[i]();
          } catch (_) {
            // best-effort rendering
          }
        }
      };
      if (typeof global.requestAnimationFrame === 'function') {
        global.requestAnimationFrame(flush);
      } else {
        global.setTimeout(flush, 16);
      }
    }
  }

  class Accordion {
    constructor(root, { onToggle } = {}) {
      this.root = root || null;
      this.onToggle = typeof onToggle === 'function' ? onToggle : null;
      this.state = {};
      this._boundClick = this._onClick.bind(this);
      if (this.root) {
        this.root.addEventListener('click', this._boundClick);
      }
    }

    destroy() {
      if (this.root) {
        this.root.removeEventListener('click', this._boundClick);
      }
    }

    setOpen(id, isOpen) {
      if (!this.root || !id) {
        return;
      }
      const section = this.root.querySelector(`[data-acc-section="${id}"]`);
      const body = this.root.querySelector(`[data-acc-body="${id}"]`);
      const toggle = this.root.querySelector(`[data-acc-toggle="${id}"]`);
      if (!section || !body || !toggle) {
        return;
      }
      const open = Boolean(isOpen);
      section.setAttribute('data-open', open ? 'true' : 'false');
      body.hidden = !open;
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      this.state[id] = open;
      if (this.onToggle) {
        this.onToggle(id, open, { ...this.state });
      }
    }

    sync(stateMap) {
      const src = stateMap && typeof stateMap === 'object' ? stateMap : {};
      Object.keys(src).forEach((id) => {
        this.setOpen(id, src[id] === true);
      });
    }

    _onClick(event) {
      if (!event || !event.target || typeof event.target.closest !== 'function') {
        return;
      }
      const btn = event.target.closest('[data-acc-toggle]');
      if (!btn || !this.root || !this.root.contains(btn)) {
        return;
      }
      const id = btn.getAttribute('data-acc-toggle');
      if (!id) {
        return;
      }
      const section = this.root.querySelector(`[data-acc-section="${id}"]`);
      const currentlyOpen = section && section.getAttribute('data-open') === 'true';
      this.setOpen(id, !currentlyOpen);
    }
  }

  class Toasts {
    constructor(host) {
      this.host = host || null;
    }

    show(message, { tone = 'info', timeoutMs = 2600 } = {}) {
      if (!this.host || !message) {
        return;
      }
      const item = createElement('div', {
        className: `nt-toast nt-toast--${tone}`,
        text: String(message)
      });
      this.host.appendChild(item);
      const ttl = Math.max(900, Number(timeoutMs) || 2600);
      global.setTimeout(() => {
        try {
          item.remove();
        } catch (_) {
          // ignore
        }
      }, ttl);
    }
  }

  function debounce(fn, waitMs = 220) {
    let timer = null;
    return function debounced(...args) {
      if (timer) {
        global.clearTimeout(timer);
      }
      timer = global.setTimeout(() => {
        timer = null;
        fn.apply(this, args);
      }, Math.max(40, Number(waitMs) || 220));
    };
  }

  NT.Ui = {
    createElement,
    clearNode,
    setText,
    setHidden,
    escapeHtml,
    createBadge,
    RenderScheduler,
    Accordion,
    Toasts,
    debounce
  };
})(globalThis);
