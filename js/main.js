// main.js
import {
  createNetwork,
  stepNetwork,
  getAllVehicles,
  trySpawnMain,
  trySpawnRamp,
  defaultIdmParams,
  defaultMobilParams,
} from './models.js';

import { initSeededRngFromUrl, rng01 } from './utils/rng.js';

// ---------------------------
// Scenario router (?scenario=main | ring | roundabout | intersection)
// Default: main (U-raskrsnica)
// ---------------------------
const __SCENARIO__ = new URLSearchParams(window.location.search).get('scenario') || 'main';

function setCtrlVisible(id, visible) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display = visible ? '' : 'none';
}

// sakrij/prikaži kontrole po scenariju
setCtrlVisible('ringCtrl', __SCENARIO__ === 'ring');          // roundabout (ring) kontrole
setCtrlVisible('mainInflowCtrl', __SCENARIO__ === 'main');    // main inflow
setCtrlVisible('rampInflowCtrl', __SCENARIO__ === 'main');    // ramp inflow

setCtrlVisible('treiberCtrl', __SCENARIO__ === 'roundabout');
setCtrlVisible('intersectionCtrl', __SCENARIO__ === 'intersection');

if (__SCENARIO__ === 'ring') {
  import('./ring.js')
    .then(m => m.runRoundabout())
    .catch(err => console.error('Failed to load roundabout scenario:', err));
} else if (__SCENARIO__ === 'roundabout') {
  import('./roundabout.js')
    .then(m => m.runRoundaboutTreiber())
    .catch(err => console.error('Failed to load treiber roundabout scenario:', err));
} else if (__SCENARIO__ === 'intersection') {
  import('./intersection.js')
    .then(m => m.runIntersection())
    .catch(err => console.error('Failed to load intersection scenario:', err));
} else {

  /*

// ---------------------------
// Seeded RNG (from URL ?seed=...)
// ---------------------------
function hashSeed(seed) {
  if (seed == null) return 0x12345;
  if (Number.isFinite(seed)) return (seed >>> 0);

  const str = String(seed);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function makeMulberry32(seedU32) {
  let a = (seedU32 >>> 0);
  return function rng() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const urlParams = new URLSearchParams(window.location.search);
const seedParam = urlParams.get('seed'); // can be null
const seedValue = (seedParam === null)
  ? 12345
  : (/^-?\d+$/.test(seedParam) ? Number(seedParam) : seedParam);

// rng is re-creatable on reset:
let rng = makeMulberry32(hashSeed(seedValue));
setRng(rng);

// helper for main.js random usage (same rng as models)
let rand01 = () => rng();
*/

const rngCtl = initSeededRngFromUrl({defaultSeed: 12345});
const seedValue = rngCtl.seedValue;
const rand01 = rng01;

// ---------------------------
// Network config (kept same as before)
// ---------------------------
const NET_CONFIG = {
  mainLength: 920,
  mainLaneCount: 3,
  rampLength: 125,

  mergeMainS: 267,
  mergeMainLane: 2,
  mergeTriggerRampS: 110,

  curveStartS: 360,
  curveLength: 200,
  curveFactor: 0.70,
  postCurveLength: 80,
  postCurveFactor: 0.85,

  // phantom is already disabled by default in models.js net.phantom.enabled=false
  // but leaving these doesn't hurt:
  brakePulseEvery: 16.0,
  brakePulseDuration: 1.6,
  brakePulseDecel: 3.2
};

// We need to reset these on Reset:
let net = createNetwork(NET_CONFIG);
const idCounter = { nextId: 0 };

// ---------------------------
// Canvas + geometry
// ---------------------------
const canvas = document.getElementById('simCanvas');
const ctx = canvas.getContext('2d');
const W = canvas.width;
const H = canvas.height;

const geom = {
  L: net.roads.main.length,

  L_bottom: 360,
  L_curve: 200,
  L_top: net.roads.main.length - 360 - 200,

  xRight: 960,
  xLeft: 260,

  yTop: 115,
  yBottom: 520,

  cx: 260,
  cy: (115 + 520) / 2,
  R: (520 - 115) / 2,

  laneOffset: 18,

  ramp: {
    x0: 580,
    y0: 610,
    x1: 440,
    y1: 542
  }
};

// ---------------------------
// Seed vehicles
// ---------------------------
function seedVehicles() {
  net.roads.main.lanes.forEach((arr) => (arr.length = 0));
  net.roads.ramp.lanes.forEach((arr) => (arr.length = 0));
  idCounter.nextId = 0;

  const nCarsPerLane = 18;
  for (let lane = 0; lane < net.roads.main.laneCount; lane++) {
    for (let k = 0; k < nCarsPerLane; k++) {
      const s = (k * net.roads.main.length) / nCarsPerLane + lane * 6;
      const v = defaultIdmParams.v0 * (0.75 + 0.5 * rand01());
      trySpawnMain(net, lane, s, v, idCounter, 7);
    }
  }

  for (let k = 0; k < 6; k++) {
    const s = k * 16;
    const v = 12 + (rand01() - 0.5) * 3;
    trySpawnRamp(net, s, v, idCounter, 9);
  }
}

// ---------------------------
// Mapping
// ---------------------------
function mapMainLane(s, laneIndex) {
  const g = geom;
  const { L_bottom, L_curve, L_top } = g;
  let x, y;

  if (s < 0) s = 0;

  if (s < L_bottom) {
    const u = s / L_bottom;
    x = g.xRight - u * (g.xRight - g.xLeft);
    y = g.yBottom;
  } else if (s < L_bottom + L_curve) {
    const u = (s - L_bottom) / L_curve;
    const theta = Math.PI / 2 + u * Math.PI;
    x = g.cx + g.R * Math.cos(theta);
    y = g.cy + g.R * Math.sin(theta);
  } else {
    const u = (s - L_bottom - L_curve) / L_top;
    x = g.xLeft + u * (g.xRight - g.xLeft);
    y = g.yTop;
  }

  // tangentAngle logic
  let tangentAngle;
  if (s < L_bottom) tangentAngle = Math.PI;
  else if (s < L_bottom + L_curve) {
    const u = (s - L_bottom) / L_curve;
    const theta = Math.PI / 2 + u * Math.PI;
    tangentAngle = theta + Math.PI / 2;
  } else tangentAngle = 0;

  const baseLane = 1;
  const offset = (laneIndex - baseLane) * g.laneOffset;
  const nAngle = tangentAngle - Math.PI / 2;

  x += offset * Math.cos(nAngle);
  y += offset * Math.sin(nAngle);

  return { x, y };
}


function mapRamp(sRamp) {
  const r = geom.ramp;
  const Lr = net.roads.ramp.length;

  let t = sRamp / Lr;
  t = Math.max(0, Math.min(1, t));

  const x = r.x0 + t * (r.x1 - r.x0);
  const y = r.y0 + t * (r.y1 - r.y0);

  return { x, y };
}

function worldToCanvas(veh) {
  if (veh.roadId === 'ramp') return mapRamp(veh.s);
  return mapMainLane(veh.s, veh.lane);
}

// speed profile (mora match createNetwork)
const curveStartS = 360;
const curveLen = 200;
const postLen = 80;
function localV0AtS(s, veh, idmParams) {
  let f = 1.0;
  if (s >= curveStartS && s <= curveStartS + curveLen) f = 0.70;
  else if (s > curveStartS + curveLen && s < curveStartS + curveLen + postLen) f = 0.85;

  const v0mult = (veh && typeof veh.v0Mult === 'number') ? veh.v0Mult : 1.0;
  return Math.max(0.1, idmParams.v0 * f * v0mult);
}

// ---------------------------
// Background
// ---------------------------
function drawBackground() {
  const laneWidth = 18;
  const edgeWidth = 4;

  ctx.fillStyle = '#4b7a33';
  ctx.fillRect(0, 0, W, H);

  function strokeMainAtLane(laneIdx, styleCb) {
    ctx.beginPath();
    let first = true;
    const L = net.roads.main.length;
    for (let s = 0; s <= L; s += 5) {
      const { x, y } = mapMainLane(s, laneIdx);
      if (first) { ctx.moveTo(x, y); first = false; }
      else ctx.lineTo(x, y);
    }
    styleCb();
  }

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  strokeMainAtLane(1, () => {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3 * laneWidth + 2 * edgeWidth;
    ctx.stroke();
  });

  strokeMainAtLane(1, () => {
    ctx.strokeStyle = '#555555';
    ctx.lineWidth = 3 * laneWidth;
    ctx.stroke();
  });

  ctx.setLineDash([24, 18]);
  [0.5, 1.5].forEach((midLane) => {
    strokeMainAtLane(midLane, () => {
      ctx.strokeStyle = '#dcdcdc';
      ctx.lineWidth = 2;
      ctx.stroke();
    });
  });
  ctx.setLineDash([]);

  // ramp
  function strokeRamp(style, lineWidth, dashed = false, tEnd = 1.0) {
    ctx.beginPath();
    let first = true;
    const Lr = net.roads.ramp.length;
    for (let s = 0; s <= Lr * tEnd + 1e-3; s += 2) {
      const { x, y } = mapRamp(s);
      if (first) { ctx.moveTo(x, y); first = false; }
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = style;
    ctx.lineWidth = lineWidth;
    if (dashed) ctx.setLineDash([24, 18]);
    ctx.stroke();
    if (dashed) ctx.setLineDash([]);
  }

  strokeRamp('#ffffff', laneWidth + 2 * edgeWidth, false, 0.85);
  strokeRamp('#555555', laneWidth - 2, false, 0.95);

  function drawMergeMarker() {
  const p0 = mapMainLane(net.merge.toS, 0);
  const p1 = mapMainLane(net.merge.toS, net.roads.main.laneCount - 1);

  ctx.save();
  ctx.setLineDash([6, 6]);
  ctx.strokeStyle = 'rgba(255,255,255,0.7)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(p0.x, p0.y);
  ctx.lineTo(p1.x, p1.y);
  ctx.stroke();
  ctx.restore();
}

  drawMergeMarker();
  drawDetectors();
}

// ---------------------------
// Vehicles: color by speed + brake lights (SVE ISTE VELIČINE)
// ---------------------------
function speedColor(ratio) {
  if (ratio < 0.35) return '#d32f2f';
  if (ratio < 0.65) return '#fbc02d';
  return '#2e7d32';
}

function drawVehicles() {
  const vehicles = getAllVehicles(net);

  for (const veh of vehicles) {
    const { x, y } = worldToCanvas(veh);
    const radius = 4;

    let fill;
    if (veh.roadId === 'ramp') {
      fill = '#ffcc00';
    } else {
      const v0loc = localV0AtS(veh.s, veh, idmParams);
      const ratio = veh.v / v0loc;
      fill = speedColor(ratio);
    }

    ctx.beginPath();
    ctx.arc(x, y, radius, 0, 2 * Math.PI);
    ctx.fillStyle = fill;
    ctx.fill();

    ctx.lineWidth = 1;
    ctx.strokeStyle = '#000';
    ctx.stroke();

    if (veh.acc < -1.0 && veh.roadId === 'main') {
      ctx.beginPath();
      ctx.arc(x, y, radius + 2, 0, 2 * Math.PI);
      ctx.strokeStyle = 'rgba(255,0,0,0.55)';
      ctx.lineWidth = 3;
      ctx.stroke();
    }
  }
}

function maskRightSide() {
  const maskStart = geom.xRight - 40;
  ctx.fillStyle = '#4b7a33';
  ctx.fillRect(maskStart, 0, W - maskStart, H);
}

// ---------------------------
// Params + inflow
// ---------------------------
const idmParams = { ...defaultIdmParams };
const mobilParams = { ...defaultMobilParams };

let mainInflowPerHour = 4500;
let rampInflowPerHour = 1200;

// accumulators must reset
let mainSpawnAccumulators = new Array(net.roads.main.laneCount).fill(0);
let rampSpawnAccumulator = 0;
let spawnedSinceLastSample = { main: 0, ramp: 0 };


function spawnMainVehicles(dt) {
  const totalRatePerSec = mainInflowPerHour / 3600;
  if (totalRatePerSec <= 0) return;

  const laneRatePerSec = totalRatePerSec / net.roads.main.laneCount;
  const sSpawn = 10;

  for (let lane = 0; lane < net.roads.main.laneCount; lane++) {
    mainSpawnAccumulators[lane] += laneRatePerSec * dt;

    while (mainSpawnAccumulators[lane] >= 1.0) {
      const vInit = idmParams.v0 * (0.85 + 0.35 * rand01());
      const ok = trySpawnMain(net, lane, sSpawn, vInit, idCounter, 7);
      if (!ok) break;
      spawnedSinceLastSample.main += 1;
      mainSpawnAccumulators[lane] -= 1.0;
    }
  }
}

function spawnRampVehicles(dt) {
  const ratePerSec = rampInflowPerHour / 3600;
  if (ratePerSec <= 0) return;

  rampSpawnAccumulator += ratePerSec * dt;

  while (rampSpawnAccumulator >= 1.0) {
    const vInit = idmParams.v0 * (0.55 + 0.25 * rand01());
    const ok = trySpawnRamp(net, 0, vInit, idCounter, 9);
    if (!ok) break;
    spawnedSinceLastSample.ramp += 1;
    rampSpawnAccumulator -= 1.0;
  }
}

// ---------------------------
// UI sliders (existing)
// ---------------------------
function setupSliders() {
  const byId = (id) => document.getElementById(id);

  const v0Slider = byId('v0Slider');
  const TSlider = byId('TSlider');
  const aSlider = byId('aSlider');
  const bSlider = byId('bSlider');
  const pSlider = byId('pSlider');
  const thrSlider = byId('thrSlider');
  const mainInflowSlider = byId('mainInflowSlider');
  const rampInflowSlider = byId('rampInflowSlider');

  const v0Value = byId('v0Value');
  const TValue = byId('TValue');
  const aValue = byId('aValue');
  const bValue = byId('bValue');
  const pValue = byId('pValue');
  const thrValue = byId('thrValue');
  const mainInflowValue = byId('mainInflowValue');
  const rampInflowValue = byId('rampInflowValue');

  if (!v0Slider || !TSlider || !aSlider || !bSlider ||
      !pSlider || !thrSlider || !mainInflowSlider || !rampInflowSlider) {
    return;
  }

  v0Slider.value = (idmParams.v0 * 3.6).toFixed(0);
  TSlider.value = idmParams.T.toFixed(1);
  aSlider.value = idmParams.a.toFixed(1);
  bSlider.value = idmParams.b.toFixed(1);
  pSlider.value = mobilParams.p.toFixed(2);
  thrSlider.value = mobilParams.bThr.toFixed(2);
  mainInflowSlider.value = mainInflowPerHour.toFixed(0);
  rampInflowSlider.value = rampInflowPerHour.toFixed(0);

  function updateV0() {
    const kmh = Number(v0Slider.value);
    idmParams.v0 = kmh / 3.6;
    if (v0Value) v0Value.textContent = `${kmh.toFixed(0)} km/h`;
  }
  function updateT() {
    const val = Number(TSlider.value);
    idmParams.T = val;
    if (TValue) TValue.textContent = val.toFixed(1);
  }
  function updateA() {
    const val = Number(aSlider.value);
    idmParams.a = val;
    if (aValue) aValue.textContent = val.toFixed(1);
  }
  function updateB() {
    const val = Number(bSlider.value);
    idmParams.b = val;
    if (bValue) bValue.textContent = val.toFixed(1);
  }
  function updateP() {
    const val = Number(pSlider.value);
    mobilParams.p = val;
    if (pValue) pValue.textContent = val.toFixed(2);
  }
  function updateThr() {
    const val = Number(thrSlider.value);
    mobilParams.bThr = val;
    if (thrValue) thrValue.textContent = val.toFixed(2);
  }
  function updateMainInflow() {
    const val = Number(mainInflowSlider.value);
    mainInflowPerHour = val;
    if (mainInflowValue) mainInflowValue.textContent = `${val.toFixed(0)} veh/h`;
  }
  function updateRampInflow() {
    const val = Number(rampInflowSlider.value);
    rampInflowPerHour = val;
    if (rampInflowValue) rampInflowValue.textContent = `${val.toFixed(0)} veh/h`;
  }

  v0Slider.addEventListener('input', updateV0);
  TSlider.addEventListener('input', updateT);
  aSlider.addEventListener('input', updateA);
  bSlider.addEventListener('input', updateB);
  pSlider.addEventListener('input', updateP);
  thrSlider.addEventListener('input', updateThr);
  mainInflowSlider.addEventListener('input', updateMainInflow);
  rampInflowSlider.addEventListener('input', updateRampInflow);

  updateV0(); updateT(); updateA(); updateB();
  updateP(); updateThr();
  updateMainInflow(); updateRampInflow();
}

setupSliders();

// ---------------------------
// Pause / Reset controls
// ---------------------------
let running = true;
const pauseBtn = document.getElementById('pauseBtn');
const resetBtn = document.getElementById('resetBtn');
const simStatus = document.getElementById('simStatus');

function updateSimUI() {
  if (simStatus) simStatus.textContent = running ? 'RUN' : 'PAUSE';
  if (pauseBtn) pauseBtn.textContent = running ? 'Pause' : 'Resume';
}

function initSim() {
  // recreate RNG so reset truly restarts deterministically for same seed
  clearLog();

 // rng = makeMulberry32(hashSeed(seedValue));
 // setRng(rng);
 // rand01 = () => rng();
  rngCtl.resetRng();

  // recreate network
  net = createNetwork(NET_CONFIG);

  // reset spawn accumulators
  mainSpawnAccumulators = new Array(net.roads.main.laneCount).fill(0);
  rampSpawnAccumulator = 0;

  // reset timebase for animation loop
  lastTs = null;

  // seed vehicles again
  seedVehicles();
  initDetectors();
}

if (pauseBtn) {
  pauseBtn.addEventListener('click', () => {
    running = !running;
    updateSimUI();
  });
}

if (resetBtn) {
  resetBtn.addEventListener('click', () => {
    initSim();
    running = true;
    updateSimUI();
  });
}

// Optional: keyboard shortcuts (ne mijenja izgled)
// Space = pause/resume, R = reset
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    running = !running;
    updateSimUI();
  } else if (e.key === 'r' || e.key === 'R') {
    initSim();
    running = true;
    updateSimUI();
  }
});

