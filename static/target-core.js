const POLL_INTERVAL_MS = 1000;
/** Slow safety poll while WebSocket is connected (master/shooter gate their own timers). */
const SAFETY_POLL_MS = 20000;

// --- Target scale (DISAG OpticScore vs SVG) ---
// X, Y = shot coordinates (centre 0,0) in DISAG OpticScore units. Distance = Teiler = sqrt(X^2+Y^2).
// DecValue/FullValue come pre-scored from OpticScore (discipline-aware). See target-registry teilerBandDsg.
// LG scale from scoring: teilerBand 25 DSG / 0.25 mm = 100 DSG/mm (±9000 → ±90 mm). SVG viewBox 0 0 200 200, centre 100.
const DSG_COORD_RANGE = 9000;           // max radius from DISAG OpticScore coordinate system
const RANGE_DIAMETER_MM = 200;             // SVG viewBox spans 200 mm (target face centred in frame)
const DSG_PER_MM = 100;                 // rifle default: scoring-verified (25 DSG per 0.1 / 0.25 mm)
// Default mapping for legacy targets: DSG_PER_SVG_UNIT = 100, SVG viewBox 0 0 200 200, centre 100.
const DEFAULT_DSG_PER_SVG_UNIT = 100;
const TARGET_DIAMETER_MM = 45.5;          // ISSF scoring target (sits inside 200 mm range)
const SHOT_DIAMETER_MM = 4.5;            // pellet diameter (mm)
const TEN_RING_DIAMETER_MM = 0.5;        // 10 ring (ISSF)
const DEFAULT_SVG_CENTER = 100;          // viewBox center (100, 100)
const DEFAULT_SVG_VIEW_SIZE = 200;       // default viewBox size for targets
// DISAG OpticScore → SVG (defaults): x_svg = SVG_CENTER + x_dsg/100, y_svg = SVG_CENTER - y_dsg/100
// 1 SVG unit = 1 mm, so pellet radius is simply half diameter.
const SHOT_RADIUS_SVG = SHOT_DIAMETER_MM / 2; // 2.25 mm
/** Default pellet outline width (mm); overridden by config.shotStrokeWidth. */
const DEFAULT_SHOT_STROKE_SVG = 0.1;

// Zoom via SVG viewBox only (target image + shot circles in ONE svg). Never CSS-transform.
// viewBox units = mm = SVG units (1 SVG unit = 1 mm at DSG_PER_MM = 100).
const ONE_RING_SVG = 2.5;           // ISSF ring width (mm)
const RING_8_RADIUS_MM = 5.25;      // ISSF ring 8 outer radius — max zoom-in frames this as outer circle
const AUTO_ZOOM_PAD_FRAC = 0.04;    // default breathing room beyond outermost shot edge
/** Extra pad as a fraction of maxDist; large faces (KK/LP) use a tighter profile value. */
const AUTO_ZOOM_PAD_FRAC_LARGE = 0.015;
const SCORING_DISK_PAD_MM = 4;      // empty/reset: tight frame so the full scoring disk starts large (like yesterday)
/** Tightest allowed viewBox span: ring 8 fills the frame (outer circle). */
const MIN_ZOOM_SPAN_MM = RING_8_RADIUS_MM * 2;
/** Wheel zoom: ln(factor) = normalizedDelta * gain. A 120-unit mouse notch ≈ 5.8%. */
const ZOOM_WHEEL_GAIN = 0.00048;
/** Cap |ln(factor)| so one event cannot skip the useful zoom range. */
const ZOOM_WHEEL_MAX_LN = 0.08;

// Classic Range pellets: rainbow or single-hue shades; sat from --shot-sat (side-menu).
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
  };
  const r = Math.round(f(0) * 255), g = Math.round(f(8) * 255), b = Math.round(f(4) * 255);
  return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

const SHOT_ORDER_COUNT = 10;
/** Original used s=75 / l=50; softer defaults; sat is live-adjustable. */
const DEFAULT_SHOT_SAT = 48;
const DEFAULT_SHOT_LIGHT = 52;

let lastLiveData = null;
let lastWettkampf = null;
let hallPluginId = '';

function setHallPluginId(id) {
  hallPluginId = String(id || '');
}

function getHallPluginId() {
  return hallPluginId;
}

function readCssNumber(name, fallback) {
  const styles = getComputedStyle(document.documentElement);
  const n = Number(styles.getPropertyValue(name).trim());
  return Number.isFinite(n) ? n : fallback;
}

function readCssRaw(name) {
  const inline = document.documentElement.style.getPropertyValue(name).trim();
  if (inline) return inline;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function shotHueAt(i) {
  const idx = ((i % SHOT_ORDER_COUNT) + SHOT_ORDER_COUNT) % SHOT_ORDER_COUNT;
  return (idx / (SHOT_ORDER_COUNT - 1)) * 330;
}

/** 'rainbow' or hue index 0..9 (matches the ten rainbow swatches). */
function getShotColorMode() {
  const raw = readCssRaw('--shot-mode');
  if (!raw || raw === 'rainbow') return 'rainbow';
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0 && n < SHOT_ORDER_COUNT) return Math.round(n);
  return 'rainbow';
}

/** Ten shot fills: rainbow hues, or light→deep shades of one selected hue. */
function getShotOrderColors() {
  const s = Math.max(0, Math.min(100, readCssNumber('--shot-sat', DEFAULT_SHOT_SAT)));
  const l = Math.max(0, Math.min(100, readCssNumber('--shot-light', DEFAULT_SHOT_LIGHT)));
  const mode = getShotColorMode();
  if (mode === 'rainbow') {
    return Array.from({ length: SHOT_ORDER_COUNT }, (_, i) => hslToHex(shotHueAt(i), s, l));
  }
  const hue = shotHueAt(mode);
  return Array.from({ length: SHOT_ORDER_COUNT }, (_, i) => {
    const t = SHOT_ORDER_COUNT <= 1 ? 1 : i / (SHOT_ORDER_COUNT - 1);
    // Same base hue: pale → deep; slider sets peak saturation.
    const sat = Math.max(0, Math.min(100, s * (0.4 + 0.6 * t)));
    const light = 74 - t * 40;
    return hslToHex(hue, sat, light);
  });
}

/** Swatch preview colours at the current saturation (rainbow order). */
function getShotSwatchColors() {
  const s = Math.max(0, Math.min(100, readCssNumber('--shot-sat', DEFAULT_SHOT_SAT)));
  const l = Math.max(0, Math.min(100, readCssNumber('--shot-light', DEFAULT_SHOT_LIGHT)));
  return Array.from({ length: SHOT_ORDER_COUNT }, (_, i) => hslToHex(shotHueAt(i), s, l));
}

function colorForShotIndex(i) {
  const colors = getShotOrderColors();
  return colors[((i % colors.length) + colors.length) % colors.length];
}

/** Re-paint pellets + last-10 bars after palette (sat / mode) changes. */
function repaintShotColors() {
  document.querySelectorAll('.last10-chart-wrap').forEach(function (wrap) {
    delete wrap.dataset.chartSig;
  });
  if (!lastLiveData || !lastLiveData.ranges) return;
  lastLiveData.ranges.forEach(function (r) {
    document.querySelectorAll('.classic-range-view').forEach(function (el) {
      const host = el.closest('[data-range]');
      const n = el.dataset.range || (host && host.dataset.range);
      if (String(n) !== String(r.rangeNum)) return;
      refreshClassicRangeView(el, r);
    });
  });
}

let zoomStateByRange = {};   // viewKey -> { x, y, w, h } SVG viewBox
let prevShotsLengthByRange = {};  // viewKey -> number
let prevIsWarmupByRange = {};     // viewKey -> last isWarmup (warmup→competition resets zoom)
let userZoomedByRange = {};  // viewKey -> true if user zoomed via wheel/drag; cleared on target reset
let pinFullUntilNewShotByRange = {}; // dblclick: stay at full disk until another shot arrives
/** Per-session series focus: { index, atShotNumber } while reviewing a completed series. */
let seriesFocusByRange = {};
/** Last-10 chart bar index currently hovered (null/undefined = none). */
let hoverBarIdxByRange = {};

function viewKey(rangeData, rangeNum) {
  const sid = rangeData && (rangeData.sessionResultId || rangeData.resultId);
  if (sid) return 's:' + sid;
  const n = rangeNum != null ? rangeNum : (rangeData && rangeData.rangeNum);
  return 'r:' + String(n);
}

function viewKeyFromSvg(svg, fallbackRangeNum) {
  if (svg && svg.dataset && svg.dataset.viewKey) return svg.dataset.viewKey;
  return 'r:' + String(fallbackRangeNum);
}

function focusKey(rangeData, rangeNum) {
  return viewKey(rangeData, rangeNum != null ? rangeNum : (rangeData && rangeData.rangeNum));
}

function liveMatchesSessionId(live, id) {
  if (!id) return true;
  if (!live) return false;
  if (String(id) === ('live-' + live.rangeNum)) return true;
  if (live.resultId) return String(live.resultId) === String(id);
  if (live.sessionResultId) return String(live.sessionResultId) === String(id);
  return true;
}

function isFrozenSessionData(rangeData) {
  return !!(rangeData && rangeData.sessionResultLive === false);
}

function isFrozenSessionView(el) {
  if (!el) return false;
  if (el.dataset && el.dataset.sessionResultLive === '0') return true;
  const panel = el.closest && el.closest('.range-panel');
  return !!(panel && panel.dataset && panel.dataset.sessionResultLive === '0');
}

function rememberPaintedRange(host, rangeData) {
  if (!host || !rangeData) return;
  host._paintedRange = rangeData;
  host.dataset.range = String(rangeData.rangeNum || '');
  if (rangeData.sessionResultId) {
    host.dataset.sessionResult = String(rangeData.sessionResultId);
    host.dataset.sessionResultLive = rangeData.sessionResultLive === false ? '0' : '1';
  } else {
    delete host.dataset.sessionResult;
    delete host.dataset.sessionResultLive;
  }
  const panel = host.closest && host.closest('.range-panel');
  if (panel && panel !== host) rememberPaintedRange(panel, rangeData);
}

function rangeDataForRepaint(rangeData) {
  if (!rangeData || isFrozenSessionData(rangeData)) return rangeData;
  const live = liveRangeData(rangeData.rangeNum);
  if (!live) return rangeData;
  if (!liveMatchesSessionId(live, rangeData.sessionResultId)) return rangeData;
  if (rangeData.sessionResultId) {
    return Object.assign({}, live, {
      sessionResultId: rangeData.sessionResultId,
      sessionResultLive: true
    });
  }
  return live;
}

function refreshClassicRangeView(el, live) {
  if (!el) return;
  if (isFrozenSessionView(el)) {
    if (el._paintedRange) renderClassicRangeView(el, el._paintedRange);
    return;
  }
  if (!live) return;
  const host = (el.closest && el.closest('.range-panel')) || el;
  const sid = (el.dataset && el.dataset.sessionResult) || (host.dataset && host.dataset.sessionResult);
  if (sid && !liveMatchesSessionId(live, sid)) return;
  let data = live;
  if (sid) {
    data = Object.assign({}, live, { sessionResultId: sid, sessionResultLive: true });
  }
  renderClassicRangeView(el, data);
}

let config = {
  ranges: 6,
  layoutColumns: 4,
  inactiveRanges: [],
  wettkampfVisible: true,
  shotStrokeWidth: DEFAULT_SHOT_STROKE_SVG,
  footer: {
    currentShotValue: true,
    teiler: true,
    shotNumber: true,
    overallSumInt: true,
    overallSumDecimal: true,
    predictionInt: true,
    predictionDecimal: true,
    seriesSumsInt: true,
    seriesSumsDecimal: true,
    last10Int: true,
    last10Decimal: true
  }
};

/** Plugin config from classic-range (discipline → profile, per-range overrides). */
let pluginTargetConfig = null;
/** Resolved scale + SVG file per range (from SRTargetRegistry when available). */
let targetContextByRange = {};
/** Range currently being rendered (fallback for helpers without rangeNum). */
let activeScaleRangeNum = null;

function setPluginTargetConfig(cfg) {
  pluginTargetConfig = cfg || null;
  targetContextByRange = {};
  // Drop zoom windows so a new profile does not keep the previous face's viewBox.
  zoomStateByRange = {};
  userZoomedByRange = {};
  pinFullUntilNewShotByRange = {};
  document.querySelectorAll('svg.target-svg-root').forEach(function (el) {
    el.remove();
  });
  if (lastLiveData) syncRangeVisibility(lastLiveData);
  else syncRangeVisibility(null);
}

function hideIdleRangesEnabled() {
  const cfg = pluginTargetConfig || {};
  return cfg.hideIdleRanges === true || cfg.hideIdleRanges === 'true';
}

function inactiveRangeSet() {
  const list = (config && config.inactiveRanges) || [];
  const set = {};
  for (let i = 0; i < list.length; i++) set[Number(list[i])] = true;
  return set;
}

function isRangeInactive(num) {
  return !!inactiveRangeSet()[Number(num)];
}

function wettkampfTileEnabled() {
  return hallPluginId === 'classic-range-condensed' && config.wettkampfVisible !== false;
}

function isWettkampfPanel(panel) {
  return !!(panel && panel.getAttribute && panel.getAttribute('data-slot') === 'wettkampf');
}

function resolveTargetProfileId(rangeNum, rangeData) {
  const cfg = pluginTargetConfig || {};
  const map = cfg.disciplineTargets || {};
  const family = effectiveFamily(rangeData);
  const fromFamily = family && profileForFamily(map, family);
  if (fromFamily) return fromFamily;
  const profile = profileFromDisciplineMap(map, rangeData);
  if (profile) return profile;
  if (family === 'lp') return 'air_pistol_10m';
  if (family === 'kk') return 'smallbore_50m_prone';
  if (family === 'lg') return 'air_rifle_10m';
  return cfg.defaultTargetProfile || 'air_rifle_10m';
}

const PROGRAM_SPECS = [
  { id: 'lg', family: 'lg', decimal: false, label: 'LG', chip: 'LG' },
  { id: 'lga', family: 'lg', decimal: true, label: 'LG Auflage', chip: 'LGA' },
  { id: 'lp', family: 'lp', decimal: false, label: 'LP', chip: 'LP' },
  { id: 'lpa', family: 'lp', decimal: true, label: 'LP Auflage', chip: 'LPA' },
  { id: 'kk', family: 'kk', decimal: false, label: 'KK', chip: 'KK' }
];
const PROGRAM_BY_ID = {};
PROGRAM_SPECS.forEach(function (p) { PROGRAM_BY_ID[p.id] = p; });

const FAMILY_ALIAS_KEYS = {
  lg: ['LG', 'Luftgewehr'],
  lp: ['LP', 'Luftpistole'],
  kk: ['KK', 'KK-Gewehr', 'Kleinkaliber']
};

