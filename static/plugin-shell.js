// Shared Web Audio: unlock on first tap, then play decoded files from /sfx/.
window.SRAudio = (function () {
  const BASE = '/sfx/';
  const EXTS = ['.mp3', '.ogg', '.m4a', '.wav'];
  const DEFAULT_CUES = ['hit-glass', 'hit-glass-far', 'bingo'];

  let ctx = null;
  let master = null;
  const buffers = {};
  const loading = {};
  const missing = {};

  function ensure() {
    if (!ctx) {
      try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { /* */ }
      if (ctx) {
        master = ctx.createGain();
        master.gain.value = 1;
        master.connect(ctx.destination);
      }
    }
    if (ctx && ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      ctx.resume().catch(function () {});
    }
    return ctx;
  }

  function decode(c, arr) {
    const copy = arr.slice(0);
    return new Promise(function (resolve, reject) {
      if (c.decodeAudioData.length === 1) {
        c.decodeAudioData(copy).then(resolve, reject);
      } else {
        c.decodeAudioData(copy, resolve, reject);
      }
    });
  }

  function start(buf, gain) {
    const c = ensure();
    if (!c || !buf || !master) return;
    const src = c.createBufferSource();
    src.buffer = buf;
    const g = c.createGain();
    g.gain.value = gain == null ? 1 : gain;
    src.connect(g);
    g.connect(master);
    src.start();
  }

  function load(name, force) {
    if (force) delete missing[name];
    if (buffers[name]) return Promise.resolve(buffers[name]);
    if (missing[name]) return Promise.resolve(null);
    if (loading[name]) return loading[name];
    const c = ensure();
    if (!c) return Promise.resolve(null);
    loading[name] = (function next(i) {
      if (i >= EXTS.length) {
        missing[name] = true;
        return Promise.resolve(null);
      }
      return fetch(BASE + encodeURIComponent(name) + EXTS[i], { cache: 'no-cache' }).then(function (res) {
        if (!res.ok) return next(i + 1);
        return res.arrayBuffer().then(function (arr) {
          return decode(c, arr);
        }).then(function (buf) {
          buffers[name] = buf;
          delete missing[name];
          return buf;
        });
      }).catch(function () {
        return next(i + 1);
      });
    })(0);
    return loading[name].then(function (buf) {
      delete loading[name];
      return buf;
    });
  }

  function play(name, opts) {
    opts = opts || {};
    return load(name, opts.retry).then(function (buf) {
      if (!buf && opts.fallbackName && opts.fallbackName !== name) {
        return play(opts.fallbackName, {
          gain: opts.fallbackGain == null ? 0.45 : opts.fallbackGain
        });
      }
      if (!buf) return false;
      start(buf, opts.gain);
      return true;
    });
  }

  function playOr(name, opts, fallback) {
    return play(name, opts).then(function (ok) {
      if (!ok && typeof fallback === 'function') fallback();
      return ok;
    });
  }

  function install(name, buf) {
    if (!name || !buf) return;
    buffers[name] = buf;
    delete missing[name];
  }

  function installFile(name, file) {
    const c = ensure();
    if (!c || !file) return Promise.resolve(false);
    return file.arrayBuffer().then(function (arr) {
      return decode(c, arr);
    }).then(function (buf) {
      install(name, buf);
      return true;
    }).catch(function () {
      return false;
    });
  }

  function preload(names) {
    (names || DEFAULT_CUES).forEach(function (n) { load(n); });
  }

  function has(name) {
    return !!buffers[name];
  }

  function arm() {
    const unlock = function () {
      ensure();
      preload();
    };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('touchstart', unlock, true);
    window.addEventListener('keydown', unlock, true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', arm);
  } else {
    arm();
  }

  return {
    ensure: ensure,
    load: load,
    play: play,
    playOr: playOr,
    install: install,
    installFile: installFile,
    preload: preload,
    has: has,
    cues: DEFAULT_CUES
  };
})();

window.SRPluginShell = (function () {
  // Loads a plugin's view.js, then delegates to SRPlugins / SRPluginViews.
  const loadedScripts = {}; // pluginId -> <script> element
  const loadingScripts = {}; // pluginId -> in-flight Promise
  const loadedThemes = {}; // pluginId -> <link> element
  let activePluginId = '';

  function deactivatePlugin(pluginId) {
    if (!pluginId) return;
    try {
      const plugin = window.SRPlugins && window.SRPlugins[pluginId];
      const view = window.SRPluginViews && window.SRPluginViews[pluginId];
      const deactivate = (plugin && plugin.deactivate) || (view && view.deactivate);
      if (typeof deactivate === 'function') deactivate();
    } catch (err) {
      console.warn('Plugin-Deaktivierung fehlgeschlagen:', pluginId, err);
    }
  }

  function setActivePlugin(pluginId) {
    const nextId = pluginId || '';
    if (activePluginId && activePluginId !== nextId) deactivatePlugin(activePluginId);
    activePluginId = nextId;
  }

  function deactivateActivePlugin() {
    if (activePluginId) deactivatePlugin(activePluginId);
    activePluginId = '';
  }

  function removeTheme(pluginId) {
    const link = loadedThemes[pluginId];
    if (link && link.parentNode) link.parentNode.removeChild(link);
    delete loadedThemes[pluginId];
  }

  function unloadOtherThemes(activePluginId) {
    Object.keys(loadedThemes).forEach(function (id) {
      if (id !== activePluginId) removeTheme(id);
    });
  }

  // Plugin views may only be loaded from this server's own /plugins/{id}/ tree,
  // so a bad API response cannot turn into arbitrary script execution.
  function resolveViewUrl(pluginId, viewUrl) {
    const url = new URL(viewUrl, location.origin);
    if (url.origin !== location.origin) return null;
    const prefix = '/plugins/' + encodeURIComponent(pluginId) + '/';
    if (url.pathname.indexOf(prefix) !== 0) return null;
    return url;
  }

  async function ensureViewScript(pluginId, viewUrl) {
    if (loadedScripts[pluginId]) return;
    if (loadingScripts[pluginId]) return loadingScripts[pluginId];
    const url = resolveViewUrl(pluginId, viewUrl);
    if (!url) throw new Error('refusing to load plugin view from ' + viewUrl);
    url.searchParams.set('t', String(Date.now()));
    const script = document.createElement('script');
    // Six hall lanes used to race this check and insert view.js six times.
    // Classic scripts share the window scope, so a second load with top-level
    // const/let throws "Identifier has already been declared".
    loadingScripts[pluginId] = new Promise(function (resolve, reject) {
      script.src = url.pathname + url.search;
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    }).then(function () {
      loadedScripts[pluginId] = script;
      delete loadingScripts[pluginId];
    }, function (err) {
      delete loadingScripts[pluginId];
      throw err;
    });
    return loadingScripts[pluginId];
  }

  function ensureTheme(pluginId, themeUrl) {
    unloadOtherThemes(pluginId || '');
    if (!themeUrl) {
      if (pluginId) removeTheme(pluginId);
      return;
    }
    const url = resolveViewUrl(pluginId, themeUrl);
    if (!url) return;
    const path = url.pathname;
    let link = loadedThemes[pluginId];
    // Keep the same stylesheet once loaded — reassigning href with a fresh
    // ?t= on every render caused FOUC / flicker on live polls and updates.
    // clearCache() / plugin switch still forces a reload.
    if (link && link.dataset.themePath === path) return;
    if (!link) {
      link = document.createElement('link');
      link.rel = 'stylesheet';
      link.dataset.pluginTheme = pluginId;
      document.head.appendChild(link);
      loadedThemes[pluginId] = link;
    }
    link.dataset.themePath = path;
    url.searchParams.set('t', String(Date.now()));
    link.href = url.pathname + url.search;
  }

  async function renderPluginView(container, pluginId, viewUrl, assetsBase, viewModel, themeUrl) {
    if (!container) return;
    // In einer Anzeige ist jeweils nur das aktive Plugin audio-/timerberechtigt.
    // Bei einem Wechsel wird die vorherige View vor dem Rendern deaktiviert.
    setActivePlugin(pluginId);
    try {
      if (container.dataset.pluginId !== pluginId) {
        container.innerHTML = '';
        container.dataset.pluginId = pluginId || '';
      }
      await ensureViewScript(pluginId, viewUrl);
      ensureTheme(pluginId, themeUrl);
      // Prefer the per-plugin registration: SRPlugins.render is a single global
      // that every loaded plugin overwrites, so the last script to load wins.
      const fn = window.SRPluginViews && window.SRPluginViews[pluginId];
      if (typeof fn === 'function') {
        // Await async plugin paints (fox/Autorennen) so overlapping live remounts cannot
        // interleave skeleton + Scheibe/Revier writes on the same host.
        await fn(container, viewModel, assetsBase);
      } else if (window.SRPlugins && typeof window.SRPlugins.render === 'function') {
        await window.SRPlugins.render(pluginId, container, viewModel, assetsBase);
      } else {
        // textContent, not innerHTML: the view model carries shooter names and
        // other values straight off the wire.
        container.replaceChildren();
        const wrap = document.createElement('div');
        wrap.className = 'plugin-fallback';
        const pre = document.createElement('pre');
        pre.textContent = JSON.stringify(viewModel, null, 2);
        wrap.appendChild(pre);
        container.appendChild(wrap);
      }
    } catch (e) {
      container.replaceChildren();
      const err = document.createElement('div');
      err.className = 'plugin-error';
      err.textContent = 'Failed to load plugin view';
      container.appendChild(err);
      console.warn('SRPluginShell.renderPluginView', e);
    }
  }

  // Also detaches the <script> element; leaving it behind accumulates a tag per
  // reload and lets a stale plugin IIFE keep its registrations alive.
  function removeScript(pluginId) {
    const script = loadedScripts[pluginId];
    if (script && script.parentNode) script.parentNode.removeChild(script);
    delete loadedScripts[pluginId];
    delete loadingScripts[pluginId];
  }

  function clearCache(pluginId) {
    if (pluginId) {
      if (activePluginId === pluginId) {
        deactivatePlugin(pluginId);
        activePluginId = '';
      }
      removeScript(pluginId);
      removeTheme(pluginId);
    } else {
      deactivateActivePlugin();
      Object.keys(loadedScripts).forEach(removeScript);
      Object.keys(loadedThemes).forEach(removeTheme);
    }
  }

  return { renderPluginView, clearCache, ensureViewScript, ensureTheme, unloadOtherThemes, deactivateActivePlugin };
})();
