// detector_test.mjs
// Usage examples:
//   node detector_test.mjs --seed demo --tEnd 120 --dt 0.05 --main 1800 --ramp 0
//   node detector_test.mjs --seed demo --scenario single
//   node detector_test.mjs --seed demo --tEnd 120 --dt 0.1  --main 1800 --ramp 0  (dt invariance check)

// -------- import sim core --------
import {
  createNetwork,
  stepNetwork,
  trySpawnMain,
  trySpawnRamp,
  defaultIdmParams,
  defaultMobilParams,
  setRng
} from './models.js';

// -------- tiny args parser --------
function getArg(name, def = null) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return def;
  const v = process.argv[idx + 1];
  if (v == null || v.startsWith('--')) return true;
  return v;
}

const scenario = String(getArg('scenario', 'flow')); // flow | single
const seedParam = getArg('seed', 'demo-seed');
const tEnd = Number(getArg('tEnd', 120));
const dt = Number(getArg('dt', 0.05));
const mainInflowPerHour = Number(getArg('main', 1800));
const rampInflowPerHour = Number(getArg('ramp', 0));
const windowSec = Number(getArg('window', 30));
const rangeM = Number(getArg('range', 20));

// -------- seeded RNG --------
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

// -------- network config --------
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

// -------- detectors (same logic as UI) --------
function makeDetector(label, s) {
  return {
    label,
    s,
    window: windowSec,
    range: rangeM,
    passTimes: [],
    totalPasses: 0,
    dupPasses: 0,
    // per detector: vehicle id -> last crossing time
    lastCrossByVeh: new Map()
  };
}

const d1S = Math.max(0, net.merge.toS - 60);
const d2S = Math.min(net.roads.main.length, net.merge.toS + 120);

const detectors = [
  makeDetector('D1', d1S),
  makeDetector('D2', d2S)
];

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

        // duplicate check: on non-ring road, same car should not cross same detector twice
        if (det.lastCrossByVeh.has(v.id)) det.dupPasses++;
        det.lastCrossByVeh.set(v.id, t);
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

// -------- spawners (same idea as in main.js) --------
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

// -------- scenario helpers --------
function clearVehicles() {
  net.roads.main.lanes.forEach(arr => arr.splice(0, arr.length));
  net.roads.ramp.lanes.forEach(arr => arr.splice(0, arr.length));
  idCounter.nextId = 0;
}

function seedSingleCar() {
  clearVehicles();
  // one car on lane 1 at s=0
  trySpawnMain(net, 1, 0, 20, idCounter, 7);
}

// -------- run sim --------
const snapshots = [];
let snapAcc = 0;

if (scenario === 'single') seedSingleCar();

const steps = Math.ceil(tEnd / dt);
for (let k = 0; k < steps; k++) {
  if (scenario !== 'single') {
    spawnMain(dt);
    spawnRamp(dt);
  }

  stepNetwork(net, idmParams, mobilParams, dt);
  detectorsOnStep(net);

  snapAcc += dt;
  if (snapAcc >= 1.0) {
    snapAcc = 0;

    const snap = { t: +net.time.toFixed(2) };
    for (const det of detectors) {
      const st = detectorStats(det, net);
      snap[det.label] = {
        s: det.s,
        flowVehH: +st.flowVehH.toFixed(1),
        meanKmh: +st.meanKmh.toFixed(1),
        densityVehKm: +st.densityVehKm.toFixed(1),
        countInRange: st.countInRange
      };
    }
    snapshots.push(snap);
  }
}

// -------- final report --------
const summary = {
  scenario,
  seed: seedParam,
  tEnd,
  dt,
  inflow: { mainInflowPerHour, rampInflowPerHour },
  detectors: detectors.map(det => {
    const st = detectorStats(det, net);
    return {
      label: det.label,
      s: det.s,
      windowSec: det.window,
      rangeM: det.range,
      totalPasses: det.totalPasses,
      dupPasses: det.dupPasses,
      flowVehH_endWindow: +st.flowVehH.toFixed(1),
      meanKmh_end: +st.meanKmh.toFixed(1),
      densityVehKm_end: +st.densityVehKm.toFixed(1)
    };
  }),
  snapshotsCount: snapshots.length,
  snapshotsSample: snapshots.slice(Math.max(0, snapshots.length - 8))
};

console.log('=== DETECTOR TEST SUMMARY ===');
console.log(JSON.stringify(summary, null, 2));

if (summary.detectors.some(d => d.dupPasses > 0)) {
  console.log('\n[WARN] Detected duplicate crossings (same vehicle crossed same detector multiple times).');
  console.log('This can happen if vehicles are moved backward/teleported across detector (e.g., clamp effects).');
}
