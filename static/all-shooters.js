(function () {
  const core = window.SRCore;
  if (!core || window.__SRAllShootersStarted) return;
  window.__SRAllShootersStarted = true;
  const refreshMs = 1200;
  let stopped = false, timer = null, activePlugin = null;
  const panels = new Map(), pluginCache = new Map();

  function makePanel(n) {
    const section = document.createElement('section');
    section.className = 'all-shooter-panel';
    section.dataset.range = String(n);
    section.innerHTML = '<div class="shooter-shell"><div class="shooter-top">' +
      '<div><div class="shooter-range-label">Stand ' + n + '</div><div class="shooter-phase shooter-name"></div></div>' +
      '<div class="all-shooter-meta"><div class="shooter-plugin-label"></div><div class="shooter-phase all-shooter-phase"></div></div>' +
      '</div><div class="shooter-plugin-wrap"><div class="all-shooter-plugin-view"></div></div></div>';
    document.getElementById('all-shooters-grid').appendChild(section);
    const panel = { root: section, pluginId: '', signature: '' };
    panels.set(n, panel);
    return panel;
  }

  async function getPlugin(id) {
    if (!pluginCache.has(id)) {
      pluginCache.set(id, fetch('/api/plugins/' + encodeURIComponent(id))
        .then(r => r.ok ? r.json() : null).catch(() => null));
    }
    return pluginCache.get(id);
  }

  async function refreshPanel(n) {
    const panel = panels.get(n) || makePanel(n);
    const responses = await Promise.all([
      fetch('/api/plugins/session?range=' + n).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/live?range=' + n).then(r => r.ok ? r.json() : null).catch(() => null)
    ]);
    if (stopped) return;
    const session = responses[0] || { rangeNum: n, phase: 'idle' };
    const live = responses[1] && responses[1].ranges && responses[1].ranges[0] || null;
    const root = panel.root;
    const name = live && live.shooterName || '';
    const nameEl = root.querySelector('.shooter-name');
    nameEl.textContent = name;
    nameEl.hidden = !name;
    root.querySelector('.shooter-plugin-label').textContent = session.pluginId ? String(session.pluginId).toUpperCase() : '';
    root.querySelector('.all-shooter-phase').textContent = session.phase || '';
    const pluginId = session.pluginId || activePlugin && activePlugin.id || '';
    const viewEl = root.querySelector('.all-shooter-plugin-view');
    if (!pluginId || !window.SRPluginShell) {
      viewEl.innerHTML = '<div class="all-shooter-empty">Kein aktives Plugin</div>';
      panel.pluginId = '';
      panel.signature = '';
      return;
    }
    const plugin = await getPlugin(pluginId);
    if (stopped || !plugin) return;
    const vm = Object.assign({}, session.viewModel || {}, {
      rangeNum: n,
      range: live || session.viewModel && session.viewModel.range || null,
      events: session.events || []
    });
    const signature = pluginId + '|' + JSON.stringify(vm);
    if (panel.pluginId !== pluginId) {
      viewEl.innerHTML = '';
      delete viewEl.dataset.pluginId;
      panel.pluginId = pluginId;
      panel.signature = '';
    }
    if (signature !== panel.signature) {
      panel.signature = signature;
      await window.SRPluginShell.renderPluginView(
        viewEl, pluginId, plugin.viewUrl, plugin.assetsBase, vm, plugin.themeUrl || ''
      );
    }
  }

  async function refreshAll() {
    if (stopped) return;
    await Promise.all(Array.from(panels.keys()).map(refreshPanel));
    if (!stopped) timer = setTimeout(refreshAll, refreshMs);
  }

  async function init() {
    document.body.classList.add('all-shooter-display');
    const grid = document.createElement('main');
    grid.id = 'all-shooters-grid';
    grid.className = 'all-shooters-grid';
    document.body.appendChild(grid);
    await core.fetchConfig();
    const cfg = core.config || {};
    let count = Number(cfg.ranges);
    if (!Number.isFinite(count) || count < 1) count = 6;
    count = Math.min(64, Math.floor(count));
    for (let n = 1; n <= count; n++) makePanel(n);
    try {
      const res = await fetch('/api/plugins/active');
      if (res.ok) { const list = await res.json(); activePlugin = list && list[0] || null; }
    } catch (_) {}
    await refreshAll();
    window.addEventListener('pagehide', function () {
      stopped = true;
      if (timer) clearTimeout(timer);
    }, { once: true });
  }

  init().catch(function (err) {
    console.error('all stands view failed', err);
    const grid = document.getElementById('all-shooters-grid');
    if (grid) grid.innerHTML = '<p>Die Standübersicht konnte nicht geladen werden.</p>';
  });
})();