const disciplineOverrideByRange = {};
const disciplineOverrideSigByRange = {};
let disciplineMenuRange = 0;

function canControlDisplay() {
  return !(window.SRMode && window.SRMode.canControl === false);
}

function isAuflageText(label) {
  return /auflage|aufgelegt/i.test(String(label || ''));
}

function parseShotCountLabel(label) {
  const s = String(label || '');
  const low = s.toLowerCase();
  if (!s) return 0;
  if (low.indexOf('unbegrenzt') !== -1) return 100;
  const times = low.match(/(\d{1,2})\s*[x×]\s*(\d{1,2})/);
  if (times) {
    const n = parseInt(times[1], 10) * parseInt(times[2], 10);
    return n >= 1000 ? 100 : n;
  }
  const triple = low.match(/(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{1,2})/);
  if (triple) {
    const n = parseInt(triple[1], 10) + parseInt(triple[2], 10) + parseInt(triple[3], 10);
    return n >= 1000 ? 100 : n;
  }
  const m = s.match(/(\d+)\s*schuss/i);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n >= 1000 ? 100 : n;
}

function shotCountFromProgram(rangeData) {
  const n = Number(rangeData && rangeData.totalShotsToFire);
  if (n >= 1000) return 100;
  if (n > 0) return n;
  return parseShotCountLabel((rangeData && rangeData.discipline) || '');
}

function detectFamily(rangeData) {
  if (!rangeData) return '';
  const disc = String(rangeData.discType || rangeData.DiscType || '').toUpperCase();
  const label = String(rangeData.discipline || '').toLowerCase();
  if (disc.indexOf('LP') === 0 || /(^|[^a-z])lp([^a-z]|$)/.test(label) || label.indexOf('luftpistole') !== -1) return 'lp';
  if (disc.indexOf('KK') === 0 || /(^|[^a-z])kk([^a-z]|$)/.test(label) || label.indexOf('kleinkaliber') !== -1) return 'kk';
  if (disc.indexOf('LG') === 0 || /(^|[^a-z])lg([^a-z]|$)/.test(label) || label.indexOf('luftgewehr') !== -1) return 'lg';
  if (isAuflageText(label)) return 'lg';
  return '';
}

function detectProgramId(rangeData) {
  const disc = String((rangeData && (rangeData.discType || rangeData.DiscType)) || '').toUpperCase();
  const family = detectFamily(rangeData);
  const auflage = disc === 'LGA' || disc === 'LPA' || disc === 'KKA' ||
    isAuflageText(rangeData && rangeData.discipline);
  if (family === 'lp') return auflage ? 'lpa' : 'lp';
  if (family === 'kk') return 'kk';
  if (family === 'lg') return auflage ? 'lga' : 'lg';
  return '';
}

function disciplineOverrideSig(rangeData) {
  return [
    rangeData && rangeData.rangeNum || 0,
    rangeData && rangeData.shooterName || '',
    rangeData && rangeData.discipline || '',
    rangeData && rangeData.discType || '',
    rangeData && rangeData.totalShotsToFire || 0
  ].join('|');
}

function syncDisciplineOverride(rangeData) {
  if (!rangeData || rangeData.rangeNum == null) return 'auto';
  const n = rangeData.rangeNum;
  const sig = disciplineOverrideSig(rangeData);
  if (!rangeData.shooterName) {
    disciplineOverrideSigByRange[n] = sig;
    disciplineOverrideByRange[n] = 'auto';
    if (disciplineMenuRange === n) closeDisciplineMenu();
    return 'auto';
  }
  if (disciplineOverrideSigByRange[n] !== sig) {
    disciplineOverrideSigByRange[n] = sig;
    disciplineOverrideByRange[n] = 'auto';
    if (disciplineMenuRange === n) closeDisciplineMenu();
  }
  return disciplineOverrideByRange[n] || 'auto';
}

function effectiveProgramId(rangeData) {
  const mode = syncDisciplineOverride(rangeData);
  if (mode && mode !== 'auto') return mode;
  return detectProgramId(rangeData);
}

function effectiveProgram(rangeData) {
  return PROGRAM_BY_ID[effectiveProgramId(rangeData)] || null;
}

function effectiveFamily(rangeData) {
  const p = effectiveProgram(rangeData);
  return (p && p.family) || detectFamily(rangeData);
}

function effectiveDecimal(rangeData) {
  const p = effectiveProgram(rangeData);
  if (p) return p.decimal;
  return isAuflageText(rangeData && rangeData.discipline);
}

function disciplineOverrideIsManual(rangeData) {
  const mode = syncDisciplineOverride(rangeData);
  if (!mode || mode === 'auto') return false;
  const detected = detectProgramId(rangeData);
  if (detected && mode === detected) return false;
  return true;
}

function profileForFamily(map, family) {
  const keys = FAMILY_ALIAS_KEYS[family] || [];
  for (let i = 0; i < keys.length; i++) {
    const id = map && map[keys[i]];
    if (id) return id;
  }
  return null;
}

function formatDisciplineChip(rangeData) {
  const p = effectiveProgram(rangeData);
  if (!p) return '';
  const n = shotCountFromProgram(rangeData);
  return n > 0 ? p.chip + String(n) : p.chip;
}

function formatOpticScoreDiscipline(rangeData) {
  const p = effectiveProgram(rangeData);
  if (!p) return (rangeData && rangeData.discipline) || '';
  const n = shotCountFromProgram(rangeData);
  const auflage = p.id === 'lga' || p.id === 'lpa';
  const code = p.family === 'lp' ? 'LP' : (p.family === 'kk' ? 'KK' : 'LG');
  if (n <= 0) return auflage ? code + ' Auflage' : code;
  return code + ' ' + n + ' Schuss' + (auflage ? ' Auflage' : '');
}

function formatDisciplineHeader(rangeData) {
  if (disciplineOverrideIsManual(rangeData)) {
    return formatOpticScoreDiscipline(rangeData);
  }
  return (rangeData && rangeData.discipline) || formatDisciplineChip(rangeData);
}

function liveRangeByNum(rangeNum) {
  const live = lastLiveData;
  return ((live && live.ranges) || []).find(function (r) {
    return r.rangeNum === rangeNum;
  }) || null;
}

function closeDisciplineMenu() {
  const menu = document.getElementById('range-disc-menu');
  if (menu) menu.hidden = true;
  disciplineMenuRange = 0;
  document.querySelectorAll('.range-disc-toggle[aria-expanded="true"]').forEach(function (el) {
    el.setAttribute('aria-expanded', 'false');
  });
}

function ensureDisciplineMenu() {
  let menu = document.getElementById('range-disc-menu');
  if (menu) return menu;
  menu = document.createElement('div');
  menu.id = 'range-disc-menu';
  menu.className = 'range-disc-menu';
  menu.hidden = true;
  let html = '<div class="range-disc-list" role="radiogroup" aria-label="Disziplin">';
  html += '<label class="range-disc-opt"><input type="radio" name="range-disc-program" value="auto"> Automatisch</label>';
  PROGRAM_SPECS.forEach(function (p) {
    html += '<label class="range-disc-opt"><input type="radio" name="range-disc-program" value="' + p.id + '"> ' +
      p.label + '</label>';
  });
  html += '</div>';
  menu.innerHTML = html;
  document.body.appendChild(menu);
  menu.addEventListener('change', function (ev) {
    const input = ev.target;
    if (!input || input.name !== 'range-disc-program') return;
    applyDisciplineOverride(disciplineMenuRange, input.value);
  });
  return menu;
}

function positionDisciplineMenu(menu, chip) {
  const r = chip.getBoundingClientRect();
  menu.style.left = 'auto';
  menu.style.top = (r.bottom + 4) + 'px';
  menu.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
  const box = menu.getBoundingClientRect();
  if (box.bottom > window.innerHeight - 8 && r.top > box.height + 8) {
    menu.style.top = (r.top - box.height - 4) + 'px';
  }
  if (box.left < 8) {
    menu.style.right = 'auto';
    menu.style.left = '8px';
  }
}

function openDisciplineMenu(chip) {
  const n = parseInt(chip.getAttribute('data-range'), 10);
  if (!Number.isFinite(n) || n < 1) return;
  const menu = ensureDisciplineMenu();
  const mode = disciplineOverrideByRange[n] || 'auto';
  menu.querySelectorAll('input[name="range-disc-program"]').forEach(function (input) {
    input.checked = input.value === mode;
  });
  document.querySelectorAll('.range-disc-toggle[aria-expanded="true"]').forEach(function (el) {
    if (el !== chip) el.setAttribute('aria-expanded', 'false');
  });
  disciplineMenuRange = n;
  menu.hidden = false;
  chip.setAttribute('aria-expanded', 'true');
  positionDisciplineMenu(menu, chip);
  const focusEl = menu.querySelector('input:checked') || menu.querySelector('input');
  if (focusEl) focusEl.focus();
}

function applyDisciplineOverride(rangeNum, mode) {
  const n = Number(rangeNum);
  if (!Number.isFinite(n) || n < 1) return;
  if (mode !== 'auto' && !PROGRAM_BY_ID[mode]) return;
  const panel = document.querySelector('.analyse-panel[data-range="' + n + '"]') ||
    document.querySelector('.range-panel[data-range="' + n + '"]');
  let rangeData = (panel && panel._paintedRange) || liveRangeByNum(n) || { rangeNum: n };
  if (!isFrozenSessionView(panel)) {
    rangeData = rangeDataForRepaint(rangeData) || rangeData;
  }
  disciplineOverrideByRange[n] = mode || 'auto';
  disciplineOverrideSigByRange[n] = disciplineOverrideSig(rangeData);
  closeDisciplineMenu();
  if (panel) delete panel.dataset.chromeSig;
  updatePluginPanelHeader(n, rangeData);
  const mount = panel && panel.querySelector('.range-plugin-view');
  const hall = getHallPluginId();
  if (mount && hall === 'classic-range-condensed' && window.SRClassicRangeCondensed) {
    window.SRClassicRangeCondensed.fillHeader(panel.querySelector('.range-header'), rangeData);
    window.SRClassicRangeCondensed.paint(mount, rangeData);
  } else if (mount && typeof renderClassicRangeView === 'function') {
    renderClassicRangeView(mount, rangeData);
  }
}

document.addEventListener('click', function (ev) {
  const menu = document.getElementById('range-disc-menu');
  const chip = ev.target && ev.target.closest && ev.target.closest('.range-disc-toggle');
  if (chip) {
    if (!canControlDisplay()) return;
    ev.preventDefault();
    const n = parseInt(chip.getAttribute('data-range'), 10);
    if (disciplineMenuRange === n && menu && !menu.hidden) {
      closeDisciplineMenu();
      return;
    }
    openDisciplineMenu(chip);
    return;
  }
  if (menu && !menu.hidden && menu.contains(ev.target)) return;
  if (menu && !menu.hidden) closeDisciplineMenu();
});

document.addEventListener('keydown', function (ev) {
  if (ev.key !== 'Escape') return;
  const menu = document.getElementById('range-disc-menu');
  if (!menu || menu.hidden) return;
  ev.preventDefault();
  closeDisciplineMenu();
});

/** Built-in OpticScore DiscType codes when plugin map has no match. */
const DISC_TYPE_FALLBACKS = {
  fun_dart: 'dartboard',
  dart: 'dartboard',
  darts: 'dartboard',
  lg: 'air_rifle_10m',
  luftgewehr: 'air_rifle_10m',
  lp: 'air_pistol_10m',
  luftpistole: 'air_pistol_10m',
  kk: 'smallbore_50m_prone',
  kleinkaliber: 'smallbore_50m_prone',
  'kk-gewehr': 'smallbore_50m_prone',
  'kk gewehr': 'smallbore_50m_prone'
};

function disciplineCandidates(rangeData) {
  if (!rangeData) return [];
  const out = [];
  const push = function (v) {
    const s = String(v || '').trim();
    if (!s) return;
    // Shot-count labels are not disciplines.
    if (/\d+\s*schuss/i.test(s)) return;
    if (out.indexOf(s) < 0) out.push(s);
  };
  push(rangeData.discipline);
  push(rangeData.discType);
  push(rangeData.DiscType);
  push(rangeData.discTypeRaw);
  return out;
}

function profileFromDisciplineMap(map, rangeData) {
  const candidates = disciplineCandidates(rangeData);
  if (!candidates.length) return null;
  const keys = Object.keys(map || {}).sort(function (a, b) {
    return b.length - a.length; // longest match first (KK-Gewehr before KK)
  });
  for (let c = 0; c < candidates.length; c++) {
    const lower = candidates[c].toLowerCase();
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (!key) continue;
      if (lower.indexOf(String(key).toLowerCase()) >= 0) return map[key];
    }
    const fb = DISC_TYPE_FALLBACKS[lower] || DISC_TYPE_FALLBACKS[lower.replace(/\s+/g, '-')];
    if (fb) return fb;
  }
  return null;
}

function updateTargetContext(rangeNum, rangeData) {
  const profileId = resolveTargetProfileId(rangeNum, rangeData);
  const prev = targetContextByRange[rangeNum];
  const registry = window.SRTargetRegistry;
  let scale;
  if (registry && typeof registry.buildScale === 'function') {
    scale = registry.buildScale(registry.getProfile(profileId));
  } else {
    scale = {
      profileId: profileId,
      file: '10_m_Air_Rifle_target.svg',
      dsgPerSvgUnit: DEFAULT_DSG_PER_SVG_UNIT,
      svgSize: DEFAULT_SVG_VIEW_SIZE,
      centerX: DEFAULT_SVG_CENTER,
      centerY: DEFAULT_SVG_CENTER,
      targetDiameterMm: TARGET_DIAMETER_MM,
      tenRingDiameterMm: TEN_RING_DIAMETER_MM,
      oneRingSvg: ONE_RING_SVG,
      ring8RadiusMm: RING_8_RADIUS_MM,
      shotRadiusSvg: SHOT_RADIUS_SVG,
      last10Max: 10.9
    };
  }
  if (prev && prev.profileId && prev.profileId !== scale.profileId) {
    resetRangeZoom(viewKey(rangeData, rangeNum), rangeNum);
  }
  if (scale.coordRadiusNeedsRefinement) {
    console.warn(
      'SRDashboard: target profile "' + scale.profileId +
      '" uses an unverified OpticScore coord scale (coordRadiusMm=' +
      scale.coordRadiusMm + '); shot placement may be off until log-verified.'
    );
  }
  targetContextByRange[rangeNum] = scale;
  activeScaleRangeNum = rangeNum;
  return scale;
}