updateSimUI();

// ---------------------------
// Loop
// ---------------------------
let lastTs = null;

function loop(ts) {
  if (lastTs === null) lastTs = ts;

  // If paused: keep drawing, but do NOT advance simulation,
  // and keep lastTs synced so we don't get a huge dt after resume.
  if (!running) {
    lastTs = ts;
    drawBackground();
    drawVehicles();
    maskRightSide();
    requestAnimationFrame(loop);
    return;
  }

  const realDt = (ts - lastTs) / 1000;
  lastTs = ts;

  const dt = 0.05;
  const nSteps = Math.max(1, Math.min(10, Math.round(realDt / dt)));

for (let i = 0; i < nSteps; i++) {
  spawnMainVehicles(dt);
  spawnRampVehicles(dt);

  // snapshot ramp ids BEFORE step (after spawn)
  const rampIdsBefore = new Set(net.roads.ramp.allVehicles().map(v => v.id));

  stepNetwork(net, idmParams, mobilParams, dt);

  // AFTER step: merges + lane changes + hard braking
  const tNow = net.time;
  const mainVeh = net.roads.main.allVehicles();

  for (const v of mainVeh) {
    // merge event: was on ramp before step, now on main
    if (rampIdsBefore.has(v.id)) {
      logEvent({
        t: tNow,
        type: "merge",
        id: v.id,
        toLane: v.lane,
        s: v.s,
        vKmh: (v.v ?? 0) * 3.6
      });
    }

    // lane-change: robust
    if (v.prevLane != null && v.lane !== v.prevLane) {
      logEvent({
        t: tNow,
        type: "lane_change",
        id: v.id,
        from: v.prevLane,
        to: v.lane,
        s: v.s,
        vKmh: (v.v ?? 0) * 3.6
      });
    }

    // hard brake (edge-triggered)
    const hard = (v.acc ?? 0) < -2.0;
    const wasHard = lastHardBrake.get(v.id) || false;
    if (hard && !wasHard) {
      logEvent({
        t: tNow,
        type: "hard_brake",
        id: v.id,
        lane: v.lane,
        s: v.s,
        acc: v.acc,
        vKmh: (v.v ?? 0) * 3.6
      });
    }
    lastHardBrake.set(v.id, hard);
  }

  detectorsOnStep();
}

  detectorsUpdateUI();
  logTick();

  drawBackground();
  drawVehicles();
  maskRightSide();

  requestAnimationFrame(loop);
}

