// detector_tt_test.mjs
// Headless travel-time test between D1 and D2 detectors.
// Usage:
//   node detector_tt_test.mjs --seed demo --tEnd 180 --dt 0.05 --main 1800 --ramp 0
//   node detector_tt_test.mjs --seed demo --tEnd 180 --dt 0.05 --main 1200 --ramp 600
//   node detector_tt_test.mjs --seed demo --scenario single --tEnd 80 --dt 0.05

import {
  createNetwork,
  stepNetwork,
  trySpawnMain,
  trySpawnRamp,
  defaultIdmParams,
  defaultMobilParams,
  setRng
} from './models.js';

// ---------- args ----------
function getArg(name, def = null) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return def;
  const v = process.argv[idx + 1];
  if (v == null || v.startsWith('--')) return true;
  return v;
}

const scenario = String(getArg('scenario', 'flow')); // flow | single
const seedParam = getArg('seed', 'demo-seed');
const tEnd = Number(getArg('tEnd', 180));
const dt = Number(getArg('dt', 0.05));
const mainInflowPerHour = Number(getArg('main', 1800));
const rampInflowPerHour = Number(getArg('ramp', 0));
const windowSec = Number(getArg('window', 30));
const rangeM = Number(getArg('range', 20));

// ---------- seeded RNG ----------
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
const rng = makeMulberry32(hashSeed(seedParam));
setRng(rng);
const rand01 = () => rng();

// ---------- network  ----------
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
  postCurveFactor: 0.85
};

let net = createNetwork(NET_CONFIG);
const idCounter = { nextId: 0 };
const idmParams = { ...defaultIdmParams };
const mobilParams = { ...defaultMobilParams };

// ---------- detectors + TT ----------
function makeDetector(label, s) {
  return {
    label,
    s,
    window: windowSec,
    range: rangeM,
    passTimes: [],
    totalPasses: 0,
    dupPasses: 0,
    lastCrossByVeh: new Map()
  };
}

const d1S = Math.max(0, net.merge.toS - 60);
const d2S = Math.min(net.roads.main.length, net.merge.toS + 120);

const D1 = makeDetector('D1', d1S);
const D2 = makeDetector('D2', d2S);
const detectors = [D1, D2];

// Travel time storage: vehicle id -> time when it crossed D1
const d1CrossTime = new Map();
// Completed travel times (seconds) D1->D2
const travelTimes = [];

function prunePassTimes(det, t) {
  const tMin = t - det.window;
  while (det.passTimes.length && det.passTimes[0] < tMin) det.passTimes.shift();
}

function detectorsOnStep(net) {
  const mainVeh = net.roads.main.allVehicles();
  const t = net.time;

  for (const det of detectors) {
    for (const v of mainVeh) {
      const ps = v.prevS;
      if (typeof ps !== 'number') continue;

      if (ps < det.s && v.s >= det.s) {
        det.passTimes.push(t);
        det.totalPasses++;

        if (det.lastCrossByVeh.has(v.id)) det.dupPasses++;
        det.lastCrossByVeh.set(v.id, t);

        // Travel-time logic
        if (det.label === 'D1') {
          d1CrossTime.set(v.id, t);
        } else if (det.label === 'D2') {
          const t1 = d1CrossTime.get(v.id);
          if (typeof t1 === 'number') {
            travelTimes.push(t - t1);
            d1CrossTime.delete(v.id); // prevent double pairing
          }
        }
      }
    }
  }
}

function detectorStats(det, net) {
  const mainVeh = net.roads.main.allVehicles();
  const t = net.time;

  prunePassTimes(det, t);
  const flowVehH = (det.passTimes.length / det.window) * 3600;

  let cnt = 0;
  let sumV = 0;
  for (const v of mainVeh) {
    if (Math.abs(v.s - det.s) <= det.range) {
      cnt++;
      sumV += v.v;
    }
  }
  const meanV = cnt ? sumV / cnt : 0;
  const meanKmh = meanV * 3.6;
  const densVehKm = (cnt / (2 * det.range)) * 1000;

  return {
    flowVehH,
    meanKmh,
    densityVehKm: densVehKm,
    countInRange: cnt
  };
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] === undefined) return sorted[base];
  return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
}

