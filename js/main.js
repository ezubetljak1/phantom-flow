// main.js
import {
  createNetwork,
  stepNetwork,
  getAllVehicles,
  trySpawnMain,
  trySpawnRamp,
  defaultIdmParams,
  defaultMobilParams,
  setRng
} from './models.js';

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

// ---------------------------
// Network config (kept same as before)
// ---------------------------
const NET_CONFIG = {
  mainLength: 920,
  mainLaneCount: 3,
  rampLength: 125,

  mergeMainS: 470,
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

  // tangentAngle logic from your old code preserved:
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
  rng = makeMulberry32(hashSeed(seedValue));
  setRng(rng);
  rand01 = () => rng();

  // recreate network
  net = createNetwork(NET_CONFIG);

  // reset spawn accumulators
  mainSpawnAccumulators = new Array(net.roads.main.laneCount).fill(0);
  rampSpawnAccumulator = 0;

  // reset timebase for animation loop
  lastTs = null;

  // seed vehicles again
  seedVehicles();
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
    stepNetwork(net, idmParams, mobilParams, dt);
  }

  drawBackground();
  drawVehicles();
  maskRightSide();

  requestAnimationFrame(loop);
}

// initial seed on load
seedVehicles();
requestAnimationFrame(loop);
