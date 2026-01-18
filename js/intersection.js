// intersection.js
// 4-kraka raskrsnica: 1 ulazna + 1 izlazna traka po kraku.
// Semafori: AUTO ciklus + MANUAL (klik ili dugmad).
// FIX:
//  - Left turn yields ONLY if opposing straight is actually close (gap acceptance)
//  - Straight has priority over left (when conflict exists)
//  - Less over-blocking: manual conflict rules instead of auto geometry conflicts
//  - Still uses short "reservation" so two conflicting flows don't overlap in center

import { Road, spawnVehicle, defaultIdmParams, accACC } from './models.js';
import { initSeededRngFromUrl, rng01 } from './utils/rng.js';

function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
function safeText(id, txt) { const el = document.getElementById(id); if (el) el.textContent = txt; }
function showBlock(id, show) { const el = document.getElementById(id); if (el) el.style.display = show ? '' : 'none'; }

function myTanh(x) {
  if (x > 50) return 1;
  if (x < -50) return -1;
  const e2x = Math.exp(2 * x);
  return (e2x - 1) / (e2x + 1);
}

function localIdmParamsForVeh(base, veh) {
  return { ...base, v0: base.v0 * (veh?.v0Mult ?? 1.0) };
}

// geometry helpers
function rotCW(v) { return { x: v.y, y: -v.x }; }
function add(a, b) { return { x: a.x + b.x, y: a.y + b.y }; }
function sub(a, b) { return { x: a.x - b.x, y: a.y - b.y }; }
function mul(a, k) { return { x: a.x * k, y: a.y * k }; }

function cubicBezier(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const tt = t * t;
  const uu = u * u;
  const uuu = uu * u;
  const ttt = tt * t;
  return {
    x: uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
    y: uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y,
  };
}

function sampleCubic(p0, p1, p2, p3, steps) {
  const pts = [];
  for (let i = 0; i <= steps; i++) pts.push(cubicBezier(p0, p1, p2, p3, i / steps));
  return pts;
}

function buildArcLengthMap(worldPts) {
  const sCum = [0];
  for (let i = 1; i < worldPts.length; i++) {
    const dx = worldPts[i].x - worldPts[i - 1].x;
    const dy = worldPts[i].y - worldPts[i - 1].y;
    sCum[i] = sCum[i - 1] + Math.hypot(dx, dy);
  }
  const total = sCum[sCum.length - 1];

  function posAtS(s) {
    const ss = clamp(s, 0, total);
    let lo = 0, hi = sCum.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (sCum[mid] < ss) lo = mid;
      else hi = mid;
    }
    const s0 = sCum[lo], s1 = sCum[hi];
    const t = (s1 <= s0) ? 0 : (ss - s0) / (s1 - s0);
    const p0 = worldPts[lo], p1 = worldPts[hi];
    return { x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t };
  }

  return { total, posAtS };
}

function strokePolyline(ctx, pts, style, width, dashed = false, alpha = 1) {
  if (pts.length < 2) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = style;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (dashed) ctx.setLineDash([24, 18]);
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
  if (dashed) ctx.setLineDash([]);
  ctx.restore();
}

// same-lane hard clamp to prevent overlaps
function enforceNoOverlapOnRoad(road, minGap = 0.20) {
  const lane = road.lanes[0];
  if (lane.length <= 1) return;
  lane.sort((a, b) => a.s - b.s);
  for (let i = lane.length - 2; i >= 0; i--) {
    const follower = lane[i];
    const leader = lane[i + 1];
    const maxS = leader.s - leader.length - minGap;
    if (follower.s > maxS) {
      follower.s = maxS;
      follower.v = Math.min(follower.v, leader.v);
    }
  }
}

