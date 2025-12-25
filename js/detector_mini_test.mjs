// detector_mini_test.mjs
// Run example:
//   node detector_mini_test.mjs --seed demo --tEnd 240 --dt 0.05 --main 1600 --ramp 600 --repeat 2
//
// What it does:
// - Runs the sim headless (no canvas)
// - Places D1 before merge, D2 after merge but before curve, D3 after curve
// - Computes travel-time stats between detectors
// - Repeats run to verify determinism for same seed

import * as M from './models.js';

const {
  createNetwork,
  stepNetwork,
  trySpawnMain,
  trySpawnRamp,
  defaultIdmParams,
  defaultMobilParams
} = M;

// ---------------------------
// CLI parse
// ---------------------------
function getArg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return def;
}

const seedRaw = getArg('seed', 'demo');
const tEnd = Number(getArg('tEnd', '240'));
const dt = Number(getArg('dt', '0.05'));
const mainInflowPerHour = Number(getArg('main', '1600'));
const rampInflowPerHour = Number(getArg('ramp', '600'));
const repeat = Number(getArg('repeat', '2'));

// ---------------------------
// Seeded RNG (Mulberry32)
// ---------------------------
function hashSeed(seed) {
  if (seed == null) return 0x12345;
  if (Number.isFinite(seed)) return (Number(seed) >>> 0);

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

// ---------------------------
// Stats helpers
// ---------------------------
function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] === undefined) return sorted[base];
  return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
}

function stats(arr) {
  if (!arr.length) {
    return { count: 0, min: 0, mean: 0, median: 0, p90: 0, p95: 0, max: 0 };
  }
  const a = [...arr].sort((x, y) => x - y);
  const sum = a.reduce((s, x) => s + x, 0);
  return {
    count: a.length,
    min: a[0],
    mean: sum / a.length,
    median: quantile(a, 0.5),
    p90: quantile(a, 0.9),
    p95: quantile(a, 0.95),
    max: a[a.length - 1]
  };
}

// Small deterministic "fingerprint" for comparison between runs
function fingerprintOf(summary) {
  // Make it robust: use counts + key means (rounded)
  const parts = [];
  parts.push(`tEnd=${summary.tEnd}`);
  parts.push(`main=${summary.inflow.mainInflowPerHour}`);
  parts.push(`ramp=${summary.inflow.rampInflowPerHour}`);
  for (const d of summary.detectors) {
    parts.push(`${d.label}@${Math.round(d.s)}:passes=${d.totalPasses}`);
  }
  const tt = summary.travelTimes;
  parts.push(`D1D2_mean=${tt.D1_to_D2.mean.toFixed(3)}`);
  parts.push(`D2D3_mean=${tt.D2_to_D3.mean.toFixed(3)}`);
  parts.push(`D1D3_mean=${tt.D1_to_D3.mean.toFixed(3)}`);
  return parts.join('|');
}

// ---------------------------
// Detector logic (crossing-based)
// ---------------------------
function makeDetector(label, s) {
  return {
    label,
    s,
    totalPasses: 0
  };
}

function crossed(prevS, curS, sDet) {
  return (typeof prevS === 'number') && prevS < sDet && curS >= sDet;
}