function getTargetScale(rangeNum) {
  const n = rangeNum != null ? rangeNum : activeScaleRangeNum;
  if (n != null && targetContextByRange[n]) return targetContextByRange[n];
  return {
    profileId: 'air_rifle_10m',
    file: '10_m_Air_Rifle_target.svg',
    dsgPerSvgUnit: DEFAULT_DSG_PER_SVG_UNIT,
    svgSize: DEFAULT_SVG_VIEW_SIZE,
    centerX: DEFAULT_SVG_CENTER,
    centerY: DEFAULT_SVG_CENTER,
    targetDiameterMm: TARGET_DIAMETER_MM,
    tenRingDiameterMm: TEN_RING_DIAMETER_MM,
    oneRingSvg: ONE_RING_SVG,
    ring8RadiusMm: RING_8_RADIUS_MM,
    shotRadiusSvg: SHOT_RADIUS_SVG,
    last10Max: 10.9
  };
}

function getShotPelletRadius(rangeNum) {
  const ts = getTargetScale(rangeNum);
  return ts.shotRadiusSvg != null ? ts.shotRadiusSvg : SHOT_RADIUS_SVG;
}

function getShotFillRadius(rangeNum) {
  // Fill stays inside the stroke so the outline sits around the disk, not in it.
  return Math.max(0.05, getShotPelletRadius(rangeNum) - getShotStrokeWidth());
}

function getShotRingRadius(rangeNum) {
  // SVG stroke is centered on r; this puts the outer edge at the pellet radius.
  return Math.max(0.05, getShotPelletRadius(rangeNum) - getShotStrokeWidth() / 2);
}

function getShotStrokeWidth() {
  const w = Number(config && config.shotStrokeWidth);
  if (!Number.isFinite(w) || w <= 0) return DEFAULT_SHOT_STROKE_SVG;
  return Math.min(w, 2);
}

/** Monotonic counter: bumped on WS apply so in-flight HTTP polls can discard stale snapshots. */
let liveGen = 0;

function bumpLiveGen() {
  liveGen += 1;
  return liveGen;
}

function getLiveGen() {
  return liveGen;
}

async function fetchConfig() {
  const res = await fetch('/api/config');
  if (res.ok) {
    config = await res.json();
    applyLayout();
    // Stroke width etc. may change — force panel/target resync.
    document.querySelectorAll('#ranges-grid .range-panel').forEach(function (p) {
      delete p.dataset.chromeSig;
    });
    if (lastLiveData) {
      // Legacy full-panel sync only — plugin-hosted stands own chart/footer inside the mount.
      const grid = document.getElementById('ranges-grid');
      (lastLiveData.ranges || []).forEach(function (r) {
        const panel = grid && grid.querySelector('.range-panel[data-range="' + r.rangeNum + '"]');
        if (panel) syncRangePanel(panel, r);
      });
      document.querySelectorAll('.classic-range-view').forEach(function (el) {
        const rangeNum = el.dataset.range || (el.closest('[data-range]') && el.closest('[data-range]').dataset.range);
        const r = (lastLiveData.ranges || []).find(function (x) {
          return String(x.rangeNum) === String(rangeNum);
        });
        refreshClassicRangeView(el, r);
      });
    }
  }
}

/** Optional base URL for the target face (e.g. plugin assetsBase). Empty → /assets/. */
let targetAssetBase = '';

function setTargetAssetBase(base) {
  const next = base ? String(base).replace(/\/?$/, '/') : '';
  if (next === targetAssetBase) return;
  targetAssetBase = next;
  // Force face remount on next render so the new href is picked up.
  document.querySelectorAll('svg.target-svg-root').forEach(function (el) {
    el.remove();
  });
}

function resolveTargetUrl(rangeNum) {
  const ts = getTargetScale(rangeNum);
  const file = (ts.file || '10_m_Air_Rifle_target.svg').replace(/^.*[\\/]/, '');
  const base = targetAssetBase || '/assets/';
  // Bump when face SVGs change so browsers do not keep a stale image href.
  const v = (ts.profileId || 'default') + '-' + (targetAssetBase ? 'plugin' : 'static') + '-face3';
  return base + encodeURIComponent(file) + '?v=' + encodeURIComponent(v);
}

/** Stand is "live" when OpticScore assigned a shooter or any shots exist. */
function rangeHasActivity(r) {
  if (!r) return false;
  if (String(r.shooterName || '').trim()) return true;
  if (r.shots && r.shots.length) return true;
  if (r.shotNumber > 0) return true;
  return false;
}

/**
 * Optionally hide idle stands (plugin setting hideIdleRanges) so active panels
 * get the viewport. If the setting is off, or nobody is live yet, show all.
 */
function syncRangeVisibility(data) {
  const grid = document.getElementById('ranges-grid');
  if (!grid) return false;
  const byNum = {};
  (data && data.ranges ? data.ranges : []).forEach(function (r) {
    byNum[r.rangeNum] = r;
  });
  const panels = Array.prototype.slice.call(grid.querySelectorAll('.range-panel'));
  let activeCount = 0;
  for (let i = 0; i < panels.length; i++) {
    if (isWettkampfPanel(panels[i])) continue;
    const num = parseInt(panels[i].dataset.range, 10);
    if (rangeHasActivity(byNum[num])) activeCount++;
  }
  const hideIdle = hideIdleRangesEnabled() && activeCount > 0;
  let changed = false;
  for (let i = 0; i < panels.length; i++) {
    const panel = panels[i];
    if (isWettkampfPanel(panel)) {
      const hideWk = !wettkampfTileEnabled();
      if (panel.hidden !== hideWk) {
        panel.hidden = hideWk;
        changed = true;
      }
      continue;
    }
    const num = parseInt(panel.dataset.range, 10);
      const hide = isRangeInactive(num) || (hideIdle && !rangeHasActivity(byNum[num]));
    const wasHidden = panel.hidden;
    if (panel.hidden !== hide) {
      panel.hidden = hide;
      changed = true;
    }
    // Chart may have been measured while hidden (0×0) — redraw when shown again.
    if (wasHidden && !hide && byNum[num]) {
      const chartWrap = panel.querySelector('.last10-chart-wrap');
      const data = panel._paintedRange || byNum[num];
      if (chartWrap) renderLast10Chart(chartWrap, last10ForDisplay(data), num, data);
    }
  }
  applyLayout();
  return changed;
}

function applyLayout() {
  const grid = document.getElementById('ranges-grid');
  if (!grid) return;
  const preferredCols = Math.max(1, config.layoutColumns || 4);
  const visible = Array.prototype.slice.call(grid.querySelectorAll('.range-panel')).filter(function (p) {
    return !p.hidden;
  });
  const wk = visible.filter(isWettkampfPanel)[0] || null;
  const ranges = visible.filter(function (p) { return !isWettkampfPanel(p); });
  ranges.forEach(function (p) {
    p.style.gridColumn = '';
    p.style.gridRow = '';
  });
  const wkDom = grid.querySelector('.range-panel[data-slot="wettkampf"]');
  if (wkDom && wkDom !== wk) {
    wkDom.style.gridColumn = '';
    wkDom.style.gridRow = '';
  }
  grid.classList.toggle('has-wettkampf', !!wk);

  if (wk && ranges.length === 0) {
    grid.style.gridTemplateColumns = 'minmax(0, 1fr)';
    grid.style.gridTemplateRows = 'minmax(0, 1fr)';
    wk.style.gridColumn = '1';
    wk.style.gridRow = '1';
    return;
  }

  const n = Math.max(1, ranges.length || config.ranges || 1);
  const compact = document.body.classList.contains('compact-display');
  const cols = compact ? 1 : packRangeColumns(n, preferredCols);
  const rows = Math.max(1, Math.ceil(n / cols));
  if (wk) {
    // Bahn tiles pack into a hole-free grid (e.g. 4 live → 2×2, not 3+1).
    // Wettkampf is a fixed-ish right column spanning the hall height.
    grid.style.gridTemplateColumns = 'repeat(' + cols + ', minmax(0, 1fr)) minmax(15rem, 22rem)';
    grid.style.gridTemplateRows = 'repeat(' + rows + ', minmax(0, 1fr))';
    wk.style.gridColumn = String(cols + 1);
    wk.style.gridRow = '1 / -1';
    return;
  }
  grid.style.gridTemplateColumns = 'repeat(' + cols + ', minmax(0, 1fr))';
  grid.style.gridTemplateRows = 'repeat(' + rows + ', minmax(0, 1fr))';
}

/** Pack live Bahnen under layoutColumns.
 *  4 live + 3-col cap → 2×2 (not 3+1). 5 live must be 3+2, not 1×5 just to avoid one hole. */
function packRangeColumns(n, preferredCols) {
  n = Math.max(1, n);
  const maxCols = Math.max(1, Math.min(preferredCols, n));
  let best = maxCols;
  let bestScore = -Infinity;
  for (let c = 1; c <= maxCols; c++) {
    const rows = Math.ceil(n / c);
    const empty = c * rows - n;
    const score = -empty * 50 - Math.abs(c - preferredCols) - rows * 200;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

async function fetchLive() {
  const res = await fetch('/api/live', { cache: 'no-store' });
  if (!res.ok) return null;
  return res.json();
}

/**
 * DISAG OpticScore → SVG mm (viewBox centre 100,100; Y flipped to screen/SVG).
 * Pass rangeNum so multi-lane renders never pick up another lane's scale.
 */
function dsgToSvg(xDsg, yDsg, rangeNum) {
  const ts = getTargetScale(rangeNum);
  return {
    x: ts.centerX + xDsg / ts.dsgPerSvgUnit,
    y: ts.centerY - yDsg / ts.dsgPerSvgUnit
  };
}

/** Empty / reset: frame the scoring disk (not the full 200 mm range). */
function fullDiskZoom(rangeNum) {
  const ts = getTargetScale(rangeNum);
  const half = ts.targetDiameterMm / 2 + SCORING_DISK_PAD_MM;
  return clampZoomWindow(
    rangeNum,
    ts.centerX - half, ts.centerX + half,
    ts.centerY - half, ts.centerY + half
  );
}

/** Entire DISAG 200 mm range (debug / max zoom-out). */
function rangeDiskZoom() {
  const ts = getTargetScale();
  return { x: 0, y: 0, w: ts.svgSize, h: ts.svgSize };
}

function resetRangeZoom(key, rangeNum) {
  if (rangeNum == null && (typeof key === 'number' || (typeof key === 'string' && key.indexOf(':') < 0))) {
    rangeNum = Number(key);
    key = 'r:' + String(rangeNum);
  }
  zoomStateByRange[key] = fullDiskZoom(rangeNum);
  userZoomedByRange[key] = false;
  pinFullUntilNewShotByRange[key] = false;
}

function viewSpan(state, rangeNum) {
  const ts = getTargetScale(rangeNum);
  if (!state || state.w == null) return ts.targetDiameterMm + 2 * SCORING_DISK_PAD_MM;
  return Math.max(state.w, state.h);
}

/** Square viewBox window, clamped to zoom limits, centred on the given bounds. */
function clampZoomWindow(rangeNum, x0, x1, y0, y1) {
  const ts = getTargetScale(rangeNum);
  const minSpan = ts.ring8RadiusMm * 2;
  // Cap at the SVG range. span > svgSize makes [span/2, svgSize-span/2] inverted and
  // pins the viewBox at (0,0) — disk jumps to the upper-left.
  const maxSpan = ts.svgSize;
  let cx = (x0 + x1) / 2;
  let cy = (y0 + y1) / 2;
  let span = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  span = Math.max(minSpan, Math.min(maxSpan, span));
  if (span >= ts.svgSize) {
    return { x: 0, y: 0, w: ts.svgSize, h: ts.svgSize };
  }
  cx = Math.max(span / 2, Math.min(ts.svgSize - span / 2, cx));
  cy = Math.max(span / 2, Math.min(ts.svgSize - span / 2, cy));
  return { x: cx - span / 2, y: cy - span / 2, w: span, h: span };
}

/** Tightest zoom that still shows all shots, always centred on the bullseye. */
function computeAutoFit(shots, rangeNum) {
  const ts = getTargetScale(rangeNum);
  if (!shots || shots.length === 0) {
    return fullDiskZoom(rangeNum);
  }
  let maxDist = 0;
  for (let i = 0; i < shots.length; i++) {
    const pt = dsgToSvg(Number(shots[i].x), Number(shots[i].y), rangeNum);
    const shotR = ts.shotRadiusSvg != null ? ts.shotRadiusSvg : SHOT_RADIUS_SVG;
    const dist = Math.hypot(pt.x - ts.centerX, pt.y - ts.centerY) + shotR;
    if (dist > maxDist) maxDist = dist;
  }
  if (maxDist <= ts.ring8RadiusMm) {
    const half = ts.ring8RadiusMm;
    return clampZoomWindow(
      rangeNum,
      ts.centerX - half, ts.centerX + half,
      ts.centerY - half, ts.centerY + half
    );
  }
  // maxDist already includes pellet radius — keep pad thin so zoom stays aggressive.
  // Floor remains ring 8 (ISSF max useful zoom-in).
  const shotR = ts.shotRadiusSvg != null ? ts.shotRadiusSvg : SHOT_RADIUS_SVG;
  const padFrac = ts.autoZoomPadFrac != null
    ? ts.autoZoomPadFrac
    : (ts.targetDiameterMm >= 100 ? AUTO_ZOOM_PAD_FRAC_LARGE : AUTO_ZOOM_PAD_FRAC);
  const pad = Math.max(shotR * 0.15, padFrac * maxDist);
  let half = Math.max(maxDist + pad, ts.ring8RadiusMm);
  half = Math.min(half, ts.svgSize / 2);
  return clampZoomWindow(
    rangeNum,
    ts.centerX - half, ts.centerX + half,
    ts.centerY - half, ts.centerY + half
  );
}

/** True if a shot point lies outside (or on the edge of) the current viewBox. */
function shotOutsideView(pt, state, rangeNum) {
  if (!state || state.w == null) return true;
  const ts = getTargetScale(rangeNum);
  const m = ts.shotRadiusSvg != null ? ts.shotRadiusSvg : SHOT_RADIUS_SVG;
  return (
    pt.x - m < state.x ||
    pt.x + m > state.x + state.w ||
    pt.y - m < state.y ||
    pt.y + m > state.y + state.h
  );
}

function applyViewBox(svg, state, rangeNum) {
  if (!svg || !state) return;
  svg.setAttribute('viewBox', `${state.x} ${state.y} ${state.w} ${state.h}`);
  const n = rangeNum != null ? rangeNum : Number(svg.dataset.rangeNum);
  const host = svg.closest('.range-target');
  if (!host || !Number.isFinite(n)) return;
  const ts = getTargetScale(n);
  const full = ts.targetDiameterMm + 2 * SCORING_DISK_PAD_MM;
  const cur = viewSpan(state, n);
  const zoom = cur > 0 ? full / cur : 1;
  host.style.setProperty('--target-zoom', String(zoom));
}

function rangeNumFromViewport(viewport, fallback) {
  const svg = viewport && viewport.querySelector && viewport.querySelector('.target-svg-root');
  const n = svg ? Number(svg.dataset.rangeNum) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/** Pixel-normalized wheel delta (line/page modes expanded). */
function wheelDeltaPx(e) {
  let dy = Number(e && e.deltaY) || 0;
  if (e.deltaMode === 1) dy *= 16;
  else if (e.deltaMode === 2) dy *= 400;
  return dy;
}

function wheelZoomFactor(e) {
  const ln = Math.max(-ZOOM_WHEEL_MAX_LN, Math.min(ZOOM_WHEEL_MAX_LN, wheelDeltaPx(e) * ZOOM_WHEEL_GAIN));
  return Math.exp(ln);
}

function clientToSvg(svg, clientX, clientY) {
  if (!svg || typeof svg.getScreenCTM !== 'function') return null;
  const ctm = svg.getScreenCTM();
  if (!ctm) return null;
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  return pt.matrixTransform(ctm.inverse());
}

/** Zoom keeping (svgX, svgY) in the same place in the frame. */
function zoomWindowAround(rangeNum, state, factor, svgX, svgY) {
  const span = viewSpan(state, rangeNum);
  const next = Math.max(span * factor, 1e-6);
  const ts = getTargetScale(rangeNum);
  let focusX = Number(svgX);
  let focusY = Number(svgY);
  if (!Number.isFinite(focusX) || !Number.isFinite(focusY)) {
    focusX = state.x + span / 2;
    focusY = state.y + span / 2;
  }
  const rx = span > 0 ? (focusX - state.x) / span : 0.5;
  const ry = span > 0 ? (focusY - state.y) / span : 0.5;
  const x0 = focusX - rx * next;
  const y0 = focusY - ry * next;
  const win = clampZoomWindow(rangeNum, x0, x0 + next, y0, y0 + next);
  if (win.w >= ts.svgSize) return win;
  // clampZoomWindow recentres; shift back so the cursor point stays put when possible.
  const dx = focusX - (win.x + rx * win.w);
  const dy = focusY - (win.y + ry * win.h);
  return panZoomWindow(rangeNum, win, dx, dy);
}

function panZoomWindow(rangeNum, state, dx, dy) {
  const ts = getTargetScale(rangeNum);
  const span = viewSpan(state, rangeNum);
  if (span >= ts.svgSize) {
    return { x: 0, y: 0, w: ts.svgSize, h: ts.svgSize };
  }
  let cx = state.x + span / 2 + (Number(dx) || 0);
  let cy = state.y + span / 2 + (Number(dy) || 0);
  cx = Math.max(span / 2, Math.min(ts.svgSize - span / 2, cx));
  cy = Math.max(span / 2, Math.min(ts.svgSize - span / 2, cy));
  return { x: cx - span / 2, y: cy - span / 2, w: span, h: span };
}

function setupZoomHandlers(viewport, fallbackRangeNum) {
  if (viewport.dataset.zoomHandlers === '1') return;
  viewport.dataset.zoomHandlers = '1';

  function currentRangeNum() {
    return rangeNumFromViewport(viewport, fallbackRangeNum);
  }

  function currentViewKey(n, svg) {
    return viewKeyFromSvg(svg || getSvg(), n);
  }

  function getState(n, svg) {
    const key = currentViewKey(n, svg);
    if (!zoomStateByRange[key]) zoomStateByRange[key] = fullDiskZoom(n);
    return zoomStateByRange[key];
  }

  function getSvg() {
    return viewport.querySelector('.target-svg-root');
  }

  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!e.deltaY) return;
    const n = currentRangeNum();
    const svg = getSvg();
    if (!Number.isFinite(n) || !svg) return;
    const factor = wheelZoomFactor(e);
    if (factor === 1) return;
    const state = getState(n, svg);
    const pt = clientToSvg(svg, e.clientX, e.clientY);
    const key = currentViewKey(n, svg);
    userZoomedByRange[key] = true;
    zoomStateByRange[key] = zoomWindowAround(
      n, state, factor,
      pt && pt.x, pt && pt.y
    );
    applyViewBox(svg, zoomStateByRange[key], n);
  }, { passive: false });

  let pan = null;

  viewport.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const n = currentRangeNum();
    const svg = getSvg();
    if (!Number.isFinite(n) || !svg) return;
    pan = { pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY, moved: false };
    try { viewport.setPointerCapture(e.pointerId); } catch (err) {}
  });

  viewport.addEventListener('pointermove', (e) => {
    if (!pan || e.pointerId !== pan.pointerId) return;
    const n = currentRangeNum();
    const svg = getSvg();
    if (!Number.isFinite(n) || !svg) return;
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const state = getState(n, svg);
    const dxPx = e.clientX - pan.lastX;
    const dyPx = e.clientY - pan.lastY;
    if (!pan.moved && (dxPx * dxPx + dyPx * dyPx) < 9) return;
    pan.moved = true;
    viewport.classList.add('is-panning');
    const dx = -(dxPx * state.w / rect.width);
    const dy = -(dyPx * state.h / rect.height);
    const key = currentViewKey(n, svg);
    userZoomedByRange[key] = true;
    zoomStateByRange[key] = panZoomWindow(n, state, dx, dy);
    applyViewBox(svg, zoomStateByRange[key], n);
    pan.lastX = e.clientX;
    pan.lastY = e.clientY;
  });

  function endPan(e) {
    if (!pan || (e && e.pointerId !== pan.pointerId)) return;
    pan = null;
    viewport.classList.remove('is-panning');
  }
  viewport.addEventListener('pointerup', endPan);
  viewport.addEventListener('pointercancel', endPan);

  viewport.addEventListener('dblclick', () => {
    const n = currentRangeNum();
    const svg = getSvg();
    if (!Number.isFinite(n) || !svg) return;
    const key = currentViewKey(n, svg);
    zoomStateByRange[key] = fullDiskZoom(n);
    userZoomedByRange[key] = false;
    pinFullUntilNewShotByRange[key] = true;
    applyViewBox(svg, zoomStateByRange[key], n);
  });
}