// initial seed on load
seedVehicles();
// ---------------------------
// Detectors (simple loop detectors on main road)
// - counts vehicles crossing a fixed s-position
// - computes flow (veh/h) in a sliding time window
// - computes mean speed (km/h) + density (veh/km) in a small spatial window
// ---------------------------
const DET_WINDOW_SEC = 30;  // sliding window for flow
const DET_RANGE_M = 50;     // +/- range around detector for speed/density

const detEls = {
  d1Label: document.getElementById('det1Label'),
  d1Flow:  document.getElementById('det1Flow'),
  d1Speed: document.getElementById('det1Speed'),
  d1Dens:  document.getElementById('det1Density'),

  d2Label: document.getElementById('det2Label'),
  d2Flow:  document.getElementById('det2Flow'),
  d2Speed: document.getElementById('det2Speed'),
  d2Dens:  document.getElementById('det2Density'),

  // NEW: D3 (iza krivine)
  d3Label: document.getElementById('det3Label'),
  d3Flow:  document.getElementById('det3Flow'),
  d3Speed: document.getElementById('det3Speed'),
  d3Dens:  document.getElementById('det3Density')
};


let detectors = []; // filled by initDetectors()

function makeDetector(label, s, els) {
  return {
    label,
    s,
    window: DET_WINDOW_SEC,
    range: DET_RANGE_M,
    passTimes: [], // times (sec) when any vehicle crossed from <s to >=s
    totalPasses: 0,
    els,
    last: null,
    smoothSpeed: null,
    smoothDens: null
  };
}
function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

