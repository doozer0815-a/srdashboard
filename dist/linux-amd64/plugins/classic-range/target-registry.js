/**
 * Hardcoded target geometry profiles. This is the canonical copy.
 * Scoring values come from OpticScore; profiles control face SVG and zoom/scale only.
 *
 * Plugins ship as self-contained zips, so plugins/autorennen/target-registry.js is
 * a verbatim copy. Keep the two identical or the same shot plots differently on
 * master and tablet.
 */
(function () {
  const DSG_COORD_RANGE = 9000;

  const PROFILES = {
    air_rifle_10m: {
      id: 'air_rifle_10m',
      label: '10 m Luftgewehr (ISSF)',
      file: '10_m_Air_Rifle_target.svg',
      targetDiameterMm: 45.5,
      tenRingDiameterMm: 0.5,
      innerTenDiameterMm: 0.5,
      ringWidthMm: 2.5,
      oneRingSvg: 2.5,
      ring8RadiusMm: 5.25,
      shotDiameterMm: 4.5,
      decMax: 10.9,
      /**
       * Scoring-verified: teilerBandDsg 25 / 0.25 mm (ISSF 2.5 mm ring / 10) = 100 DSG/mm.
       * ±9000 → ±90 mm (outer frame size is not the scale source).
       */
      coordRadiusMm: 90,
      teilerBandDsg: 25,
      last10Max: 10.9
    },
    air_pistol_10m: {
      id: 'air_pistol_10m',
      label: '10 m Luftpistole (ISSF)',
      file: '10_m_Air_Pistol_target.svg',
      targetDiameterMm: 155.5,
      tenRingDiameterMm: 11.5,
      innerTenDiameterMm: 5.0,
      ringWidthMm: 8.0,
      oneRingSvg: 8.0,
      ring8RadiusMm: 21.75,
      shotDiameterMm: 4.5,
      decMax: 10.9,
      /**
       * Same OpticScore scale as LG/KK: 100 DSG/mm (±9000 → ±90 mm).
       * Face is ~KK-sized; ring geometry differs, unit scale does not.
       */
      coordRadiusMm: 90,
      teilerBandDsg: 80,
      last10Max: 10.9
    },
    smallbore_50m_prone: {
      id: 'smallbore_50m_prone',
      label: '50 m KK liegend',
      file: '50_m_Smallbore_target.svg',
      targetDiameterMm: 154.4,
      tenRingDiameterMm: 10.4,
      innerTenDiameterMm: 5.0,
      ringWidthMm: 8.0,
      oneRingSvg: 8.0,
      ring8RadiusMm: 21.2, // ISSF 8-ring Ø 42.4 mm
      shotDiameterMm: 5.6,
      decMax: 10.9,
      /**
       * KK OpticScore Teiler/X/Y use ~100 DSG per mm (log-verified vs ISSF rings + DecValue).
       * ±9000 → ±90 mm (same DSG/mm as LG; ring geometry differs).
       */
      coordRadiusMm: 90,
      /** ~8 mm ring / 10 decimal steps × 100 DSG/mm. */
      teilerBandDsg: 80,
      last10Max: 10.9,
      /** Tighter auto-zoom than LG; still shows all shots, floor = ring 8. */
      autoZoomPadFrac: 0.012
    },
    smallbore_50m_3p: {
      id: 'smallbore_50m_3p',
      label: '50 m KK 3-Stellung',
      file: '50_m_Smallbore_target.svg',
      targetDiameterMm: 154.4,
      tenRingDiameterMm: 10.4,
      innerTenDiameterMm: 5.0,
      ringWidthMm: 8.0,
      oneRingSvg: 8.0,
      ring8RadiusMm: 21.2,
      shotDiameterMm: 5.6,
      decMax: 10.9,
      coordRadiusMm: 90,
      teilerBandDsg: 80,
      last10Max: 10.9,
      autoZoomPadFrac: 0.012
    },
    dartboard: {
      id: 'dartboard',
      label: 'Dartboard',
      file: 'dartboard.svg',
      targetDiameterMm: 140,
      tenRingDiameterMm: 0,
      innerTenDiameterMm: 0,
      ringWidthMm: 0,
      oneRingSvg: 0,
      ring8RadiusMm: 0,
      shotDiameterMm: 4.5,
      decMax: 60,
      coordRadiusMm: 90,
      teilerBandDsg: 100,
      last10Max: 60
    }
  };

  const DEFAULT_PROFILE_ID = 'air_rifle_10m';

  function getProfile(profileId) {
    return PROFILES[profileId] || PROFILES[DEFAULT_PROFILE_ID];
  }

  function profileIds() {
    return Object.keys(PROFILES);
  }

  function buildScale(profile) {
    const p = profile || PROFILES[DEFAULT_PROFILE_ID];
    const coordRadiusMm = p.coordRadiusMm != null ? p.coordRadiusMm : 90;
    const dsgPerMm = DSG_COORD_RANGE / coordRadiusMm;
    const DEFAULT_SVG_CENTER = 100;
    const DEFAULT_SVG_VIEW_SIZE = 200;
    // 1 SVG unit = 1 mm in the DISAG frame.
    const shotRadiusSvg = (p.shotDiameterMm != null ? p.shotDiameterMm : 4.5) / 2;
    return {
      profileId: p.id,
      file: p.file,
      label: p.label,
      dsgPerSvgUnit: dsgPerMm,
      coordRadiusMm: coordRadiusMm,
      coordRadiusNeedsRefinement: !!p.coordRadiusNeedsRefinement,
      svgSize: DEFAULT_SVG_VIEW_SIZE,
      centerX: DEFAULT_SVG_CENTER,
      centerY: DEFAULT_SVG_CENTER,
      targetDiameterMm: p.targetDiameterMm,
      tenRingDiameterMm: p.tenRingDiameterMm,
      innerTenDiameterMm: p.innerTenDiameterMm,
      ringWidthMm: p.ringWidthMm,
      oneRingSvg: p.oneRingSvg,
      ring8RadiusMm: p.ring8RadiusMm,
      shotDiameterMm: p.shotDiameterMm,
      shotRadiusSvg: shotRadiusSvg,
      decMax: p.decMax != null ? p.decMax : 10.9,
      teilerBandDsg: p.teilerBandDsg,
      last10Max: p.last10Max != null ? p.last10Max : (p.decMax != null ? p.decMax : 10.9),
      autoZoomPadFrac: p.autoZoomPadFrac
    };
  }

  window.SRTargetRegistry = {
    profiles: PROFILES,
    defaultProfileId: DEFAULT_PROFILE_ID,
    ownerPluginId: 'classic-range',
    getProfile: getProfile,
    profileIds: profileIds,
    buildScale: buildScale
  };
})();