function ensureTargetSvg(container, rangeNum) {
  let wrapper = container.querySelector('.target-wrapper');
  if (!wrapper) {
    wrapper = document.createElement('div');
    wrapper.className = 'target-wrapper';
    container.appendChild(wrapper);
  }
  // Strip legacy Plotly / CSS-zoom layers only — never remount a healthy SVG (cache-bust URLs vary).
  wrapper.querySelectorAll('.target-plot, .target-svg, .zoom-debug').forEach((el) => el.remove());
  wrapper.style.transform = '';

  let svg = wrapper.querySelector('svg.target-svg-root');
  const ts = getTargetScale(rangeNum);
  if (svg && svg.dataset.profileId && svg.dataset.profileId !== ts.profileId) {
    svg.remove();
    svg = null;
  }
  if (svg && svg.querySelector('.target-face') && svg.querySelector('.target-shots')) {
    svg.dataset.rangeNum = String(rangeNum);
    return svg;
  }
  if (svg) svg.remove();

  svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'target-svg-root');
  svg.dataset.profileId = ts.profileId || '';
  svg.dataset.rangeNum = String(rangeNum);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.setAttribute('viewBox', `0 0 ${ts.svgSize} ${ts.svgSize}`);

  const face = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  face.setAttribute('class', 'target-face');
  face.setAttribute('data-style', ts.profileId || 'issf-original');
  const img = document.createElementNS('http://www.w3.org/2000/svg', 'image');
  img.setAttribute('href', resolveTargetUrl(rangeNum));
  img.setAttributeNS('http://www.w3.org/1999/xlink', 'href', resolveTargetUrl(rangeNum));
  img.setAttribute('x', '0');
  img.setAttribute('y', '0');
  img.setAttribute('width', String(ts.svgSize));
  img.setAttribute('height', String(ts.svgSize));
  img.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  face.appendChild(img);
  const marker = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  marker.setAttribute('cx', String(ts.centerX));
  marker.setAttribute('cy', String(ts.centerY));
  marker.setAttribute('r', String(ts.targetDiameterMm / 2));
  marker.setAttribute('fill', 'none');
  marker.setAttribute('stroke', 'none');
  marker.setAttribute('pointer-events', 'none');
  face.appendChild(marker);
  svg.appendChild(face);

  const shotsGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  shotsGroup.setAttribute('class', 'target-shots');
  svg.appendChild(shotsGroup);
  wrapper.appendChild(svg);
  return svg;
}

function upsertShotCircles(shotsGroup, shots, rangeNum) {
  // Keep the whole shot stack above the target face.
  if (shotsGroup.parentNode && shotsGroup.parentNode.lastElementChild !== shotsGroup) {
    shotsGroup.parentNode.appendChild(shotsGroup);
  }

  let fillG = shotsGroup.querySelector('.target-shots-fill');
  let ringG = shotsGroup.querySelector('.target-shots-ring');
  if (!fillG) {
    fillG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    fillG.setAttribute('class', 'target-shots-fill');
    shotsGroup.insertBefore(fillG, shotsGroup.firstChild);
  }
  if (!ringG) {
    ringG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    ringG.setAttribute('class', 'target-shots-ring');
    shotsGroup.appendChild(ringG);
  } else {
    shotsGroup.appendChild(ringG); // outlines always above fills so covered shots keep a visible border
  }

  Array.prototype.slice.call(shotsGroup.children).forEach(function (n) {
    if (n === fillG || n === ringG) return;
    if (n.classList && (n.classList.contains('target-shot-hover-halo') || n.classList.contains('target-shot-hover-label'))) return;
    if (n.tagName && n.tagName.toLowerCase() === 'circle') fillG.appendChild(n);
    else shotsGroup.removeChild(n);
  });

  shots.forEach((s, i) => {
    const pt = dsgToSvg(Number(s.x), Number(s.y), rangeNum);
    const paint = colorForShotIndex(i);
    const fillR = getShotFillRadius(rangeNum);
    const ringR = getShotRingRadius(rangeNum);

    let fill = fillG.querySelector('circle[data-shot-idx="' + i + '"]');
    if (!fill) {
      fill = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      fill.setAttribute('data-shot-idx', String(i));
      fill.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'title'));
      fillG.appendChild(fill);
    }
    fill.setAttribute('cx', String(pt.x));
    fill.setAttribute('cy', String(pt.y));
    fill.setAttribute('r', String(fillR));
    fill.setAttribute('fill', paint);
    fill.setAttribute('fill-opacity', '1');
    fill.setAttribute('stroke', 'none');
    const dec = Number(s.decValue);
    if (Number.isFinite(dec)) fill.setAttribute('data-dec-value', String(dec));
    else fill.removeAttribute('data-dec-value');
    fill.classList.toggle('is-last', i === shots.length - 1);
    const title = fill.querySelector('title');
    if (title) {
      title.textContent = `#${i + 1}: ${Number(s.decValue).toFixed(1)} (T ${Number(s.distance).toFixed(1)})`;
    }

    let ring = ringG.querySelector('circle[data-shot-idx="' + i + '"]');
    if (!ring) {
      ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      ring.setAttribute('data-shot-idx', String(i));
      ring.setAttribute('fill', 'none');
      ringG.appendChild(ring);
    }
    ring.setAttribute('cx', String(pt.x));
    ring.setAttribute('cy', String(pt.y));
    ring.setAttribute('r', String(ringR));
    ring.setAttribute('stroke', paint);
    ring.setAttribute('stroke-width', String(getShotStrokeWidth()));
    ring.setAttribute('stroke-opacity', '1');
    ring.setAttribute('pointer-events', 'none');
    ring.classList.toggle('is-last', i === shots.length - 1);
  });

  Array.prototype.slice.call(fillG.querySelectorAll('circle')).forEach(function (c) {
    const idx = parseInt(c.getAttribute('data-shot-idx'), 10);
    if (!Number.isFinite(idx) || idx >= shots.length) fillG.removeChild(c);
  });
  Array.prototype.slice.call(ringG.querySelectorAll('circle')).forEach(function (c) {
    const idx = parseInt(c.getAttribute('data-shot-idx'), 10);
    if (!Number.isFinite(idx) || idx >= shots.length) ringG.removeChild(c);
  });

  paintHoverForRange(rangeNum);
}

function renderTarget(container, rangeData, isWarmup, opts) {
  if (!container || !rangeData) return;

  const rangeNum = rangeData.rangeNum;
  const pinFullDisk = !!(opts && opts.pinFullDisk);
  updateTargetContext(rangeNum, rangeData);

  container.querySelectorAll('.target-plot').forEach((el) => el.remove());

  let svg = container.querySelector('svg.target-svg-root');
  const ts = getTargetScale(rangeNum);
  if (svg && svg.dataset.profileId && svg.dataset.profileId !== ts.profileId) {
    svg.remove();
    svg = null;
  }
  if (!svg || !svg.querySelector('.target-face') || !svg.querySelector('.target-shots')) {
    svg = ensureTargetSvg(container, rangeNum);
  }
  const shotsGroup = svg.querySelector('.target-shots');
  if (!shotsGroup) return;
  svg.dataset.viewKey = viewKey(rangeData, rangeNum);

  const key = svg.dataset.viewKey;
  const shots = shotsForDisplay(rangeData);
  const focusingSeries = seriesFocusByRange[key] != null;
  const prevLen = prevShotsLengthByRange[key] ?? 0;
  const currentLen = shots.length;
  const warmupFlag = !!(isWarmup != null ? isWarmup : rangeData.isWarmup);
  const wasWarmup = prevIsWarmupByRange[key];
  const shotsCleared = currentLen < prevLen;
  const warmupChanged = wasWarmup !== undefined && wasWarmup !== warmupFlag;

  if (shotsCleared || warmupChanged) {
    resetRangeZoom(key, rangeNum);
  }
  if (currentLen > prevLen && !focusingSeries) {
    pinFullUntilNewShotByRange[key] = false;
  }

  if (currentLen === 0 || (!focusingSeries && pinFullUntilNewShotByRange[key])) {
    if (!userZoomedByRange[key]) {
      zoomStateByRange[key] = fullDiskZoom(rangeNum);
    }
  } else if (!userZoomedByRange[key]) {
    // Game plugins (Autorennen) keep classic Scheibe fidelity: full scoring disk, never ring-8 auto-zoom.
    // Only widen when a shot falls outside the scoring disk.
    if (pinFullDisk) {
      let z = fullDiskZoom(rangeNum);
      if (currentLen > 0) {
        const fitted = computeAutoFit(shots, rangeNum);
        if (viewSpan(fitted, rangeNum) > viewSpan(z, rangeNum)) {
          z = fitted;
        }
      }
      zoomStateByRange[key] = z;
    } else {
      zoomStateByRange[key] = computeAutoFit(shots, rangeNum);
    }
  } else {
    const state = zoomStateByRange[key];
    const latest = shots[shots.length - 1];
    if (latest) {
      const pt = dsgToSvg(Number(latest.x), Number(latest.y), rangeNum);
      if (shotOutsideView(pt, state, rangeNum)) {
        const fitted = computeAutoFit(shots, rangeNum);
        if (viewSpan(fitted, rangeNum) > viewSpan(state, rangeNum)) {
          zoomStateByRange[key] = fitted;
        }
      }
    }
  }
  prevShotsLengthByRange[key] = currentLen;
  prevIsWarmupByRange[key] = warmupFlag;

  if (!zoomStateByRange[key] || zoomStateByRange[key].w == null) {
    zoomStateByRange[key] = fullDiskZoom(rangeNum);
  }
  applyViewBox(svg, zoomStateByRange[key], rangeNum);
  setupZoomHandlers(container, rangeNum);
  upsertShotCircles(shotsGroup, shots, rangeNum);
  container.classList.toggle('series-focus', focusingSeries);
  container.classList.toggle('warmup', displayIsWarmup(rangeData));
}