// ---------------------------
// One simulation run
// ---------------------------
function runOnce(seedStr) {
  const rng = makeMulberry32(hashSeed(seedStr));
  const rand01 = () => rng();

  // If your models.js supports setRng, use it (so lane-changing randomness etc. is seeded too)
  if (typeof M.setRng === 'function') {
    M.setRng(rng);
  } else {
    // Not fatal, but determinism may be weaker if models.js still uses Math.random internally.
    // You said you already seed-replaced, so this should exist in your version.
    // Keeping warning to help debug quickly.
    // eslint-disable-next-line no-console
    console.warn('[WARN] models.js has no setRng(). If it still uses Math.random internally, results may vary run-to-run.');
  }

  const NET_CONFIG = {
    mainLength: 920,
    mainLaneCount: 3,
    rampLength: 125,

    // you already tuned mergeMainS in main.js:
    mergeMainS: 267,
    mergeMainLane: 2,
    mergeTriggerRampS: 110,

    curveStartS: 360,
    curveLength: 200,
    curveFactor: 0.70,
    postCurveLength: 80,
    postCurveFactor: 0.85
  };

  const net = createNetwork(NET_CONFIG);

  // Detector positions (by rule, not hard-coded numbers)
  const mergeS = net.merge.toS;
  const curveStart = NET_CONFIG.curveStartS;
  const curveEnd = NET_CONFIG.curveStartS + NET_CONFIG.curveLength;

  // D1: before merge
  const D1 = makeDetector('D1', Math.max(10, mergeS - 60));

  // D2: after merge but before curve
  // keep it comfortably after merge, but don't go into curve
  const D2 = makeDetector('D2', Math.min(curveStart - 40, mergeS + 60));

  // D3: after curve exit (just after curve end)
  const D3 = makeDetector('D3', Math.min(net.roads.main.length - 10, curveEnd + 20));

  const detectors = [D1, D2, D3];

  // Sanity checks (printable in summary)
  const placement = {
    mergeS,
    curveStart,
    curveEnd,
    ok: {
      D1_before_merge: D1.s < mergeS,
      D2_after_merge: D2.s > mergeS,
      D2_before_curve: D2.s < curveStart,
      D3_after_curve: D3.s > curveEnd
    }
  };

  const idmParams = { ...defaultIdmParams };
  const mobilParams = { ...defaultMobilParams };

  const idCounter = { nextId: 0 };

  let mainAcc = new Array(net.roads.main.laneCount).fill(0);
  let rampAcc = 0;

  function spawnMainVehicles() {
    const totalRatePerSec = mainInflowPerHour / 3600;
    if (totalRatePerSec <= 0) return;
    const laneRatePerSec = totalRatePerSec / net.roads.main.laneCount;
    const sSpawn = 10;

    for (let lane = 0; lane < net.roads.main.laneCount; lane++) {
      mainAcc[lane] += laneRatePerSec * dt;
      while (mainAcc[lane] >= 1.0) {
        const vInit = idmParams.v0 * (0.85 + 0.35 * rand01());
        const ok = trySpawnMain(net, lane, sSpawn, vInit, idCounter, 7);
        if (!ok) break;
        mainAcc[lane] -= 1.0;
      }
    }
  }

  function spawnRampVehicles() {
    const ratePerSec = rampInflowPerHour / 3600;
    if (ratePerSec <= 0) return;
    rampAcc += ratePerSec * dt;

    while (rampAcc >= 1.0) {
      const vInit = idmParams.v0 * (0.55 + 0.25 * rand01());
      const ok = trySpawnRamp(net, 0, vInit, idCounter, 9);
      if (!ok) break;
      rampAcc -= 1.0;
    }
  }

  // Travel-time tracking:
  // Record the time each vehicle crosses each detector (first time only)
  const tCross = {
    D1: new Map(),
    D2: new Map(),
    D3: new Map()
  };

  const tt_D1_D2 = [];
  const tt_D2_D3 = [];
  const tt_D1_D3 = [];

  const steps = Math.floor(tEnd / dt);
  for (let k = 0; k < steps; k++) {
    spawnMainVehicles();
    spawnRampVehicles();

    stepNetwork(net, idmParams, mobilParams, dt);
    const t = net.time;

    const mainVeh = net.roads.main.allVehicles();

    for (const v of mainVeh) {
      const prevS = v.prevS;
      const curS = v.s;
      const id = v.id;

      // D1
      if (!tCross.D1.has(id) && crossed(prevS, curS, D1.s)) {
        tCross.D1.set(id, t);
        D1.totalPasses++;
      }
      // D2
      if (!tCross.D2.has(id) && crossed(prevS, curS, D2.s)) {
        tCross.D2.set(id, t);
        D2.totalPasses++;

        const t1 = tCross.D1.get(id);
        if (typeof t1 === 'number') tt_D1_D2.push(t - t1);
      }
      // D3
      if (!tCross.D3.has(id) && crossed(prevS, curS, D3.s)) {
        tCross.D3.set(id, t);
        D3.totalPasses++;

        const t2 = tCross.D2.get(id);
        if (typeof t2 === 'number') tt_D2_D3.push(t - t2);

        const t1 = tCross.D1.get(id);
        if (typeof t1 === 'number') tt_D1_D3.push(t - t1);
      }
    }
  }

  const summary = {
    seed: seedStr,
    tEnd,
    dt,
    inflow: { mainInflowPerHour, rampInflowPerHour },
    placement,
    detectors: detectors.map(d => ({ label: d.label, s: d.s, totalPasses: d.totalPasses })),
    travelTimes: {
      D1_to_D2: stats(tt_D1_D2),
      D2_to_D3: stats(tt_D2_D3),
      D1_to_D3: stats(tt_D1_D3)
    }
  };

  return { summary, fingerprint: fingerprintOf(summary) };
}

// ---------------------------
// Run (repeat) + compare
// ---------------------------
const runs = [];
for (let i = 0; i < repeat; i++) {
  runs.push(runOnce(seedRaw));
}

console.log('=== DETECTOR MINI TEST ===');
console.log(JSON.stringify(runs[0].summary, null, 2));
console.log('fingerprint[0]:', runs[0].fingerprint);

if (runs.length >= 2) {
  let allSame = true;
  for (let i = 1; i < runs.length; i++) {
    console.log(`fingerprint[${i}]:`, runs[i].fingerprint);
    if (runs[i].fingerprint !== runs[0].fingerprint) allSame = false;
  }
  console.log('same-seed deterministic across repeats:', allSame);
}