function travelTimeSummary(tt) {
  if (!tt.length) {
    return { count: 0 };
  }
  const a = [...tt].sort((x, y) => x - y);
  const sum = a.reduce((p, c) => p + c, 0);
  return {
    count: a.length,
    min: +a[0].toFixed(2),
    mean: +(sum / a.length).toFixed(2),
    median: +quantile(a, 0.5).toFixed(2),
    p90: +quantile(a, 0.9).toFixed(2),
    p95: +quantile(a, 0.95).toFixed(2),
    max: +a[a.length - 1].toFixed(2)
  };
}

// ---------- spawners ----------
let mainSpawnAcc = new Array(net.roads.main.laneCount).fill(0);
let rampSpawnAcc = 0;

function spawnMain(dt) {
  const totalRatePerSec = mainInflowPerHour / 3600;
  if (totalRatePerSec <= 0) return;

  const laneRate = totalRatePerSec / net.roads.main.laneCount;
  const sSpawn = 10;

  for (let lane = 0; lane < net.roads.main.laneCount; lane++) {
    mainSpawnAcc[lane] += laneRate * dt;
    while (mainSpawnAcc[lane] >= 1.0) {
      const vInit = idmParams.v0 * (0.85 + 0.35 * rand01());
      const ok = trySpawnMain(net, lane, sSpawn, vInit, idCounter, 7);
      if (!ok) break;
      mainSpawnAcc[lane] -= 1.0;
    }
  }
}

function spawnRamp(dt) {
  const ratePerSec = rampInflowPerHour / 3600;
  if (ratePerSec <= 0) return;

  rampSpawnAcc += ratePerSec * dt;
  while (rampSpawnAcc >= 1.0) {
    const vInit = idmParams.v0 * (0.55 + 0.25 * rand01());
    const ok = trySpawnRamp(net, 0, vInit, idCounter, 9);
    if (!ok) break;
    rampSpawnAcc -= 1.0;
  }
}

// ---------- single car seed ----------
function clearVehicles() {
  net.roads.main.lanes.forEach(arr => arr.splice(0, arr.length));
  net.roads.ramp.lanes.forEach(arr => arr.splice(0, arr.length));
  idCounter.nextId = 0;
  d1CrossTime.clear();
  travelTimes.length = 0;
  detectors.forEach(d => {
    d.passTimes.length = 0;
    d.totalPasses = 0;
    d.dupPasses = 0;
    d.lastCrossByVeh.clear();
  });
}

function seedSingleCar() {
  clearVehicles();
  trySpawnMain(net, 1, 0, 20, idCounter, 7);
}

// ---------- run ----------
if (scenario === 'single') seedSingleCar();

const steps = Math.ceil(tEnd / dt);
for (let k = 0; k < steps; k++) {
  if (scenario !== 'single') {
    spawnMain(dt);
    spawnRamp(dt);
  }

  stepNetwork(net, idmParams, mobilParams, dt);
  detectorsOnStep(net);
}

// ---------- report ----------
const detReport = detectors.map(det => {
  const st = detectorStats(det, net);
  return {
    label: det.label,
    s: det.s,
    totalPasses: det.totalPasses,
    dupPasses: det.dupPasses,
    flowVehH_endWindow: +st.flowVehH.toFixed(1),
    meanKmh_end: +st.meanKmh.toFixed(1),
    densityVehKm_end: +st.densityVehKm.toFixed(1)
  };
});

const summary = {
  scenario,
  seed: seedParam,
  tEnd,
  dt,
  inflow: { mainInflowPerHour, rampInflowPerHour },
  detectors: detReport,
  travelTime_D1_to_D2_sec: travelTimeSummary(travelTimes)
};

console.log('=== DETECTOR TRAVEL-TIME TEST SUMMARY ===');
console.log(JSON.stringify(summary, null, 2));

if (detReport.some(d => d.dupPasses > 0)) {
  console.log('\n[WARN] Duplicate crossings detected for at least one detector.');
}