export function runIntersection(canvasOverride) {
  const canvas = canvasOverride || document.getElementById('simCanvas');
  if (!canvas) throw new Error('Missing #simCanvas');
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;

  const h1 = document.querySelector('h1');
  safeText('scenarioValue', 'Raskrsnica');

  showBlock('ringCtrl', false);
  showBlock('treiberCtrl', false);
  showBlock('intersectionCtrl', true);
  showBlock('mainInflowCtrl', false);
  showBlock('rampInflowCtrl', false);

  // RNG
  const rngCtl = initSeededRngFromUrl({ defaultSeed: 12345 });

  // IDM base 
  const idm = { ...defaultIdmParams };
  idm.a = Math.max(idm.a, 1.6);
  idm.b = Math.max(idm.b, 2.2);
  idm.T = Math.min(idm.T, 1.10);

  const net = {
    time: 0,
    hetero: {
      truckFraction: 0.08,
      carLength: 4.5,
      truckLength: 7.5,
      v0Spread: 0.12,
      truckV0Mult: 0.80,
    }
  };

  const idCounter = { nextId: 1 };

  // -----------------------------
  // JSON logger
  // -----------------------------
  let logData = null;
  let lastSampleT = -1e9;
  const LOG_EVERY_SEC = 0.5; // sampling period

  let exitedAgg = null;

  function startLog() {
    lastSampleT = -1e9;
    exitedAgg = { n: 0, sumTravel: 0, sumWait: 0, byTo: { N: 0, E: 0, S: 0, W: 0 } };

    logData = {
      meta: {
        scenario: 'intersection',
        createdAt: new Date().toISOString(),
        seed: rngCtl?.seedValue ?? null,
        idm: { ...idm },
        cycle: { ...cycle },

        // existing
        inflowPerHour,
        shareNS,

        // NEW (optional)
        usePerDirInflow,
        inflowByDir: { ...inflowByDir },

        // NEW turning ratios
        turnPct: {
          right: Math.round(turnRightP * 100),
          straight: Math.round(turnStraightP * 100),
          left: Math.round(turnLeftP * 100),
        },

        stopOffsetM,
        stopAdvanceM,
      },
      samples: [],
      events: []
    };
  }

  function clearLog() { startLog(); }

  function downloadLog() {
    if (!logData) startLog();
    // store latest UI params
    logData.meta.inflowPerHour = inflowPerHour;
    logData.meta.shareNS = shareNS;
    logData.meta.usePerDirInflow = usePerDirInflow;
    logData.meta.inflowByDir = { ...inflowByDir };
    logData.meta.turnPct = {
      right: Math.round(turnRightP * 100),
      straight: Math.round(turnStraightP * 100),
      left: Math.round(turnLeftP * 100),
    };
    logData.meta.cycle = { ...cycle };
    logData.meta.idm = { ...idm };

    const payload = JSON.stringify(logData, null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    const t = Math.round(net.time);
    const seed = (rngCtl?.seedValue ?? 'na');
    a.href = url;
    a.download = `intersection_seed-${seed}_t-${t}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();

    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function computeApproachQueue(dirKey) {
    const A = inRoads[dirKey];
    if (!A) return { n: 0, lenM: 0, meanWait: 0, maxWait: 0 };

    const stopS = A.road.length - stopOffsetM - stopAdvanceM;
    const lane = A.road.lanes[0] || [];
    const LOOKBACK = 120;   // meters upstream of stopline considered as "approach queue"
    const V_STOP = 0.5;     // m/s threshold for "waiting"

    const q = lane.filter(v => (stopS - v.s) >= -5 && (stopS - v.s) <= LOOKBACK && (v.v ?? 0) <= V_STOP);
    if (q.length === 0) return { n: 0, lenM: 0, meanWait: 0, maxWait: 0 };

    let minS = q[0].s;
    let sumW = 0;
    let maxW = 0;
    for (const v of q) {
      if (v.s < minS) minS = v.s;
      const w = v.waitT ?? 0;
      sumW += w;
      if (w > maxW) maxW = w;
    }

    return {
      n: q.length,
      lenM: Math.max(0, stopS - minS),
      meanWait: sumW / q.length,
      maxWait: maxW
    };
  }

  function logTick() {
    if (!logData) startLog();

    if (net.time - lastSampleT < LOG_EVERY_SEC) return;
    lastSampleT = net.time;

    const qN = computeApproachQueue('N');
    const qE = computeApproachQueue('E');
    const qS = computeApproachQueue('S');
    const qW = computeApproachQueue('W');

    const exited = exitedAgg || { n: 0, sumTravel: 0, sumWait: 0, byTo: { N: 0, E: 0, S: 0, W: 0 } };
    const meanTravel = exited.n ? exited.sumTravel / exited.n : 0;
    const meanWait = exited.n ? exited.sumWait / exited.n : 0;

    logData.samples.push({
      t: Number(net.time.toFixed(3)),
      phase,
      tlMode,

      // existing
      inflowPerHour,
      shareNS,

      // NEW
      usePerDirInflow,
      inflowByDir: { ...inflowByDir },
      turnPct: {
        right: Math.round(turnRightP * 100),
        straight: Math.round(turnStraightP * 100),
        left: Math.round(turnLeftP * 100),
      },

      queues: { N: qN, E: qE, S: qS, W: qW },
      exited: {
        n: exited.n,
        meanTravel,
        meanWait,
        byTo: { ...exited.byTo }
      }
    });

    const logInfo = document.getElementById('logInfo');
    if (logInfo) logInfo.textContent = `log: ${logData.samples.length} samples`;

    // reset between-sample aggregates
    exitedAgg = { n: 0, sumTravel: 0, sumWait: 0, byTo: { N: 0, E: 0, S: 0, W: 0 } };
  }

  const downloadLogBtn = document.getElementById('downloadLogBtn');
  if (downloadLogBtn) downloadLogBtn.onclick = downloadLog;

  const clearLogBtn = document.getElementById('clearLogBtn');
  if (clearLogBtn) clearLogBtn.onclick = clearLog;

  // UI
  let inflowPerHour = 2400;
  let shareNS = 0.50;

  // NEW: per-direction inflow (optional mode)
  let usePerDirInflow = false;
  let inflowByDir = { N: 600, E: 600, S: 600, W: 600 };

  // NEW: turning ratios (global)
  let turnRightP = 0.18;
  let turnStraightP = 0.60;
  let turnLeftP = 1 - turnRightP - turnStraightP;

  const inflowSlider = document.getElementById('interInflowSlider');
  const inflowValue = document.getElementById('interInflowValue');
  const shareSlider = document.getElementById('interShareSlider');
  const shareValue = document.getElementById('interShareValue');

  // NEW: per-dir controls
  const perDirToggle = document.getElementById('interPerDirToggle');
  const perDirBlock = document.getElementById('interPerDirBlock');

  const inflowNSlider = document.getElementById('interInflowNSlider');
  const inflowESlider = document.getElementById('interInflowESlider');
  const inflowSSlider = document.getElementById('interInflowSSlider');
  const inflowWSlider = document.getElementById('interInflowWSlider');

  const inflowNValue = document.getElementById('interInflowNValue');
  const inflowEValue = document.getElementById('interInflowEValue');
  const inflowSValue = document.getElementById('interInflowSValue');
  const inflowWValue = document.getElementById('interInflowWValue');

  // NEW: turn sliders
  const turnRightSlider = document.getElementById('interTurnRightSlider');
  const turnStraightSlider = document.getElementById('interTurnStraightSlider');
  const turnRightValue = document.getElementById('interTurnRightValue');
  const turnStraightValue = document.getElementById('interTurnStraightValue');
  const turnLeftValue = document.getElementById('interTurnLeftValue');

  function updatePerDirUI() {
    if (perDirBlock) perDirBlock.style.display = usePerDirInflow ? '' : 'none';

    // disable simple controls when per-dir ON (minimal + avoids confusion)
    if (inflowSlider) inflowSlider.disabled = usePerDirInflow;
    if (shareSlider) shareSlider.disabled = usePerDirInflow;
  }

  function updateInflowDirValues() {
    if (inflowNValue) inflowNValue.textContent = `${Math.round(inflowByDir.N)} veh/h`;
    if (inflowEValue) inflowEValue.textContent = `${Math.round(inflowByDir.E)} veh/h`;
    if (inflowSValue) inflowSValue.textContent = `${Math.round(inflowByDir.S)} veh/h`;
    if (inflowWValue) inflowWValue.textContent = `${Math.round(inflowByDir.W)} veh/h`;
  }

  function updateTurnUI() {
    // normalize/clamp so that Right+Straight <= 0.98 (avoid negative left)
    let r = clamp(turnRightP, 0, 0.98);
    let s = clamp(turnStraightP, 0, 0.98);
    if (r + s > 0.98) {
      const k = 0.98 / (r + s);
      r *= k; s *= k;
    }
    turnRightP = r;
    turnStraightP = s;
    turnLeftP = Math.max(0, 1 - r - s);

    if (turnRightValue) turnRightValue.textContent = `${Math.round(turnRightP * 100)}%`;
    if (turnStraightValue) turnStraightValue.textContent = `${Math.round(turnStraightP * 100)}%`;
    if (turnLeftValue) turnLeftValue.textContent = `${Math.round(turnLeftP * 100)}%`;
  }

  if (inflowSlider) {
    inflowPerHour = Number(inflowSlider.value || 2400);
    inflowSlider.oninput = () => {
      inflowPerHour = Number(inflowSlider.value || 0);
      if (inflowValue) inflowValue.textContent = `${inflowPerHour} veh/h`;
    };
    if (inflowValue) inflowValue.textContent = `${inflowPerHour} veh/h`;
  }

  if (shareSlider) {
    shareNS = Number(shareSlider.value || 50) / 100;
    shareSlider.oninput = () => {
      shareNS = Number(shareSlider.value || 0) / 100;
      if (shareValue) shareValue.textContent = `${Math.round(shareNS * 100)}%`;
    };
    if (shareValue) shareValue.textContent = `${Math.round(shareNS * 100)}%`;
  }

  if (perDirToggle) {
    perDirToggle.onchange = () => {
      usePerDirInflow = !!perDirToggle.checked;
      updatePerDirUI();
    };
  }

  // init per-dir from sliders if present
  if (inflowNSlider) inflowByDir.N = Number(inflowNSlider.value || inflowByDir.N);
  if (inflowESlider) inflowByDir.E = Number(inflowESlider.value || inflowByDir.E);
  if (inflowSSlider) inflowByDir.S = Number(inflowSSlider.value || inflowByDir.S);
  if (inflowWSlider) inflowByDir.W = Number(inflowWSlider.value || inflowByDir.W);

  if (inflowNSlider) inflowNSlider.oninput = () => { inflowByDir.N = Number(inflowNSlider.value || 0); updateInflowDirValues(); };
  if (inflowESlider) inflowESlider.oninput = () => { inflowByDir.E = Number(inflowESlider.value || 0); updateInflowDirValues(); };
  if (inflowSSlider) inflowSSlider.oninput = () => { inflowByDir.S = Number(inflowSSlider.value || 0); updateInflowDirValues(); };
  if (inflowWSlider) inflowWSlider.oninput = () => { inflowByDir.W = Number(inflowWSlider.value || 0); updateInflowDirValues(); };

  updateInflowDirValues();
  updatePerDirUI();

  // turning sliders init
  if (turnRightSlider) turnRightP = Number(turnRightSlider.value || 18) / 100;
  if (turnStraightSlider) turnStraightP = Number(turnStraightSlider.value || 60) / 100;

  if (turnRightSlider) {
    turnRightSlider.oninput = () => {
      turnRightP = Number(turnRightSlider.value || 0) / 100;
      updateTurnUI();
    };
  }
  if (turnStraightSlider) {
    turnStraightSlider.oninput = () => {
      turnStraightP = Number(turnStraightSlider.value || 0) / 100;
      updateTurnUI();
    };
  }
  updateTurnUI();

  // Semafori
  const cycle = { green: 28.0, yellow: 3.0, redYellow: 1.5, allRed: 1.0 };
  let tlMode = 'auto';
  let phase = 'NS_GREEN';
  let phaseT = cycle.green;

  const tlModeValue = document.getElementById('tlModeValue');
  const tlPhaseValue = document.getElementById('tlPhaseValue');
  const tlTimerValue = document.getElementById('tlTimerValue');

  function phaseLabel() {
    if (phase === 'NS_GREEN') return 'NS green';
    if (phase === 'NS_YELLOW') return 'NS yellow';
    if (phase === 'EW_GREEN') return 'EW green';
    if (phase === 'EW_YELLOW') return 'EW yellow';
    if (phase === 'NS_REDYELLOW') return 'NS red/yellow';
    if (phase === 'EW_REDYELLOW') return 'EW red/yellow';
    return 'ALL red';
  }

  function updateTlUI() {
    if (tlModeValue) tlModeValue.textContent = tlMode.toUpperCase();
    if (tlPhaseValue) tlPhaseValue.textContent = phaseLabel();
  }

  function setManual(dir) {
    tlMode = 'manual';
    phase = (dir === 'NS') ? 'NS_GREEN' : 'EW_GREEN';
    phaseT = 1e9;
    updateTlUI();
  }

  function setAuto() {
    tlMode = 'auto';
    phase = 'NS_GREEN';
    phaseT = cycle.green;
    updateTlUI();
  }

  const tlAutoBtn = document.getElementById('tlAutoBtn');
  const tlNSBtn = document.getElementById('tlNSBtn');
  const tlEWBtn = document.getElementById('tlEWBtn');
  if (tlAutoBtn) tlAutoBtn.onclick = () => setAuto();
  if (tlNSBtn) tlNSBtn.onclick = () => setManual('NS');
  if (tlEWBtn) tlEWBtn.onclick = () => setManual('EW');
  updateTlUI();

  function isGreenForApproach(dir) {
    // Yellow is treated as "go" (same behavior as green) for vehicles.
    // Red is only during ALL_RED phases.
    if (phase.startsWith('ALL')) return false;
    if (dir === 'N' || dir === 'S') return (phase === 'NS_GREEN' || phase === 'NS_YELLOW' || phase === 'NS_REDYELLOW');
    return (phase === 'EW_GREEN' || phase === 'EW_YELLOW' || phase === 'EW_REDYELLOW');
  }

  // IDM sliders
  function readIdmSliders() {
    const v0Slider = document.getElementById('v0Slider');
    const TSlider = document.getElementById('TSlider');
    const aSlider = document.getElementById('aSlider');
    const bSlider = document.getElementById('bSlider');
    const s0Slider = document.getElementById('s0Slider');

    if (v0Slider) idm.v0 = Number(v0Slider.value) / 3.6;
    if (TSlider) idm.T = Number(TSlider.value);
    if (aSlider) idm.a = Number(aSlider.value);
    if (bSlider) idm.b = Number(bSlider.value);
    if (s0Slider) idm.s0 = Number(s0Slider.value);

    idm.a = Math.max(idm.a, 0.9);

    safeText('v0Value', `${Math.round(idm.v0 * 3.6)} km/h`);
    safeText('TValue', `${idm.T.toFixed(1)} s`);
    safeText('aValue', `${idm.a.toFixed(1)}`);
    safeText('bValue', `${idm.b.toFixed(1)}`);
    safeText('s0Value', `${idm.s0.toFixed(1)} m`);
  }

  // World
  const laneWidthM = 6.0;
  const sepM = laneWidthM * 1.35;

  const halfM = 18.0;
  const armLenM = 140.0;
  const stopOffsetM = 7.0;
  // Visual/behavioral tweak: stop a bit BEFORE the line so cars don't creep into the intersection on red.
  const stopAdvanceM = 2.0;

  const outerExtentM = halfM + armLenM + 20;
  const pxPerM_fit = (Math.min(W, H) * 0.5 - 40) / outerExtentM;
  const pxPerM = Math.min(4.8, pxPerM_fit);
  const cx = W * 0.5;
  const cy = H * 0.55;
  function w2c(xm, ym) { return { x: cx + xm * pxPerM, y: cy - ym * pxPerM }; }

  const dirs = {
    N: { u: { x: 0, y: 1 } },
    E: { u: { x: 1, y: 0 } },
    S: { u: { x: 0, y: -1 } },
    W: { u: { x: -1, y: 0 } },
  };

  function opposite(d) { return (d === 'N') ? 'S' : (d === 'S') ? 'N' : (d === 'E') ? 'W' : 'E'; }
  function rightTurn(d) { return (d === 'N') ? 'W' : (d === 'W') ? 'S' : (d === 'S') ? 'E' : 'N'; }
  function leftTurn(d)  { return (d === 'N') ? 'E' : (d === 'E') ? 'S' : (d === 'S') ? 'W' : 'N'; }

  const inRoads = {};
  const outRoads = {};

  function buildApproach(dirKey) {
    const u = dirs[dirKey].u;
    const travelIn = mul(u, -1);
    const rightIn = rotCW(travelIn);

    const inOff = mul(rightIn, sepM * 0.5);
    const outOff = mul(inOff, -1);

    const pInFar  = add(mul(u, halfM + armLenM), inOff);
    const pInNear = add(mul(u, halfM), inOff);

    const pOutNear = add(mul(u, halfM), outOff);
    const pOutFar  = add(mul(u, halfM + armLenM), outOff);

    const inRoad = new Road({ id: `in_${dirKey}`, length: armLenM, laneCount: 1, isRing: false });
    const outRoad = new Road({ id: `out_${dirKey}`, length: armLenM, laneCount: 1, isRing: false });

    inRoads[dirKey] = { road: inRoad, dir: dirKey, u, travelIn, rightIn, pFar: pInFar, pNear: pInNear };
    outRoads[dirKey] = { road: outRoad, dir: dirKey, u, pNear: pOutNear, pFar: pOutFar };
  }
  for (const k of Object.keys(dirs)) buildApproach(k);

  // Connectors
  const connectors = new Map(); // "N->E" -> { road, arc, worldPts, from, to, key, type }

  function moveType(from, to) {
    if (to === opposite(from)) return 'S';
    if (to === rightTurn(from)) return 'R';
    return 'L';
  }

  function makeConnector(from, to) {
    const key = `${from}->${to}`;
    const A = inRoads[from];
    const B = outRoads[to];

    const p0 = A.pNear;
    const p3 = B.pNear;

    const c = halfM * 0.85;
    let p1 = add(p0, mul(A.travelIn, c));
    let p2 = sub(p3, mul(B.u, c));

    // Make opposite straights "parallel-ish" so they don't visually overlap
    const type = moveType(from, to);
    if (type === 'S') {
      const shift = laneWidthM * 0.75;
      const shiftVec = mul(A.rightIn, shift);
      p1 = add(p1, shiftVec);
      p2 = add(p2, shiftVec);
    } else if (type === 'L') {
      const shift = laneWidthM * 0.18;
      const shiftVec = mul(A.rightIn, shift);
      p1 = add(p1, shiftVec);
      p2 = add(p2, shiftVec);
    } else {
      const shift = laneWidthM * 0.12;
      const shiftVec = mul(A.rightIn, shift);
      p1 = add(p1, shiftVec);
      p2 = add(p2, shiftVec);
    }

    const worldPts = sampleCubic(p0, p1, p2, p3, 50);
    const arc = buildArcLengthMap(worldPts);
    const road = new Road({ id: `conn_${from}_${to}`, length: arc.total, laneCount: 1, isRing: false });

    connectors.set(key, { road, arc, worldPts, from, to, key, type });
  }

  for (const from of ['N', 'E', 'S', 'W']) {
    makeConnector(from, opposite(from));
    makeConnector(from, rightTurn(from));
    makeConnector(from, leftTurn(from));
  }

  // Road->world mapping
  const roadMap = new Map();
  for (const k of ['N','E','S','W']) {
    const A = inRoads[k];
    roadMap.set(A.road.id, (s) => {
      const t = clamp(s / A.road.length, 0, 1);
      return { x: A.pFar.x + (A.pNear.x - A.pFar.x) * t, y: A.pFar.y + (A.pNear.y - A.pFar.y) * t };
    });
    const B = outRoads[k];
    roadMap.set(B.road.id, (s) => {
      const t = clamp(s / B.road.length, 0, 1);
      return { x: B.pNear.x + (B.pFar.x - B.pNear.x) * t, y: B.pNear.y + (B.pFar.y - B.pNear.y) * t };
    });
  }
  for (const C of connectors.values()) roadMap.set(C.road.id, (s) => C.arc.posAtS(s));

  // ---------------------------
  // Conflict rules (MANUAL, not auto)
  // ---------------------------
  const conflicts = new Map(); // key -> [conflicting keys]
  for (const key of connectors.keys()) conflicts.set(key, []);

  function addConflict(a, b) {
    if (!conflicts.has(a) || !conflicts.has(b)) return;
    if (!conflicts.get(a).includes(b)) conflicts.get(a).push(b);
    if (!conflicts.get(b).includes(a)) conflicts.get(b).push(a);
  }

  function key(from, to) { return `${from}->${to}`; }

  function buildPhaseConflicts(a, b) {
    const aS = key(a, opposite(a));
    const bS = key(b, opposite(b));
    const aL = key(a, leftTurn(a));
    const bL = key(b, leftTurn(b));
    const aR = key(a, rightTurn(a));
    const bR = key(b, rightTurn(b));

    addConflict(aL, bS);
    addConflict(bL, aS);
    addConflict(aL, bL);

    addConflict(aL, bR);
    addConflict(bL, aR);
  }

  buildPhaseConflicts('N', 'S');
  buildPhaseConflicts('E', 'W');

  // Reservation / right-of-way gating
  const conflictUntil = new Map(); // movementKey -> until time for CONFLICTS
  const nextSelfAt = new Map();    // movementKey -> earliest time next vehicle may enter (headway)

  function cleanupLocks(t) {
    for (const [k, until] of conflictUntil.entries()) {
      if (until <= t) conflictUntil.delete(k);
    }
    for (const [k, t0] of nextSelfAt.entries()) {
      if (t0 <= t - 10) nextSelfAt.delete(k);
    }
  }

  function canEnterMovement(key, t) {
    if (!key || !connectors.has(key)) return false;

    const selfAt = nextSelfAt.get(key) || 0;
    if (t < selfAt) return false;

    for (const other of (conflicts.get(key) || [])) {
      const until = conflictUntil.get(other) || 0;
      if (until > t) return false;
    }
    return true;
  }

  function reserveMovement(key, veh, t) {
    const C = connectors.get(key);
    if (!C) return;

    const type = C.type; // 'S' | 'L' | 'R'
    const headway =
      (type === 'R') ? 0.80 :
      (type === 'S') ? 0.95 :
                      1.25; // left

    const conflictDur =
      (type === 'R') ? 0.95 :
      (type === 'S') ? 1.15 :
                      1.85; // left

    nextSelfAt.set(key, t + headway);
    conflictUntil.set(key, t + conflictDur);
  }

  // Gap acceptance: LEFT yields only if opposing straight is close
  function opposingStraightIsClose(fromDir) {
    const opp = opposite(fromDir);
    if (!isGreenForApproach(opp)) return false;

    const lane = inRoads[opp].road.lanes[0];
    if (!lane || lane.length === 0) return false;

    let leader = lane[0];
    for (const v of lane) if (v.s > leader.s) leader = v;

    const oppStraightKey = key(opp, opposite(opp));
    const oppRightKey    = key(opp, rightTurn(opp));

    const isOppStraight = (leader.nextConnKey === oppStraightKey);
    const isOppRight    = (leader.nextConnKey === oppRightKey);
    if (!isOppStraight && !isOppRight) return false;

    const stopS = inRoads[opp].road.length - stopOffsetM - stopAdvanceM;
    const d = stopS - leader.s;
    const speed = Math.max(leader.v, 0.1);
    const tArr = d / speed;

    const D_CRIT = isOppRight ? 12.0 : 18.0;
    const T_CRIT = isOppRight ? 1.2  : 1.7;

    if (d < 0) return true;
    if (d <= D_CRIT) return true;
    if (tArr <= T_CRIT) return true;
    return false;
  }

  function isLeftKey(k) {
    const C = connectors.get(k);
    return C?.type === 'L';
  }

  function shouldLeftYieldNow(leftKey) {
    const C = connectors.get(leftKey);
    if (!C || C.type !== 'L') return false;

    const from = C.from;
    const opp = opposite(from);
    if (!isGreenForApproach(from) || !isGreenForApproach(opp)) return false;

    return opposingStraightIsClose(from);
  }

  // Lights objects (clickable)
  const lights = [
    { approach: 'N', group: 'NS', posPx: { x: 0, y: 0 }, rPx: 10 },
    { approach: 'S', group: 'NS', posPx: { x: 0, y: 0 }, rPx: 10 },
    { approach: 'E', group: 'EW', posPx: { x: 0, y: 0 }, rPx: 10 },
    { approach: 'W', group: 'EW', posPx: { x: 0, y: 0 }, rPx: 10 },
  ];

  function updateLightPositionsPx() {
    for (const L of lights) {
      const A = inRoads[L.approach];
      const stopS = A.road.length - stopOffsetM - stopAdvanceM;
      const pStop = roadMap.get(A.road.id)(stopS);
      const side = rotCW(A.travelIn);
      const pSide = w2c(pStop.x + side.x * 2.5, pStop.y + side.y * 2.5);
      L.posPx = { x: pSide.x, y: pSide.y };
      L.rPx = 9;
    }
  }

  canvas.addEventListener('click', (ev) => {
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;

    for (const L of lights) {
      const dx = x - L.posPx.x;
      const dy = y - L.posPx.y;
      if (dx * dx + dy * dy <= (L.rPx + 6) * (L.rPx + 6)) {
        if (L.group === 'NS') setManual('NS');
        else setManual('EW');
        return;
      }
    }
  });

  // Pause/Reset
  let running = true;
  const pauseBtn = document.getElementById('pauseBtn');
  const resetBtn = document.getElementById('resetBtn');
  const simStatus = document.getElementById('simStatus');

  if (pauseBtn) pauseBtn.onclick = () => {
    running = !running;
    if (simStatus) simStatus.textContent = running ? 'RUN' : 'PAUSE';
    pauseBtn.textContent = running ? 'Pause' : 'Resume';
  };

  function randomBrakePulse() {
    const all = [];
    for (const k of ['N','E','S','W']) {
      all.push(...inRoads[k].road.lanes[0]);
      all.push(...outRoads[k].road.lanes[0]);
    }
    for (const C of connectors.values()) all.push(...C.road.lanes[0]);
    if (all.length === 0) return;

    const veh = all[Math.floor(rng01() * all.length)];
    const decel = 3.0 + 2.0 * rng01();
    veh.extraBrake = -decel;
    veh.brakeUntil = net.time + 1.1;
  }

  const interBrakePulseBtn = document.getElementById('interBrakePulseBtn');
  if (interBrakePulseBtn) interBrakePulseBtn.onclick = randomBrakePulse;

  // Reset
  let inflowAcc = { N:0, E:0, S:0, W:0 };

  function resetSim() {
    rngCtl.resetRng();
    net.time = 0;
    idCounter.nextId = 1;

    for (const k of ['N','E','S','W']) {
      inRoads[k].road.lanes[0].length = 0;
      outRoads[k].road.lanes[0].length = 0;
    }
    for (const C of connectors.values()) C.road.lanes[0].length = 0;

    inflowAcc = { N:0, E:0, S:0, W:0 };
    conflictUntil.clear();
    nextSelfAt.clear();

    startLog();
    setAuto();
  }
  if (resetBtn) resetBtn.onclick = resetSim;

  // Spawning + routing
  function pickTurn(fromDir) {
    const r = rng01();

    // NEW: driven by sliders (global ratios)
    if (r < turnRightP) return { to: rightTurn(fromDir) };
    if (r < (turnRightP + turnStraightP)) return { to: opposite(fromDir) };
    return { to: leftTurn(fromDir) };
  }

  function canSpawnSimple(road, sSpawn, newLen, minGap) {
    const lane = road.lanes[0];
    if (lane.length === 0) return true;
    lane.sort((a, b) => a.s - b.s);
    const leader = lane.find(v => v.s >= sSpawn) || null;
    if (!leader) return true;
    return (leader.s - sSpawn) >= (newLen + minGap);
  }

  function spawnApproach(dirKey, dt) {
    let ratePerSec = 0;

    // NEW: per-direction mode overrides total/share
    if (usePerDirInflow) {
      const v = inflowByDir[dirKey] ?? 0;
      ratePerSec = Math.max(0, v) / 3600;
    } else {
      const totalRatePerSec = inflowPerHour / 3600;
      if (totalRatePerSec <= 0) return;

      const rateNS = totalRatePerSec * shareNS;
      const rateEW = totalRatePerSec * (1 - shareNS);

      if (dirKey === 'N' || dirKey === 'S') ratePerSec = rateNS / 2;
      else ratePerSec = rateEW / 2;
    }

    if (ratePerSec <= 0) return;

    inflowAcc[dirKey] += ratePerSec * dt;

    const road = inRoads[dirKey].road;
    const sSpawn = 6;

    while (inflowAcc[dirKey] >= 1.0) {
      const vInit = idm.v0 * (0.90 + 0.25 * rng01());
      const newLen = net.hetero.truckLength;
      if (!canSpawnSimple(road, sSpawn, newLen, 6)) break;

      const veh = spawnVehicle(net, road, {
        id: idCounter.nextId++,
        lane: 0,
        s: sSpawn,
        v: vInit
      });

      const { to } = pickTurn(dirKey);
      veh.nextConnKey = `${dirKey}->${to}`;

      // stats / logging
      veh.spawnT = net.time;
      veh.waitT = 0;
      veh.fromDir = dirKey;
      veh.toDir = to;
      veh.exitT = null;

      inflowAcc[dirKey] -= 1.0;
    }
  }

  // Dynamics
  function calcAccForRoad(road, options = {}) {
    const lane = road.lanes[0];
    if (lane.length === 0) return;

    lane.sort((a, b) => a.s - b.s);

    for (let i = 0; i < lane.length; i++) {
      const veh = lane[i];
      const lead = (i + 1 < lane.length) ? lane[i + 1] : null;

      let sGap = 1e9, vLead = veh.v, aLead = 0;

      if (lead) {
        sGap = (lead.s - veh.s) - lead.length;
        vLead = lead.v;
        aLead = lead.acc ?? 0;
      }

      if (options.stopS != null && options.blockedFn) {
        const sStop = options.stopS;
        if (options.blockedFn(veh)) {
          const gapStop = (sStop - veh.s) - veh.length;
          if (gapStop >= 0 && gapStop < sGap) {
            sGap = gapStop;
            vLead = 0;
            aLead = 0;
          }
        }
      }

      const p = localIdmParamsForVeh(idm, veh);
      let acc = accACC(Math.max(0.01, sGap), veh.v, vLead, aLead, p);

      if (net.time < (veh.brakeUntil ?? -1e9)) acc += (veh.extraBrake ?? 0);
      veh.acc = acc;
    }
  }

  function integrateRoad(road, dt) {
    const lane = road.lanes[0];
    for (const veh of lane) {
      veh.v = Math.max(0, veh.v + veh.acc * dt);
      veh.s = veh.s + veh.v * dt;
    }
  }

  function updateWaitTimes(dt) {
    const V_STOP = 0.5; // m/s
    const roads = [];
    for (const k of ['N','E','S','W']) roads.push(inRoads[k].road, outRoads[k].road);
    for (const C of connectors.values()) roads.push(C.road);

    for (const R of roads) {
      const lane = R.lanes[0] || [];
      for (const veh of lane) {
        if ((veh.v ?? 0) <= V_STOP) veh.waitT = (veh.waitT ?? 0) + dt;
      }
    }
  }

  function tryTransfer(veh, fromRoad, toRoad, sInto = 0, minGap = 4) {
    const laneT = toRoad.lanes[0];
    laneT.sort((a, b) => a.s - b.s);

    const leader = laneT.find(v => v.s >= sInto) || null;
    if (leader && (leader.s - sInto) < (veh.length + minGap)) {
      veh.s = Math.min(veh.s, fromRoad.length - 1e-3);
      veh.v = 0;
      return false;
    }

    const src = fromRoad.lanes[0];
    const idx = src.indexOf(veh);
    if (idx >= 0) src.splice(idx, 1);

    veh.roadId = toRoad.id;
    veh.s = sInto;
    veh.acc = 0;
    toRoad.lanes[0].push(veh);
    return true;
  }

  // STEP
  function step(dt) {
    net.time += dt;

    // TL AUTO
    if (tlMode === 'auto') {
      phaseT -= dt;
      if (phaseT <= 0) {
        if (phase === 'NS_GREEN') { phase = 'NS_YELLOW'; phaseT = cycle.yellow; }
        else if (phase === 'NS_YELLOW') { phase = 'ALL_RED_1'; phaseT = cycle.allRed; }
        else if (phase === 'ALL_RED_1') { phase = 'EW_REDYELLOW'; phaseT = cycle.redYellow; }
        else if (phase === 'EW_REDYELLOW') { phase = 'EW_GREEN'; phaseT = cycle.green; }
        else if (phase === 'EW_GREEN') { phase = 'EW_YELLOW'; phaseT = cycle.yellow; }
        else if (phase === 'EW_YELLOW') { phase = 'ALL_RED_2'; phaseT = cycle.allRed; }
        else if (phase === 'ALL_RED_2') { phase = 'NS_REDYELLOW'; phaseT = cycle.redYellow; }
        else { phase = 'NS_GREEN'; phaseT = cycle.green; }
        updateTlUI();
      }
    }

    cleanupLocks(net.time);

    // Spawn
    spawnApproach('N', dt);
    spawnApproach('E', dt);
    spawnApproach('S', dt);
    spawnApproach('W', dt);

    // Incoming: block ONLY close to stopline (no early braking)
    for (const k of ['N','E','S','W']) {
      const A = inRoads[k];
      const stopS = A.road.length - stopOffsetM - stopAdvanceM;

      const blockedFn = (veh) => {
        const bEff = Math.max(1.5, idm.b);
        const dNeed = Math.max(18, veh.v * 1.2 + (veh.v * veh.v) / (2 * bEff));
        if (veh.s < stopS - dNeed) return false;

        if (!isGreenForApproach(k)) return true;

        const mKey = veh.nextConnKey;
        if (!mKey || !connectors.has(mKey)) return true;

        if (isLeftKey(mKey) && shouldLeftYieldNow(mKey)) return true;

        return !canEnterMovement(mKey, net.time);
      };

      calcAccForRoad(A.road, { stopS, blockedFn });
    }

    // Connectors + outgoing
    for (const C of connectors.values()) calcAccForRoad(C.road, {});
    for (const k of ['N','E','S','W']) calcAccForRoad(outRoads[k].road, {});

    // Integrate
    for (const k of ['N','E','S','W']) integrateRoad(inRoads[k].road, dt);

    // Prevent "creeping" into intersection on red due to timestep discretization.
    for (const k of ['N','E','S','W']) {
      if (isGreenForApproach(k)) continue;
      const A = inRoads[k];
      const stopS = A.road.length - stopOffsetM - stopAdvanceM;
      const lane = A.road.lanes[0];
      for (const veh of lane) {
        if (veh.s > stopS - 0.1 && veh.s < stopS + 1.0) {
          veh.s = stopS - veh.length - 0.1;
          veh.v = 0;
          veh.acc = 0;
        }
      }
    }

    for (const C of connectors.values()) integrateRoad(C.road, dt);
    for (const k of ['N','E','S','W']) integrateRoad(outRoads[k].road, dt);

    // No-overlap
    for (const k of ['N','E','S','W']) enforceNoOverlapOnRoad(inRoads[k].road);
    for (const C of connectors.values()) enforceNoOverlapOnRoad(C.road);
    for (const k of ['N','E','S','W']) enforceNoOverlapOnRoad(outRoads[k].road);

    updateWaitTimes(dt);

    // Transfer: incoming -> connector
    for (const k of ['N','E','S','W']) {
      const A = inRoads[k].road;
      const lane = A.lanes[0];

      for (let i = lane.length - 1; i >= 0; i--) {
        const veh = lane[i];
        if (veh.s >= A.length - 1e-6) {
          const mKey = veh.nextConnKey;

          if (!isGreenForApproach(k) || !mKey || !connectors.has(mKey)) {
            veh.s = A.length - 0.01;
            veh.v = 0;
            veh.acc = 0;
            continue;
          }

          if (isLeftKey(mKey) && shouldLeftYieldNow(mKey)) {
            veh.s = A.length - 0.01;
            veh.v = 0;
            veh.acc = 0;
            continue;
          }

          if (canEnterMovement(mKey, net.time)) {
            reserveMovement(mKey, veh, net.time);
            tryTransfer(veh, A, connectors.get(mKey).road, 0, 3.5);
          } else {
            veh.s = A.length - 0.01;
            veh.v = 0;
            veh.acc = 0;
          }
        }
      }
    }

    // Transfer: connector -> outgoing
    for (const C of connectors.values()) {
      const lane = C.road.lanes[0];
      for (let i = lane.length - 1; i >= 0; i--) {
        const veh = lane[i];
        if (veh.s >= C.road.length - 1e-6) {
          tryTransfer(veh, C.road, outRoads[C.to].road, 0, 4);
        }
      }
    }

    // Despawn + log exit events
    for (const k of ['N','E','S','W']) {
      const R = outRoads[k].road;
      const lane = R.lanes[0] || [];
      for (const veh of lane) {
        if (veh.exitT == null && veh.s >= R.length) {
          veh.exitT = net.time;

          const travelT = (veh.spawnT != null) ? (veh.exitT - veh.spawnT) : null;
          const waitT = veh.waitT ?? null;

          if (exitedAgg) {
            exitedAgg.n += 1;
            if (travelT != null) exitedAgg.sumTravel += travelT;
            if (waitT != null) exitedAgg.sumWait += waitT;
            if (veh.toDir && exitedAgg.byTo[veh.toDir] != null) exitedAgg.byTo[veh.toDir] += 1;
          }

          if (logData && veh.id != null) {
            logData.events.push({
              type: 'exit',
              t: Number(net.time.toFixed(3)),
              id: veh.id,
              from: veh.fromDir ?? null,
              to: veh.toDir ?? null,
              travelT,
              waitT
            });
          }
        }
      }
    }

    const buffer = 80;
    for (const k of ['N','E','S','W']) {
      const R = outRoads[k].road;
      R.lanes[0] = R.lanes[0].filter(v => v.s <= R.length + buffer);
    }
  }

  // Drawing
  function speedColor(ratio) {
    if (ratio < 0.35) return '#d32f2f';
    if (ratio < 0.65) return '#fbc02d';
    return '#2e7d32';
  }

  function drawVehicleDot(px, py, veh) {
    const r = 4;
    const v0loc = (idm.v0 * (veh.v0Mult ?? 1.0)) || 1e-6;
    const ratio = veh.v / v0loc;

    ctx.beginPath();
    ctx.arc(px, py, r, 0, 2 * Math.PI);
    ctx.fillStyle = speedColor(ratio);
    ctx.fill();

    ctx.lineWidth = 1;
    ctx.strokeStyle = '#000';
    ctx.stroke();

    if ((veh.acc ?? 0) < -1.0) {
      ctx.beginPath();
      ctx.arc(px, py, r + 2, 0, 2 * Math.PI);
      ctx.strokeStyle = 'rgba(255,0,0,0.55)';
      ctx.lineWidth = 3;
      ctx.stroke();
    }
  }

  function drawBackground() {
    ctx.fillStyle = '#4b7a33';
    ctx.fillRect(0, 0, W, H);

    const laneWidthPx = laneWidthM * (Math.min(4.8, (Math.min(W, H) * 0.5 - 40) / outerExtentM));
    const edgeWidthPx = 4;

    function toCanvasPts(worldPts) { return worldPts.map(p => w2c(p.x, p.y)); }

    // arms
    for (const k of ['N','E','S','W']) {
      const A = inRoads[k];
      const B = outRoads[k];

      const ptsIn = toCanvasPts([A.pFar, A.pNear]);
      const ptsOut = toCanvasPts([B.pNear, B.pFar]);

      strokePolyline(ctx, ptsIn,  '#ffffff', laneWidthPx + 2 * edgeWidthPx);
      strokePolyline(ctx, ptsIn,  '#555555', laneWidthPx);

      strokePolyline(ctx, ptsOut, '#ffffff', laneWidthPx + 2 * edgeWidthPx);
      strokePolyline(ctx, ptsOut, '#555555', laneWidthPx);
    }

    // connectors
    for (const C of connectors.values()) {
      const pts = toCanvasPts(C.worldPts);
      strokePolyline(ctx, pts, '#ffffff', laneWidthPx + 2 * edgeWidthPx, false, 1);
      strokePolyline(ctx, pts, '#555555', laneWidthPx, false, 1);
    }

    // stop lines + lights
    updateLightPositionsPx();

    ctx.save();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 4;
    for (const k of ['N','E','S','W']) {
      const A = inRoads[k];
      const stopS = A.road.length - stopOffsetM - stopAdvanceM;
      const pStop = roadMap.get(A.road.id)(stopS);
      const side = rotCW(A.travelIn);
      const a = w2c(pStop.x - side.x * 3.2, pStop.y - side.y * 3.2);
      const b = w2c(pStop.x + side.x * 3.2, pStop.y + side.y * 3.2);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();

    for (const L of lights) {
      let color = '#d50000';
      if (!phase.startsWith('ALL')) {
        if (L.group === 'NS' && (phase === 'NS_GREEN' || phase === 'NS_YELLOW' || phase === 'NS_REDYELLOW')) {
          color = (phase === 'NS_GREEN') ? '#00c853' : '#ffeb3b';
        } else if (L.group === 'EW' && (phase === 'EW_GREEN' || phase === 'EW_YELLOW' || phase === 'EW_REDYELLOW')) {
          color = (phase === 'EW_GREEN') ? '#00c853' : '#ffeb3b';
        }
      }

      ctx.beginPath();
      ctx.arc(L.posPx.x, L.posPx.y, L.rPx, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#000';
      ctx.stroke();
    }
  }

  function drawVehicles() {
    const allRoads = [];
    for (const k of ['N','E','S','W']) { allRoads.push(inRoads[k].road, outRoads[k].road); }
    for (const C of connectors.values()) allRoads.push(C.road);

    for (const R of allRoads) {
      const mapFn = roadMap.get(R.id);
      if (!mapFn) continue;
      for (const veh of R.lanes[0]) {
        const pW = mapFn(veh.s);
        const pC = w2c(pW.x, pW.y);
        drawVehicleDot(pC.x, pC.y, veh);
      }
    }
  }

  // Loop
  resetSim();

  let lastTs = null;
  function loop(ts) {
    if (lastTs == null) lastTs = ts;

    readIdmSliders();

    const dtRaw = (ts - lastTs) / 1000;
    const dt = clamp(dtRaw, 0, 0.05);
    lastTs = ts;

    if (running) step(dt);
    if (running) logTick();

    if (tlTimerValue) tlTimerValue.textContent = `t=${net.time.toFixed(1)}`;

    drawBackground();
    drawVehicles();

    requestAnimationFrame(loop);
  }

  requestAnimationFrame(loop);
}