const DEFAULT_CHART_COLORS = {
  bar: '#0a7a8c',
  paperBg: '#f7fafc',
  plotBg: '#f7fafc',
  font: '#5a6b7a',
  border: '#b8c6d1'
};

function getChartColors() {
  const styles = getComputedStyle(document.documentElement);
  const pick = (name, fallback) => {
    const v = styles.getPropertyValue(name).trim();
    return v || fallback;
  };
  return {
    bar: pick('--accent', DEFAULT_CHART_COLORS.bar),
    paperBg: pick('--panel', DEFAULT_CHART_COLORS.paperBg),
    plotBg: pick('--panel', DEFAULT_CHART_COLORS.plotBg),
    font: pick('--muted', DEFAULT_CHART_COLORS.font),
    border: pick('--line', DEFAULT_CHART_COLORS.border)
  };
}

/** Series-relative Y range so tight high scores still use the full plot height. */
function computeValueRange(last10Values, rangeNum) {
  const ts = getTargetScale(rangeNum);
  const maxVal = ts.last10Max != null ? ts.last10Max : 10.9;
  if (!last10Values || last10Values.length === 0) return [0, maxVal];
  const vals = last10Values.map(Number).filter((n) => !Number.isNaN(n));
  if (vals.length === 0) return [0, maxVal];
  let minV = Math.min(...vals);
  let maxV = Math.max(...vals);
  const padding = 0.15;
  if (minV === maxV) {
    minV = Math.max(0, minV - 0.5);
    maxV = Math.min(maxVal, maxV + 0.5);
  } else {
    const span = maxV - minV;
    minV = Math.max(0, minV - padding * span);
    maxV = Math.min(maxVal, maxV + padding * span);
  }
  if (maxV <= minV) maxV = Math.min(maxVal, minV + 0.5);
  return [minV, maxV];
}

function liveRangeData(rangeNum) {
  if (!lastLiveData || !lastLiveData.ranges) return null;
  return lastLiveData.ranges.find(function (r) {
    return r.rangeNum === rangeNum;
  }) || null;
}

/** Map a last-10 bar index to the shot currently drawn on the scheibe (−1 if that bar is not on the disk). */
function chartBarToShotIndex(rangeNum, barIdx, rangeData) {
  if (barIdx == null || !Number.isFinite(barIdx) || barIdx < 0) return -1;
  const src = rangeData || liveRangeData(rangeNum);
  if (!src) return barIdx;
  const shots = shotsForDisplay(src);
  const values = last10ForDisplay(src);
  if (!shots.length) return -1;
  if (values.length === shots.length) {
    return barIdx < shots.length ? barIdx : -1;
  }
  const shotIdx = barIdx - (values.length - shots.length);
  if (shotIdx < 0 || shotIdx >= shots.length) return -1;
  return shotIdx;
}

function hoverValueLabel(barIdx, value) {
  const n = Number(value);
  const val = Number.isFinite(n) ? n.toFixed(1) : '–';
  return '#' + (barIdx + 1) + ': ' + val;
}

function forEachRangeHost(rangeNum, fn) {
  if (!Number.isFinite(rangeNum)) return;
  document.querySelectorAll(
    '.range-panel[data-range="' + rangeNum + '"], .classic-range-view[data-range="' + rangeNum + '"]'
  ).forEach(fn);
}

function ensureShotHoverOverlay(shotsGroup) {
  let halo = shotsGroup.querySelector('.target-shot-hover-halo');
  if (!halo) {
    halo = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    halo.setAttribute('class', 'target-shot-hover-halo');
    halo.setAttribute('fill', 'none');
    halo.setAttribute('pointer-events', 'none');
    halo.setAttribute('visibility', 'hidden');
    shotsGroup.appendChild(halo);
  }
  let label = shotsGroup.querySelector('.target-shot-hover-label');
  if (!label) {
    label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('class', 'target-shot-hover-label');
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('dominant-baseline', 'central');
    label.setAttribute('pointer-events', 'none');
    label.setAttribute('visibility', 'hidden');
    shotsGroup.appendChild(label);
  }
  shotsGroup.appendChild(halo);
  shotsGroup.appendChild(label);
  return { halo: halo, label: label };
}

function paintShotHoverOnGroup(shotsGroup, rangeNum, shotIdx) {
  if (!shotsGroup) return;
  const on = shotIdx != null && shotIdx >= 0;
  shotsGroup.classList.toggle('chart-hover', on);
  shotsGroup.querySelectorAll('.target-shots-fill circle, .target-shots-ring circle').forEach(function (c) {
    const i = parseInt(c.getAttribute('data-shot-idx'), 10);
    c.classList.toggle('is-hover', on && i === shotIdx);
  });
  if (!on) {
    const halo = shotsGroup.querySelector('.target-shot-hover-halo');
    const label = shotsGroup.querySelector('.target-shot-hover-label');
    if (halo) halo.setAttribute('visibility', 'hidden');
    if (label) {
      label.setAttribute('visibility', 'hidden');
      label.textContent = '';
    }
    return;
  }
  const overlay = ensureShotHoverOverlay(shotsGroup);
  const fill = shotsGroup.querySelector('.target-shots-fill circle[data-shot-idx="' + shotIdx + '"]');
  if (!fill) {
    overlay.halo.setAttribute('visibility', 'hidden');
    overlay.label.setAttribute('visibility', 'hidden');
    overlay.label.textContent = '';
    return;
  }
  const cx = parseFloat(fill.getAttribute('cx'));
  const cy = parseFloat(fill.getAttribute('cy'));
  const r = parseFloat(fill.getAttribute('r')) || 2.25;
  const z = zoomStateByRange[viewKeyFromSvg(shotsGroup.ownerSVGElement, rangeNum)];
  const span = z && z.w ? z.w : (getTargetScale(rangeNum).svgSize || 200);
  const fontSize = Math.max(2.2, span * 0.055);
  overlay.halo.setAttribute('cx', String(cx));
  overlay.halo.setAttribute('cy', String(cy));
  overlay.halo.setAttribute('r', String(r + Math.max(0.35, span * 0.012)));
  overlay.halo.setAttribute('stroke-width', String(Math.max(0.25, span * 0.008)));
  overlay.halo.setAttribute('visibility', 'visible');
  const title = fill.querySelector('title');
  overlay.label.textContent = title && title.textContent
    ? title.textContent.replace(/\s*\(T.*\)$/, '')
    : hoverValueLabel(shotIdx, null);
  overlay.label.setAttribute('x', String(cx));
  let labelY = cy - r - fontSize * 0.45;
  const viewTop = z && z.y != null ? z.y : 0;
  if (labelY < viewTop + fontSize) labelY = cy + r + fontSize * 0.95;
  overlay.label.setAttribute('y', String(labelY));
  overlay.label.setAttribute('font-size', String(fontSize));
  overlay.label.setAttribute('stroke-width', String(fontSize * 0.12));
  overlay.label.setAttribute('visibility', 'visible');
}

function paintChartBarHover(container, barIdx) {
  if (!container) return;
  const hovering = barIdx != null && Number.isFinite(barIdx) && barIdx >= 0;
  container.classList.toggle('is-hovering', hovering);
  container.querySelectorAll('[data-shot-idx]').forEach(function (el) {
    const i = parseInt(el.getAttribute('data-shot-idx'), 10);
    el.classList.toggle('is-hover', hovering && i === barIdx);
  });
  let tip = container.querySelector('.last10-value-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'last10-value-tip';
    container.appendChild(tip);
  }
  if (!hovering) {
    tip.hidden = true;
    return;
  }
  const bar = container.querySelector('rect.last10-bar[data-shot-idx="' + barIdx + '"]');
  if (!bar) {
    tip.hidden = true;
    return;
  }
  const title = bar.querySelector('title');
  tip.textContent = title ? title.textContent : hoverValueLabel(barIdx, null);
  const x = parseFloat(bar.getAttribute('x')) + parseFloat(bar.getAttribute('width')) / 2;
  tip.style.left = x + 'px';
  tip.style.top = '2px';
  tip.hidden = false;
}

function paintHoverForRange(rangeNum) {
  if (!Number.isFinite(rangeNum)) return;
  const barIdx = hoverBarIdxByRange[rangeNum];
  forEachRangeHost(rangeNum, function (host) {
    const data = host._paintedRange || liveRangeData(rangeNum);
    const shotIdx = barIdx == null ? -1 : chartBarToShotIndex(rangeNum, barIdx, data);
    host.querySelectorAll('.target-shots').forEach(function (g) {
      paintShotHoverOnGroup(g, rangeNum, shotIdx);
    });
    host.querySelectorAll('.last10-chart-wrap').forEach(function (wrap) {
      paintChartBarHover(wrap, barIdx);
    });
  });
}

function setChartHover(rangeNum, barIdx) {
  if (!Number.isFinite(rangeNum)) return;
  const next = (barIdx == null || !Number.isFinite(barIdx) || barIdx < 0) ? undefined : barIdx;
  if (hoverBarIdxByRange[rangeNum] === next) return;
  if (next == null) delete hoverBarIdxByRange[rangeNum];
  else hoverBarIdxByRange[rangeNum] = next;
  paintHoverForRange(rangeNum);
}

function wireLast10ChartHover(container, rangeNum) {
  if (!container) return;
  container.dataset.rangeNum = Number.isFinite(rangeNum) ? String(rangeNum) : '';
  if (container.dataset.hoverWired === '1') return;
  container.dataset.hoverWired = '1';
  container.addEventListener('pointermove', function (ev) {
    const n = parseInt(container.dataset.rangeNum, 10);
    const hit = ev.target.closest('[data-shot-idx]');
    if (hit && container.contains(hit)) {
      const idx = parseInt(hit.getAttribute('data-shot-idx'), 10);
      setChartHover(n, Number.isFinite(idx) ? idx : null);
    } else {
      setChartHover(n, null);
    }
  });
  container.addEventListener('pointerleave', function () {
    setChartHover(parseInt(container.dataset.rangeNum, 10), null);
  });
}

function renderLast10Chart(container, last10Values, rangeNum, rangeData) {
  if (!container) return;
  if (rangeData) container.dataset.viewKey = viewKey(rangeData, rangeNum);
  const colors = getChartColors();
  const shotColors = getShotOrderColors();
  const values = (last10Values || []).map(Number).filter((n) => !Number.isNaN(n));
  const [yMin, yMax] = computeValueRange(last10Values, rangeNum);
  const ySpan = Math.max(0.01, yMax - yMin);

  // Match viewBox to the laid-out size so labels are not stretched by preserveAspectRatio=none.
  const rect = container.getBoundingClientRect();
  const W = Math.max(120, Math.round(rect.width) || 200);
  const H = Math.max(40, Math.round(rect.height) || 56);
  const padL = 28;
  const padR = 6;
  const padT = 6;
  const padB = 16;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const slotW = plotW / 10;
  const fontSize = Math.max(9, Math.round(H * 0.16));

  let svg = container.querySelector('svg.last10-svg');
  if (!svg) {
    Array.prototype.slice.call(container.children).forEach(function (child) {
      if (!child.classList || !child.classList.contains('last10-value-tip')) child.remove();
    });
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'last10-svg');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Letzte Schüsse');
    container.appendChild(svg);
  }
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');

  const sig = [W, H, yMin.toFixed(3), yMax.toFixed(3), values.join(','), shotColors.join(',')].join('|');
  const skipPaint = container.dataset.chartSig === sig && svg.childElementCount > 0;
  if (!skipPaint) {
    container.dataset.chartSig = sig;
    const yToSvg = (v) => padT + plotH - ((v - yMin) / ySpan) * plotH;
    // Baseline at yMin of the zoomed scale (may be > 0 when scores are clustered high).
    const baselineY = yToSvg(yMin);
    let html = '';
    html += `<line x1="${padL}" y1="${baselineY}" x2="${W - padR}" y2="${baselineY}" stroke="${colors.border}" stroke-width="1"/>`;
    for (let i = 0; i < 10; i++) {
      const v = values[i];
      if (v == null || Number.isNaN(v)) continue;
      const barH = Math.max(1, ((v - yMin) / ySpan) * plotH);
      const x = padL + i * slotW + slotW * 0.15;
      const w = slotW * 0.7;
      const y = yToSvg(v);
      const fill = shotColors[i % shotColors.length] || colors.bar;
      const tip = hoverValueLabel(i, v);
      html += `<rect class="last10-bar" data-shot-idx="${i}" x="${x}" y="${y}" width="${w}" height="${barH}" fill="${fill}"><title>${tip}</title></rect>`;
    }
    for (let i = 1; i <= 10; i++) {
      const x = padL + (i - 0.5) * slotW;
      html += `<text x="${x}" y="${H - 3}" text-anchor="middle" fill="${colors.font}" font-size="${fontSize}" pointer-events="none">${i}</text>`;
    }
    html += `<text x="3" y="${padT + fontSize}" fill="${colors.font}" font-size="${fontSize}" pointer-events="none">${yMax.toFixed(1)}</text>`;
    html += `<text x="3" y="${padT + plotH}" fill="${colors.font}" font-size="${fontSize}" pointer-events="none">${yMin.toFixed(1)}</text>`;
    for (let i = 0; i < 10; i++) {
      const v = values[i];
      if (v == null || Number.isNaN(v)) continue;
      const tip = hoverValueLabel(i, v);
      html += `<rect class="last10-hit" data-shot-idx="${i}" x="${padL + i * slotW}" y="${padT}" width="${slotW}" height="${plotH + padB}" fill="transparent"><title>${tip}</title></rect>`;
    }
    svg.innerHTML = html;
  }

  wireLast10ChartHover(container, rangeNum);
  if (Number.isFinite(rangeNum)) paintHoverForRange(rangeNum);
}

function footerItem(label, value, visible) {
  if (!visible) return '';
  return `<span class="footer-item"><span class="label">${label}:</span><span class="value">${value}</span></span>`;
}

