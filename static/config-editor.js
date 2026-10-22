(function () {
  const FOOTER_FIELDS = [
    ['currentShotValue', 'Aktueller Schuss'],
    ['teiler', 'Teiler'],
    ['shotNumber', 'Schussnummer'],
    ['overallSumInt', 'Summe (ganz)'],
    ['overallSumDecimal', 'Summe (dezimal)'],
    ['predictionInt', 'Prognose (ganz)'],
    ['predictionDecimal', 'Prognose (dezimal)'],
    ['seriesSumsInt', 'Serien (ganz)'],
    ['seriesSumsDecimal', 'Serien (dezimal)'],
    ['last10Int', 'Letzte 10 (ganz)'],
    ['last10Decimal', 'Letzte 10 (dezimal)']
  ];

  let panel = null;
  let globalData = null;
  let pluginData = null;
  let pluginId = '';
  let controlFetch = function (url, options) {
    return window.SRAuth.fetchWithAuth(url, options);
  };
  let getRangesFn = function () {
    if (globalData && globalData.ranges) return globalData.ranges;
    return (window.SRCore && window.SRCore.config && window.SRCore.config.ranges) || 6;
  };

  const PLUGIN_FIELD_LABELS = {
    laps: 'Laps to win',
    sectorsPerLap: 'Sectors per lap',
    sectorProgressMax: 'Sector progress to complete',
    speedDivisor: 'Speed divisor (higher = slower)',
    overtakeRingGap: 'Overtake ring gap (normal)',
    drsOvertakeRingGap: 'Overtake ring gap (DRS)',
    drsRequiresTokens: 'DRS requires bonus tokens',
    drsZoneSector: 'DRS sector number',
    lapBonusCarryCap: 'Max lap bonus tokens',
    ringTenBonusTokens: 'Tokens per ring ten',
    cleanSectorBonusTokens: 'Tokens per clean sector',
    overtakeBonusTokens: 'Tokens per clean overtake',
    perfectLapBonusTokens: 'Tokens per perfect lap',
    ringTenMovementBonus: 'Extra movement on ring ten',
    roundTimeoutSec: 'Round timeout (seconds)',
    reactionWindowMs: 'Reaction bonus window (ms)',
    reactionBonusMax: 'Max reaction bonus (0–1)',
    lightCount: 'Start light count',
    lightIntervalMs: 'Ms between red lights',
    greenDelayMinMs: 'Min random delay before green',
    greenDelayMaxMs: 'Max random delay before green',
    falseStartPenalty: 'False start penalty (sector progress)',
    preferOpticScoreTime: 'Use OpticScore ShotDateTime for reaction',
    defaultDifficulty: 'Default handicap tier',
    rangeDifficulties: 'Per-range handicap tier',
    rangeHandicaps: 'Per-range movement multiplier',
    handicapEasyMovementScale: 'Easy movement scale',
    handicapNormalMovementScale: 'Normal movement scale',
    handicapHardMovementScale: 'Hard movement scale',
    handicapNormalScoreOffset: 'Normal score offset',
    handicapHardScoreOffset: 'Hard score offset',
    handicapEasyScoreMin: 'Easy score floor',
    handicapEasyScoreMax: 'Easy score ceiling',
    defaultTargetProfile: 'Standard-Scheibe (Fallback)',
    hideIdleRanges: 'Leere Bahnen ausblenden',
    disciplineTargets: 'Scheibe pro Disziplin',
    rangeTargets: 'Scheibe pro Bahn',
    circuitId: 'Rennstrecke',
    motionMode: 'Bewegungsmodus',
    stintSize: 'Stintlänge (Pit alle N)',
    roundDurationSec: 'Rundenzeit (Sekunden)',
    skippedRoundsToCrash: 'Ausgelassene Runden bis Crash',
    overtakeRatio: 'Überhol-Faktor',
    paceCompress: 'Pace-Kompression',
    pacePivot: 'Pace-Pivot',
    drsStackPerPlace: 'DRS-Stack pro Platz',
    drsSections: 'DRS-Sektionen',
    gridGap: 'Startabstand',
    trackLength: 'Streckenlänge',
    highShotThreshold: 'High-Shot-Schwelle',
    streakBonus: 'Streak-Bonus',
    pitCueWindowMs: 'Pit-Zeitfenster (ms)',
    startingScore: 'Start-Spiel',
    doubleIn: 'Double-In',
    doubleOut: 'Double-Out',
    orderMode: 'Spielerreihenfolge',
    beginnerRange: 'Anfänger-Stand',
    autoStartWhenAllReady: 'Auto-Start wenn alle bereit',
    requireEqualShotTotals: 'Gleiche Schusszahl erforderlich',
    fieldEventsEnabled: 'Feld-Events aktiv',
    fieldEventMinGapSec: 'Min. Abstand Feld-Events (s)',
    fieldEventChancePerRound: 'Feld-Event-Chance pro Runde',
    holeInHoleMinOverlap: 'Hole-in-Hole Überlappung',
    holeInHoleBonus: 'Hole-in-Hole Bonus',
    shotDiameterMm: 'Schussdurchmesser (mm)',
    handicaps: 'Handicap pro Bahn'
  };

  const TARGET_PROFILE_ENUM = ['air_rifle_10m', 'air_pistol_10m', 'smallbore_50m_prone', 'smallbore_50m_3p'];
  const TARGET_PROFILE_LABELS = {
    air_rifle_10m: '10 m Luftgewehr',
    air_pistol_10m: '10 m Luftpistole',
    smallbore_50m_prone: '50 m KK liegend',
    smallbore_50m_3p: '50 m KK 3-Stellung'
  };
  const DISCIPLINE_FAMILIES = [
    { id: 'LG', label: 'Luftgewehr (LG)', keys: ['LG', 'Luftgewehr'], profiles: ['air_rifle_10m'] },
    { id: 'LP', label: 'Luftpistole (LP)', keys: ['LP', 'Luftpistole'], profiles: ['air_pistol_10m'] },
    { id: 'KK', label: 'Kleinkaliber (KK)', keys: ['KK', 'Kleinkaliber', 'KK-Gewehr'], profiles: ['smallbore_50m_prone', 'smallbore_50m_3p'] }
  ];

  function targetProfileLabel(id) {
    return TARGET_PROFILE_LABELS[id] || id;
  }

  function familyProfileValue(dt, family) {
    const keys = family.keys || [];
    for (let i = 0; i < keys.length; i++) {
      const cur = dt[keys[i]];
      if (cur) return cur;
    }
    return family.profiles[0] || '';
  }

  function fieldLabel(key) {
    return PLUGIN_FIELD_LABELS[key] || key;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function setStatus(el, text, isError) {
    if (!el) return;
    el.textContent = text || '';
    el.className = 'config-editor-status' + (isError ? ' config-editor-status-error' : '');
  }

  function schemaType(prop) {
    return prop && prop.type ? prop.type : 'string';
  }

  function isOverridden(key, merged, defaults) {
    if (!defaults || !(key in defaults)) return key in (pluginData && pluginData.overrides || {});
    return JSON.stringify(merged[key]) !== JSON.stringify(defaults[key]);
  }

  function renderSchemaField(key, prop, value, defaults, merged) {
    const t = schemaType(prop);
    const overridden = isOverridden(key, merged, defaults);
    const hint = overridden ? ' <span class="config-override-badge">Override</span>' : '';
    const id = 'pcfg-' + key;
    const label = esc(fieldLabel(key));

    if (key === 'rangeHandicaps') {
      const ranges = getRangesFn();
      const rh = (value && typeof value === 'object') ? value : {};
      let html = '<fieldset class="config-fieldset"><legend>' + label + hint + '</legend><div class="config-check-grid">';
      for (let r = 1; r <= ranges; r++) {
        const rk = String(r);
        const cur = rh[rk] != null ? rh[rk] : (rh[r] != null ? rh[r] : 1);
        html += '<label class="config-field">Bahn ' + r +
          '<input type="number" step="any" min="0.1" max="3" data-key="' +
          esc(key) + '" data-range="' + r + '" value="' + esc(cur) + '"></label>';
      }
      html += '</div></fieldset>';
      return html;
    }

    if (key === 'rangeTargets') {
      const ranges = getRangesFn();
      const rt = (value && typeof value === 'object') ? value : {};
      const profileEnums = (prop.additionalProperties && prop.additionalProperties.properties &&
        prop.additionalProperties.properties.targetProfile &&
        prop.additionalProperties.properties.targetProfile.enum) || TARGET_PROFILE_ENUM;
      let html = '<fieldset class="config-fieldset"><legend>' + label + hint + '</legend><p class="config-hint">Überschreibt Disziplin-Zuordnung für einzelne Bahnen.</p><div class="config-check-grid">';
      for (let r = 1; r <= ranges; r++) {
        const rk = String(r);
        const cur = rt[rk] || rt[r];
        const profile = (cur && typeof cur === 'object' && cur.targetProfile) ? cur.targetProfile : '';
        html += '<label class="config-field">Bahn ' + r + '<select data-key="' + esc(key) + '" data-range="' + r + '" data-subkey="targetProfile">';
        html += '<option value="">— automatisch —</option>';
        profileEnums.forEach(function (opt) {
          html += '<option value="' + esc(opt) + '"' + (profile === opt ? ' selected' : '') + '>' + esc(opt) + '</option>';
        });
        html += '</select></label>';
      }
      html += '</div></fieldset>';
      return html;
    }

    if (key === 'disciplineTargets') {
      const dt = (value && typeof value === 'object') ? value : {};
      const allEnums = (prop.additionalProperties && prop.additionalProperties.enum) || TARGET_PROFILE_ENUM;
      let html = '<fieldset class="config-fieldset"><legend>' + label + hint + '</legend>' +
        '<p class="config-hint">Eine Scheibe pro Disziplin. Live kommt LG/LP/KK von OpticScore; auf der Anzeige lässt sich das pro Bahn korrigieren.</p>' +
        '<div class="config-check-grid">';
      DISCIPLINE_FAMILIES.forEach(function (family) {
        const enums = family.profiles && family.profiles.length ? family.profiles : allEnums;
        const cur = familyProfileValue(dt, family);
        html += '<label class="config-field">' + esc(family.label) +
          '<select data-key="' + esc(key) + '" data-family="' + esc(family.id) + '">';
        enums.forEach(function (opt) {
          html += '<option value="' + esc(opt) + '"' + (cur === opt ? ' selected' : '') + '>' +
            esc(targetProfileLabel(opt)) + '</option>';
        });
        html += '</select></label>';
      });
      html += '</div></fieldset>';
      return html;
    }

    if (key === 'rangeDifficulties' || (t === 'object' && prop.additionalProperties && prop.additionalProperties.enum)) {
      const ranges = getRangesFn();
      const rd = (value && typeof value === 'object') ? value : {};
      let html = '<fieldset class="config-fieldset"><legend>' + label + hint + '</legend><div class="config-check-grid">';
      for (let r = 1; r <= ranges; r++) {
        const rk = String(r);
        const cur = rd[rk] || rd[r] || 'normal';
        const enums = (prop.additionalProperties && prop.additionalProperties.enum) || ['easy', 'normal', 'hard'];
        html += '<label class="config-field">Bahn ' + r + '<select data-key="' + esc(key) + '" data-range="' + r + '">';
        enums.forEach(function (opt) {
          html += '<option value="' + esc(opt) + '"' + (cur === opt ? ' selected' : '') + '>' + esc(opt) + '</option>';
        });
        html += '</select></label>';
      }
      html += '</div></fieldset>';
      return html;
    }

    if (t === 'boolean') {
      return '<label class="config-check"><input type="checkbox" id="' + id + '" data-key="' + esc(key) + '"' +
        (value ? ' checked' : '') + '> <span>' + label + hint + '</span></label>';
    }
    if (prop.enum) {
      let html = '<label class="config-field">' + label + hint + '<select id="' + id + '" data-key="' + esc(key) + '">';
      prop.enum.forEach(function (opt) {
        html += '<option value="' + esc(opt) + '"' + (value === opt ? ' selected' : '') + '>' +
          esc(targetProfileLabel(opt)) + '</option>';
      });
      html += '</select></label>';
      return html;
    }
    const inputType = (t === 'integer' || t === 'number') ? 'number' : 'text';
    const step = t === 'integer' ? ' step="1"' : (t === 'number' ? ' step="any"' : '');
    const min = prop.minimum != null ? ' min="' + esc(prop.minimum) + '"' : '';
    const max = prop.maximum != null ? ' max="' + esc(prop.maximum) + '"' : '';
    return '<label class="config-field">' + label + hint + '<input type="' + inputType + '" id="' + id +
      '" data-key="' + esc(key) + '" value="' + esc(value == null ? '' : value) + '"' + step + min + max + '></label>';
  }

  function collectPluginMerged() {
    if (!panel || !pluginData) return {};
    const merged = Object.assign({}, pluginData.manifestDefaults || {});
    const schema = (pluginData.configSchema && pluginData.configSchema.properties) || {};
    Object.keys(schema).forEach(function (key) {
      const prop = schema[key];
      if (key === 'rangeTargets') {
        const rt = {};
        panel.querySelectorAll('[data-key="' + key + '"][data-range]').forEach(function (sel) {
          const profile = sel.value;
          if (profile) {
            rt[String(sel.getAttribute('data-range'))] = { targetProfile: profile };
          }
        });
        merged[key] = rt;
        return;
      }
      if (key === 'disciplineTargets') {
        const dt = {};
        panel.querySelectorAll('[data-key="' + key + '"][data-family]').forEach(function (sel) {
          const familyId = sel.getAttribute('data-family');
          const family = DISCIPLINE_FAMILIES.filter(function (f) { return f.id === familyId; })[0];
          const keys = (family && family.keys) || [familyId];
          keys.forEach(function (alias) {
            dt[alias] = sel.value;
          });
        });
        panel.querySelectorAll('[data-key="' + key + '"][data-discipline]').forEach(function (sel) {
          dt[sel.getAttribute('data-discipline')] = sel.value;
        });
        merged[key] = dt;
        return;
      }
      if (key === 'rangeHandicaps') {
        const rh = {};
        panel.querySelectorAll('[data-key="' + key + '"][data-range]').forEach(function (inp) {
          rh[String(inp.getAttribute('data-range'))] = parseFloat(inp.value);
        });
        merged[key] = rh;
        return;
      }
      if (key === 'rangeDifficulties' || (schemaType(prop) === 'object' && prop.additionalProperties && prop.additionalProperties.enum)) {
        const rd = {};
        panel.querySelectorAll('[data-key="' + key + '"][data-range]').forEach(function (sel) {
          rd[String(sel.getAttribute('data-range'))] = sel.value;
        });
        merged[key] = rd;
        return;
      }
      const el = panel.querySelector('[data-key="' + key + '"]');
      if (!el) return;
      if (el.type === 'checkbox') merged[key] = el.checked;
      else if (el.type === 'number') merged[key] = el.value.includes('.') ? parseFloat(el.value) : parseInt(el.value, 10);
      else if (schemaType(prop) === 'integer') merged[key] = parseInt(el.value, 10);
      else if (schemaType(prop) === 'number') merged[key] = parseFloat(el.value);
      else merged[key] = el.value;
    });
    return merged;
  }

  function collectGlobalConfig() {
    const footer = {};
    FOOTER_FIELDS.forEach(function (pair) {
      const el = panel.querySelector('#gfooter-' + pair[0]);
      footer[pair[0]] = el ? el.checked : false;
    });
    const pins = [];
    panel.querySelectorAll('.plugin-pin-row').forEach(function (row) {
      const id = row.querySelector('.pin-id');
      const ver = row.querySelector('.pin-version');
      if (id && id.value.trim()) {
        pins.push({ id: id.value.trim(), version: ver ? ver.value.trim() : '' });
      }
    });
    const body = {
      udpPort: parseInt(panel.querySelector('#g-udpPort').value, 10),
      udpForward: (panel.querySelector('#g-udpForward').value || '').trim(),
      odbcName: panel.querySelector('#g-odbcName').value,
      ranges: parseInt(panel.querySelector('#g-ranges').value, 10),
      layoutColumns: parseInt(panel.querySelector('#g-layoutColumns').value, 10),
      pluginsDir: panel.querySelector('#g-pluginsDir').value,
      activePlugin: panel.querySelector('#g-activePlugin').value,
      pluginPins: pins,
      defaultDisplayMode: panel.querySelector('#g-defaultMode').value,
      shotStrokeWidth: parseFloat(panel.querySelector('#g-shotStrokeWidth').value),
      footer: footer
    };
    // The server cannot send the token back, so an empty field means "keep the
    // stored one" rather than "clear it". Omitting the key expresses that.
    const token = panel.querySelector('#g-controlToken').value;
    if (token) body.controlToken = token;
    return body;
  }

  function renderGlobalSection() {
    const c = globalData || {};
    const f = c.footer || {};
    let pinRows = '';
    (c.pluginPins || []).forEach(function (p) {
      pinRows += '<div class="plugin-pin-row">' +
        '<input class="pin-id" placeholder="Plugin-ID" value="' + esc(p.id || p.ID || '') + '">' +
        '<input class="pin-version" placeholder="Version" value="' + esc(p.version || p.Version || '') + '">' +
        '</div>';
    });
    if (!pinRows) {
      pinRows = '<div class="plugin-pin-row">' +
        '<input class="pin-id" placeholder="Plugin-ID"> <input class="pin-version" placeholder="Version">' +
        '</div>';
    }

    let footerHtml = '';
    FOOTER_FIELDS.forEach(function (pair) {
      footerHtml += '<label class="config-check"><input type="checkbox" id="gfooter-' + pair[0] + '"' +
        (f[pair[0]] ? ' checked' : '') + '> <span>' + esc(pair[1]) + '</span></label>';
    });

    return '<section class="config-section">' +
      '<header class="config-section-head">' +
      '<h3>Standort</h3>' +
      '<p class="config-hint">Globale Einstellungen aus <code>config.xml</code>. UDP-Weiterleitung sendet jedes OpticScore-Datagramm an ein zweites Dashboard (Neustart nötig).</p>' +
      '</header>' +
      '<div class="config-grid">' +
      '<label class="config-field">UDP-Port<input type="number" id="g-udpPort" value="' + esc(c.udpPort) + '"></label>' +
      '<label class="config-field">UDP-Weiterleitung<input type="text" id="g-udpForward" placeholder="127.0.0.1:30170 oder 192.168.1.10:30169" value="' +
        esc(c.udpForward || '') + '"></label>' +
      '<label class="config-field">ODBC-Name<input type="text" id="g-odbcName" value="' + esc(c.odbcName) + '"></label>' +
      '<label class="config-field">Bahnen<input type="number" id="g-ranges" min="1" value="' + esc(c.ranges) + '"></label>' +
      '<label class="config-field">Layout-Spalten<input type="number" id="g-layoutColumns" min="1" value="' + esc(c.layoutColumns) + '"></label>' +
      '<label class="config-field">Plugin-Ordner<input type="text" id="g-pluginsDir" value="' + esc(c.pluginsDir) + '"></label>' +
      '<label class="config-field">Standard-Plugin<input type="text" id="g-activePlugin" value="' + esc(c.activePlugin || 'classic-range') + '"></label>' +
      '<label class="config-field">Anzeige-Modus<input type="text" id="g-defaultMode" value="' + esc(c.defaultDisplayMode) + '"></label>' +
      '<label class="config-field">Control-Token<input type="password" id="g-controlToken" autocomplete="new-password" placeholder="' +
        (c.controlTokenSet ? 'gesetzt — leer lassen, um es zu behalten' : 'nicht gesetzt') + '"></label>' +
      '<label class="config-field">Schuss-Kontur (mm)<input type="number" id="g-shotStrokeWidth" min="0" max="2" step="0.01" value="' +
        esc(c.shotStrokeWidth != null ? c.shotStrokeWidth : 0.1) + '"></label>' +
      '</div>' +
      '<fieldset class="config-fieldset"><legend>Plugin-Versionen pinnen</legend>' +
      pinRows +
      '<button type="button" class="btn btn-ghost config-add-pin">Pin hinzufügen</button></fieldset>' +
      '<fieldset class="config-fieldset"><legend>Footer-Anzeige</legend>' +
      '<div class="config-check-grid">' + footerHtml + '</div></fieldset>' +
      '<div class="config-actions">' +
      '<button type="button" class="btn btn-primary" id="config-save-global">Standort speichern</button>' +
      '<span id="config-global-status" class="config-editor-status"></span>' +
      '</div>' +
      '</section>';
  }

  function renderRecoverySection() {
    return '<section class="config-section">' +
      '<header class="config-section-head">' +
      '<h3>Wiederherstellung</h3>' +
      '<p class="config-hint">Konsolen-Ausgabe von <code>srdashboard.exe</code> und die Datei <code>log/&lt;Startzeit&gt;.txt</code> sind dasselbe Format. ' +
      'Hier einfügen (oder OpticScore-JSON). Schüsse laufen durch die normale Prüfung; das aktive Spiel wertet sie mit aus. ' +
      'Zufallsereignisse (z. B. Reifenplatzer) stehen nicht im Log und lassen sich nicht originalgetreu wiederholen. ' +
      'Danach <a href="/">Live-Ansicht</a> öffnen.</p>' +
      '</header>' +
      '<label class="config-check config-field-full"><input type="checkbox" id="recovery-clear-ranges" checked> ' +
      '<span>Bahnen vor dem Nachspielen leeren</span></label>' +
      '<label class="config-field config-field-full">Log einfügen' +
      '<textarea id="recovery-log" class="config-recovery-log" rows="12" spellcheck="false" ' +
      'placeholder="Konsolen-Ausgabe, log/&lt;Startzeit&gt;.txt oder OpticScore-JSON einfügen…"></textarea></label>' +
      '<div class="config-actions">' +
      '<button type="button" class="btn btn-primary" id="recovery-replay">Schüsse nachspielen</button>' +
      '<button type="button" class="btn btn-ghost" id="recovery-clear-text">Leeren</button>' +
      '<span id="recovery-status" class="config-editor-status"></span>' +
      '</div>' +
      '</section>';
  }

  function renderPluginSection() {
    if (!pluginId) {
      return '<section class="config-section">' +
        '<header class="config-section-head"><h3>Plugin</h3>' +
        '<p class="config-hint">Kein aktives Plugin – Overrides können hier nicht geladen werden.</p></header></section>';
    }
    if (!pluginData) {
      return '<section class="config-section">' +
        '<header class="config-section-head"><h3>Plugin</h3>' +
        '<p class="config-hint">Laden…</p></header></section>';
    }
    const schema = pluginData.configSchema || {};
    const props = schema.properties || {};
    const merged = pluginData.merged || {};
    const defaults = pluginData.manifestDefaults || {};
    let fields = '';
    Object.keys(props).forEach(function (key) {
      fields += '<div class="config-plugin-field">' +
        renderSchemaField(key, props[key], merged[key], defaults, merged) + '</div>';
    });
    if (!fields) fields = '<p class="config-hint">Dieses Plugin hat keine konfigurierbaren Einstellungen.</p>';
    return '<section class="config-section">' +
      '<header class="config-section-head">' +
      '<h3>Plugin — ' + esc(pluginId) + '</h3>' +
      '<p class="config-hint">Werte mit <span class="config-override-badge">Override</span> weichen vom Manifest ab und werden in <code>plugins/' +
      esc(pluginId) + '/config.xml</code> gespeichert.</p>' +
      '</header>' +
      '<div class="config-plugin-fields">' + fields + '</div>' +
      '<div class="config-actions">' +
      '<button type="button" class="btn btn-primary" id="config-save-plugin">Plugin speichern</button>' +
      '<span id="config-plugin-status" class="config-editor-status"></span>' +
      '</div>' +
      '</section>';
  }

  function render() {
    if (!panel) return;
    const pageMode = panel.classList.contains('config-page-panel') ||
      document.body.classList.contains('config-display');
    if (pageMode) {
      panel.innerHTML =
        '<div class="config-page-body">' +
        renderGlobalSection() +
        renderRecoverySection() +
        renderPluginSection() +
        '</div>';
    } else {
      panel.innerHTML =
        '<div class="drawer-inner settings-inner">' +
        '<header class="settings-head">' +
        '<div><h2>Plugin</h2><p class="settings-sub">Aktives Plugin</p></div>' +
        '<button type="button" class="btn btn-ghost settings-close" id="config-close" aria-label="Schließen">Schließen</button>' +
        '</header>' +
        '<div class="settings-body">' +
        renderPluginSection() +
        '</div></div>';
      const closeBtn = panel.querySelector('#config-close');
      if (closeBtn) {
        closeBtn.onclick = function () {
          panel.hidden = true;
          syncSettingsButton(false);
        };
      }
    }

    const saveGlobal = panel.querySelector('#config-save-global');
    if (saveGlobal) saveGlobal.onclick = saveGlobalConfig;
    const savePlugin = panel.querySelector('#config-save-plugin');
    if (savePlugin) savePlugin.onclick = savePluginConfig;
    const replayBtn = panel.querySelector('#recovery-replay');
    if (replayBtn) replayBtn.onclick = replayRecoveryLog;
    const clearBtn = panel.querySelector('#recovery-clear-text');
    if (clearBtn) {
      clearBtn.onclick = function () {
        const ta = panel.querySelector('#recovery-log');
        const status = panel.querySelector('#recovery-status');
        if (ta) ta.value = '';
        setStatus(status, '', false);
      };
    }
    const addPin = panel.querySelector('.config-add-pin');
    if (addPin) {
      addPin.onclick = function () {
        const pinFieldset = addPin.closest('.config-fieldset');
        if (!pinFieldset) return;
        const row = document.createElement('div');
        row.className = 'plugin-pin-row';
        row.innerHTML = '<input class="pin-id" placeholder="Plugin-ID"> <input class="pin-version" placeholder="Version">';
        pinFieldset.insertBefore(row, addPin);
      };
    }
  }

  function syncSettingsButton(open) {
    // no side-menu settings button anymore
  }

  async function loadGlobal() {
    const res = await fetch('/api/config');
    if (res.ok) globalData = await res.json();
  }

  async function loadPlugin(id) {
    pluginId = id || '';
    pluginData = null;
    render();
    if (!pluginId) return;
    const res = await fetch('/api/plugins/' + encodeURIComponent(pluginId) + '/config');
    if (res.ok) pluginData = await res.json();
    render();
  }

  async function saveGlobalConfig() {
    const status = panel.querySelector('#config-global-status');
    setStatus(status, 'Speichern…', false);
    const body = collectGlobalConfig();
    const res = await controlFetch('/api/config', {
      method: 'PUT',
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      setStatus(status, 'Fehler: ' + (await res.text()), true);
      return;
    }
    const result = await res.json();
    globalData = body;
    if (result.restartRequired) {
      setStatus(status, 'Gespeichert. Neustart nötig für: ' + (result.restartFields || []).join(', '), true);
    } else {
      setStatus(status, 'Gespeichert.', false);
      if (window.SRCore && window.SRCore.fetchConfig) await window.SRCore.fetchConfig();
    }
  }

  async function replayRecoveryLog() {
    const status = panel.querySelector('#recovery-status');
    const ta = panel.querySelector('#recovery-log');
    if (!ta) return;
    const logText = ta.value.trim();
    if (!logText) {
      setStatus(status, 'Bitte zuerst ein Log einfügen.', true);
      return;
    }
    setStatus(status, 'Spiele Schüsse nach…', false);
    const res = await controlFetch('/api/recovery/replay', {
      method: 'POST',
      body: JSON.stringify({
        log: logText,
        clear: !!(panel.querySelector('#recovery-clear-ranges') && panel.querySelector('#recovery-clear-ranges').checked)
      })
    });
    if (!res.ok) {
      setStatus(status, 'Fehler: ' + (await res.text()), true);
      return;
    }
    const result = await res.json();
    const lines = result && result.lines != null ? result.lines : 0;
    const applied = result && result.applied != null ? result.applied : 0;
    if (lines === 0) {
      setStatus(status, 'Keine Schuss-Zeilen erkannt. Log aus log/ oder OpticScore OUT-JSONInterface einfügen.', true);
    } else if (applied === 0) {
      setStatus(status, lines + ' Zeile(n) erkannt, aber kein Schuss übernommen (Bahn aktiv? Daten gültig?).', true);
    } else {
      setStatus(status, applied + ' von ' + lines + ' Schuss' + (lines === 1 ? '' : 'en') + ' nachgespielt (Live + Spiel). Live-Ansicht aktualisieren.', false);
    }
  }

  async function savePluginConfig() {
    const status = panel.querySelector('#config-plugin-status');
    setStatus(status, 'Speichern…', false);
    const merged = collectPluginMerged();
    const res = await controlFetch('/api/plugins/' + encodeURIComponent(pluginId) + '/config', {
      method: 'PUT',
      body: JSON.stringify({ merged: merged })
    });
    if (!res.ok) {
      setStatus(status, 'Fehler: ' + (await res.text()), true);
      return;
    }
    const result = await res.json();
    pluginData = Object.assign({}, pluginData, {
      overrides: result.overrides,
      merged: result.merged
    });
    render();
    if (window.SRCore && typeof window.SRCore.setPluginTargetConfig === 'function' && result.merged) {
      window.SRCore.setPluginTargetConfig(result.merged);
    }
    setStatus(panel.querySelector('#config-plugin-status'), 'Gespeichert.', false);
  }

  function applyOptions(options) {
    options = options || {};
    if (options.getRanges) getRangesFn = options.getRanges;
    if (options.controlFetch) controlFetch = options.controlFetch;
  }

  function ensurePanel(container) {
    if (panel) return panel;
    if (container) {
      panel = typeof container === 'string' ? document.getElementById(container) : container;
    } else {
      panel = document.getElementById('config-editor-panel');
    }
    return panel;
  }

  window.SRConfigEditor = {
    init: function (container, options) {
      ensurePanel(container);
      if (!panel) return;
      applyOptions(options);
    },
    mountPage: function (container, options) {
      ensurePanel(container);
      if (!panel) return;
      panel.classList.add('config-page-panel');
      panel.hidden = false;
      applyOptions(options);
      // Site config only used for range count helpers; UI is plugin-only
      loadGlobal().then(function () {
        if (options && options.pluginId) loadPlugin(options.pluginId);
        else render();
      });
    },
    open: function (options) {
      const q = (options && options.pluginId)
        ? '/config?plugin=' + encodeURIComponent(options.pluginId)
        : '/config';
      location.href = q;
    },
    show: function () { location.href = '/config'; },
    hide: function () {
      if (panel && !panel.classList.contains('config-page-panel')) {
        panel.hidden = true;
        panel.style.display = 'none';
      }
    },
    loadGlobal: loadGlobal,
    loadPlugin: loadPlugin
  };
})();
