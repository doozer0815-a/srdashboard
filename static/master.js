(function () {
  const core = window.SRCore;
  if (!core) return;

  let activePlugin = null;
  let installedPlugins = [];
  let pluginSessions = {};
  let activeMeta = { active: false, pluginId: '' };
  const WS_BASE_RECONNECT_MS = 1000;
  const WS_MAX_RECONNECT_MS = 30000;
  let ws = null;
  let wsOpen = false;
  let reconnectTimer = null;
  let reconnectDelay = WS_BASE_RECONNECT_MS;
  let pollTimers = [];
  let stopped = false;
  /** Bumps on every activate / full remount so late async mounts cannot resurrect a prior plugin. */
  let mountGen = 0;

  function controlFetch(url, options) {
    return window.SRAuth.fetchWithAuth(url, options);
  }

  function currentPluginId() {
    return (activePlugin && activePlugin.id) || activeMeta.pluginId || '';
  }

  function isSharedPlugin() {
    const id = currentPluginId();
    if (!id) return false;
    if (activePlugin && activePlugin.id === id) {
      return activePlugin.mode === 'shared';
    }
    const installed = installedPlugins.find(function (p) { return p.id === id; });
    if (installed) return installed.mode === 'shared';
    return id === 'autorennen' || id === 'fox-on-the-run' ||
      id === 'zehner-bingo' || id === 'barrikade' || id === 'ludo' ||
      id === 'darts' ||
      id === 'tauziehen' || id === 'kettenreaktion' || id === 'biathlon' ||
      id === 'schrumpfender-kreis' || id === 'kronen-duell' ||
      id === 'bank-oder-risiko' || id === 'ko-pokal' || id === 'schiessgolf' ||
      id === 'turmbau' || id === 'ansage-duell' || id === 'analyse';
  }

  function isDisplayPlugin() {
    const id = currentPluginId();
    if (!id) return false;
    if (activePlugin && activePlugin.id === id) {
      return activePlugin.kind === 'display';
    }
    const installed = installedPlugins.find(function (p) { return p.id === id; });
    return !!(installed && installed.kind === 'display');
  }

  function teardownSharedHost() {
    const host = document.getElementById('shared-master-host');
    if (host) {
      host.innerHTML = '';
      host.hidden = true;
      delete host._sharedReady;
      delete host._arLastVM;
      host.removeAttribute('style');
      if (host.parentNode) host.parentNode.removeChild(host);
    }
    const grid = document.getElementById('ranges-grid');
    if (grid) {
      grid.hidden = false;
      grid.style.display = '';
    }
  }

  /** Shared host is ready for in-place live updates (any shared plugin, not Autorennen-only). */
  function sharedHostReady(host) {
    return !!(host && !host.hidden && (host._sharedReady || host._arLastVM));
  }

  function clearRangePluginMounts() {
    const grid = document.getElementById('ranges-grid');
    if (!grid) return;
    grid.querySelectorAll('.range-panel').forEach(function (panel) {
      panel.classList.remove('crc-panel');
      const header = panel.querySelector('.range-header');
      if (header) {
        delete header._crcHtml;
        header.className = 'range-header';
        header.removeAttribute('style');
        header.removeAttribute('title');
        header.innerHTML = '';
      }
    });
    grid.querySelectorAll('.range-plugin-view').forEach(function (mount) {
      mount.innerHTML = '';
      delete mount.dataset.pluginId;
      mount.className = 'range-plugin-view';
    });
  }

  function isInlineDisplayPlugin(id) {
    return id === 'classic-range' || id === 'classic-range-condensed';
  }

  async function loadTargetRegistry(assetsBase, pluginId) {
    // assetsBase is /plugins/<id>/assets — registry lives one level up.
    const pid = pluginId || 'classic-range';
    const root = (assetsBase || '/plugins/' + pid + '/assets')
      .replace(/\/assets\/?$/, '/')
      .replace(/\/?$/, '/');
    await new Promise(function (resolve, reject) {
      const script = document.createElement('script');
      script.src = root + 'target-registry.js?t=' + Date.now();
      script.onload = function () {
        if (window.SRTargetRegistry) window.SRTargetRegistry.ownerPluginId = pid;
        resolve();
      };
      script.onerror = reject;
      document.head.appendChild(script);
    }).catch(function () {});
  }

  async function fetchActivePlugin() {
    const res = await fetch('/api/plugins/active');
    if (!res.ok) return;
    const list = await res.json();
    activePlugin = (list && list[0]) || null;
    if (activePlugin) {
      activeMeta = { active: true, pluginId: activePlugin.id || '' };
    }
    if (core.setHallPluginId) {
      core.setHallPluginId((activePlugin && activePlugin.id) || activeMeta.pluginId || '');
    }
    if (activePlugin && isInlineDisplayPlugin(activePlugin.id)) {
      await loadTargetRegistry(activePlugin.assetsBase, activePlugin.id);
      if (activePlugin.assetsBase && core.setTargetAssetBase) {
        core.setTargetAssetBase(activePlugin.assetsBase);
      }
    }
    if (activePlugin && activePlugin.defaults && core.setPluginTargetConfig) {
      core.setPluginTargetConfig(activePlugin.defaults);
    }
    if (window.SRPluginShell && window.SRPluginShell.unloadOtherThemes) {
      window.SRPluginShell.unloadOtherThemes(activePlugin && activePlugin.id);
    }
  }

  async function fetchInstalledPlugins() {
    const res = await fetch('/api/plugins');
    if (res.ok) installedPlugins = await res.json();
  }

  async function fetchSessions() {
    const res = await fetch('/api/plugins/session');
    if (!res.ok) return;
    const data = await res.json();
    pluginSessions = {};
    (data.sessions || []).forEach(function (s) { pluginSessions[s.rangeNum] = s; });
    if (data.active) activeMeta = data.active;
    else if (data.match) activeMeta = { active: !!data.match.active, pluginId: data.match.pluginId || '' };
  }

  function statusText() {
    if (activePlugin) {
      return activePlugin.label + ' (' + activePlugin.id + ')';
    }
    if (activeMeta.pluginId) return activeMeta.pluginId;
    return 'Kein Plugin';
  }

  function updateStatus() {
    const text = statusText();
    ['match-status-strip', 'match-status-compact'].forEach(function (id) {
      const el = document.getElementById(id);
      if (!el) return;
      el.innerHTML = '<span class="status-active">' + escapeHtml(text) + '</span>';
    });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** Pending live ranges to paint on the next animation frame (avoids WS await backlog). */
  const pendingLive = {};
  let rafPaint = 0;

  function queueLiveRange(range) {
    if (!range || range.rangeNum == null) return;
    pendingLive[range.rangeNum] = range;
    if (rafPaint) return;
    rafPaint = requestAnimationFrame(function () {
      rafPaint = 0;
      const nums = Object.keys(pendingLive);
      const batch = [];
      for (let i = 0; i < nums.length; i++) {
        const n = parseInt(nums[i], 10);
        const r = pendingLive[n];
        delete pendingLive[n];
        batch.push(r);
      }
      // Unhide newly active stands before paint so target layout gets real box size.
      if (typeof core.syncRangeVisibility === 'function') {
        core.syncRangeVisibility(core.lastLiveData);
      }
      for (let i = 0; i < batch.length; i++) {
        paintLiveRange(batch[i]);
      }
    });
  }

  /** In-place classic update — no plugin remount / no script reload. */
  function paintLiveRange(range) {
    if (!range) return;
    const id = currentPluginId();
    core.updatePluginPanelHeader(range.rangeNum, range);
    // Shared plugins own the stage; never paint into hidden per-range mounts.
    if (isSharedPlugin()) return;

    const panel = document.querySelector('.range-panel[data-range="' + range.rangeNum + '"]');
    if (!panel) return;
    const mount = panel.querySelector('.range-plugin-view');
    if (!mount) return;

    if (id === 'classic-range' && typeof core.renderClassicRangeView === 'function') {
      if (activePlugin && activePlugin.assetsBase && core.setTargetAssetBase) {
        core.setTargetAssetBase(activePlugin.assetsBase);
      }
      mount.className = 'range-plugin-view classic-range-view';
      mount.dataset.range = String(range.rangeNum);
      core.renderClassicRangeView(mount, range);
      return;
    }
    if (id === 'classic-range-condensed' && window.SRClassicRangeCondensed) {
      if (activePlugin && activePlugin.assetsBase && core.setTargetAssetBase) {
        core.setTargetAssetBase(activePlugin.assetsBase);
      }
      const header = panel.querySelector('.range-header');
      if (header) window.SRClassicRangeCondensed.fillHeader(header, range);
      mount.className = 'range-plugin-view crc-view';
      mount.dataset.range = String(range.rangeNum);
      mount.dataset.pluginId = 'classic-range-condensed';
      window.SRClassicRangeCondensed.paint(mount, range);
      return;
    }
    // Per-range non-classic plugins: remount (async, fire-and-forget).
    if (id) mountRangePlugin(range.rangeNum, mountGen);
  }

  async function mountRangePlugin(rangeNum, gen) {
    if (!activePlugin || !window.SRPluginShell) return;
    if (isSharedPlugin()) return;
    if (gen != null && gen !== mountGen) return;
    const grid = document.getElementById('ranges-grid');
    if (!grid || grid.hidden) return;
    const panel = grid.querySelector('.range-panel[data-range="' + rangeNum + '"]');
    if (!panel) return;
    const mount = panel.querySelector('.range-plugin-view');
    if (!mount) return;

    const session = pluginSessions[rangeNum] || {};
    const live = (core.lastLiveData && core.lastLiveData.ranges || []).find(function (r) {
      return r.rangeNum === rangeNum;
    });
    const viewModel = Object.assign({}, session.viewModel || {}, {
      rangeNum: rangeNum,
      // Prefer live range data — session viewModel.range can be stale or PascalCase from Go.
      range: live || (session.viewModel && session.viewModel.range) || null,
      events: session.events || []
    });

    await window.SRPluginShell.renderPluginView(
      mount,
      activePlugin.id,
      activePlugin.viewUrl,
      activePlugin.assetsBase,
      viewModel,
      activePlugin.themeUrl || ''
    );
    if (gen != null && gen !== mountGen) {
      mount.innerHTML = '';
      delete mount.dataset.pluginId;
      const header = panel.querySelector('.range-header');
      if (header) {
        delete header._crcHtml;
        header.className = 'range-header';
        header.removeAttribute('style');
        header.innerHTML = '';
      }
    }
  }

  async function mountAllPluginViews() {
    const gen = ++mountGen;
    const n = (core.config && core.config.ranges) || 1;
    const shared = isSharedPlugin();

    if (shared) {
      clearRangePluginMounts();
      const grid = document.getElementById('ranges-grid');
      if (!grid || !activePlugin) return;
      let host = document.getElementById('shared-master-host');
      if (!host) {
        host = document.createElement('div');
        host.id = 'shared-master-host';
        host.className = 'shared-master-host';
        grid.parentNode.insertBefore(host, grid);
      }
      grid.hidden = true;
      grid.style.display = 'none';
      host.hidden = false;
      host.style.cssText = 'position:absolute;inset:0;z-index:2;';
      const stage = document.getElementById('stage');
      if (stage) stage.style.position = 'relative';
      const session = pluginSessions[1] || Object.values(pluginSessions)[0] || {};
      const viewModel = buildSharedViewModel(session);
      await window.SRPluginShell.renderPluginView(
        host,
        activePlugin.id,
        activePlugin.viewUrl,
        activePlugin.assetsBase,
        viewModel,
        activePlugin.themeUrl || ''
      );
      // Stale mount must NOT tear down a newer host — that unhides #ranges-grid
      // under/through the absolute fox/Autorennen surface (meadow + Scheibe ghosting).
      if (gen !== mountGen) return;
      host._sharedReady = true;
      return;
    }

    teardownSharedHost();
    if (gen !== mountGen) return;

    core.ensurePluginPanels(n);
    const skip = inactiveRangeSet();
    const tasks = [];
    for (let i = 1; i <= n; i++) {
      if (skip[i]) continue;
      tasks.push(mountRangePlugin(i, gen));
    }
    await Promise.all(tasks);
  }

  function buildSharedViewModel(session) {
    // rangeNum 0 = master overview. Plugins that key off rangeNum (fox, tannebaum)
    // must not see a lane id here or they paint the shooter layout on the hall screen.
    const viewModel = Object.assign({}, (session && session.viewModel) || {}, {
      rangeNum: 0,
      events: (session && session.events) || [],
      inactiveRanges: (core.config && core.config.inactiveRanges) || []
    });
    if (viewModel.race && viewModel.race.cars && core.lastLiveData) {
      const lives = core.lastLiveData.ranges || [];
      viewModel.race.cars = viewModel.race.cars.map(function (c) {
        const live = lives.find(function (r) { return r.rangeNum === c.rangeNum; });
        if (!live) return c;
        const copy = Object.assign({}, c);
        if (live.shooterName) copy.shooterName = live.shooterName;
        if (live.currentValue != null && live.currentValue > 0) copy.lastShotValue = live.currentValue;
        return copy;
      });
    }
    if (viewModel.hunt && viewModel.hunt.players && core.lastLiveData) {
      const lives = core.lastLiveData.ranges || [];
      viewModel.hunt.players = viewModel.hunt.players.map(function (p) {
        const live = lives.find(function (r) { return r.rangeNum === p.rangeNum; });
        if (!live) return p;
        const copy = Object.assign({}, p);
        if (live.shooterName) copy.shooterName = live.shooterName;
        if (live.discipline) copy.discipline = live.discipline;
        if (live.discType) copy.discipline = copy.discipline || live.discType;
        return copy;
      });
    }
    return viewModel;
  }

  /** In-place shared update — never tear down the track SVG. */
  function updateSharedPluginView(session) {
    if (!activePlugin || !window.SRPluginShell) return;
    const host = document.getElementById('shared-master-host');
    if (!host || host.hidden) {
      mountAllPluginViews();
      return;
    }
    const viewModel = buildSharedViewModel(session || {});
    window.SRPluginShell.renderPluginView(
      host,
      activePlugin.id,
      activePlugin.viewUrl,
      activePlugin.assetsBase,
      viewModel,
      activePlugin.themeUrl || ''
    );
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    // Back off so a server that stays down is not hit every 3s forever.
    reconnectDelay = Math.min(reconnectDelay * 2, WS_MAX_RECONNECT_MS);
    reconnectTimer = setTimeout(connectWS, reconnectDelay);
  }

  function connectWS() {
    if (stopped) return;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      try {
        ws.onclose = null;
        ws.onmessage = null;
        ws.onopen = null;
        ws.onerror = null;
        ws.close();
      } catch (_) {}
      ws = null;
    }
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/ws');
    ws.onopen = function () {
      wsOpen = true;
      reconnectDelay = WS_BASE_RECONNECT_MS;
    };
    ws.onerror = function (ev) {
      console.warn('websocket error', ev);
    };
    ws.onmessage = function (ev) {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'plugin_session' && msg.session) {
          pluginSessions[msg.session.rangeNum] = msg.session;
          if (isSharedPlugin()) {
            updateSharedPluginView(msg.session);
          } else if (!isInlineDisplayPlugin(currentPluginId())) {
            mountRangePlugin(msg.session.rangeNum, mountGen);
          }
        }
        if (msg.type === 'active_plugin' && msg.active) {
          activeMeta = msg.active;
          if (activePlugin && activeMeta.pluginId && activePlugin.id !== activeMeta.pluginId) {
            // Stale until refreshAll finishes — prefer activeMeta for routing.
            activePlugin = null;
            teardownSharedHost();
            refreshControls();
          }
          updateStatus();
        }
        if (msg.type === 'match' && msg.match) {
          activeMeta = { active: !!msg.match.active, pluginId: msg.match.pluginId || '' };
          if (activePlugin && activeMeta.pluginId && activePlugin.id !== activeMeta.pluginId) {
            activePlugin = null;
            teardownSharedHost();
            refreshControls();
          }
          updateStatus();
        }
        if (msg.type === 'live' && msg.range) {
          const n = msg.range.rangeNum;
          const max = (core.config && core.config.ranges) || 0;
          if (n < 1 || (max && n > max) || isRangeInactive(n)) {
            return;
          }
          const live = core.lastLiveData || { ranges: [] };
          const ranges = (live.ranges || []).slice();
          const idx = ranges.findIndex(function (r) { return r.rangeNum === msg.range.rangeNum; });
          if (idx >= 0) ranges[idx] = msg.range;
          else ranges.push(msg.range);
          core.lastLiveData = { ranges: ranges };
          core.bumpLiveGen();
          if (isSharedPlugin()) {
            // Live scores update in place; remounting every shot races mountGen
            // and can briefly expose the classic range grid under the shared host.
            const host = document.getElementById('shared-master-host');
            if (sharedHostReady(host)) {
              updateSharedPluginView(pluginSessions[1] || Object.values(pluginSessions)[0] || {});
            } else {
              mountAllPluginViews();
            }
          } else {
            queueLiveRange(msg.range);
            if (typeof core.paintWettkampfTile === 'function') core.paintWettkampfTile();
          }
        }
        if (msg.type === 'wettkampf' && msg.wettkampf) {
          core.lastWettkampf = msg.wettkampf;
          if (typeof core.paintWettkampfTile === 'function') core.paintWettkampfTile();
        }
        if (msg.type === 'plugins_changed' || msg.type === 'config_changed') {
          refreshAll();
        }
      } catch (e) {
        console.warn('ws message', e);
      }
    };
    ws.onclose = function () {
      wsOpen = false;
      scheduleReconnect();
    };
  }

  async function activatePlugin(id) {
    // Audio, Queues und Plugin-Timer beim Verlassen von darts sofort beenden,
    // nicht erst nach der Antwort des Aktivierungs-Requests.
    if (currentPluginId() !== (id || '') && window.SRPluginShell && window.SRPluginShell.deactivateActivePlugin) {
      window.SRPluginShell.deactivateActivePlugin();
    }
    // Optimistic isolation: drop prior plugin UI before the round-trip returns.
    mountGen += 1;
    activeMeta = { active: true, pluginId: id || '' };
    if (activePlugin && activePlugin.id !== id) activePlugin = null;
    if (core.setHallPluginId) core.setHallPluginId(id || '');
    teardownSharedHost();
    clearRangePluginMounts();
    refreshControls();
    updateStatus();

    const res = await controlFetch('/api/plugins/activate', {
      method: 'POST',
      body: JSON.stringify({ id: id })
    });
    if (!res.ok) {
      const t = await res.text();
      alert('Activate failed: ' + t);
      return;
    }
    if (window.SRPluginShell) window.SRPluginShell.clearCache();
    await refreshAll();
  }

  function inactiveRangeSet() {
    const list = (core.config && core.config.inactiveRanges) || [];
    const set = {};
    for (let i = 0; i < list.length; i++) set[Number(list[i])] = true;
    return set;
  }

  function isRangeInactive(n) {
    return !!inactiveRangeSet()[n];
  }

  async function putInactiveRanges(inactive, wettkampfVisible) {
    const body = { inactiveRanges: inactive };
    if (typeof wettkampfVisible === 'boolean') body.wettkampfVisible = wettkampfVisible;
    const res = await controlFetch('/api/runtime', {
      method: 'PUT',
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      alert('Bahnen: ' + (await res.text()));
      fillRangeLaneControls();
      return false;
    }
    if (core.fetchConfig) await core.fetchConfig();
    fillRangeLaneControls();
    if (!isSharedPlugin() && typeof core.ensurePluginPanels === 'function') {
      const n = (core.config && core.config.ranges) || 1;
      core.ensurePluginPanels(n);
      if (core.lastLiveData && typeof core.syncRangeVisibility === 'function') {
        core.syncRangeVisibility(core.lastLiveData);
      }
      const skip = inactiveRangeSet();
      const tasks = [];
      for (let i = 1; i <= n; i++) {
        if (skip[i]) continue;
        tasks.push(mountRangePlugin(i, mountGen));
      }
      await Promise.all(tasks);
      if (typeof core.paintWettkampfTile === 'function') core.paintWettkampfTile();
    }
    return true;
  }

  let rangeConfirmPending = false;
  let rangeConfirmResolve = null;

  function putInactiveFromList(rangeList) {
    const max = Math.max(1, (core.config && core.config.ranges) || 1);
    const next = [];
    const boxes = rangeList.querySelectorAll('input[data-range]');
    for (let i = 0; i < boxes.length; i++) {
      const rn = parseInt(boxes[i].getAttribute('data-range'), 10);
      if (rn >= 1 && rn <= max && !boxes[i].checked) next.push(rn);
    }
    putInactiveRanges(next, wettkampfBoxChecked(rangeList));
  }

  function wettkampfBoxChecked(rangeList) {
    const box = rangeList && rangeList.querySelector('input[data-slot="wettkampf"]');
    if (box) return !!box.checked;
    return !(core.config && core.config.wettkampfVisible === false);
  }

  function closeRangeConfirm(ok) {
    const modal = document.getElementById('range-confirm-modal');
    if (modal) modal.hidden = true;
    const resolve = rangeConfirmResolve;
    rangeConfirmResolve = null;
    rangeConfirmPending = false;
    if (resolve) resolve(!!ok);
  }

  function ensureRangeConfirmModal() {
    let modal = document.getElementById('range-confirm-modal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'range-confirm-modal';
    modal.className = 'range-confirm-modal';
    modal.hidden = true;
    modal.innerHTML =
      '<div class="range-confirm-backdrop" data-range-confirm="cancel"></div>' +
      '<div class="range-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="range-confirm-title" aria-describedby="range-confirm-text">' +
      '<h2 id="range-confirm-title">Bahn deaktivieren?</h2>' +
      '<p id="range-confirm-text">Die Bahn wird in dieser Anzeige ausgeblendet. Schütze, Schüsse und Summen werden gelöscht — auch wenn die Bahn leer ist.</p>' +
      '<div class="range-confirm-actions">' +
      '<button type="button" class="range-confirm-cancel" data-range-confirm="cancel">Abbrechen</button>' +
      '<button type="button" class="range-confirm-ok" data-range-confirm="ok">Deaktivieren</button>' +
      '</div></div>';
    document.body.appendChild(modal);
    modal.addEventListener('click', function (ev) {
      const action = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-range-confirm');
      if (action === 'ok') closeRangeConfirm(true);
      else if (action === 'cancel') closeRangeConfirm(false);
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape') return;
      const open = document.getElementById('range-confirm-modal');
      if (!open || open.hidden) return;
      ev.preventDefault();
      closeRangeConfirm(false);
    });
    return modal;
  }

  function confirmDeactivateBahn(n) {
    const modal = ensureRangeConfirmModal();
    const title = document.getElementById('range-confirm-title');
    if (title) title.textContent = formatBahnList([n]) + ' deaktivieren?';
    modal.hidden = false;
    const cancel = modal.querySelector('.range-confirm-cancel');
    if (cancel) cancel.focus();
    return new Promise(function (resolve) {
      rangeConfirmResolve = resolve;
    });
  }

  function rangeLiveData(n) {
    const ranges = (core.lastLiveData && core.lastLiveData.ranges) || [];
    for (let i = 0; i < ranges.length; i++) {
      if (Number(ranges[i].rangeNum) === n) return ranges[i];
    }
    return null;
  }

  function bahnHasLiveData(n) {
    const has = core.rangeHasActivity;
    if (typeof has !== 'function') return true;
    return has(rangeLiveData(n));
  }

  function requestDeactivateBahn(box, rangeList) {
    if (!box || rangeConfirmPending) return;
    const n = parseInt(box.getAttribute('data-range'), 10);
    if (n < 1) return;
    if (!bahnHasLiveData(n)) {
      box.checked = false;
      putInactiveFromList(rangeList);
      return;
    }
    rangeConfirmPending = true;
    box.checked = true;
    confirmDeactivateBahn(n).then(function (ok) {
      if (!ok) {
        box.checked = true;
        return;
      }
      box.checked = false;
      putInactiveFromList(rangeList);
    });
  }

  function formatBahnList(nums) {
    if (!nums.length) return '';
    if (nums.length === 1) return 'Bahn ' + nums[0];
    const parts = [];
    let start = nums[0];
    let prev = nums[0];
    for (let i = 1; i <= nums.length; i++) {
      const cur = nums[i];
      if (cur === prev + 1) {
        prev = cur;
        continue;
      }
      parts.push(start === prev ? String(start) : start + '–' + prev);
      start = prev = cur;
    }
    return 'Bahnen ' + parts.join(', ');
  }

  function setSideMenuOpen(open) {
    const toggle = document.getElementById('menu-toggle');
    const menu = document.getElementById('top-bar-menu');
    const bar = document.getElementById('top-bar');
    if (!menu) return;
    menu.hidden = !open;
    if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (bar) bar.classList.toggle('is-menu-open', !!open);
  }

  function fillRangeLaneControls() {
    const list = document.getElementById('range-lane-select');
    if (!list || rangeConfirmPending) return;
    const n = Math.max(1, (core.config && core.config.ranges) || 1);
    const inactive = inactiveRangeSet();
    const crc = currentPluginId() === 'classic-range-condensed';
    const wkOn = !(core.config && core.config.wettkampfVisible === false);
    const sig = n + ':' + Object.keys(inactive).filter(function (k) { return inactive[k]; }).sort().join(',') +
      ':' + (crc ? (wkOn ? 'w1' : 'w0') : 'wx');
    if (list.dataset.laneSig === sig && list.querySelector('input[data-range]')) return;
    let html = '';
    for (let i = 1; i <= n; i++) {
      const off = !!inactive[i];
      html += '<label class="range-lane-item' + (off ? ' is-inactive' : '') + '">' +
        '<input type="checkbox" data-range="' + i + '"' + (off ? '' : ' checked') + '>Bahn ' + i + '</label>';
    }
    if (crc) {
      html += '<label class="range-lane-item' + (wkOn ? '' : ' is-inactive') + '">' +
        '<input type="checkbox" data-slot="wettkampf"' + (wkOn ? ' checked' : '') + '>Wettkampf</label>';
    }
    list.innerHTML = html;
    list.dataset.laneSig = sig;
  }

  function canControlUI() {
    return !(window.SRMode && window.SRMode.canControl === false);
  }

  function shotColourControlsHtml() {
    return '<button type="button" class="btn btn-ghost" id="btn-theme-toggle">Dunkelmodus</button>' +
      '<label class="plugin-active-label shot-sat-control">Farbsättigung' +
      '<span class="shot-sat-row">' +
      '<input type="range" id="shot-sat-slider" min="0" max="100" step="1" aria-valuemin="0" aria-valuemax="100">' +
      '<span class="shot-sat-value" id="shot-sat-value" aria-hidden="true"></span>' +
      '</span>' +
      '<div class="shot-hue-swatches" id="shot-hue-swatches" role="group" aria-label="Schussfarbe">' +
      Array.from({ length: 10 }, function (_, i) {
        return '<button type="button" class="shot-hue-swatch" data-shot-mode="' + i + '" title="Farbe ' + (i + 1) + '" aria-label="Farbe ' + (i + 1) + '" aria-pressed="false"></button>';
      }).join('') +
      '<button type="button" class="shot-hue-swatch shot-hue-rainbow" data-shot-mode="rainbow" title="Regenbogen" aria-label="Regenbogen" aria-pressed="false"></button>' +
      '</div></label>' +
      '<button type="button" class="btn btn-ghost" id="btn-fullscreen-toggle">Vollbild</button>' +
      '<button type="button" class="btn btn-ghost" id="btn-compact-toggle">Compact</button>';
  }

  function buildControls() {
    const strip = document.getElementById('control-strip');
    if (!strip) return;
    const admin = canControlUI();
    if (!admin) {
      strip.innerHTML =
        '<div class="plugin-quick">' +
        '<label class="plugin-active-label">Aktiv' +
        '<span class="plugin-active-readonly" id="plugin-active-label">–</span></label>' +
        '<button type="button" class="btn btn-ghost" id="rulebook-menu-btn" hidden>Regelbuch</button>' +
        shotColourControlsHtml() +
        '<span class="tablet-hint">Ansicht (öffentlich)</span>' +
        '</div>';
    } else {
      strip.innerHTML =
        '<div class="plugin-quick">' +
        '<label class="plugin-active-label">Aktiv' +
        '<select id="plugin-active-select"></select></label>' +
        '<a class="btn btn-ghost" id="plugin-config-link" href="/config">Einstellungen</a>' +
        '<button type="button" class="btn btn-ghost" id="rulebook-menu-btn" hidden>Regelbuch</button>' +
        '<span id="race-controls" class="race-controls" hidden>' +
        '<button type="button" class="btn btn-primary" id="race-start-btn">Start</button>' +
        '<button type="button" class="btn" id="race-reset-btn">Reset</button>' +
        '<button type="button" class="btn" id="race-puncture-btn" hidden>Reifenplatzer</button>' +
        '<button type="button" class="btn" id="race-oil-btn" hidden>Ölverlust</button>' +
        '</span>' +
        '<div class="plugin-active-label">Bahnen' +
        '<div id="range-lane-select" class="range-lane-list" role="group" aria-label="Bahnen"></div></div>' +
        shotColourControlsHtml() +
        '<button type="button" class="btn btn-ghost" id="btn-control-token">Control-Token</button>' +
        '<span class="tablet-hint">Tablet: /BahnNr z.B. ' + location.origin + '/3</span>' +
        '</div>';
    }

    const sel = document.getElementById('plugin-active-select');
    if (sel) {
      sel.onchange = function () {
        if (sel.value) activatePlugin(sel.value);
      };
    }
    async function raceControl(action, type) {
      const body = { action: action };
      if (type) body.type = type;
      const res = await controlFetch('/api/plugins/control', {
        method: 'POST',
        body: JSON.stringify(body)
      });
      if (!res.ok) alert(await res.text());
    }
    const startBtn = document.getElementById('race-start-btn');
    if (startBtn) {
      startBtn.onclick = function () { raceControl('start'); };
      document.getElementById('race-reset-btn').onclick = function () { raceControl('reset'); };
      document.getElementById('race-puncture-btn').onclick = function () { raceControl('field_event', 'puncture'); };
      document.getElementById('race-oil-btn').onclick = function () { raceControl('field_event', 'oil_leak'); };
    }
    const rangeList = document.getElementById('range-lane-select');
    if (rangeList) {
      function laneCheckbox(ev) {
        const t = ev.target;
        if (t && t.type === 'checkbox' && t.getAttribute('data-range')) return t;
        const item = t && t.closest && t.closest('.range-lane-item');
        if (!item || !rangeList.contains(item)) return null;
        return item.querySelector('input[data-range]');
      }
      rangeList.addEventListener('pointerdown', function (ev) {
        const box = laneCheckbox(ev);
        if (!box || !box.checked) return;
        ev.preventDefault();
        requestDeactivateBahn(box, rangeList);
      }, { capture: true, passive: false });
      rangeList.addEventListener('keydown', function (ev) {
        if (ev.key !== ' ' && ev.key !== 'Enter') return;
        const box = ev.target;
        if (!box || box.type !== 'checkbox' || !box.getAttribute('data-range') || !box.checked) return;
        ev.preventDefault();
        requestDeactivateBahn(box, rangeList);
      });
      rangeList.addEventListener('change', function (ev) {
        const box = ev.target;
        if (!box || box.type !== 'checkbox') return;
        if (box.getAttribute('data-slot') === 'wettkampf') {
          putInactiveFromList(rangeList);
          return;
        }
        if (!box.getAttribute('data-range')) return;
        if (!box.checked) {
          requestDeactivateBahn(box, rangeList);
          return;
        }
        putInactiveFromList(rangeList);
      });
    }
    const tokenBtn = document.getElementById('btn-control-token');
    if (tokenBtn) {
      function syncTokenButton() {
        const set = !!window.SRAuth.get();
        tokenBtn.textContent = set ? 'Control-Token ✓' : 'Control-Token';
        tokenBtn.title = set
          ? 'Token ist auf diesem Gerät hinterlegt — klicken zum Ändern'
          : 'Token für Steuerbefehle hinterlegen';
      }
      syncTokenButton();
      tokenBtn.onclick = function () {
        window.SRAuth.promptForToken('Control-Token für dieses Gerät (leer = löschen):');
        syncTokenButton();
      };
    }
    const themeBtn = document.getElementById('btn-theme-toggle');
    if (themeBtn && window.SRTheme) {
      function syncThemeButton() {
        const dark = window.SRTheme.get() === 'dark';
        themeBtn.textContent = dark ? 'Hellmodus' : 'Dunkelmodus';
        themeBtn.setAttribute('aria-pressed', dark ? 'true' : 'false');
        themeBtn.title = dark ? 'Zum hellen Modus wechseln' : 'Zum dunklen Modus wechseln';
      }
      syncThemeButton();
      themeBtn.onclick = function () {
        window.SRTheme.toggle();
        syncThemeButton();
      };
      document.addEventListener('srdashboard:themechange', syncThemeButton);
    }
    const satSlider = document.getElementById('shot-sat-slider');
    const satValue = document.getElementById('shot-sat-value');
    const hueSwatches = document.getElementById('shot-hue-swatches');
    if (satSlider && window.SRShotSat) {
      function syncShotSatUI(sat) {
        const n = window.SRShotSat.get();
        const v = sat != null ? sat : n;
        satSlider.value = String(v);
        satSlider.setAttribute('aria-valuenow', String(v));
        satSlider.setAttribute('aria-valuetext', v + ' Prozent');
        if (satValue) satValue.textContent = v + '%';
        syncShotHueSwatches();
      }
      function syncShotHueSwatches() {
        if (!hueSwatches) return;
        const mode = window.SRShotMode ? window.SRShotMode.get() : 'rainbow';
        const colors = (window.SRCore && typeof window.SRCore.getShotSwatchColors === 'function')
          ? window.SRCore.getShotSwatchColors()
          : [];
        hueSwatches.querySelectorAll('.shot-hue-swatch').forEach(function (btn) {
          const raw = btn.getAttribute('data-shot-mode');
          const isRainbow = raw === 'rainbow';
          const pressed = isRainbow ? mode === 'rainbow' : String(mode) === String(raw);
          btn.setAttribute('aria-pressed', pressed ? 'true' : 'false');
          if (!isRainbow) {
            const idx = parseInt(raw, 10);
            if (Number.isFinite(idx) && colors[idx]) btn.style.background = colors[idx];
          }
        });
      }
      syncShotSatUI();
      function onSatInput() {
        const next = window.SRShotSat.set(satSlider.value);
        syncShotSatUI(next);
      }
      satSlider.addEventListener('input', onSatInput);
      satSlider.addEventListener('change', onSatInput);
      document.addEventListener('srdashboard:shotsatchange', function (ev) {
        syncShotSatUI(ev.detail && ev.detail.sat);
      });
      // Theme CSS may change --shot-sat; refresh slider when user has no override.
      document.addEventListener('srdashboard:themechange', function () {
        syncShotSatUI();
      });
      document.addEventListener('srdashboard:shotmodechange', function () {
        syncShotHueSwatches();
      });
      if (hueSwatches && window.SRShotMode) {
        hueSwatches.addEventListener('click', function (ev) {
          const btn = ev.target && ev.target.closest && ev.target.closest('.shot-hue-swatch');
          if (!btn || !hueSwatches.contains(btn)) return;
          const raw = btn.getAttribute('data-shot-mode');
          window.SRShotMode.set(raw === 'rainbow' ? 'rainbow' : parseInt(raw, 10));
          syncShotHueSwatches();
        });
      }
    }
    const fsBtn = document.getElementById('btn-fullscreen-toggle');
    if (fsBtn) {
      function syncFullscreenButton() {
        const on = isFullscreen();
        fsBtn.textContent = on ? 'Vollbild beenden' : 'Vollbild';
        fsBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
      syncFullscreenButton();
      fsBtn.onclick = function () {
        toggleFullscreen().then(syncFullscreenButton).catch(function () {
          syncFullscreenButton();
        });
      };
      document.addEventListener('fullscreenchange', syncFullscreenButton);
      document.addEventListener('webkitfullscreenchange', syncFullscreenButton);
    }
    const compactBtn = document.getElementById('btn-compact-toggle');
    if (compactBtn) {
      const compactOn = window.SRDisplay && window.SRDisplay.display === 'compact';
      compactBtn.setAttribute('aria-pressed', compactOn ? 'true' : 'false');
      compactBtn.title = compactOn ? 'Zur vollen Halle mit Scheibe' : 'Kompakt-Halle ohne Scheibe';
      compactBtn.onclick = function () {
        location.assign(compactOn ? '/' : '/compact');
      };
    }
    refreshControls();
  }

  function refreshControls() {
    const activeId = currentPluginId();
    const readonly = document.getElementById('plugin-active-label');
    if (readonly) {
      const p = installedPlugins.find(function (x) { return x.id === activeId; }) || activePlugin;
      readonly.textContent = p
        ? ((p.label || p.id) + (p.kind ? ' (' + p.kind + ')' : ''))
        : (activeId || '–');
    }
    const sel = document.getElementById('plugin-active-select');
    if (sel) {
      sel.innerHTML = installedPlugins.map(function (p) {
        return '<option value="' + escapeHtml(p.id) + '"' +
          (p.id === activeId ? ' selected' : '') + '>' +
          escapeHtml(p.label || p.id) + ' (' + escapeHtml(p.kind || '') + ')</option>';
      }).join('');
    }
    const race = document.getElementById('race-controls');
    if (race) {
      const shared = isSharedPlugin();
      const id = currentPluginId();
      race.hidden = !shared || !canControlUI() || isDisplayPlugin() || id === 'darts';
      const startBtn = document.getElementById('race-start-btn');
      const punctureBtn = document.getElementById('race-puncture-btn');
      const oilBtn = document.getElementById('race-oil-btn');
      if (id === 'autorennen') {
        if (startBtn) startBtn.textContent = 'Rennen starten';
        if (punctureBtn) punctureBtn.hidden = false;
        if (oilBtn) oilBtn.hidden = false;
      } else if (id === 'fox-on-the-run') {
        if (startBtn) startBtn.textContent = 'Jagd starten';
        if (punctureBtn) punctureBtn.hidden = true;
        if (oilBtn) oilBtn.hidden = true;
      } else if (id === 'tannebaum-einzel' || id === 'tannebaum-team') {
        if (startBtn) startBtn.textContent = 'Tannebaum starten';
        if (punctureBtn) punctureBtn.hidden = true;
        if (oilBtn) oilBtn.hidden = true;
      } else if (id === 'zehner-bingo') {
        if (startBtn) startBtn.textContent = 'Bingo starten';
        if (punctureBtn) punctureBtn.hidden = true;
        if (oilBtn) oilBtn.hidden = true;
      } else if (id === 'barrikade') {
        if (startBtn) startBtn.textContent = 'Barrikade starten';
        if (punctureBtn) punctureBtn.hidden = true;
        if (oilBtn) oilBtn.hidden = true;
      } else if (id === 'ludo') {
        if (startBtn) startBtn.textContent = 'Ludo starten';
        if (punctureBtn) punctureBtn.hidden = true;
        if (oilBtn) oilBtn.hidden = true;
      } else if (id === 'darts') {
        if (startBtn) startBtn.textContent = 'Dart starten';
        if (punctureBtn) punctureBtn.hidden = true;
        if (oilBtn) oilBtn.hidden = true;
      } else if (id === 'tauziehen') {
        if (startBtn) startBtn.textContent = 'Tauziehen starten';
        if (punctureBtn) punctureBtn.hidden = true;
        if (oilBtn) oilBtn.hidden = true;
      } else if (id === 'kettenreaktion') {
        if (startBtn) startBtn.textContent = 'Kette starten';
        if (punctureBtn) punctureBtn.hidden = true;
        if (oilBtn) oilBtn.hidden = true;
      } else if (id === 'biathlon') {
        if (startBtn) startBtn.textContent = 'Biathlon starten';
        if (punctureBtn) punctureBtn.hidden = true;
        if (oilBtn) oilBtn.hidden = true;
      } else if (id === 'schrumpfender-kreis') {
        if (startBtn) startBtn.textContent = 'Kreis starten';
        if (punctureBtn) punctureBtn.hidden = true;
        if (oilBtn) oilBtn.hidden = true;
      } else if (id === 'kronen-duell') {
        if (startBtn) startBtn.textContent = 'Duell starten';
        if (punctureBtn) punctureBtn.hidden = true;
        if (oilBtn) oilBtn.hidden = true;
      } else if (id === 'bank-oder-risiko') {
        if (startBtn) startBtn.textContent = 'Risiko starten';
        if (punctureBtn) punctureBtn.hidden = true;
        if (oilBtn) oilBtn.hidden = true;
      } else if (id === 'ko-pokal') {
        if (startBtn) startBtn.textContent = 'Pokal starten';
        if (punctureBtn) punctureBtn.hidden = true;
        if (oilBtn) oilBtn.hidden = true;
      } else if (id === 'schiessgolf') {
        if (startBtn) startBtn.textContent = 'Golf starten';
        if (punctureBtn) punctureBtn.hidden = true;
        if (oilBtn) oilBtn.hidden = true;
      } else if (id === 'turmbau') {
        if (startBtn) startBtn.textContent = 'Turm starten';
        if (punctureBtn) punctureBtn.hidden = true;
        if (oilBtn) oilBtn.hidden = true;
      } else if (id === 'ansage-duell') {
        if (startBtn) startBtn.textContent = 'Ansage starten';
        if (punctureBtn) punctureBtn.hidden = true;
        if (oilBtn) oilBtn.hidden = true;
      } else {
        if (startBtn) startBtn.textContent = 'Start';
        if (punctureBtn) punctureBtn.hidden = true;
        if (oilBtn) oilBtn.hidden = true;
      }
    }
    fillRangeLaneControls();
    syncRulebookButtons();
  }

  function syncRulebookButtons() {
    const rb = window.SRRulebook;
    if (!rb) return;
    const slim = document.getElementById('rulebook-btn');
    const menuBtn = document.getElementById('rulebook-menu-btn');
    rb.wireButton(slim);
    rb.wireButton(menuBtn);
    rb.syncButton(slim, activePlugin);
    rb.syncButton(menuBtn, activePlugin);
  }

  async function fetchWettkampf() {
    try {
      const res = await fetch('/api/wettkampf', { cache: 'no-store' });
      if (!res.ok) return;
      core.lastWettkampf = await res.json();
    } catch (e) {}
  }

  async function refreshAll() {
    await core.fetchConfig();
    await fetchWettkampf();
    await fetchActivePlugin();
    await fetchInstalledPlugins();
    await fetchSessions();
    updateStatus();
    refreshControls();
    core.applyLayout();
    const live = await core.fetchLive();
    if (live) core.render(live);
    else core.ensurePluginPanels((core.config && core.config.ranges) || 1);
    await mountAllPluginViews();
    if (isInlineDisplayPlugin(currentPluginId()) && core.lastLiveData) {
      (core.lastLiveData.ranges || []).forEach(function (r) { paintLiveRange(r); });
      if (typeof core.paintWettkampfTile === 'function') core.paintWettkampfTile();
    }
  }

  async function pollFallback() {
    const gen = core.getLiveGen();
    await fetchSessions();
    const live = await core.fetchLive();
    if (core.getLiveGen() !== gen) return; // WS already newer
    if (live) {
      core.lastLiveData = live;
      if (isSharedPlugin()) {
        // Prefer in-place update — full remount every SAFETY_POLL_MS flickered.
        updateSharedPluginView(pluginSessions[1] || Object.values(pluginSessions)[0] || {});
      } else {
        (live.ranges || []).forEach(function (r) { queueLiveRange(r); });
      }
    } else if (!wsOpen) {
      if (isSharedPlugin()) {
        const host = document.getElementById('shared-master-host');
        if (host && !host.hidden) {
          updateSharedPluginView(pluginSessions[1] || Object.values(pluginSessions)[0] || {});
          return;
        }
      }
      await mountAllPluginViews();
    }
  }

  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  function toggleFullscreen() {
    if (isFullscreen()) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      return exit ? exit.call(document) : Promise.resolve();
    }
    const el = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    return req ? req.call(el) : Promise.resolve();
  }

  function wireMenu() {
    const toggle = document.getElementById('menu-toggle');
    const menu = document.getElementById('top-bar-menu');
    if (toggle && menu) {
      toggle.onclick = function () {
        setSideMenuOpen(menu.hidden);
      };
    }
    const stopSlim = document.getElementById('plugin-stop-slim');
    if (stopSlim) stopSlim.hidden = true;
  }

  function refreshThemeDependentViews() {
    if (core.lastLiveData) core.render(core.lastLiveData);
  }

  function teardown() {
    stopped = true;
    pollTimers.forEach(clearInterval);
    pollTimers = [];
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      try {
        ws.onclose = null;
        ws.close();
      } catch (_) {}
      ws = null;
    }
  }

  async function init() {
    wireMenu();
    buildControls();
    document.addEventListener('srdashboard:themechange', refreshThemeDependentViews);
    window.addEventListener('pagehide', teardown);
    await refreshAll();
    connectWS();
    pollTimers.push(setInterval(function () {
      if (!wsOpen) pollFallback();
    }, 1000));
    pollTimers.push(setInterval(function () {
      if (wsOpen) pollFallback();
    }, core.SAFETY_POLL_MS || 20000));
  }

  init().catch(function (e) {
    console.error('master init failed', e);
  });
})();