function footerItemTwoLines(label, line1, line2, visible) {
  if (!visible) return '';
  return `<span class="footer-item footer-item-twolines"><span class="label">${label}:</span><span class="value"><span class="value-line">${line1}</span><span class="value-line">${line2}</span></span></span>`;
}

const SERIES_LEN = 10;

function chunkSeries(shots, size) {
  const out = [];
  if (!shots || !shots.length || size <= 0) return out;
  for (let i = 0; i < shots.length; i += size) {
    out.push(shots.slice(i, i + size));
  }
  return out;
}

function seriesShotsForFocus(rangeData, focus) {
  if (!focus) return null;
  if (focus.live) return rangeData.shots || [];
  if ((focus.kind || 'comp') === 'warmup') {
    return chunkSeries(rangeData.warmupShots || [], SERIES_LEN)[focus.index] || [];
  }
  return (rangeData.seriesShots || [])[focus.index] || [];
}

/** Triangle follows the series on the target: Probe review or live warmup. */
function displayIsWarmup(rangeData) {
  const focus = rangeData && seriesFocusByRange[focusKey(rangeData)];
  if (focus != null) return (focus.kind || 'comp') === 'warmup';
  return !!(rangeData && rangeData.isWarmup);
}

/** Shots currently drawn on the target (live or a reviewed completed series). */
function shotsForDisplay(rangeData) {
  const focus = seriesFocusByRange[focusKey(rangeData)];
  if (focus != null) {
    const series = seriesShotsForFocus(rangeData, focus);
    if (series && series.length) return series;
  }
  return rangeData.shots || [];
}

/** Bar-chart values for the shots currently shown (series focus or live last-10). */
function last10ForDisplay(rangeData) {
  const focus = seriesFocusByRange[focusKey(rangeData)];
  if (focus != null) {
    const series = seriesShotsForFocus(rangeData, focus);
    if (series && series.length) {
      return series.map(function (s) { return Number(s.decValue); });
    }
  }
  return rangeData.last10Values || [];
}

/** Drop series review when a newer shot arrives or the series list no longer has that index. */
function syncSeriesFocus(rangeData) {
  if (!rangeData) return;
  const key = focusKey(rangeData);
  const n = rangeData.rangeNum;
  const focus = seriesFocusByRange[key];
  if (!focus) return;
  if ((rangeData.shotNumber || 0) > focus.atShotNumber) {
    delete seriesFocusByRange[key];
    userZoomedByRange[key] = false;
    pinFullUntilNewShotByRange[key] = false;
    resetRangeZoom(key, n);
    return;
  }
  if (focus.live) {
    if (!((rangeData.shots || []).length)) {
      delete seriesFocusByRange[key];
      userZoomedByRange[key] = false;
      resetRangeZoom(key, n);
    }
    return;
  }
  const series = seriesShotsForFocus(rangeData, focus);
  if (focus.index < 0 || !(series || []).length) {
    delete seriesFocusByRange[key];
    userZoomedByRange[key] = false;
    resetRangeZoom(key, n);
  }
}

function setSeriesFocus(rangeNum, index, rangeData, live, kind) {
  const data = (rangeNum && typeof rangeNum === 'object') ? rangeNum : rangeData;
  const key = focusKey(data, data && data.rangeNum);
  const n = data && data.rangeNum;
  const k = kind || 'comp';
  const cur = seriesFocusByRange[key];
  if (cur && cur.index === index && !!cur.live === !!live && (cur.kind || 'comp') === k) {
    delete seriesFocusByRange[key];
  } else {
    seriesFocusByRange[key] = {
      index: index,
      kind: k,
      live: !!live,
      atShotNumber: (data && data.shotNumber) || 0
    };
  }
  // Force autofit for the newly shown set.
  userZoomedByRange[key] = false;
  pinFullUntilNewShotByRange[key] = false;
  resetRangeZoom(key, n);
}

