(function () {
  const core = window.SRCore;
  if (!core) return;

  const params = new URLSearchParams(location.search);
  const rangeNum = (window.SRDisplay && window.SRDisplay.rangeNum) ||
    parseInt(params.get('range') || '1', 10);
  let pluginSession = { rangeNum: rangeNum, phase: 'idle' };
  let activePlugin = null;
  const WS_BASE_RECONNECT_MS = 1000;
  const WS_MAX_RECONNECT_MS = 30000;
  let ws = null;
  let wsOpen = false;
  let reconnectTimer = null;
  let reconnectDelay = WS_BASE_RECONNECT_MS;
  let pollTimers = [];
  let stopped = false;
  let lastLive = null;
  let renderToken = 0;

  async function fetchActivePlugin() {
    const res = await fetch('/api/plugins/active');
    if (!res.ok) return;
    const list = await res.json();
    activePlugin = (list && list[0]) || null;
  }

  async function fetchSession() {
    const res = await fetch('/api/plugins/session?range=' + rangeNum);
    if (res.ok) pluginSession = await res.json();
  }

  async function fetchLiveRange() {
    const res = await fetch('/api/live?range=' + rangeNum);
    if (res.ok) {
      const data = await res.json();
      return (data.ranges && data.ranges[0]) || null;
    }
    return null;
  }

  function ensureShell(app) {
    if (app.querySelector('.shooter-shell')) return;
    app.innerHTML =
      '<div class="shooter-shell">' +
      '<div class="shooter-top">' +
      '<div><div class="shooter-range-label">Stand ' + rangeNum + '</div>' +
      '<div class="shooter-phase shooter-name"></div></div>' +
      '<div style="text-align:right">' +
      '<div class="shooter-plugin-label" id="shooter-plugin-label"></div>' +
      '<div class="shooter-phase" id="shooter-phase-label"></div>' +
      '</div></div>' +
      '<div class="shooter-plugin-wrap"><div id="shooter-plugin-view"></div></div>' +
      '</div>';
  }

  async function renderShooter(liveRange) {
    const token = ++renderToken;
    const app = document.getElementById('shooter-app');
    if (!app) return;

    if (liveRange) {
      lastLive = liveRange;
      if (core) core.lastLiveData = { ranges: [liveRange] };
    }

    ensureShell(app);

    const name = (liveRange && liveRange.shooterName) || (lastLive && lastLive.shooterName) || '';
    const nameEl = app.querySelector('.shooter-name');
    if (nameEl) {
      nameEl.hidden = !name;
      nameEl.textContent = name || '';
    }

    const pluginId = (pluginSession && pluginSession.pluginId) || (activePlugin && activePlugin.id) || '';
    const pluginLabel = document.getElementById('shooter-plugin-label');
    const phaseLabel = document.getElementById('shooter-phase-label');
    if (pluginLabel) pluginLabel.textContent = pluginId ? String(pluginId).toUpperCase() : '';
    if (phaseLabel) phaseLabel.textContent = pluginSession.phase || '';

    if (!pluginId || !window.SRPluginShell) return;

    let plugin = activePlugin;
    if (!plugin || plugin.id !== pluginId) {
      const res = await fetch('/api/plugins/' + encodeURIComponent(pluginId));
      if (token !== renderToken) return;
      if (!res.ok) return;
      plugin = await res.json();
      if (token !== renderToken) return;
    }

    const vm = Object.assign({}, pluginSession.viewModel || {}, {
      rangeNum: rangeNum,
      range: liveRange || lastLive || (pluginSession.viewModel && pluginSession.viewModel.range) || null,
      events: pluginSession.events || []
    });
    const viewEl = document.getElementById('shooter-plugin-view');
    await window.SRPluginShell.renderPluginView(
      viewEl,
      pluginId,
      plugin.viewUrl,
      plugin.assetsBase,
      vm,
      plugin.themeUrl || ''
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
    ws = new WebSocket(proto + '//' + location.host + '/ws?range=' + rangeNum);
    ws.onopen = function () {
      wsOpen = true;
      reconnectDelay = WS_BASE_RECONNECT_MS;
    };
    ws.onerror = function (ev) {
      console.warn('websocket error', ev);
    };
    ws.onmessage = async function (ev) {
      if (stopped) return;
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'plugin_session' && msg.session) {
          pluginSession = msg.session;
          await renderShooter();
        }
        if (msg.type === 'live' && msg.range) {
          lastLive = msg.range;
          if (core) {
            core.lastLiveData = { ranges: [msg.range] };
            core.bumpLiveGen();
          }
          await renderShooter(msg.range);
        }
        if (msg.type === 'plugins_changed') {
          if (window.SRPluginShell) window.SRPluginShell.clearCache();
          await fetchActivePlugin();
          await fetchSession();
          const viewEl = document.getElementById('shooter-plugin-view');
          if (viewEl) {
            viewEl.innerHTML = '';
            delete viewEl.dataset.pluginId;
          }
          await renderShooter(lastLive);
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

  async function pollFallback() {
    const genAtStart = core.getLiveGen();
    await fetchSession();
    const liveRange = await fetchLiveRange();
    if (core.getLiveGen() !== genAtStart) return;
    await renderShooter(liveRange);
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
    document.body.classList.add('shooter-display');
    const chrome = document.getElementById('master-chrome');
    if (chrome) chrome.hidden = true;
    const app = document.getElementById('shooter-app');
    if (app) app.hidden = false;
    window.addEventListener('pagehide', teardown);
    await core.fetchConfig();
    await fetchActivePlugin();
    await fetchSession();
    connectWS();
    const live = await fetchLiveRange();
    await renderShooter(live);
    pollTimers.push(setInterval(function () {
      if (!wsOpen) pollFallback();
    }, 1000));
    pollTimers.push(setInterval(function () {
      if (wsOpen) pollFallback();
    }, core.SAFETY_POLL_MS || 20000));
  }

  init().catch(function (e) {
    console.error('shooter init failed', e);
  });
})();
