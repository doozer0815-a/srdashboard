(function () {
  function resolveDisplay() {
    const params = new URLSearchParams(location.search);
    const qDisplay = params.get('display');
    const qRange = params.get('range');
    if (qDisplay === 'shooter' || qDisplay === 'master' || qDisplay === 'config' || qDisplay === 'compact' || qDisplay === 'all') {
      return {
        display: qDisplay,
        rangeNum: qDisplay === 'shooter' ? (parseInt(qRange, 10) || 1) : null
      };
    }
    if (/^\/config\/?$/.test(location.pathname)) {
      return { display: 'config', rangeNum: null };
    }
    if (/^\/compact\/?$/.test(location.pathname)) {
      return { display: 'compact', rangeNum: null };
    }
    if (/^\/all\/?$/.test(location.pathname)) {
      return { display: 'master', rangeNum: null, noMenu: true };
    }
    const m = location.pathname.match(/^\/(\d+)\/?$/);
    if (m) {
      return { display: 'shooter', rangeNum: parseInt(m[1], 10) };
    }
    return { display: 'master', rangeNum: null };
  }

  const resolved = resolveDisplay();
  const display = resolved.display;
  window.SRDisplay = resolved;

  const THEME_KEY = 'srdashboard-theme';

  function getTheme() {
    const attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'dark' || attr === 'light') return attr;
    try {
      const stored = localStorage.getItem(THEME_KEY);
      if (stored === 'dark' || stored === 'light') return stored;
    } catch (e) { /* ignore */ }
    return 'light';
  }

  function applyTheme(theme) {
    const next = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* ignore */ }
    document.dispatchEvent(new CustomEvent('srdashboard:themechange', { detail: { theme: next } }));
    return next;
  }

  function toggleTheme() {
    return applyTheme(getTheme() === 'dark' ? 'light' : 'dark');
  }

  window.SRTheme = {
    get: getTheme,
    set: applyTheme,
    toggle: toggleTheme
  };

  const SHOT_SAT_KEY = 'srdashboard-shot-sat';
  const FALLBACK_SHOT_SAT = 48;

  function clampShotSat(n, fallback) {
    const fb = fallback != null ? fallback : FALLBACK_SHOT_SAT;
    n = Math.round(Number(n));
    if (!Number.isFinite(n)) return fb;
    return Math.max(0, Math.min(100, n));
  }

  /** Theme CSS default (--shot-sat on :root / [data-theme]), not a hardcoded constant. */
  function themeShotSatDefault() {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue('--shot-sat').trim();
      const n = Number(v);
      if (Number.isFinite(n)) return clampShotSat(n, FALLBACK_SHOT_SAT);
    } catch (e) { /* ignore */ }
    return FALLBACK_SHOT_SAT;
  }

  function getShotSat() {
    const inline = document.documentElement.style.getPropertyValue('--shot-sat').trim();
    if (inline !== '') {
      const n = Number(inline);
      if (Number.isFinite(n)) return clampShotSat(n, themeShotSatDefault());
    }
    try {
      const stored = localStorage.getItem(SHOT_SAT_KEY);
      if (stored != null && stored !== '') return clampShotSat(stored, themeShotSatDefault());
    } catch (e) { /* ignore */ }
    return themeShotSatDefault();
  }

  function applyShotSat(sat, opts) {
    const next = clampShotSat(sat, themeShotSatDefault());
    document.documentElement.style.setProperty('--shot-sat', String(next));
    try { localStorage.setItem(SHOT_SAT_KEY, String(next)); } catch (e) { /* ignore */ }
    if (!opts || opts.emit !== false) {
      document.dispatchEvent(new CustomEvent('srdashboard:shotsatchange', { detail: { sat: next } }));
    }
    return next;
  }

  window.SRShotSat = {
    get: getShotSat,
    set: applyShotSat,
    get default() { return themeShotSatDefault(); }
  };

  const SHOT_MODE_KEY = 'srdashboard-shot-mode';
  const DEFAULT_SHOT_MODE = 'rainbow';

  function normalizeShotMode(mode) {
    if (mode === 'rainbow' || mode == null || mode === '') return 'rainbow';
    const n = Number(mode);
    if (Number.isFinite(n) && n >= 0 && n <= 9) return Math.round(n);
    return DEFAULT_SHOT_MODE;
  }

  function getShotMode() {
    const inline = document.documentElement.style.getPropertyValue('--shot-mode').trim();
    if (inline) return normalizeShotMode(inline);
    try {
      const stored = localStorage.getItem(SHOT_MODE_KEY);
      if (stored != null && stored !== '') return normalizeShotMode(stored);
    } catch (e) { /* ignore */ }
    return DEFAULT_SHOT_MODE;
  }

  function applyShotMode(mode, opts) {
    const next = normalizeShotMode(mode);
    document.documentElement.style.setProperty('--shot-mode', String(next));
    try { localStorage.setItem(SHOT_MODE_KEY, String(next)); } catch (e) { /* ignore */ }
    if (!opts || opts.emit !== false) {
      document.dispatchEvent(new CustomEvent('srdashboard:shotmodechange', { detail: { mode: next } }));
    }
    return next;
  }

  window.SRShotMode = {
    get: getShotMode,
    set: applyShotMode,
    default: DEFAULT_SHOT_MODE
  };

  // Listener role: admin (full control) vs public (read-only view port).
  window.SRMode = {
    role: 'admin',
    canControl: true,
    ready: null
  };
  window.SRMode.ready = fetch('/api/mode')
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (data) {
      const role = data && data.role === 'public' ? 'public' : 'admin';
      window.SRMode.role = role;
      window.SRMode.canControl = role !== 'public';
      document.documentElement.setAttribute('data-role', role);
      return window.SRMode;
    })
    .catch(function () {
      document.documentElement.setAttribute('data-role', 'admin');
      return window.SRMode;
    });

  document.addEventListener('DOMContentLoaded', function () {
    const chrome = document.getElementById('master-chrome');
    const shooter = document.getElementById('shooter-app');
    const config = document.getElementById('config-app');
    if (display === 'shooter') {
      if (chrome) chrome.hidden = true;
      if (config) config.hidden = true;
      if (shooter) shooter.hidden = false;
    } else if (display === 'config') {
      if (chrome) chrome.hidden = true;
      if (shooter) shooter.hidden = true;
      if (config) config.hidden = false;
      document.body.classList.add('config-display');
    } else {
      if (shooter) shooter.hidden = true;
      if (config) config.hidden = true;
      if (chrome) chrome.hidden = false;
      if (display === 'compact') document.body.classList.add('compact-display');
      if (resolved.noMenu) document.body.classList.add('hall-no-menu');
    }
  });
})();