function paintSeriesFocusActive(footerEl, rangeData) {
  if (!footerEl) return;
  const data = (rangeData && typeof rangeData === 'object') ? rangeData : { rangeNum: rangeData };
  const focus = seriesFocusByRange[focusKey(data)];
  footerEl.querySelectorAll('.serien-col').forEach(function (btn) {
    const idx = parseInt(btn.dataset.seriesIdx, 10);
    const kind = btn.getAttribute('data-series-kind') || 'comp';
    const on = focus != null && idx === focus.index &&
      (focus.kind || 'comp') === kind &&
      !!focus.live === (btn.getAttribute('data-series-live') === '1');
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function wireSeriesClicks(footerEl, rangeData) {
  if (!footerEl || !rangeData) return;
  footerEl.onclick = function (ev) {
    const btn = ev.target.closest('.serien-col');
    if (!btn || !footerEl.contains(btn)) return;
    const idx = parseInt(btn.dataset.seriesIdx, 10);
    if (!Number.isFinite(idx)) return;
    const isLive = btn.getAttribute('data-series-live') === '1';
    const kind = btn.getAttribute('data-series-kind') || 'comp';
    const series = seriesShotsForFocus(rangeData, { index: idx, live: isLive, kind: kind });
    if (!series || !series.length) return;
    setSeriesFocus(rangeData, idx, rangeData, isLive, kind);
    // Frozen Analyse results keep their snapshot. Live stands refresh from the lane payload.
    const data = rangeDataForRepaint(rangeData);
    const mount = footerEl.closest('.classic-range-view') || footerEl.closest('.range-plugin-view');
    const panel = footerEl.closest('.range-panel');
    if (mount && mount.classList.contains('classic-range-view')) {
      renderClassicRangeView(mount, data);
    } else if (panel) {
      const targetEl = panel.querySelector('.range-target');
      if (targetEl) renderTarget(targetEl, data, data.isWarmup);
      paintSeriesFocusActive(footerEl, data);
    }
  };
}

function plannedSeriesCount(rangeData) {
  const total = Number(rangeData && rangeData.totalShotsToFire) || 0;
  if (total <= 0) return 0;
  return Math.ceil(total / SERIES_LEN);
}

function sumShots(shots) {
  let sumInt = 0;
  let sumDec = 0;
  for (let i = 0; i < shots.length; i++) {
    sumInt += Number(shots[i].fullValue) || 0;
    sumDec += Number(shots[i].decValue) || 0;
  }
  return { sumInt: sumInt, sumDec: sumDec };
}

function seriesCol(kind, index, label, intV, decV, shots, live) {
  return {
    kind: kind,
    index: index,
    label: label,
    intV: intV,
    decV: decV,
    shots: shots || [],
    live: !!live
  };
}

/** Probe series from retained warmupShots (10-shot chunks; last may be short). */
function warmupSeriesColumns(rangeData) {
  const chunks = chunkSeries(rangeData.warmupShots || [], SERIES_LEN);
  const inWarmup = !!rangeData.isWarmup;
  return chunks.map(function (chunk, i) {
    const s = sumShots(chunk);
    const live = inWarmup && i === chunks.length - 1 && chunk.length > 0 && chunk.length < SERIES_LEN;
    return seriesCol('warmup', i, 'P' + (i + 1), s.sumInt, s.sumDec, chunk, live);
  });
}

/** Competition series only — during Probe these live in warmupShots instead. */
function competitionSeriesColumns(rangeData) {
  if (rangeData.isWarmup) return [];
  const ints = (rangeData.seriesSumsInt || []).slice();
  const decs = (rangeData.seriesSums || []).slice();
  const seriesShots = rangeData.seriesShots || [];
  const shots = rangeData.shots || [];
  const liveOpen = shots.length > 0 && shots.length < SERIES_LEN;
  const sumsHaveOpen = ints.length > seriesShots.length;
  if (liveOpen && !sumsHaveOpen) {
    const s = sumShots(shots);
    ints.push(s.sumInt);
    decs.push(s.sumDec);
  }
  const n = Math.max(ints.length, decs.length, seriesShots.length, plannedSeriesCount(rangeData));
  const cols = [];
  for (let i = 0; i < n; i++) {
    const live = liveOpen && i === (ints.length - 1);
    const shotList = live ? shots : (seriesShots[i] || []);
    cols.push(seriesCol(
      'comp',
      i,
      String(i + 1),
      ints[i] != null ? ints[i] : null,
      decs[i] != null ? decs[i] : null,
      shotList,
      live
    ));
  }
  return cols;
}

/** Series columns: Probe (P1…) first, then Wertung (1…); pad Wertung to the program length. */
function seriesDisplayColumns(rangeData) {
  const cols = warmupSeriesColumns(rangeData).concat(competitionSeriesColumns(rangeData));
  const shots = rangeData.shots || [];
  let currentIdx = -1;
  for (let i = 0; i < cols.length; i++) {
    if (cols[i].live) currentIdx = i;
  }
  if (currentIdx < 0 && shots.length === SERIES_LEN) {
    const kind = rangeData.isWarmup ? 'warmup' : 'comp';
    for (let i = cols.length - 1; i >= 0; i--) {
      if (cols[i].kind === kind && (cols[i].shots || []).length === SERIES_LEN) {
        currentIdx = i;
        break;
      }
    }
  }
  return { cols: cols, n: cols.length, currentIdx: currentIdx };
}

function seriesOverviewCount(rangeData) {
  return seriesDisplayColumns(rangeData).n;
}

function renderFooter(rangeData) {
  const f = config.footer || {};
  const w = rangeData.currentValue != null && f.currentShotValue ? rangeData.currentValue.toFixed(1) : '–';
  const t = rangeData.currentTeiler != null && f.teiler ? rangeData.currentTeiler.toFixed(1) : '–';
  const best =
    f.teiler && rangeData.bestTeilerShot > 0
      ? Number(rangeData.bestTeiler).toFixed(1) + ' #' + rangeData.bestTeilerShot
      : '–';
  const sumInt = f.overallSumInt || f.overallSumDecimal ? String(rangeData.overallSumInt ?? 0) : '–';
  const sumDec = f.overallSumInt || f.overallSumDecimal ? (rangeData.overallSumDecimal ?? 0).toFixed(1) : '–';
  const hasPred = (rangeData.predictionInt != null && rangeData.predictionInt > 0) || (rangeData.predictionDecimal != null && rangeData.predictionDecimal > 0);
  const predInt = f.predictionInt || f.predictionDecimal ? (hasPred ? String(rangeData.predictionInt ?? 0) : '–') : '–';
  const predDec = f.predictionInt || f.predictionDecimal ? (hasPred ? (rangeData.predictionDecimal ?? 0).toFixed(1) : '–') : '–';
  const sharp = f.shotNumber ? (rangeData.shotNumber ?? '–') : '–';

  const thLabel = (label) => '<th class="footer-th footer-th-label"><span class="footer-label">' + label + ':</span></th>';
  const thValue = (val) => '<th class="footer-th footer-th-value"><span class="footer-value">' + val + '</span></th>';
  const thValueLeft = (val) => '<th class="footer-th footer-th-value footer-value-left"><span class="footer-value">' + val + '</span></th>';
  const tdLabel = (label) => '<td class="footer-td footer-td-label"><span class="footer-label">' + (label ? label + ':' : '') + '</span></td>';
  const tdValue = (val) => '<td class="footer-td footer-td-value"><span class="footer-value">' + val + '</span></td>';
  const tdValueLeft = (val) => '<td class="footer-td footer-td-value footer-value-left"><span class="footer-value">' + val + '</span></td>';

  let serienHtml = '';
  if (f.seriesSumsInt || f.seriesSumsDecimal) {
    const colsModel = seriesDisplayColumns(rangeData);
    const n = colsModel.n;
    const showInt = !!f.seriesSumsInt;
    const showDec = !!f.seriesSumsDecimal;
    let cols = '';
    if (n === 0) {
      cols = '<span class="serien-col serien-empty"><span class="serien-cell">–</span></span>';
    } else {
      for (let i = 0; i < n; i++) {
        const col = colsModel.cols[i];
        const intV = col.intV != null ? String(col.intV) : '';
        const decV = col.decV != null ? Number(col.decV).toFixed(1) : '';
        const hasShots = (col.shots && col.shots.length) || col.live;
        const pad = showDec && intV !== '' ? '<span class="serien-frac-slot" aria-hidden="true">.0</span>' : '';
        const tag = hasShots ? 'button' : 'span';
        const reviewing = seriesFocusByRange[focusKey(rangeData)] != null;
        const current = !reviewing && i === colsModel.currentIdx;
        const warmupCls = col.kind === 'warmup' ? ' serien-warmup' : '';
        const titleKind = col.kind === 'warmup' ? 'Probeserie ' : 'Serie ';
        const titleNum = col.kind === 'warmup' ? (col.index + 1) : col.label;
        const attrs = hasShots
          ? ' type="button" class="serien-col' + warmupCls + (current ? ' serien-current' : '') + '" data-series-idx="' + col.index + '"' +
            ' data-series-kind="' + col.kind + '"' +
            (col.live ? ' data-series-live="1"' : '') +
            ' title="' + titleKind + titleNum + ' auf Scheibe anzeigen"'
          : ' class="serien-col serien-unavailable' + warmupCls + '"';
        cols += '<' + tag + attrs + '>' +
          '<span class="serien-cell serien-idx">' + col.label + '</span>';
        if (showInt) cols += '<span class="serien-cell serien-ints">' + intV + pad + '</span>';
        if (showDec) cols += '<span class="serien-cell serien-decs">' + decV + '</span>';
        cols += '</' + tag + '>';
      }
    }
    serienHtml =
      '<div class="footer-serien-row' + (n > 4 ? ' serien-many' : '') + '">' +
      '<span class="footer-label">Serien:</span>' +
      '<span class="serien-grid serien-cols">' + cols + '</span>' +
      '</div>';
  }

  const innerTableWithValues =
    '<table class="footer-inner-table"><thead><tr>' +
    thLabel('Wert') + thValue(w) + thLabel('Teiler') + thValue(t) + thLabel('Summe') + thValueLeft(sumInt) + thLabel('Prognose') + thValueLeft(predInt) +
    '</tr></thead><tbody><tr>' +
    tdLabel('Schuss') + tdValue(sharp) + tdLabel('Bester T') + tdValue(best) + tdLabel('') + tdValueLeft(sumDec) + tdLabel('') + tdValueLeft(predDec) +
    '</tr></tbody></table>';

  return (
    '<div class="footer-stack">' +
    innerTableWithValues +
    serienHtml +
    '</div>'
  );
}

function formatRangeHeader(r) {
  const line1 = r.shooterName || ('Stand ' + r.rangeNum + ' – kein Schütze');
  const line2 = r.clubName || '';
  const line3 = r.discipline || '';
  const stand = 'Stand ' + r.rangeNum;
  return { line1, line2, line3, stand };
}

function formatShotChip(r) {
  const val = r.currentValue != null ? Number(r.currentValue).toFixed(1) : '–';
  const n = r.shotNumber != null ? r.shotNumber : (r.shots && r.shots.length) || '–';
  const teiler = r.currentTeiler != null ? Number(r.currentTeiler).toFixed(1) : '';
  return {
    val: val,
    meta: '#' + n + (teiler !== '' ? ' · T ' + teiler : '') + (r.isWarmup ? ' · Probe' : '')
  };
}

function rangeChromeSignature(r) {
  const shots = r.shots || [];
  const last = shots.length ? shots[shots.length - 1] : null;
  return [
    r.rangeNum,
    r.shotNumber,
    shots.length,
    last ? `${last.x}:${last.y}:${last.decValue}` : '',
    r.overallSumInt,
    r.overallSumDecimal,
    r.currentValue,
    r.currentTeiler,
    r.bestTeiler,
    r.bestTeilerShot,
    r.predictionInt,
    r.predictionDecimal,
    r.isWarmup ? 1 : 0,
    (r.warmupShots || []).length,
    r.sessionResultId || r.resultId || '',
    r.sessionResultLive === false ? 0 : 1,
    (function () {
      const f = seriesFocusByRange[focusKey(r)];
      return f ? ((f.kind || 'comp') + ':' + f.index + ':' + (f.live ? 1 : 0)) : '';
    })(),
    r.shooterName || '',
    r.clubName || '',
    r.discipline || '',
    disciplineOverrideByRange[r.rangeNum] || 'auto',
    r.totalShotsToFire || 0,
    (r.seriesSumsInt || []).join(','),
    (r.seriesSums || []).join(','),
    (r.last10Values || []).join(','),
    seriesOverviewCount(r),
    getShotStrokeWidth()
  ].join('|');
}

function paintShotValCanvas(canvas, text) {
  const label = text == null || text === '' ? '–' : String(text);
  canvas.setAttribute('aria-label', label);
  const rootStyle = getComputedStyle(document.documentElement);
  const score = (rootStyle.getPropertyValue('--score') || '').trim();
  const ink = (rootStyle.getPropertyValue('--ink') || '#15202b').trim() || '#15202b';
  const fill = score || ink;
  // Heavier than the shooter name (600/20px) so the current value leads the header row
  const fontCss = '700 32px "Segoe UI", system-ui, sans-serif';
  const dpr = window.devicePixelRatio || 1;
  const ss = 4; // supersample, then CSS-downscale — smooths Skia stair-steps vs Notepad
  const scale = dpr * ss;

  const measure = document.createElement('canvas').getContext('2d');
  measure.font = fontCss;
  const textW = Math.ceil(measure.measureText(label).width);
  const cssW = Math.max(52, textW + 6);
  const cssH = 30;

  canvas.width = Math.ceil(cssW * scale);
  canvas.height = Math.ceil(cssH * scale);
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';

  const ctx = canvas.getContext('2d');
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.font = fontCss;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = fill;
  ctx.fillText(label, cssW - 2, cssH / 2);
}

function repaintAllShotVals() {
  document.querySelectorAll('canvas.shot-val').forEach(function (c) {
    paintShotValCanvas(c, c.getAttribute('aria-label') || '–');
  });
}

if (typeof document !== 'undefined') {
  document.addEventListener('srdashboard:themechange', function () {
    repaintAllShotVals();
    repaintShotColors();
  });
  document.addEventListener('srdashboard:shotsatchange', repaintShotColors);
  document.addEventListener('srdashboard:shotmodechange', repaintShotColors);
  window.addEventListener('resize', function () {
    repaintAllShotVals();
    // Re-measure last-10 charts so preserveAspectRatio=none does not stretch a stale viewBox.
    document.querySelectorAll('.last10-chart-wrap').forEach(function (wrap) {
      const panel = wrap.closest('[data-range]');
      const rangeNum = panel ? parseInt(panel.dataset.range, 10) : NaN;
      let values = null;
      let rangeData = panel && panel._paintedRange;
      if (rangeData) values = last10ForDisplay(rangeData);
      else if (lastLiveData && lastLiveData.ranges) {
        const r = lastLiveData.ranges.find(function (x) {
          return x.rangeNum === rangeNum;
        });
        if (r) {
          rangeData = r;
          values = last10ForDisplay(r);
        }
      }
      renderLast10Chart(wrap, values, rangeNum, rangeData);
    });
  });
}

function fillRangeHeader(header, rangeData) {
  delete header._crcHtml;
  header.style.backgroundColor = '';
  header.removeAttribute('title');
  if (header.classList.contains('crc-header') || header.querySelector('.crc-header-line')) {
    header.innerHTML = '';
  }
  header.className = 'range-header' + (rangeData.shooterName ? '' : ' empty');
  const h = formatRangeHeader(rangeData);
  const chip = formatShotChip(rangeData);

  let top = header.querySelector('.range-header-top');
  let metaRow = header.querySelector('.range-header-meta-row');
  let line3 = header.querySelector(':scope > .range-header-line3');

  if (!top || !metaRow || !line3) {
    header.innerHTML = '';
    top = document.createElement('div');
    top.className = 'range-header-top';
    top.innerHTML =
      '<div class="range-header-text"><div class="range-header-line1"></div></div>' +
      '<div class="range-header-actions">' +
      '<button type="button" class="range-qr-btn" title="Ergebnis-QR (Ring Reader)" aria-label="Ergebnis-QR">QR</button>' +
      '<div class="range-shot-chip"><canvas class="shot-val" role="img"></canvas></div>' +
      '</div>';
    header.appendChild(top);

    metaRow = document.createElement('div');
    metaRow.className = 'range-header-meta-row';
    metaRow.innerHTML = '<span class="range-club"></span><span class="shot-meta"></span>';
    header.appendChild(metaRow);

    line3 = document.createElement('div');
    line3.className = 'range-header-line3';
    line3.innerHTML = '<button type="button" class="range-discipline"></button><span class="range-stand"></span>';
    header.appendChild(line3);
  } else if (!header.querySelector('.range-qr-btn')) {
    const chip = header.querySelector('.range-shot-chip');
    if (chip && !chip.parentElement.classList.contains('range-header-actions')) {
      const actions = document.createElement('div');
      actions.className = 'range-header-actions';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'range-qr-btn';
      btn.title = 'Ergebnis-QR (Ring Reader)';
      btn.setAttribute('aria-label', 'Ergebnis-QR');
      btn.textContent = 'QR';
      chip.parentElement.insertBefore(actions, chip);
      actions.appendChild(btn);
      actions.appendChild(chip);
    }
  }

  const qrBtn = header.querySelector('.range-qr-btn');
  if (qrBtn) {
    qrBtn.dataset.range = String(rangeData.rangeNum || '');
    if (rangeData.sessionResultId) {
      qrBtn.dataset.result = String(rangeData.sessionResultId);
    } else if (rangeData.resultId) {
      qrBtn.dataset.result = String(rangeData.resultId);
    } else {
      delete qrBtn.dataset.result;
    }
    const canExport = !!(
      (rangeData.warmupShots && rangeData.warmupShots.length) ||
      (rangeData.seriesShots && rangeData.seriesShots.length) ||
      (rangeData.shots && rangeData.shots.length)
    );
    qrBtn.disabled = !canExport;
    qrBtn.hidden = !rangeData.shooterName && !canExport;
  }

  header.querySelector('.range-sum-row')?.remove();

  // Migrate older span.shot-val nodes to canvas (live panels without remount).
  let shotVal = header.querySelector('.shot-val');
  if (shotVal && shotVal.tagName !== 'CANVAS') {
    const canvas = document.createElement('canvas');
    canvas.className = 'shot-val';
    canvas.setAttribute('role', 'img');
    shotVal.replaceWith(canvas);
    shotVal = canvas;
  }

  const line1 = header.querySelector('.range-header-line1');
  const clubEl = metaRow.querySelector('.range-club');
  let discEl = line3.querySelector('.range-discipline');
  const standEl = line3.querySelector('.range-stand');
  const shotMeta = metaRow.querySelector('.shot-meta');

  if (line1) {
    line1.textContent = h.line1;
    line1.title = rangeData.shooterName ? h.line1 : '';
  }
  if (clubEl) {
    clubEl.textContent = h.line2;
    clubEl.title = h.line2 || '';
    clubEl.hidden = !h.line2;
  }
  metaRow.hidden = !h.line2 && !chip.meta;
  if (discEl) {
    if (discEl.tagName !== 'BUTTON') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = discEl.className || 'range-discipline';
      discEl.replaceWith(btn);
      discEl = btn;
    }
    const canToggle = canControlDisplay() && !!rangeData.shooterName;
    const manual = disciplineOverrideIsManual(rangeData);
    discEl.textContent = formatDisciplineHeader(rangeData);
    discEl.title = canToggle
      ? 'Disziplin. Tippen öffnet Automatisch / LG / LP / KK.'
      : (formatDisciplineHeader(rangeData) || '');
    discEl.classList.toggle('range-disc-toggle', canToggle);
    discEl.classList.toggle('is-manual', manual);
    discEl.disabled = !canToggle;
    if (canToggle) {
      discEl.dataset.range = String(rangeData.rangeNum || '');
      discEl.setAttribute('aria-haspopup', 'true');
      discEl.setAttribute('aria-expanded', disciplineMenuRange === rangeData.rangeNum ? 'true' : 'false');
      discEl.setAttribute('aria-controls', 'range-disc-menu');
      discEl.setAttribute('aria-label', discEl.title);
    } else {
      discEl.removeAttribute('data-range');
      discEl.removeAttribute('aria-haspopup');
      discEl.removeAttribute('aria-expanded');
      discEl.removeAttribute('aria-controls');
    }
  }
  if (standEl) standEl.textContent = h.stand;
  line3.hidden = false;
  if (shotVal) paintShotValCanvas(shotVal, chip.val);
  if (shotMeta) shotMeta.textContent = chip.meta;
}

function renderRangePanel(rangeData) {
  const panel = document.createElement('div');
  panel.className = 'range-panel';
  panel.dataset.range = rangeData.rangeNum;

  const header = document.createElement('div');
  fillRangeHeader(header, rangeData);
  panel.appendChild(header);

  const targetContainer = document.createElement('div');
  targetContainer.className = 'range-target' + (displayIsWarmup(rangeData) ? ' warmup' : '');
  panel.appendChild(targetContainer);

  const f = config.footer || {};
  const showLast10 = f.last10Int || f.last10Decimal;
  if (showLast10) {
    const chartWrap = document.createElement('div');
    chartWrap.className = 'last10-chart-wrap';
    panel.appendChild(chartWrap);
  }

  const footer = document.createElement('div');
  footer.className = 'range-footer';
  footer.innerHTML = renderFooter(rangeData);
  footer.dataset.seriesN = String(seriesOverviewCount(rangeData));
  panel.appendChild(footer);

  syncSeriesFocus(rangeData);
  renderTarget(targetContainer, rangeData, rangeData.isWarmup);
  wireSeriesClicks(footer, rangeData);
  paintSeriesFocusActive(footer, rangeData);
  if (showLast10) {
    const chartWrap = panel.querySelector('.last10-chart-wrap');
    if (chartWrap) renderLast10Chart(chartWrap, last10ForDisplay(rangeData), rangeData.rangeNum, rangeData);
  }
  rememberPaintedRange(panel, rangeData);
  panel.dataset.chromeSig = rangeChromeSignature(rangeData);

  return panel;
}

/** Strip target/chart/footer that legacy syncRangePanel attached next to the plugin mount. */
function stripLegacyPanelChrome(panel) {
  if (!panel) return;
  const kids = Array.prototype.slice.call(panel.children);
  for (let i = 0; i < kids.length; i++) {
    const child = kids[i];
    if (child.classList.contains('range-plugin-view') || child.classList.contains('range-header')) continue;
    if (
      child.classList.contains('last10-chart-wrap') ||
      child.classList.contains('range-footer') ||
      child.classList.contains('range-target')
    ) {
      child.remove();
    }
  }
}

function renderClassicRangeView(container, rangeData, opts) {
  if (!container || !rangeData) return;
  rememberPaintedRange(container, rangeData);

  // Drop leftover markup from another plugin (e.g. autorennen) before painting.
  if (
    container.querySelector('.ar-master-layout, .ar-shooter-layout, .plugin-fallback, .plugin-error') ||
    (container.dataset.pluginId && container.dataset.pluginId !== 'classic-range')
  ) {
    container.innerHTML = '';
  }
  container.dataset.pluginId = 'classic-range';

  syncSeriesFocus(rangeData);

  // One chart lives inside the mount; drop duplicates left on the parent panel.
  const hostPanel = container.closest('.range-panel');
  if (hostPanel) stripLegacyPanelChrome(hostPanel);

  let targetEl = container.querySelector(':scope > .range-target');
  if (!targetEl) {
    targetEl = document.createElement('div');
    targetEl.className = 'range-target';
    container.appendChild(targetEl);
  }
  targetEl.classList.toggle('warmup', displayIsWarmup(rangeData));

  const f = config.footer || {};
  const showLast10 = f.last10Int || f.last10Decimal;
  // Keep a single direct-child chart (racey remounts used to append extras).
  const extraCharts = container.querySelectorAll(':scope > .last10-chart-wrap');
  for (let i = 1; i < extraCharts.length; i++) extraCharts[i].remove();
  let chartWrap = container.querySelector(':scope > .last10-chart-wrap');
  if (showLast10) {
    if (!chartWrap) {
      chartWrap = document.createElement('div');
      chartWrap.className = 'last10-chart-wrap';
      const footerEl = container.querySelector(':scope > .range-footer');
      if (footerEl) container.insertBefore(chartWrap, footerEl);
      else container.appendChild(chartWrap);
    }
    renderLast10Chart(chartWrap, last10ForDisplay(rangeData), rangeData.rangeNum, rangeData);
  } else if (chartWrap) {
    chartWrap.remove();
  }

  let footerEl = container.querySelector(':scope > .range-footer');
  if (!footerEl) {
    footerEl = document.createElement('div');
    footerEl.className = 'range-footer';
    container.appendChild(footerEl);
  }
  const seriesN = seriesOverviewCount(rangeData);
  footerEl.innerHTML = renderFooter(rangeData);
  footerEl.dataset.seriesN = String(seriesN);
  wireSeriesClicks(footerEl, rangeData);
  paintSeriesFocusActive(footerEl, rangeData);
  renderTarget(targetEl, rangeData, rangeData.isWarmup, opts);
}

function syncRangePanel(panel, r) {
  if (!panel || !r) return;
  if (isFrozenSessionView(panel)) return;
  rememberPaintedRange(panel, r);
  // Plugin mounts own target/chart/footer — never paint a second copy on the panel.
  if (panel.classList.contains('plugin-hosted') || panel.querySelector(':scope > .range-plugin-view')) {
    stripLegacyPanelChrome(panel);
    return;
  }
  const sig = rangeChromeSignature(r);
  if (panel.dataset.chromeSig === sig) return;
  panel.dataset.chromeSig = sig;

  const header = panel.querySelector('.range-header');
  const targetEl = panel.querySelector('.range-target');
  const footerEl = panel.querySelector('.range-footer');
  const f = config.footer || {};
  const showLast10 = f.last10Int || f.last10Decimal;
  if (header) fillRangeHeader(header, r);
  if (targetEl) targetEl.classList.toggle('warmup', displayIsWarmup(r));

  const seriesN = seriesOverviewCount(r);
  syncSeriesFocus(r);
  if (footerEl) {
    footerEl.innerHTML = renderFooter(r);
    footerEl.dataset.seriesN = String(seriesN);
    wireSeriesClicks(footerEl, r);
    paintSeriesFocusActive(footerEl, r);
  }
  if (showLast10) {
    let chartWrap = panel.querySelector('.last10-chart-wrap');
    if (!chartWrap) {
      chartWrap = document.createElement('div');
      chartWrap.className = 'last10-chart-wrap';
      panel.insertBefore(chartWrap, footerEl);
    }
    renderLast10Chart(chartWrap, last10ForDisplay(r), r.rangeNum, r);
  } else {
    const chartWrap = panel.querySelector('.last10-chart-wrap');
    if (chartWrap) chartWrap.remove();
  }
  renderTarget(targetEl, r, r.isWarmup);
}

/** Empty range shell for plugin-hosted UI: header + .range-plugin-view mount. */
function ensurePluginPanels(numRanges) {
  const grid = document.getElementById('ranges-grid');
  if (!grid) return;
  const n = Math.max(1, numRanges || (config && config.ranges) || 1);
  const inactive = inactiveRangeSet();
  const keep = new Set();
  for (let i = 1; i <= n; i++) {
    if (inactive[i]) continue;
    keep.add(i);
    let panel = grid.querySelector('.range-panel[data-range="' + i + '"]');
    if (!panel) {
      panel = document.createElement('div');
      panel.className = 'range-panel plugin-hosted';
      panel.dataset.range = String(i);
      const header = document.createElement('div');
      header.className = 'range-header';
      fillRangeHeader(header, { rangeNum: i });
      panel.appendChild(header);
      const mount = document.createElement('div');
      mount.className = 'range-plugin-view';
      panel.appendChild(mount);
      grid.appendChild(panel);
    } else if (!panel.querySelector('.range-plugin-view')) {
      const mount = document.createElement('div');
      mount.className = 'range-plugin-view';
      panel.appendChild(mount);
    }
    panel.classList.add('plugin-hosted');
    stripLegacyPanelChrome(panel);
  }
  grid.querySelectorAll('.range-panel').forEach(function (panel) {
    if (isWettkampfPanel(panel)) return;
    const num = parseInt(panel.dataset.range, 10);
    if (!keep.has(num)) panel.remove();
  });
  // appendChild moves an existing node — rebuild 1…N order so a re-activated
  // Bahn is not left at the end of the grid.
  for (let i = 1; i <= n; i++) {
    if (!keep.has(i)) continue;
    const panel = grid.querySelector('.range-panel[data-range="' + i + '"]');
    if (panel) grid.appendChild(panel);
  }
  ensureWettkampfPanel(grid);
}

function ensureWettkampfPanel(grid) {
  if (!grid) return;
  let panel = grid.querySelector('.range-panel[data-slot="wettkampf"]');
  if (!wettkampfTileEnabled()) {
    if (panel) panel.remove();
    return;
  }
  if (!panel) {
    panel = document.createElement('div');
    panel.className = 'range-panel plugin-hosted crc-panel crc-wettkampf-panel';
    panel.setAttribute('data-slot', 'wettkampf');
    const header = document.createElement('div');
    header.className = 'range-header crc-header';
    panel.appendChild(header);
    const mount = document.createElement('div');
    mount.className = 'range-plugin-view crc-wettkampf-view';
    mount.dataset.pluginId = 'classic-range-condensed';
    panel.appendChild(mount);
    grid.appendChild(panel);
  }
  panel.classList.add('plugin-hosted', 'crc-panel', 'crc-wettkampf-panel');
  stripLegacyPanelChrome(panel);
  grid.appendChild(panel);
}

function updatePluginPanelHeader(rangeNum, rangeData) {
  const grid = document.getElementById('ranges-grid');
  if (!grid) return;
  const panel = grid.querySelector(`.range-panel[data-range="${rangeNum}"]`);
  if (!panel) return;
  const header = panel.querySelector('.range-header');
  if (!header) return;
  const data = rangeData || { rangeNum: rangeNum };
  const mount = panel.querySelector('.range-plugin-view');
  const condensed = hallPluginId === 'classic-range-condensed' ||
    (mount && mount.dataset.pluginId === 'classic-range-condensed');
  if (condensed) {
    // Do not paint Classic QR/chip/title chrome while Condensed is active —
    // a live frame before crc-panel is set used to mix the two headers.
    if (window.SRClassicRangeCondensed) {
      panel.classList.add('crc-panel');
      window.SRClassicRangeCondensed.fillHeader(header, data);
    }
    return;
  }
  panel.classList.remove('crc-panel');
  fillRangeHeader(header, data);
}

function render(data) {
  lastLiveData = data;
  const grid = document.getElementById('ranges-grid');
  if (!grid || !data) return;

  // Hall maximum from config.ranges only — never grow the grid from live payloads.
  const configured = Math.max(1, (config && config.ranges) || 1);
  ensurePluginPanels(configured);

  const byNum = {};
  (data.ranges || []).forEach((r) => { byNum[r.rangeNum] = r; });
  const inactive = inactiveRangeSet();
  for (let i = 1; i <= configured; i++) {
    if (inactive[i]) continue;
    updatePluginPanelHeader(i, byNum[i] || { rangeNum: i });
  }
  syncRangeVisibility(data);
  paintWettkampfTile();
}

function paintWettkampfTile() {
  if (!wettkampfTileEnabled()) return;
  const fn = window.SRClassicRangeCondensed && window.SRClassicRangeCondensed.paintWettkampf;
  if (typeof fn !== 'function') return;
  const panel = document.querySelector('.range-panel[data-slot="wettkampf"]');
  if (!panel) return;
  const mount = panel.querySelector('.range-plugin-view');
  const header = panel.querySelector('.range-header');
  fn(mount, header, lastWettkampf, lastLiveData);
}

async function poll() {
  try {
    const data = await fetchLive();
    if (data) render(data);
  } catch (e) {
    console.warn('Poll failed:', e);
  }
}

window.SRCore = {
  POLL_INTERVAL_MS,
  SAFETY_POLL_MS,
  get config() { return config; },
  get lastLiveData() { return lastLiveData; },
  set lastLiveData(v) { lastLiveData = v; },
  get lastWettkampf() { return lastWettkampf; },
  set lastWettkampf(v) { lastWettkampf = v; },
  bumpLiveGen,
  getLiveGen,
  fetchConfig,
  fetchLive,
  applyLayout,
  syncRangeVisibility,
  rangeHasActivity,
  isRangeInactive,
  wettkampfTileEnabled,
  paintWettkampfTile,
  render,
  ensurePluginPanels,
  updatePluginPanelHeader,
  setHallPluginId,
  getHallPluginId,
  renderRangePanel,
  syncRangePanel,
  renderClassicRangeView,
  renderTarget,
  renderFooter,
  fillRangeHeader,
  formatRangeHeader,
  getShotOrderColors,
  getShotSwatchColors,
  getShotColorMode,
  repaintShotColors,
  getTargetScale,
  setTargetAssetBase,
  setPluginTargetConfig,
  dsgToSvg,
  effectiveDecimal,
  effectiveProgramId,
  parseShotCountLabel,
  formatDisciplineChip,
  formatDisciplineHeader,
  disciplineOverrideIsManual,
  openResultQR: openResultQRModal
};

let qrFormatsCache = null;

async function loadQRFormats() {
  if (qrFormatsCache) return qrFormatsCache;
  try {
    const res = await fetch('/api/qr/formats');
    if (!res.ok) return [{ id: 'rr', label: 'Ring Reader' }];
    qrFormatsCache = await res.json();
    return qrFormatsCache;
  } catch (e) {
    return [{ id: 'rr', label: 'Ring Reader' }];
  }
}

function setQRModalView(modal, view) {
  const showJson = view === 'json';
  modal.dataset.view = showJson ? 'json' : 'qr';
  const body = modal.querySelector('#qr-result-body');
  const jsonPanel = modal.querySelector('#qr-result-json-panel');
  const viewBtn = modal.querySelector('#qr-view-toggle');
  const copyBtn = modal.querySelector('#qr-json-copy');
  const jsonText = (modal.querySelector('#qr-result-json') || {}).textContent || '';
  if (body) body.hidden = showJson;
  if (jsonPanel) jsonPanel.hidden = !showJson;
  if (viewBtn) {
    viewBtn.textContent = showJson ? 'QR' : 'JSON';
    viewBtn.title = showJson ? 'QR-Code anzeigen' : 'Plaintext JSON anzeigen';
  }
  if (copyBtn) copyBtn.hidden = !showJson || !jsonText;
}

function ensureQRModal() {
  let modal = document.getElementById('qr-result-modal');
  if (modal && !modal.querySelector('#qr-view-toggle')) {
    modal.remove();
    modal = null;
  }
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'qr-result-modal';
  modal.className = 'qr-result-modal';
  modal.hidden = true;
  modal.dataset.view = 'qr';
  modal.innerHTML =
    '<div class="qr-result-backdrop" data-qr-close="1"></div>' +
    '<div class="qr-result-dialog" role="dialog" aria-modal="true" aria-labelledby="qr-result-title">' +
    '<div class="qr-result-head">' +
    '<h2 id="qr-result-title">Ergebnis-QR</h2>' +
    '<button type="button" class="qr-result-close btn btn-ghost" data-qr-close="1" aria-label="Schließen">×</button>' +
    '</div>' +
    '<div class="qr-result-toolbar">' +
    '<div class="qr-result-formats" id="qr-result-formats"></div>' +
    '<button type="button" class="qr-view-toggle" id="qr-view-toggle" hidden>JSON</button>' +
    '<button type="button" class="qr-json-copy" id="qr-json-copy" hidden title="JSON in Zwischenablage">Copy</button>' +
    '</div>' +
    '<div class="qr-result-body" id="qr-result-body">' +
    '<img class="qr-result-img" id="qr-result-img" alt="QR-Code" width="512" height="512">' +
    '<p class="qr-result-hint" id="qr-result-hint"></p>' +
    '<p class="qr-result-error" id="qr-result-error" hidden></p>' +
    '</div>' +
    '<div class="qr-result-json-panel" id="qr-result-json-panel" hidden>' +
    '<pre class="qr-result-json" id="qr-result-json"></pre>' +
    '</div>' +
    '</div>';
  document.body.appendChild(modal);
  modal.addEventListener('click', function (ev) {
    if (ev.target && ev.target.getAttribute('data-qr-close')) {
      modal.hidden = true;
    }
  });
  modal.querySelector('#qr-view-toggle').addEventListener('click', function () {
    setQRModalView(modal, modal.dataset.view === 'json' ? 'qr' : 'json');
  });
  modal.querySelector('#qr-json-copy').addEventListener('click', async function () {
    const pre = modal.querySelector('#qr-result-json');
    const text = pre && pre.textContent;
    if (!text) return;
    const btn = modal.querySelector('#qr-json-copy');
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'Copied';
      setTimeout(function () { btn.textContent = 'Copy'; }, 1500);
    } catch (e) {
      btn.textContent = 'Failed';
      setTimeout(function () { btn.textContent = 'Copy'; }, 1500);
    }
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && !modal.hidden) modal.hidden = true;
  });
  return modal;
}