function initDetectors() {
  const L = net.roads.main.length;

  const sMerge = net.merge.toS;

  const sCurveIn  = curveStartS;               // ulaz u krivinu
  const sCurveOut = curveStartS + curveLen;    // izlaz iz krivine

  // D1: prije merge
  const s1 = clamp(sMerge - 60, 0, L);

  // D2: poslije merge ali prije krivine
  // cilj: između merge+80 i (curveStart-40)
  const minS2 = sMerge + 80;
  const maxS2 = sCurveIn - 40;

  // ako je merge preblizu krivini pa se opsezi "preklapaju", fallback:
  // stavi D2 na sredinu između merge i krivine (ali ipak u validnom dometu)
  let s2;
  if (minS2 < maxS2) {
    s2 = clamp(sMerge + 140, minS2, maxS2);
  } else {
    const mid = (sMerge + sCurveIn) * 0.5;
    s2 = clamp(mid, 0, L);
  }

  // D3: iza krivine (na izlazu)
  const s3 = clamp(sCurveOut + 20, 0, L);

  detectors = [
    makeDetector('D1', s1, { label: detEls.d1Label, flow: detEls.d1Flow, speed: detEls.d1Speed, dens: detEls.d1Dens }),
    makeDetector('D2', s2, { label: detEls.d2Label, flow: detEls.d2Flow, speed: detEls.d2Speed, dens: detEls.d2Dens }),
    makeDetector('D3', s3, { label: detEls.d3Label, flow: detEls.d3Flow, speed: detEls.d3Speed, dens: detEls.d3Dens })
  ];

  for (const d of detectors) {
    if (d.els?.label) d.els.label.textContent = `${d.label} @ ${d.s.toFixed(0)} m`;
  }

  refreshLogDerivedMeta();
}

