window.SRPlugins = window.SRPlugins || {};
window.SRPluginViews = window.SRPluginViews || {};

(function () {
  const PLUGIN_ID = 'darts';
  let lastEventList = [];
  let lastGamePhase = '';

  const AUDIO_BASE = '/plugins/darts/assets/audio/';
  const audioQueue = [];
  const audioDrainCallbacks = [];
  let audioPlaying = false;
  let audioUnlocked = false;
  let audioRelaySocket = null;
  let audioRelayRole = '';
  let audioRelayRange = 0;
  let dartsAudioActive = false;
  let audioRelayReconnectTimer = null;
  let audioRelayGeneration = 0;
  let activeAudioElement = null;
  let unlockAudioElement = null;
  let audioUnlockListenersInstalled = false;
  let unlockOnceHandler = null;

  const AUDIO_SETTINGS_KEY = 'srdashboard.darts.audio';
  let audioEnabled = true;
  let audioVolume = 1.0;

  function loadAudioSettings() {
    // Zuerst die gespeicherten Lautstärke-/Audioeinstellungen laden.
    try {
      const raw = localStorage.getItem(AUDIO_SETTINGS_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        if (typeof saved.enabled === 'boolean') audioEnabled = saved.enabled;
        const volume = Number(saved.volume);
        if (Number.isFinite(volume)) audioVolume = Math.max(0, Math.min(1, volume));
      }
    } catch (_) {}

    // URL-Parameter hat Vorrang vor den lokal gespeicherten Einstellungen.
    // Damit lässt sich jedes Anzeigegerät gezielt stumm oder aktiv schalten.
    try {
      const audioParam = new URLSearchParams(window.location.search).get('audio');
      if (audioParam === '1') audioEnabled = true;
      else if (audioParam === '0') audioEnabled = false;
    } catch (_) {}
  }
  function saveAudioSettings() {
    try {
      localStorage.setItem(
        AUDIO_SETTINGS_KEY,
        JSON.stringify({
          enabled: audioEnabled,
          volume: audioVolume
        })
      );
    } catch (_) {}
  }

  function runAudioDrainCallbacks() {
    if (audioPlaying || audioQueue.length) return;
    while (audioDrainCallbacks.length) {
      const callback = audioDrainCallbacks.shift();
      try { callback(); } catch (err) {
        console.warn('[darts] Audio-Abschlussaktion fehlgeschlagen:', err);
      }
    }
  }

  function whenAudioQueueDrained(callback) {
    if (typeof callback !== 'function') return;
    audioDrainCallbacks.push(callback);
    runAudioDrainCallbacks();
  }

  function clearAudioQueue() {
    audioQueue.length = 0;
    runAudioDrainCallbacks();
  }

  // Audio ist ausschließlich aktiv, solange die Ansicht des Plugins 'darts'
  // tatsächlich gerendert wird. Beim Pluginwechsel werden sämtliche Ressourcen
  // beendet, nicht nur aus der Warteschlange entfernt.
  function deactivateDartsAudio() {
    dartsAudioActive = false;
    audioRelayGeneration += 1;

    if (audioRelayReconnectTimer !== null) {
      clearTimeout(audioRelayReconnectTimer);
      audioRelayReconnectTimer = null;
    }

    // Drain-Callbacks nicht ausführen: Sie könnten weitere Audioausgaben planen.
    audioQueue.length = 0;
    audioDrainCallbacks.length = 0;

    [activeAudioElement, unlockAudioElement].forEach(function (audio) {
      if (!audio) return;
      try { audio.pause(); } catch (_) {}
      try { audio.currentTime = 0; } catch (_) {}
      try { audio.removeAttribute('src'); audio.load(); } catch (_) {}
    });
    activeAudioElement = null;
    unlockAudioElement = null;
    audioPlaying = false;
    audioUnlocked = false;

    if (audioRelaySocket) {
      const socket = audioRelaySocket;
      audioRelaySocket = null;
      try {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
      } catch (_) {}
    }
    audioRelayRole = '';
    removeAudioUnlockPrompt();

    if (audioUnlockListenersInstalled && unlockOnceHandler && typeof document !== 'undefined') {
      document.removeEventListener('pointerdown', unlockOnceHandler, true);
      document.removeEventListener('keydown', unlockOnceHandler, true);
      document.removeEventListener('click', unlockOnceHandler, true);
    }
    audioUnlockListenersInstalled = false;
    unlockOnceHandler = null;
  }

  function activateDartsAudio() {
    if (dartsAudioActive) return;
    dartsAudioActive = true;
    loadAudioSettings();
    setupAudioRelay();
    if (typeof document !== 'undefined') {
      unlockOnceHandler = function () { unlockAudio(); };
      document.addEventListener('pointerdown', unlockOnceHandler, true);
      document.addEventListener('keydown', unlockOnceHandler, true);
      document.addEventListener('click', unlockOnceHandler, true);
      audioUnlockListenersInstalled = true;
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', showAudioUnlockPrompt, { once: true });
      } else {
        showAudioUnlockPrompt();
      }
    }
  }

  loadAudioSettings();

  function audioFileForSpecialDart(ev) {
    if (!ev || ev.type !== 'dart') return null;

    // Eingabegeräte und Spielmodi liefern die Trefferangaben teils in
    // leicht unterschiedlichen Formen. Deshalb alle relevanten Felder
    // normalisieren und Single Bull vor Cricket-Sonderregeln erkennen.
    const data = ev.data || {};
    const notation = String(data.notation || ev.notation || '')
      .trim().toUpperCase().replace(/[\s_-]+/g, '');
    const ring = String(data.ring || ev.ring || '')
      .trim().toLowerCase().replace(/[\s_-]+/g, '');
    const score = Number(data.score ?? ev.score);
    const value = Number(data.value ?? ev.value);
    const multiplier = Number(data.multiplier ?? ev.multiplier);

    // Äußerer Bull (25), unabhängig vom Spielmodus.
    // BULL / bullseye hat Vorrang als innerer Bull und darf nicht als Single zählen.
    const isInnerBull = ring === 'bullseye' || notation === 'BULL' || notation === 'INNERBULL';
    const isOuterBull = !isInnerBull && (
      ring === 'outerbull' ||
      ring === 'singlebull' ||
      ring === 'sbull' ||
      ['25', 'S25', 'SB', 'SINGLEBULL', 'OUTERBULL', 'SBULL'].includes(notation) ||
      (score === 25 && multiplier !== 2) ||
      (value === 25 && multiplier === 1)
    );
    if (isOuterBull) return 'bull.mp3';

    // In Cricket keine Sondertöne für Treffer ausgeben, die kein neues Ziel markieren.
    if (data.cricketTarget && Number(data.cricketMarks) === 0) return null;

    switch (notation) {
      case 'T20': return 'tripple20.mp3';
      case 'T19': return 'tripple19.mp3';
      case 'T18': return 'tripple18.mp3';
      case 'T17': return 'tripple17.mp3';
      case 'T16': return 'tripple16.mp3';
      case 'BULL': return 'bullseye.mp3';
      default: return null;
    }
  }

  function relayAudioFile(file) {
    if (!file || !audioRelaySocket || audioRelaySocket.readyState !== WebSocket.OPEN) return;
    try { audioRelaySocket.send(JSON.stringify({ type: 'audio_play', file: file })); } catch (_) {}
  }

  function queueAudioFile(file) {
    if (!dartsAudioActive || !file) return;
    if (file === 'bull.mp3') {
      console.info('[darts] Bull-Audio: queueAudioFile aufgerufen', {
        audioEnabled: audioEnabled,
        audioUnlocked: audioUnlocked,
        audioPlaying: audioPlaying,
        queueLength: audioQueue.length,
        relayRole: audioRelayRole
      });
    }
    // Nur die Eingabe-/Bahnansicht sendet Audioereignisse an den Server.
    // Empfänger spielen die Ereignisse lokal ab, wenn audio=1 gesetzt ist.
    if (audioRelayRole === 'source') relayAudioFile(file);
    if (!audioEnabled) return;
    audioQueue.push(file);
    playNextAudio();
  }

  function setupAudioRelay() {
    try {
      const params = new URLSearchParams(window.location.search);
      const param = params.get('audio');
      if (param === '1') audioEnabled = true;
      else if (param === '0') audioEnabled = false;
      const display = window.SRDisplay || {};
      const isShooter = display.display === 'shooter' || document.body.classList.contains('shooter-display');
      audioRelayRole = param === '1' ? 'receiver' : (isShooter ? 'source' : '');
      if (!audioRelayRole) return;
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const qs = new URLSearchParams();
      if (display.rangeNum) qs.set('range', String(display.rangeNum));
      if (audioRelayRole === 'source') qs.set('audioSource', '1');
      else qs.set('audio', '1');
      const generation = audioRelayGeneration;
      const connect = () => {
        if (!dartsAudioActive || generation !== audioRelayGeneration) return;
        if (audioRelaySocket && (audioRelaySocket.readyState === WebSocket.OPEN || audioRelaySocket.readyState === WebSocket.CONNECTING)) return;
        audioRelaySocket = new WebSocket(proto + '//' + location.host + '/ws?' + qs.toString());
        audioRelaySocket.onmessage = function (ev) {
          if (!dartsAudioActive || generation !== audioRelayGeneration || audioRelayRole !== 'receiver' || !audioEnabled) return;
          try {
            const msg = JSON.parse(ev.data);
            if (msg.type === 'audio_play' && typeof msg.file === 'string') queueRemoteAudioFile(msg.file);
          } catch (_) {}
        };
        audioRelaySocket.onclose = function () {
          if (!dartsAudioActive || generation !== audioRelayGeneration) return;
          if (audioRelayReconnectTimer !== null) clearTimeout(audioRelayReconnectTimer);
          audioRelayReconnectTimer = setTimeout(function () {
            audioRelayReconnectTimer = null;
            connect();
          }, 2000);
        };
        audioRelaySocket.onerror = function () { try { audioRelaySocket.close(); } catch (_) {} };
      };
      connect();
    } catch (e) { console.warn('[darts] Audio relay konnte nicht gestartet werden', e); }
  }

  function queueRemoteAudioFile(file) {
    if (!dartsAudioActive || !audioEnabled || !/^(busted|next-player|bullseye|bull|tripple16|tripple17|tripple18|tripple19|tripple20|[1-9]?[0-9]|1[0-7][0-9]|180)\.mp3$/.test(file)) return;
    audioQueue.push(file);
    playNextAudio();
  }

  // Der Audio-Relay wird erst beim Rendern des aktiven Darts-Plugins gestartet.

  // Browser verlangen häufig eine bewusste Benutzerinteraktion, bevor Audio
  // abgespielt werden darf. Für explizite audio=1-Aufrufe zeigen wir deshalb
  // einen klaren Freischaltknopf statt stillschweigend Audio zu verwerfen.
  let audioUnlockPrompt = null;
  function removeAudioUnlockPrompt() {
    if (audioUnlockPrompt && audioUnlockPrompt.parentNode) {
      audioUnlockPrompt.parentNode.removeChild(audioUnlockPrompt);
    }
    audioUnlockPrompt = null;
  }
  function showAudioUnlockPrompt() {
    if (!dartsAudioActive || !document.body || audioUnlockPrompt || !audioEnabled) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('audio') !== '1') return;
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;z-index:2147483647;left:50%;bottom:18px;transform:translateX(-50%);padding:10px 14px;background:rgba(20,20,20,.94);color:#fff;border-radius:8px;box-shadow:0 2px 12px rgba(0,0,0,.4);font:16px sans-serif;text-align:center;max-width:calc(100vw - 32px);';
    const text = document.createElement('div');
    text.textContent = 'Audio aktivieren, um Töne dieser Anzeige zu hören.';
    text.style.cssText = 'margin-bottom:8px;';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Audio aktivieren';
    button.style.cssText = 'font:inherit;font-weight:600;padding:8px 14px;cursor:pointer;';
    button.addEventListener('click', function () { unlockAudio(); });
    wrap.appendChild(text);
    wrap.appendChild(button);
    document.body.appendChild(wrap);
    audioUnlockPrompt = wrap;
  }

  function playNextAudio() {
    if (!dartsAudioActive) return;
    if (!audioEnabled) {
      clearAudioQueue();
      return;
    }

    if (audioPlaying) return;
    if (!audioQueue.length) {
      runAudioDrainCallbacks();
      return;
    }
    if (!audioUnlocked) return;

    const file = audioQueue.shift();

    if (file === 'bull.mp3') {
      console.info('[darts] Bull-Audio: Wiedergabe wird gestartet', {
        url: AUDIO_BASE + encodeURIComponent(file),
        volume: audioVolume
      });
    }

    const audio = new Audio(
      AUDIO_BASE +
      encodeURIComponent(file)
    );
    activeAudioElement = audio;
    const playbackGeneration = audioRelayGeneration;

    audio.volume = audioVolume;
    audioPlaying = true;

    let settled = false;
    const done = function () {
      // ended/error/play().catch können für dieselbe Instanz mehrfach eintreffen.
      if (settled) return;
      settled = true;
      if (playbackGeneration !== audioRelayGeneration) {
        if (activeAudioElement === audio) activeAudioElement = null;
        return;
      }
      if (activeAudioElement === audio) activeAudioElement = null;
      audioPlaying = false;
      if (dartsAudioActive) playNextAudio();
    };

    audio.addEventListener(
      'ended',
      done,
      { once: true }
    );

    audio.addEventListener(
      'error',
      function () {
        console.warn(
          '[darts] Audio konnte nicht geladen werden:',
          file
        );

        done();
      },
      { once: true }
    );

    if (file === 'bull.mp3') {
      audio.addEventListener('playing', function () {
        console.info('[darts] Bull-Audio: playing-Event', {
          currentSrc: audio.currentSrc,
          volume: audio.volume,
          muted: audio.muted,
          currentTime: audio.currentTime
        });
      }, { once: true });
      audio.addEventListener('loadeddata', function () {
        console.info('[darts] Bull-Audio: loadeddata', {
          readyState: audio.readyState,
          duration: audio.duration
        });
      }, { once: true });
      audio.addEventListener('ended', function () {
        console.info('[darts] Bull-Audio: ended');
      }, { once: true });
      audio.addEventListener('error', function () {
        console.error('[darts] Bull-Audio: media error', {
          code: audio.error && audio.error.code,
          message: audio.error && audio.error.message,
          currentSrc: audio.currentSrc
        });
      }, { once: true });
    }

    const promise = audio.play();

    if (file === 'bull.mp3' && promise && typeof promise.then === 'function') {
      promise.then(function () {
        console.info('[darts] Bull-Audio: play-Promise resolved');
      }).catch(function (err) {
        console.error('[darts] Bull-Audio: play-Promise rejected', err);
      });
    }

    if (
      promise &&
      typeof promise.catch === 'function'
    ) {
      promise.catch(function (err) {
        console.warn(
          '[darts] Audio-Wiedergabe blockiert:',
          file,
          err
        );

        done();
      });
    }
  }

  function unlockAudio() {
    if (!dartsAudioActive || audioUnlocked) {
      return;
    }

    // Browser erlauben Audio teilweise erst nach einer
    // Benutzerinteraktion. Deshalb wird beim Start einmal
    // ein stummer Clip angespielt.
    const audio = new Audio(
      AUDIO_BASE + 'next-player.mp3'
    );
    unlockAudioElement = audio;
    const unlockGeneration = audioRelayGeneration;

    audio.muted = true;
    audio.volume = 0;


    const promise = audio.play();

    if (
      promise &&
      typeof promise.then === 'function'
    ) {
      promise
        .then(function () {
          if (!dartsAudioActive || unlockGeneration !== audioRelayGeneration) {
            try { audio.pause(); } catch (_) {}
            return;
          }
          audio.pause();
          if (unlockAudioElement === audio) unlockAudioElement = null;

          try {
            audio.currentTime = 0;
          } catch (_) {}

          audioUnlocked = true;
          removeAudioUnlockPrompt();
          playNextAudio();
        })
        .catch(function () {
          if (unlockAudioElement === audio) unlockAudioElement = null;
          // Die normale Audio-Queue versucht es später erneut.
        });
    }
  }

  function numericRoundAudio(score) {
    const n = Number(score);

    if (
      !Number.isFinite(n) ||
      n < 1 ||
      n > 180
    ) {
      return null;
    }

    return String(
      Math.round(n)
    ) + '.mp3';
  }

  let lastTurnEndAudioSignature = null;
  let turnEndAudioHandled = false;

  function handleDartAudioEvents(events, canAdvanceTurn, gameMode) {
    const list = Array.isArray(events) ? events : [];
    if (!list.length) {
      // Merke den leeren Zustand, damit eine spätere neue Partie wieder
      // regulär verarbeitet werden kann.
      lastEventList = [];
      return;
    }

    // events ist eine wachsende Ereignisliste. Ein Vergleich der kompletten
    // Liste führt dazu, dass bei jedem neuen Event alle alten Events erneut
    // abgespielt werden. Verarbeite nur den neuen Suffix.
    let commonPrefix = 0;
    const maxPrefix = Math.min(lastEventList.length, list.length);
    while (
      commonPrefix < maxPrefix &&
      JSON.stringify(lastEventList[commonPrefix]) === JSON.stringify(list[commonPrefix])
    ) {
      commonPrefix++;
    }

    // Wenn die Liste zurückgesetzt oder im Mittelteil verändert wurde,
    // behandle sie als neuen Snapshot und beginne ab dem ersten abweichenden Event.
    const newEvents = list.slice(commonPrefix);
    lastEventList = list.map(function (ev) {
      try { return JSON.parse(JSON.stringify(ev)); } catch (_) { return ev; }
    });

    newEvents.forEach(function (ev) {
      if (
        !ev ||
        !ev.type
      ) {
        return;
      }

      if (ev.type === 'dart') {
        turnEndAudioHandled = false;
        lastTurnEndAudioSignature = null;
      }

      // Around the Clock: Nur wertende Treffer ansagen.
      // Die Spiellogik setzt data.clockHit auf true, wenn das aktuelle
      // Ziel getroffen wurde. Fehlwürfe/falsche Zahlen bleiben stumm.
      if (ev.type === 'dart' && gameMode === 'around_clock') {
        const dartData = ev.data || {};
        if (dartData.clockHit === true) {
          queueAudioFile('good-single.mp3');
        }
        return;
      }

      // T17/T18/T19/T20/Bullseye
      // direkt nach dem Dart.
      if (ev.type === 'dart') {
        const special = audioFileForSpecialDart(ev);
        const dartData = ev.data || {};
        const rawNotation = String(dartData.notation || ev.notation || '').trim();
        const rawRing = String(dartData.ring || ev.ring || '').trim();
        const rawScore = dartData.score ?? ev.score;

        // Temporary targeted diagnostics: show the actual outer-bull event
        // received by the browser and which audio file is selected.
        if (/bull|^25$|^s25$/i.test(rawNotation) || /bull/i.test(rawRing) || Number(rawScore) === 25) {
          console.info('[darts] Bull-Audio-Diagnose', {
            notation: rawNotation,
            ring: rawRing,
            score: rawScore,
            selectedAudio: special,
            event: ev
          });
        }

        if (special) queueAudioFile(special);
        return;
      }

      // Normales Ende einer Aufnahme:
      // Rundensumme, danach Spielerwechsel.
      if (ev.type === 'turn_end') {
        // Ein turn_end kann nach einem State-/Event-Reset erneut im Snapshot
        // auftauchen. In diesem Fall die Spielerwechsel-Audio nicht doppelt
        // einreihen. Ein neuer Dart setzt die Sperre wieder zurück.
        let turnEndSignature;
        try {
          turnEndSignature = JSON.stringify(ev);
        } catch (_) {
          turnEndSignature = String(ev.type);
        }
        if (turnEndAudioHandled && turnEndSignature === lastTurnEndAudioSignature) {
          return;
        }
        turnEndAudioHandled = true;
        lastTurnEndAudioSignature = turnEndSignature;

        // Bei Bust keine Rundensumme ansagen, sondern busted.mp3.
        const busted = !!(
          ev.data &&
          String(ev.data.result || '').toLowerCase() === 'bust'
        );

        if (busted) {
          queueAudioFile('busted.mp3');
        } else {
          const roundFile =
            numericRoundAudio(
              ev.data &&
              ev.data.roundScore
            );

          if (roundFile) {
            queueAudioFile(roundFile);
          }
        }

        queueAudioFile('next-player.mp3');

        // Erst wenn auch next-player.mp3 vollständig abgespielt wurde,
        // wird der nächste Spieler in der Spiellogik aktiviert.
        if (canAdvanceTurn) {
          whenAudioQueueDrained(function () {
            postControl('next_turn', {}).catch(function (err) {
              console.error('[darts] Spielerwechsel fehlgeschlagen:', err);
            });
          });
        }

        return;
      }

      // Checkout:
      // Rundensumme, danach game-shot.
      // Kein next-player.
      if (ev.type === 'checkout') {
        const roundFile =
          numericRoundAudio(
            ev.data &&
            ev.data.roundScore
          );

        if (roundFile) {
          queueAudioFile(roundFile);
        }

        try {
          if (navigator.vibrate) {
            navigator.vibrate(
              [80, 50, 140]
            );
          }
        } catch (_) {}
      }
    });
  }

  const PHASE_LABEL = {
    warmup: 'Einschießen',
    arming: 'Bereit',
    playing: 'Spiel',
    finished: 'Beendet'
  };

  const SECTORS = [
    20, 1, 18, 4, 13,
    6, 10, 15, 2, 17,
    3, 19, 7, 16, 8,
    11, 14, 9, 12, 5
  ];

  function esc(s) {
    return String(
      s == null ? '' : s
    )
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function num(n, fallback) {
    const v = Number(n);

    return isFinite(v)
      ? v
      : (fallback || 0);
  }

  function postControl(
    action,
    params
  ) {
    const body = JSON.stringify({
      action: action,
      params: params || {}
    });

    const fn =
      (
        window.SRAuth &&
        window.SRAuth.fetchWithAuth
      ) ||
      fetch;

    return fn(
      '/api/plugins/control',
      {
        method: 'POST',

        headers: {
          'Content-Type':
            'application/json'
        },

        body: body
      }
    );
  }

  function polar(r, deg) {
    const a =
      (deg - 90) *
      Math.PI /
      180;

    return {
      x: r * Math.cos(a),
      y: r * Math.sin(a)
    };
  }

  function annularSectorPath(
    innerR,
    outerR,
    a0,
    a1
  ) {
    const o0 =
      polar(outerR, a0);

    const o1 =
      polar(outerR, a1);

    const i1 =
      polar(innerR, a1);

    const i0 =
      polar(innerR, a0);

    return (
      'M ' +
      o0.x.toFixed(3) +
      ' ' +
      o0.y.toFixed(3) +

      ' A ' +
      outerR +
      ' ' +
      outerR +
      ' 0 0 1 ' +
      o1.x.toFixed(3) +
      ' ' +
      o1.y.toFixed(3) +

      ' L ' +
      i1.x.toFixed(3) +
      ' ' +
      i1.y.toFixed(3) +

      ' A ' +
      innerR +
      ' ' +
      innerR +
      ' 0 0 0 ' +
      i0.x.toFixed(3) +
      ' ' +
      i0.y.toFixed(3) +

      ' Z'
    );
  }

  function dartPoint(d) {
    // DISAG/OpticScore X/Y sind in 1/100 mm.
    // Die Dartboard-SVG wird im ViewBox-Koordinatensystem
    // mit 1 SVG-Einheit pro mm dargestellt. Daher keine
    // zusätzliche Skalierung der Trefferkoordinaten.
    // SVG-Y zeigt nach unten, deshalb Y spiegeln.
    const boardScale = 340 / 451; // 0.75388
    return {
      x: (num(d.x) / 100) * boardScale,
      y: (-num(d.y) / 100) * boardScale
    };
  }

  function boardSvg(darts) {
    const parts = [];
    parts.push(
      '<svg class="dt-board-svg" ' +
      'viewBox="30 30 140 140" ' +
      'role="img" ' +
      'aria-label="Dartscheibe">'
    );

    // Statisches Dartboard aus dem Plugin-Asset.
    parts.push(
      '<image ' +
      'class="dt-board-image" ' +
      'href="/plugins/darts/assets/dartboard.svg" ' +
      'x="-70.75388" ' +
      'y="-70.75388" ' +
      'width="340" ' +
      'height="340" ' +
      'preserveAspectRatio="none" ' +
      '/>'
    );

    // Dynamische Treffer über dem statischen Dartboard.
    (darts || []).forEach(
      function (d, i) {
        const p = dartPoint(d);
    	const boardScale = 340 / 451;
	    const hitScale = 0.309050772626711 * boardScale;

        const label =
          d.notation ||
          (
            'Dart ' +
            (i + 1)
          );

        parts.push(
          '<g class="dt-hit" ' +
          'transform="translate(' +
          (100 + p.x).toFixed(2) +
          ' ' +
          (100 + p.y).toFixed(2) +
          ') scale(' + hitScale + ')">' +

          '<circle ' +
          'r="7.3" ' +
          'class="dt-hit-circle"/>' +

          '<text ' +
          'x="0" ' +
          'y=".5" ' +
          'class="dt-hit-number">' +

          esc(
            d.index ||
            i + 1
          ) +

          '</text>' +

          '<title>' +
          esc(label) +
          ' · ' +
          esc(d.score) +
          ' Punkte' +
          '</title>' +

          '</g>'
        );
      }
    );

    parts.push('</svg>');

    return parts.join('');
  }

  function orderControls(
    game,
    players
  ) {
    const mode =
      game.orderMode ||
      'range';

    const beginner =
      Number(
        game.beginnerRange ||
        1
      );

    // Freeze game setup while a match is in progress; allow edits again
    // after reset or when the game has ended.
    const settingsLocked =
      game.phase === 'playing';

    const ranges =
      (players || []).filter(
        function (p) {
          return p.active;
        }
      );

    return (
      '<div class="dt-controls" data-controls>' +

      '<label>Spielart ' +
      '<select data-game-mode' + (settingsLocked ? ' disabled' : '') + '>' +
      '<option value="x01"' + ((game.gameMode || 'x01') === 'x01' ? ' selected' : '') + '>301 / 501 / 701</option>' +
      '<option value="cricket"' + (game.gameMode === 'cricket' ? ' selected' : '') + '>Standard Cricket</option>' +
      '<option value="around_clock"' + (game.gameMode === 'around_clock' ? ' selected' : '') + '>Around the Clock</option>' +
      '</select>' +
      '</label>' +

      '<label class="dt-x01-setting" data-x01-setting>Start ' +

      '<select data-starting-score' +
      (settingsLocked ? ' disabled' : '') +
      '>' +

      [301, 501, 701]
        .map(function (n) {
          return (
            '<option value="' +
            n +
            '"' +

            (
              Number(
                game.startingScore ||
                501
              ) === n
                ? ' selected'
                : ''
            ) +

            '>' +
            n +
            '</option>'
          );
        })
        .join('') +

      '</select>' +

      '</label>' +

      '<label class="dt-x01-setting" data-x01-setting>' +

      '<input type="checkbox" ' +
      'data-double-in' +
      (settingsLocked ? ' disabled' : '') +

      (
        game.doubleIn
          ? ' checked'
          : ''
      ) +

      '> Double In' +

      '</label>' +

      '<label class="dt-x01-setting" data-x01-setting>' +

      '<input type="checkbox" ' +
      'data-double-out' +
      (settingsLocked ? ' disabled' : '') +

      (
        game.doubleOut
          ? ' checked'
          : ''
      ) +

      '> Double Out' +

      '</label>' +

      '<label>Spielerreihenfolge ' +

      '<select data-order-mode' +
      (settingsLocked ? ' disabled' : '') +
      '>' +

      '<option value="range"' +

      (
        mode === 'range'
          ? ' selected'
          : ''
      ) +

      '>Stand 1 → X</option>' +

      '<option value="beginner"' +

      (
        mode === 'beginner'
          ? ' selected'
          : ''
      ) +

      '>Beginner wählen</option>' +

      '</select>' +

      '</label>' +

      '<label data-beginner-wrap' +

      (
        mode === 'beginner'
          ? ''
          : ' hidden'
      ) +

      '>Anfänger-Stand ' +

      '<select data-beginner-range' +
      (settingsLocked ? ' disabled' : '') +
      '>' +

      ranges
        .map(function (p) {
          return (
            '<option value="' +
            p.rangeNum +
            '"' +

            (
              p.rangeNum === beginner
                ? ' selected'
                : ''
            ) +

            '>Stand ' +
            p.rangeNum +
            '</option>'
          );
        })
        .join('') +

      '</select>' +

      '</label>' +

      '<button type="button" data-start' +
      (
        game.phase === 'playing'
          ? ' disabled'
          : ''
      ) +
      '>Dart starten' +
      '</button>' +

      '<button type="button" ' +
      'class="secondary" data-reset>' +
      'Reset' +
      '</button>' +

      '</div>'
    );
  }

  function audioControlsHtml() {
    const percent =
      Math.round(
        audioVolume * 100
      );

    return (
      '<div class="dt-audio-controls" data-audio-controls>' +

      '<label class="dt-audio-toggle">' +

      '<input type="checkbox" ' +
      'data-audio-enabled' +

      (
        audioEnabled
          ? ' checked'
          : ''
      ) +

      '> Ansagen' +

      '</label>' +

      '<label class="dt-volume-label">' +

      '<span>Lautstärke</span>' +

      '<input type="range" ' +
      'min="0" max="100" step="5" ' +
      'value="' +
      percent +
      '" ' +
      'data-audio-volume>' +

      '<output data-audio-volume-value>' +
      percent +
      ' %</output>' +

      '</label>' +

      '</div>'
    );
  }

  function bindAudioControls(
    container
  ) {
    const controls =
      container.querySelector(
        '[data-audio-controls]'
      );

    if (!controls) {
      return;
    }

    const enabled =
      controls.querySelector(
        '[data-audio-enabled]'
      );

    const volume =
      controls.querySelector(
        '[data-audio-volume]'
      );

    const output =
      controls.querySelector(
        '[data-audio-volume-value]'
      );

    if (enabled) {
      enabled.onchange =
        function () {
          audioEnabled =
            !!enabled.checked;

          if (!audioEnabled) {
            clearAudioQueue();
          }

          saveAudioSettings();
        };
    }

    if (volume) {
      volume.oninput =
        function () {
          const value =
            Number(volume.value);

          audioVolume =
            Math.max(
              0,
              Math.min(
                1,
                value / 100
              )
            );

          if (output) {
            output.textContent =
              Math.round(
                audioVolume * 100
              ) +
              ' %';
          }

          saveAudioSettings();
        };
    }
  }

  function playersHtml(game, inactiveRanges) {
    const inactive = {};
    (Array.isArray(inactiveRanges) ? inactiveRanges : []).forEach(function (n) {
      inactive[Number(n)] = true;
    });

    const players =
      (game.players || []).filter(
        function (p) {
          return p.active && !inactive[Number(p.rangeNum)];
        }
      );

    if (!players.length) {
      return (
        '<div class="dt-help">' +
        'Keine aktiven Stände.' +
        '</div>'
      );
    }

    return players
      .map(function (p) {
        const active =
          p.activeTurn;

        const darts =
          (p.roundDarts || [])
            .map(function (d) {
              return (
                '<span class="dt-dart-chip' +

                (
                  d.doubleInBlocked
                    ? ' blocked'
                    : ''
                ) +

                '">' +

                esc(d.notation) +

                ' · ' +

                esc(d.score) +

                '</span>'
              );
            })
            .join('');

        const resultClass =
          p.lastResult === 'Bust'
            ? 'dt-bust'
            : '';

        return (
          '<div class="dt-player ' + (game.gameMode === 'cricket' ? 'dt-player-cricket ' : (game.gameMode === 'around_clock' ? 'dt-player-clock ' : '')) +

          (
            active
              ? 'active '
              : ''
          ) +

          (
            p.finished
              ? 'finished'
              : ''
          ) +

          '" data-range="' +

          p.rangeNum +

          '">' +

          '<span class="dt-swatch" ' +

          'style="background:' +

          esc(
            p.color ||
            '#888'
          ) +

          '"></span>' +

          '<div>' +

          '<div class="dt-who">' +

          esc(
            p.label ||
            (
              'Stand ' +
              p.rangeNum
            )
          ) +

          '</div>' +

          (game.gameMode !== 'cricket' ? '<div class="dt-darts">' +

          (
            darts ||
            '<span class="dt-dart-chip">—</span>'
          ) +

          (
            p.lastResult && p.lastResult !== 'Runde'
              ? '<span class="' + (resultClass ? resultClass : 'dt-result') + '">' +
                  esc(p.lastResult === 'Bust' ? 'Busted' : p.lastResult) +
                '</span>'
              : ''
          ) +

          '</div>' : '') +

          '</div>' +

          '<div class="dt-score">' +

          esc(game.gameMode === 'cricket' ? (p.cricketPoints || 0) : (game.gameMode === 'around_clock' ? ((p.clockTarget || 1) <= 20 ? 'Ziel ' + (p.clockTarget || 1) : ((p.clockTarget || 1) === 21 ? 'Bull' : 'Fertig')) : p.score)) +

          '</div>' +
          (game.gameMode === 'cricket' ? '<div class="dt-stat dt-open"><strong>' + esc(p.openDarts) + '</strong></div>' : '') +
          (game.gameMode === 'cricket' ? '<div class="dt-cricket-marks" aria-label="Cricket-Zieltreffer">' + ['20','19','18','17','16','15','B'].map(function(k){ var count = Math.max(0, Math.min(3, Number(p.cricketMarks && p.cricketMarks[k] || 0))); return '<div class="dt-cricket-target"><span class="dt-cricket-target-label">' + k + '</span><span class="dt-cricket-lights">' + [0,1,2].map(function(i){ return '<i class="dt-cricket-light' + (i < count ? ' lit' : '') + '" aria-label="' + (i < count ? 'getroffen' : 'offen') + '"></i>'; }).join('') + '</span></div>'; }).join('') + '</div>' : '') +

          (game.gameMode !== 'cricket' ? '<div class="dt-stat"><strong>' + esc(p.roundScore) + '</strong></div>' : '') +

          (game.gameMode !== 'cricket' ? '<div class="dt-stat dt-open"><strong>' + esc(p.openDarts) + '</strong></div>' : '') +

          (game.gameMode === 'cricket' ? '<div class="dt-stat ' +

          resultClass +

          '">' +

          esc(
            p.lastResult === 'Bust' ? 'Busted' : (p.lastResult || '')
          ) +

          '</div>' : '') +

          '</div>'
        );
      })
      .join('');
  }

  function render(
    container,
    viewModel
  ) {
    activateDartsAudio();
    container.classList.add(
      'darts-view'
    );

    const vm =
      viewModel || {};

    const game =
      vm.game || {};

    const isShooter =
      document.body.classList.contains(
        'shooter-display'
      ) ||
      (
        window.SRDisplay &&
        window.SRDisplay.display ===
          'shooter'
      );

    const isCompact =
      window.SRDisplay &&
      window.SRDisplay.display ===
        'compact';

    const canControl =
      !(
        window.SRMode &&
        window.SRMode.canControl ===
          false
      );

    if (
      !container.querySelector(
        '.dt-layout'
      )
    ) {
      container.innerHTML =
        '<div class="dt-layout">' +

        '<header class="dt-header" ' +
        'data-header></header>' +

        '<main class="dt-main">' +

        '<section class="dt-board-col">' +

        '<div class="dt-board-wrap" ' +
        'data-board></div>' +

        '</section>' +

        '<section class="dt-side">' +

        '<div class="dt-panel" ' +
        'data-gameinfo></div>' +

        '<div class="dt-panel" ' +
        'data-players></div>' +

        '<div class="dt-panel" ' +
        'data-history></div>' +

        '</section>' +

        '</main>' +

        '<footer class="dt-footer" ' +
        'data-footer></footer>' +

        '</div>';
    }


    // Responsive Layout mit stabilem Umschaltpunkt.
    // Die Entscheidung basiert auf der Breite des Plugin-Containers und der
    // verfügbaren Höhe des Hauptbereichs. Eine Hysterese verhindert Flackern
    // durch Rundungsdifferenzen und ResizeObserver-Rückkopplungen.
    const responsiveLayout = container.querySelector('.dt-layout');
    if (responsiveLayout && !responsiveLayout._dtFrameLayoutObserver &&
        typeof ResizeObserver !== 'undefined') {
      let stackedState = responsiveLayout.classList.contains('dt-stacked');
      let layoutFramePending = false;

      const updateFrameLayout = function () {
        if (layoutFramePending) return;
        layoutFramePending = true;
        requestAnimationFrame(function () {
          layoutFramePending = false;
          const main = responsiveLayout.querySelector('.dt-main');
          const boardFrame = responsiveLayout.querySelector('.dt-board-col');
          if (!main || !boardFrame) return;

          const layoutStyle = getComputedStyle(responsiveLayout);
          const cssMinWidth = parseFloat(layoutStyle.getPropertyValue('--dt-player-min-width'));
          const minPlayerWidth = Number.isFinite(cssMinWidth) && cssMinWidth > 0 ? cssMinWidth : 500;
          const mainStyle = getComputedStyle(main);
          const paddingX = (parseFloat(mainStyle.paddingLeft) || 0) +
            (parseFloat(mainStyle.paddingRight) || 0);
          const paddingY = (parseFloat(mainStyle.paddingTop) || 0) +
            (parseFloat(mainStyle.paddingBottom) || 0);
          const gap = parseFloat(mainStyle.columnGap) || 0;

          // Hauptbereich-Höhe ist die Soll-Kantenlänge der quadratischen
          // Board-Spalte; sie bleibt unabhängig vom aktiven Grid-Modus.
          const squareSize = Math.max(0, main.clientHeight - paddingY);
          const availableWidth = Math.max(0, main.clientWidth - paddingX);
          const requiredWidth = squareSize + minPlayerWidth + gap;
          const hysteresis = 16;

          // Beim Wechsel in die gestapelte Ansicht gilt die echte Grenze.
          // Zurück in die Zweispaltenansicht erst mit 16 px zusätzlichem Platz.
          const shouldStack = stackedState
            ? availableWidth < requiredWidth + hysteresis
            : availableWidth < requiredWidth;

          if (shouldStack !== stackedState) {
            stackedState = shouldStack;
            responsiveLayout.classList.toggle('dt-stacked', stackedState);
          }

          if (!stackedState) {
            const sideWidth = Math.max(minPlayerWidth, availableWidth - squareSize - gap);
            const nextColumns = 'minmax(0, ' + squareSize + 'px) minmax(' +
              minPlayerWidth + 'px, ' + sideWidth + 'px)';
            if (main.style.gridTemplateColumns !== nextColumns) {
              main.style.gridTemplateColumns = nextColumns;
            }
            if (main.style.gridTemplateRows) main.style.removeProperty('grid-template-rows');
            if (boardFrame.style.width !== squareSize + 'px') boardFrame.style.width = squareSize + 'px';
            if (boardFrame.style.height !== '100%') boardFrame.style.height = '100%';
          } else {
            if (main.style.gridTemplateColumns) main.style.removeProperty('grid-template-columns');
            if (main.style.gridTemplateRows) main.style.removeProperty('grid-template-rows');
            if (boardFrame.style.width) boardFrame.style.removeProperty('width');
            if (boardFrame.style.height) boardFrame.style.removeProperty('height');
          }
        });
      };

      responsiveLayout._dtFrameLayoutObserver = new ResizeObserver(updateFrameLayout);
      // Nur den stabilen äußeren Plugin-Container beobachten, nicht .dt-main:
      // dessen Abmessungen ändern sich durch die Umschaltung selbst.
      responsiveLayout._dtFrameLayoutObserver.observe(responsiveLayout);
      updateFrameLayout();

      // Spielerdaten dynamisch skalieren. Nur den stabilen Seitencontainer
      // beobachten: Die Liste selbst ändert ihre Geometrie durch die Skalierung
      // und darf daher keinen ResizeObserver-Rückkopplungseffekt auslösen.
      const side = responsiveLayout.querySelector('.dt-side');
      if (side && !side._dtPlayerFitObserver) {
        const fitPlayerData = function () {
          const playerPanel = side.querySelector('[data-players]');
          const list = playerPanel && playerPanel.querySelector('.dt-players');
          if (!playerPanel || !list) return;
          const rows = Array.from(list.querySelectorAll('.dt-player'));
          if (!rows.length) return;

          // clientHeight der Liste ist bereits die nach Header, Spielsteuerung
          // und Verlauf verbleibende Höhe. Deshalb nichts davon erneut abziehen.
          const listHeight = list.clientHeight;
          const style = getComputedStyle(list);
          const gap = parseFloat(style.rowGap || style.gap) || 0;
          const available = Math.max(0, listHeight - gap * Math.max(0, rows.length - 1));
          const perRow = available / rows.length;
          const cricket = rows.some(row => row.classList.contains('dt-player-cricket'));
          const baseHeight = cricket ? 82 : 72;
          const scale = Math.max(0.3, Math.min(1.5, perRow / baseHeight));
          const nextScale = scale.toFixed(3);
          if (side.style.getPropertyValue('--dt-player-scale') !== nextScale) {
            side.style.setProperty('--dt-player-scale', nextScale);
          }
          side.style.setProperty('--dt-player-row-height', baseHeight + 'px');
        };
        side._dtFitPlayerData = fitPlayerData;
        if (typeof ResizeObserver === 'function') {
          side._dtPlayerFitObserver = new ResizeObserver(function () {
            if (side._dtFitPlayerDataFrame) cancelAnimationFrame(side._dtFitPlayerDataFrame);
            side._dtFitPlayerDataFrame = requestAnimationFrame(function () {
              side._dtFitPlayerDataFrame = 0;
              fitPlayerData();
            });
          });
          side._dtPlayerFitObserver.observe(side);
        }
        // Initialer Lauf und Größenänderungen der äußeren Seite.
        requestAnimationFrame(fitPlayerData);
      }

    }

    const active =
      Number(
        game.activeRange ||
        0
      );

    const focus =
      isShooter
        ? Number(
            vm.rangeNum ||
            0
          )
        : active;

    const boardRange =
      Number(
        game.boardRange ||
        active
      );

    const darts =
      game.boardDarts ||
      [];

    const header =
      container.querySelector(
        '[data-header]'
      );

    header.innerHTML =
      '<span class="dt-title">' +

      (
        game.phase === 'playing' || game.phase === 'finished'
          ? (game.gameMode === 'cricket' ? 'Dart Cricket' : (game.gameMode === 'around_clock' ? 'Around the Clock' : 'Dart ' + esc(game.startingScore || 501)))
          : (game.gameMode === 'cricket' ? 'Dart Cricket' : (game.gameMode === 'around_clock' ? 'Around the Clock' : 'Dart'))
      ) +

      '</span>' +

      '<span class="dt-badge">' +

      esc(
        PHASE_LABEL[
          game.phase
        ] ||
        game.phase ||
        ''
      ) +

      '</span>' +

      (game.gameMode === 'cricket' ? '<span>Standard Cricket</span>' : (game.gameMode === 'around_clock' ? '<span>1–20 + Bull</span>' :
        (game.doubleIn && game.doubleOut
          ? '<span>Double-In / Double-Out</span>'
          : game.doubleIn
            ? '<span>Double-In</span>'
            : game.doubleOut
              ? '<span>Double-Out</span>'
              : ''))) +

      (
        focus
          ? (
            '<span>Stand ' +
            esc(focus) +
            '</span>'
          )
          : ''
      ) +

      '<span class="dt-status">' +

      esc(
        (game.gameMode !== 'cricket' && String(game.statusLine || '').indexOf('Ansagen werden abgespielt') !== -1)
          ? ''
          : (game.statusLine || '')
      ) +

      '</span>';

    const board =
      container.querySelector(
        '[data-board]'
      );

    board.innerHTML =
      boardSvg(darts);

    const info =
      container.querySelector(
        '[data-gameinfo]'
      );

    // In der Gesamtansicht /all wird der Bereich „Aktuelle Runde“ ausgeblendet.
    // Andere Ansichten behalten die bisherige Anzeige.
    info.style.display = (window.SRDisplay && window.SRDisplay.noMenu) ? 'none' : '';

    if (
      isShooter ||
      isCompact ||
      !canControl ||
      (window.SRDisplay && window.SRDisplay.noMenu)
    ) {
      info.innerHTML =
        '<h3>Aktuelle Runde</h3>' +

        '<div class="dt-help">' +

        'Stand ' +

        esc(
          focus ||
          active ||
          '—'
        ) +

        ' · ' +

        esc(
          game.statusLine ||
          ''
        ) +

        '</div>';
    } else {
      info.innerHTML =
        '<h3>Spielsteuerung</h3>' +

        orderControls(
          game,
          game.players || []
        ) +

        audioControlsHtml() +

        '<div class="dt-help">' +

        'Die Auswahl des Beginners gilt ' +
        'beim nächsten Start. ' +
        'Die Reihenfolge läuft danach ' +
        'reihum weiter.' +

        '</div>';
    }

    bindAudioControls(
      container
    );

    const players =
      container.querySelector(
        '[data-players]'
      );

    // Die Spieler-Kopfzeile muss bei jedem Rendern zum aktuellen Spielmodus passen.
    // Neben dem internen Modus 'x01' werden auch direkte Variantenbezeichnungen akzeptiert.
    const isX01 = game.gameMode !== 'cricket' && game.gameMode !== 'around_clock' && /^(x01|301|501|701)?$/i.test(String(game.gameMode || 'x01'));

    players.innerHTML =
      (isX01
        ? '<div class="dt-player-head" aria-hidden="true"><span class="dt-player-head-title">Spieler</span><span>Gesamt</span><span>Aktuell</span><span>Offen</span></div>'
        : (game.gameMode === 'cricket' ? '<div class="dt-player-head dt-player-head-cricket" aria-hidden="true"><span class="dt-player-head-title">Spieler</span><span>Punkte</span><span>Offen</span></div>' : (game.gameMode === 'around_clock' ? '<div class="dt-player-head" aria-hidden="true"><span class="dt-player-head-title">Spieler</span><span>Nächstes Ziel</span></div>' : '<h3>Spieler</h3>'))) +
      '<div class="dt-players">' +
      playersHtml(game, vm.inactiveRanges) +
      '</div>';

    const playerFitSide = container.querySelector('.dt-side');
    if (playerFitSide && playerFitSide._dtFitPlayerData) {
      requestAnimationFrame(playerFitSide._dtFitPlayerData);
    }

    const recent =
      (
        game.recentDarts ||
        []
      )
        .slice(-9)
        .reverse();

    container
      .querySelector(
        '[data-history]'
      )
      .innerHTML =

        '<h3>Letzte Darts</h3>' +

        (
          recent.length
            ? (
              '<div class="dt-darts">' +

              recent
                .map(
                  function (d) {
                    return (
                      '<span class="dt-dart-chip">' +

                      esc(
                        d.notation
                      ) +

                      ' · ' +

                      esc(
                        Number(d.score) || Number(d.value) || 0
                      ) +

                      '</span>'
                    );
                  }
                )
                .join('') +

              '</div>'
            )
            : (
              '<div class="dt-help">' +
              'Noch keine Darts.' +
              '</div>'
            )
        );

    container
      .querySelector(
        '[data-footer]'
      )
      .innerHTML =

        'Nur DiscTypeRaw = fun_dart wird verarbeitet · Distance in 1/100 mm · Trefferposition aus X/Y';

    // Live-Breiten in der Fußzeile aktualisieren.
    const metricsEl = container.querySelector('.dt-layout-metrics');
    const metricsLayout = container.querySelector('.dt-layout');
    if (metricsEl && metricsLayout && !metricsLayout._dtLayoutMetricsObserver &&
        typeof ResizeObserver !== 'undefined') {
      const updateLayoutMetrics = function () {
        const board = metricsLayout.querySelector('.dt-board-wrap');
        const players = metricsLayout.querySelector('.dt-side, .dt-players, [data-players]');
        metricsEl.textContent =
          'Plugin: ' + Math.round(metricsLayout.getBoundingClientRect().width) + ' px · ' +
          'Dartscheibe: ' + Math.round(board ? board.getBoundingClientRect().width : 0) + ' px · ' +
          'Spielerdaten: ' + Math.round(players ? players.getBoundingClientRect().width : 0) + ' px';
      };
      metricsLayout._dtLayoutMetricsObserver = new ResizeObserver(updateLayoutMetrics);
      metricsLayout._dtLayoutMetricsObserver.observe(metricsLayout);
      const board = metricsLayout.querySelector('.dt-board-wrap');
      const players = metricsLayout.querySelector('.dt-side, .dt-players, [data-players]');
      if (board) metricsLayout._dtLayoutMetricsObserver.observe(board);
      if (players) metricsLayout._dtLayoutMetricsObserver.observe(players);
      updateLayoutMetrics();
    }


    const controls =
      container.querySelector(
        '[data-controls]'
      );

    if (
      controls &&
      canControl &&
      !isCompact &&
      !isShooter
    ) {
      const gameModeSelect = controls.querySelector('[data-game-mode]');
      function updateCricketSettingsVisibility() {
        // Startscore, Double In und Double Out gelten nur für X01.
        // Bei Cricket und Around the Clock werden diese Felder ausgeblendet.
        const mode = gameModeSelect && gameModeSelect.value;
        const hideX01Settings = mode !== 'x01' && mode !== '301' && mode !== '501' && mode !== '701';
        controls.querySelectorAll('[data-x01-setting]').forEach(function (el) {
          el.hidden = !!hideX01Settings;
        });
      }
      if (gameModeSelect) {
        gameModeSelect.onchange = function () {
          updateCricketSettingsVisibility();

          // Spieleranzeige sofort beim Ändern der Spielart aktualisieren,
          // nicht erst nach dem Klick auf „Dart starten“.
          const selectedMode = gameModeSelect.value || 'x01';
          // Persist the selection immediately so the next view-model refresh
          // cannot restore the previous game mode.
          postControl('set_game_mode', { gameMode: selectedMode }).catch(function (err) {
            console.error('Spielart konnte nicht gespeichert werden:', err);
          });
          const selectedGame = Object.assign({}, game, { gameMode: selectedMode });
          const playerList = container.querySelector('[data-players]');
          if (playerList) {
            const isX01Mode = /^(x01|301|501|701)$/i.test(String(selectedMode));
            playerList.innerHTML =
              (isX01Mode
                ? '<div class="dt-player-head" aria-hidden="true"><span class="dt-player-head-title">Spieler</span><span>Gesamt</span><span>Aktuell</span><span>Offen</span></div>'
                : (game.gameMode === 'cricket' ? '<div class="dt-player-head dt-player-head-cricket" aria-hidden="true"><span class="dt-player-head-title">Spieler</span><span>Punkte</span><span>Offen</span></div>' : (game.gameMode === 'around_clock' ? '<div class="dt-player-head" aria-hidden="true"><span class="dt-player-head-title">Spieler</span><span>Nächstes Ziel</span></div>' : '<h3>Spieler</h3>'))) +
              '<div class="dt-players">' +
              playersHtml(selectedGame, vm.inactiveRanges) +
              '</div>';
            if (playerList && playerList.closest('.dt-side') && playerList.closest('.dt-side')._dtFitPlayerData) {
              requestAnimationFrame(playerList.closest('.dt-side')._dtFitPlayerData);
            }
          }
        };
      }
      updateCricketSettingsVisibility();

      const mode =
        controls.querySelector(
          '[data-order-mode]'
        );

      const wrap =
        controls.querySelector(
          '[data-beginner-wrap]'
        );

      if (mode) {
        mode.onchange =
          function () {
            if (wrap) {
              wrap.hidden =
                mode.value !==
                'beginner';
            }
          };
      }

      const start =
        controls.querySelector(
          '[data-start]'
        );

      if (start) {
        start.onclick =
          async function () {
            unlockAudio();

            const orderMode =
              mode
                ? mode.value
                : 'range';

            const sel =
              controls.querySelector(
                '[data-beginner-range]'
              );

            const beginnerRange =
              sel
                ? Number(
                    sel.value
                  )
                : 1;

            const gameModeEl =
              controls.querySelector('[data-game-mode]');
            const gameMode = gameModeEl ? gameModeEl.value : 'x01';

            const scoreSel =
              controls.querySelector(
                '[data-starting-score]'
              );

            const doubleInEl =
              controls.querySelector(
                '[data-double-in]'
              );

            const doubleOutEl =
              controls.querySelector(
                '[data-double-out]'
              );

            const doubleIn =
              !!(
                doubleInEl &&
                doubleInEl.checked
              );

            const doubleOut =
              !!(
                doubleOutEl &&
                doubleOutEl.checked
              );

            start.disabled = true;

            let res;
            try {
              res =
                await postControl(
                  'start',
                  {
                    gameMode: gameMode,
                    startingScore:
                      scoreSel
                        ? Number(
                            scoreSel.value
                          )
                        : 501,

                    doubleIn:
                      doubleIn,

                    doubleOut:
                      doubleOut,

                    orderMode:
                      orderMode,

                    beginnerRange:
                      beginnerRange
                  }
                );

              if (!res.ok) {
                alert(
                  await res.text()
                );
              }
            } finally {
              // Keep the start button locked after a successful start.
              // A failed request leaves it available for retry.
              if (!res || !res.ok) {
                start.disabled = false;
              }
            }
          };
      }

      const reset =
        controls.querySelector(
          '[data-reset]'
        );

      if (reset) {
        reset.onclick =
          async function () {
            const res =
              await postControl(
                'reset',
                {}
              );

            if (!res.ok) {
              alert(
                await res.text()
              );
            }
          };
      }
    }

    // Audio-Ereignisse verarbeiten.
    handleDartAudioEvents(
      vm.events || [],
      canControl,
      game.gameMode || 'x01'
    );

    // Erst die Rundensumme aus dem Checkout-Ereignis einreihen,
    // danach die Audiohinweise für das Spielende.
    if (game.phase && game.phase !== lastGamePhase) {
      if (game.phase === 'playing') {
        queueAudioFile('gameon.mp3');
      } else if (game.phase === 'finished') {
        queueAudioFile('game-shot.mp3');
        queueAudioFile('winner.mp3');
      }
      lastGamePhase = game.phase;
    }

    if (
      container.id ===
      'shared-master-host'
    ) {
      container._sharedReady =
        true;
    }
  }

  // Dart-View registrieren.
  //
  // Diese Schreibweise NICHT auf mehrere Zeilen aufteilen.
  // Der Fullplay-Test sucht exakt nach:
  // SRPluginViews[PLUGIN_ID]
  window.SRPluginViews[PLUGIN_ID] = render;
  window.SRPlugins[PLUGIN_ID] = { render: render, deactivate: deactivateDartsAudio };
})();