async function openResultQRModal(rangeNum, fmtId, resultId) {
  const modal = ensureQRModal();
  const img = modal.querySelector('#qr-result-img');
  const hint = modal.querySelector('#qr-result-hint');
  const errEl = modal.querySelector('#qr-result-error');
  const formatsEl = modal.querySelector('#qr-result-formats');
  const jsonEl = modal.querySelector('#qr-result-json');
  const viewBtn = modal.querySelector('#qr-view-toggle');
  const copyBtn = modal.querySelector('#qr-json-copy');
  const keepView = modal.dataset.view === 'json' ? 'json' : 'qr';
  errEl.hidden = true;
  errEl.textContent = '';
  img.removeAttribute('src');
  hint.textContent = 'Lade…';
  jsonEl.textContent = '';
  viewBtn.hidden = true;
  copyBtn.hidden = true;
  copyBtn.textContent = 'Copy';
  setQRModalView(modal, 'qr');

  const formats = await loadQRFormats();
  const activeFmt = fmtId || (formats[0] && formats[0].id) || 'rr';
  formatsEl.innerHTML = '';
  formats.forEach(function (f) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'qr-format-btn' + (f.id === activeFmt ? ' is-active' : '');
    btn.textContent = f.label || f.id;
    btn.addEventListener('click', function () {
      openResultQRModal(rangeNum, f.id, resultId);
    });
    formatsEl.appendChild(btn);
  });

  modal.hidden = false;
  modal.dataset.range = String(rangeNum || '');
  modal.dataset.result = resultId || '';
  modal.dataset.fmt = activeFmt;
  const q = resultId
    ? ('result=' + encodeURIComponent(resultId))
    : ('range=' + encodeURIComponent(rangeNum));

  try {
    const metaRes = await fetch('/api/qr?' + q + '&fmt=' + encodeURIComponent(activeFmt));
    if (!metaRes.ok) {
      const text = await metaRes.text();
      throw new Error(text || ('HTTP ' + metaRes.status));
    }
    const meta = await metaRes.json();
    const bahn = meta.range || rangeNum;
    document.getElementById('qr-result-title').textContent = (meta.label || 'QR') + ' · Bahn ' + bahn;
    hint.textContent = 'Mit dem Handy scannen → ' + (meta.label || activeFmt);
    img.src = '/api/qr.png?' + q +
      '&fmt=' + encodeURIComponent(activeFmt) + '&t=' + Date.now();
    if (meta.json) {
      jsonEl.textContent = meta.json;
      viewBtn.hidden = false;
      setQRModalView(modal, keepView === 'json' ? 'json' : 'qr');
    } else {
      setQRModalView(modal, 'qr');
    }
  } catch (e) {
    errEl.hidden = false;
    errEl.textContent = e.message || String(e);
    hint.textContent = '';
    setQRModalView(modal, 'qr');
  }
}

document.addEventListener('click', function (ev) {
  const btn = ev.target && ev.target.closest && ev.target.closest('.range-qr-btn');
  if (!btn || btn.disabled) return;
  const resultId = btn.dataset.result || '';
  const rangeNum = parseInt(btn.dataset.range || btn.closest('[data-range]')?.dataset?.range || '', 10);
  if (!resultId && !rangeNum) return;
  ev.preventDefault();
  openResultQRModal(rangeNum, undefined, resultId);
});