// ---- travel-time tracker state ----
const TT_WINDOW_SEC = 180; // keep last 3 minutes of TT samples
const ttBySegment = {
  "D1_D2": [],
  "D2_D3": [],
  "D1_D3": []
};
const seenAt = new Map(); // vid -> { D1: t, D2: t, D3: t }

function pushTT(seg, dt, nowT) {
  if (!Number.isFinite(dt) || dt <= 0) return;
  ttBySegment[seg].push({ t: nowT, dt });
  // prune old
  const tMin = nowT - TT_WINDOW_SEC;
  while (ttBySegment[seg].length && ttBySegment[seg][0].t < tMin) ttBySegment[seg].shift();
}

function recordCrossing(detLabel, veh, nowT) {
  const vid = (veh && (veh.id ?? veh.vid ?? veh._id));
  if (vid == null) return;

  let rec = seenAt.get(vid);
  if (!rec) {
    rec = {};
    seenAt.set(vid, rec);
  }
  if (rec[detLabel] == null) rec[detLabel] = nowT;

  // If we have pairs, compute TT
  if (rec.D1 != null && rec.D2 != null) pushTT("D1_D2", rec.D2 - rec.D1, nowT);
  if (rec.D2 != null && rec.D3 != null) pushTT("D2_D3", rec.D3 - rec.D2, nowT);
  if (rec.D1 != null && rec.D3 != null) pushTT("D1_D3", rec.D3 - rec.D1, nowT);

  // cleanup: once passed D3, we can drop this vehicle record
  if (rec.D3 != null) seenAt.delete(vid);
}

// Called after EACH stepNetwork (bitno kad imaš nSteps>1)
function detectorsOnStep() {
  const mainVeh = net.roads.main.allVehicles();
  const t = net.time;

  for (const d of detectors) {
    for (const v of mainVeh) {
      const ps = v.prevS;
      if (typeof ps !== 'number') continue;

      // crossing event
      if (ps < d.s && v.s >= d.s) {
        d.passTimes.push(t);
        d.totalPasses += 1;
        recordCrossing(d.label, v, t);

        logEvent({
            t,
            type: "detector_cross",
            det: d.label,
            id: v.id,
            lane: v.lane,
            s: v.s,
            vKmh: (v.v ?? 0) * 3.6
          });

      }
    }
  }
}


// Called ONCE per animation frame (prune + compute + UI)
function detectorsUpdateUI() {
  const mainVeh = net.roads.main.allVehicles();
  const t = net.time;

  const alpha = 0.2; // smoothing strength (0..1)

  for (const d of detectors) {
    // 1) prune passTimes to last window seconds
    const tMin = t - d.window;
    while (d.passTimes.length && d.passTimes[0] < tMin) d.passTimes.shift();

    // 2) flow over window
    const flow = (d.passTimes.length / d.window) * 3600;

    // 3) local speed + density in +/- range around detector position
    let sumV = 0;
    let cnt = 0;
    for (const v of mainVeh) {
      if (Math.abs(v.s - d.s) <= d.range) {
        sumV += v.v;
        cnt += 1;
      }
    }

    const meanV = cnt ? (sumV / cnt) : 0;
    const meanKmh = meanV * 3.6;
    const densVehKm = (cnt / (2 * d.range)) * 1000;

    // 4) update smooth values only when we have data
    if (cnt) {
      d.smoothSpeed = (d.smoothSpeed ?? meanKmh);
      d.smoothDens  = (d.smoothDens  ?? densVehKm);

      // exponential moving average
      d.smoothSpeed = d.smoothSpeed + alpha * (meanKmh - d.smoothSpeed);
      d.smoothDens  = d.smoothDens  + alpha * (densVehKm - d.smoothDens);
    }

    // keep last computed values for logging/plotting
    d.last = {
      t,
      s: d.s,
      flowVehH: flow,
      meanKmh: meanKmh,
      densityVehKm: densVehKm,
      countInRange: cnt,
      smoothSpeedKmh: (d.smoothSpeed ?? null),
      smoothDensityVehKm: (d.smoothDens ?? null)
    };


    // 5) UI
    if (d.els?.label) d.els.label.textContent = `${d.label} @ ${d.s.toFixed(0)} m`;
    if (d.els?.flow)  d.els.flow.textContent  = `${flow.toFixed(0)} veh/h`;

    if (d.els?.speed) {
      d.els.speed.textContent = cnt ? `${d.smoothSpeed.toFixed(1)} km/h` : '—';
    }
    if (d.els?.dens) {
      d.els.dens.textContent  = cnt ? `${d.smoothDens.toFixed(1)} veh/km` : '—';
    }
  }
}
// ---------------------------
// JSON logging
// ---------------------------
const LOG_EVERY_SEC = 1.0;     // 1 Hz
let lastLogT = -Infinity;

// heatmap binning along MAIN road
const BIN_SIZE_M = 20;         // 10-25m je ok; 20m super kompromis
let nBinsMain = Math.ceil(NET_CONFIG.mainLength / BIN_SIZE_M);

// helper stats
function mean(arr) {
  if (!arr.length) return null;
  let s = 0;
  for (const x of arr) s += x;
  return s / arr.length;
}
function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  let v = 0;
  for (const x of arr) v += (x - m) * (x - m);
  return Math.sqrt(v / (arr.length - 1));
}
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const i = Math.floor(pos);
  const f = pos - i;
  if (i + 1 < sorted.length) return sorted[i] * (1 - f) + sorted[i + 1] * f;
  return sorted[i];
}
function ttStats(list) {
  const dts = list.map(x => x.dt).filter(Number.isFinite);
  if (!dts.length) return { count: 0 };
  dts.sort((a,b)=>a-b);
  return {
    count: dts.length,
    min: dts[0],
    mean: mean(dts),
    median: quantile(dts, 0.5),
    p90: quantile(dts, 0.9),
    p95: quantile(dts, 0.95),
    max: dts[dts.length - 1]
  };
}

function computeBinsMain(vehMain) {
  // arrays: total across lanes
  const count = new Array(nBinsMain).fill(0);
  const sumV = new Array(nBinsMain).fill(0);

  // per-lane
  const laneCount = net.roads.main.laneCount;
  const countL = Array.from({ length: laneCount }, () => new Array(nBinsMain).fill(0));
  const sumVL = Array.from({ length: laneCount }, () => new Array(nBinsMain).fill(0));

  for (const v of vehMain) {
    const s = v.s;
    if (!Number.isFinite(s)) continue;
    let b = Math.floor(s / BIN_SIZE_M);
    if (b < 0) b = 0;
    if (b >= nBinsMain) b = nBinsMain - 1;

    const kmh = (v.v ?? 0) * 3.6;

    count[b] += 1;
    sumV[b] += kmh;

    const ln = v.lane ?? 0;
    if (ln >= 0 && ln < laneCount) {
      countL[ln][b] += 1;
      sumVL[ln][b] += kmh;
    }
  }

  const speedKmh = count.map((c, i) => (c ? sumV[i] / c : null));
  const densityVehKm = count.map(c => c * (1000 / BIN_SIZE_M)); // veh / km

  const speedKmhByLane = [];
  const densityVehKmByLane = [];
  for (let ln = 0; ln < net.roads.main.laneCount; ln++) {
    speedKmhByLane.push(countL[ln].map((c, i) => (c ? sumVL[ln][i] / c : null)));
    densityVehKmByLane.push(countL[ln].map(c => c * (1000 / BIN_SIZE_M)));
  }

  return {
    binSizeM: BIN_SIZE_M,
    nBins: nBinsMain,
    speedKmh,
    densityVehKm,
    speedKmhByLane,
    densityVehKmByLane
  };
}

function computeGlobalStats(vehMain, vehRamp) {
  const spMain = [];
  const spRamp = [];
  const accMain = [];

  let brakingMain = 0;
  let slowMain = 0;     // < 5 km/h
  let stoppedMain = 0;  // < 0.5 km/h

  // also store slow region extent (helpful for "queue length" proxy)
  let slowMinS = null;
  let slowMaxS = null;

  for (const v of vehMain) {
    const kmh = (v.v ?? 0) * 3.6;
    spMain.push(kmh);

    const a = v.acc ?? 0;
    accMain.push(a);
    if (a < -1.0) brakingMain += 1;

    if (kmh < 5) {
      slowMain += 1;
      const s = v.s;
      if (Number.isFinite(s)) {
        slowMinS = (slowMinS == null) ? s : Math.min(slowMinS, s);
        slowMaxS = (slowMaxS == null) ? s : Math.max(slowMaxS, s);
      }
    }
    if (kmh < 0.5) stoppedMain += 1;
  }

  for (const v of vehRamp) {
    spRamp.push((v.v ?? 0) * 3.6);
  }

  // lane stats
  const laneCount = net.roads.main.laneCount;
  const laneSpeed = Array.from({ length: laneCount }, () => []);
  const laneCountVeh = new Array(laneCount).fill(0);

  for (const v of vehMain) {
    const ln = v.lane ?? 0;
    if (ln >= 0 && ln < laneCount) {
      laneSpeed[ln].push((v.v ?? 0) * 3.6);
      laneCountVeh[ln] += 1;
    }
  }

  return {
    main: {
      avgSpeedKmh: mean(spMain),
      stdSpeedKmh: std(spMain),
      avgAcc: mean(accMain),
      fracBraking: vehMain.length ? brakingMain / vehMain.length : 0,
      slowCount: slowMain,
      stoppedCount: stoppedMain,
      slowMinS,
      slowMaxS,
      laneAvgSpeedKmh: laneSpeed.map(xs => mean(xs)),
      laneCount: laneCountVeh
    },
    ramp: {
      avgSpeedKmh: mean(spRamp),
      stdSpeedKmh: std(spRamp)
    }
  };
}

const logData = {
  meta: {
    seed: seedValue,
    createdAt: new Date().toISOString(),
    dtSim: 0.05,
    logEverySec: LOG_EVERY_SEC,
    netConfig: NET_CONFIG,
    derived: {
      mainLength: NET_CONFIG.mainLength,
      laneCount: NET_CONFIG.mainLaneCount,
      mergeS: NET_CONFIG.mergeMainS,
      curveStartS: NET_CONFIG.curveStartS,
      curveEndS: NET_CONFIG.curveStartS + NET_CONFIG.curveLength,
      postCurveEndS: NET_CONFIG.curveStartS + NET_CONFIG.curveLength + NET_CONFIG.postCurveLength,
      bins: { binSizeM: BIN_SIZE_M, nBins: nBinsMain },
      detectors: {} // filled after initDetectors()
    },
    hasEvents: true
  },
  samples: []
};

function refreshLogDerivedMeta() {
  // call after initDetectors() or after net recreate
  nBinsMain = Math.ceil(net.roads.main.length / BIN_SIZE_M);
  logData.meta.derived.mainLength = net.roads.main.length;
  logData.meta.derived.laneCount = net.roads.main.laneCount;
  logData.meta.derived.mergeS = net.merge?.toS ?? NET_CONFIG.mergeMainS;
  logData.meta.derived.curveStartS = curveStartS;
  logData.meta.derived.curveEndS = curveStartS + curveLen;
  logData.meta.derived.postCurveEndS = curveStartS + curveLen + postLen;
  logData.meta.derived.bins = { binSizeM: BIN_SIZE_M, nBins: nBinsMain };

  const detMap = {};
  for (const d of detectors) detMap[d.label] = { s: d.s, range: d.range, window: d.window };
  logData.meta.derived.detectors = detMap;
}

const TRAJ_MAX = 30;
function snapshotTraj(vehMain) {
  const arr = vehMain
    .slice()
    .sort((a,b) => a.id - b.id)
    .slice(0, TRAJ_MAX)
    .map(v => ({
      id: v.id,
      lane: v.lane,
      s: v.s,
      vKmh: (v.v ?? 0) * 3.6,
      acc: v.acc ?? 0
    }));
  return arr;
}


function logTick() {
  const t = net.time;
  if (t - lastLogT < LOG_EVERY_SEC) return;
  lastLogT = t;

  const vehAll = getAllVehicles(net);
  const vehMain = net.roads.main.allVehicles();
  const vehRamp = net.roads.ramp.allVehicles();

  // detector snapshot (last computed)
  const detObj = {};
  const detTotals = {};
  for (const d of detectors) {
    detObj[d.label] = d.last ? { ...d.last } : null;
    detTotals[d.label] = d.totalPasses ?? 0;
  }

  // heatmap bins along main
  const binsMain = computeBinsMain(vehMain);

  // global KPIs
  const global = computeGlobalStats(vehMain, vehRamp);

  // travel time stats from sliding window arrays
  const tt = {
    windowSec: TT_WINDOW_SEC,
    D1_D2: ttStats(ttBySegment["D1_D2"]),
    D2_D3: ttStats(ttBySegment["D2_D3"]),
    D1_D3: ttStats(ttBySegment["D1_D3"])
  };

  logData.samples.push({
    t,
    inflow: { mainInflowPerHour, rampInflowPerHour },
    counts: { nAll: vehAll.length, nMain: vehMain.length, nRamp: vehRamp.length },

    // core detector signals (for time-series)
    detectors: detObj,

    // cumulative counts (N-curves)
    detectorTotals: detTotals,

    // higher-level summary metrics
    global,

    // space-time heatmap payload (speed/density per bin, by lane)
    binsMain,

    // travel time stats
    travelTime: tt,
    spawns: {...spawnedSinceLastSample},
    traj: snapshotTraj(vehMain)
  });

  spawnedSinceLastSample.main = 0;
  spawnedSinceLastSample.ramp = 0;

  const logInfo = document.getElementById('logInfo');
  if (logInfo) logInfo.textContent = `log: ${logData.samples.length} samples`;
}

// ---------------------------
// EVENT logging (discrete events)
// ---------------------------
const MAX_EVENTS = 200000; // safety cap
function logEvent(e) {
  if (!e) return;
  logData.events = logData.events || [];
  if (logData.events.length >= MAX_EVENTS) return;
  logData.events.push(e);
}

// state for edge-triggered events
const lastHardBrake = new Map(); // id -> bool (wasHardBraking)


function downloadJSON() {
  const nameSeed = String(seedValue).replace(/[^a-z0-9_-]+/gi, '_');
  const fileName = `simlog_seed-${nameSeed}_t-${Math.round(net.time)}.json`;

  const blob = new Blob([JSON.stringify(logData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();

  URL.revokeObjectURL(url);
}

function clearLog() {
  logData.samples.length = 0;
  logData.events = [];
  lastHardBrake.clear();
  lastLogT = -Infinity;
  logData.meta.createdAt = new Date().toISOString();

  // also clear TT buffers and seenAt
  for (const k of Object.keys(ttBySegment)) ttBySegment[k].length = 0;
  seenAt.clear();

   // KLJUČNO: reset detector internal state
  for (const d of detectors) {
    d.passTimes.length = 0;
    d.totalPasses = 0;
    d.last = null;
    d.smoothSpeed = null;
    d.smoothDens = null;
  }

  const logInfo = document.getElementById('logInfo');
  if (logInfo) logInfo.textContent = `log: 0 samples`;
}

// wire buttons
const downloadLogBtn = document.getElementById('downloadLogBtn');
const clearLogBtn = document.getElementById('clearLogBtn');
if (downloadLogBtn) downloadLogBtn.addEventListener('click', downloadJSON);
if (clearLogBtn) clearLogBtn.addEventListener('click', clearLog);



// Optional: nacrtaj detektore kao isprekidanu liniju na putu
function drawDetectors() {
  if (!detectors.length) return;

  ctx.save();
  ctx.setLineDash([10, 8]);
  ctx.strokeStyle = 'rgba(144,213,255,1)';
  ctx.lineWidth = 2;

  for (const d of detectors) {
    const p0 = mapMainLane(d.s, 0);
    const p1 = mapMainLane(d.s, net.roads.main.laneCount - 1);
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.stroke();
  }

  ctx.restore();
}

initDetectors();
requestAnimationFrame(loop);

}
