// ring.js
// 3-trake kružna raskrsnica (ring road) bez inflow-a
// Kontrole:
// - Slider "Vozila / traka" (ringCountSlider)
// - Dugme "Random kočenje" (brakePulseBtn) -> maybeTriggerBreakPulse()

import {
  Road,
  spawnVehicle,
  stepNetwork,
  defaultIdmParams,
  defaultMobilParams,
} from './models.js';

import { initSeededRngFromUrl, rng01 } from './utils/rng.js';


let logData = null;
let lastSampleT = -1e9;
let lastTrajT = -1e9;

function safeText(id, txt) {
  const el = document.getElementById(id);
  if (el) el.textContent = txt;
}

export function runRoundabout() {
  const canvas = document.getElementById('simCanvas');
  const ctx = canvas.getContext('2d');

  safeText('scenarioValue', 'Krug');

  // Update naslov / opis
  const h1 = document.querySelector('h1');
  const info = document.getElementById('info');

  // Sakrij inflow kontrole i detektore (nisu bitni u ovom scenariju)
  const hideCtrlByChildId = (childId) => {
    const el = document.getElementById(childId);
    if (!el) return;
    const box = el.closest('.ctrl');
    if (box) box.style.display = 'none';
  };
  hideCtrlByChildId('mainInflowSlider');
  hideCtrlByChildId('rampInflowSlider');
  hideCtrlByChildId('det1Label');

  // Kontrole
  const pauseBtn = document.getElementById('pauseBtn');
  const resetBtn = document.getElementById('resetBtn');
  const simStatus = document.getElementById('simStatus');

  const countSlider = document.getElementById('ringCountSlider');
  const countValue = document.getElementById('ringCountValue');
  const brakeBtn = document.getElementById('brakePulseBtn');

  const v0Slider = document.getElementById('v0Slider');
  const TSlider  = document.getElementById('TSlider');
  const aSlider  = document.getElementById('aSlider');
  const bSlider  = document.getElementById('bSlider');
  const pSlider  = document.getElementById('pSlider');
  const thrSlider= document.getElementById('thrSlider');

  const v0Value = document.getElementById('v0Value');
  const TValue  = document.getElementById('TValue');
  const aValue  = document.getElementById('aValue');
  const bValue  = document.getElementById('bValue');
  const pValue  = document.getElementById('pValue');
  const thrValue= document.getElementById('thrValue');

  // ---------------------------
  // Model parametri
  // ---------------------------
  const idm = { ...defaultIdmParams };
  const mobil = { ...defaultMobilParams };

  // Postavi inicijalne vrijednosti slider-a (ako postoje)
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const setSlider = (sl, val) => { if (sl) { sl.value = String(val); sl.dispatchEvent(new Event('input')); } };

  if (v0Slider) { v0Slider.min = 40; v0Slider.max = 140; v0Slider.step = 1; }
  if (TSlider)  { TSlider.min = 0.8;  TSlider.max = 3.0;  TSlider.step = 0.1; }
  if (aSlider)  { aSlider.min = 0.3;  aSlider.max = 3.0;  aSlider.step = 0.1; }
  if (bSlider)  { bSlider.min = 0.5;  bSlider.max = 4.0;  bSlider.step = 0.1; }
  if (pSlider)  { pSlider.min = -0.4;  pSlider.max = 1.0;  pSlider.step = 0.01; }
  if (thrSlider){ thrSlider.min = 0.0;thrSlider.max = 1.0;thrSlider.step = 0.01; }

  // Default vrijednosti 
  setSlider(v0Slider, 110);
  setSlider(TSlider,  1.4);
  setSlider(aSlider,  1.0);
  setSlider(bSlider,  2.5);
  setSlider(pSlider,  0.1);
  setSlider(thrSlider,0.35);

  // Log dugmad (initLog se poziva kasnije nakon geometry+detectors init)
  const downloadBtn = document.getElementById('downloadLogBtn');
  const clearBtn = document.getElementById('clearLogBtn');
  if (downloadBtn) downloadBtn.addEventListener('click', downloadLog);
  if (clearBtn) clearBtn.addEventListener('click', clearLog);


  // ---------------------------
  // Ring geometrija (fizičke jedinice)
  // ---------------------------
  const laneCount = 3;
  const innerRadiusM = 95;   // unutrašnji rub kružnog toka
  const laneWidthM  = 5.8;   // širina trake (m)  (deblje trake)   // širina trake (m)  (deblje trake)
  const refRadiusM  = innerRadiusM + laneWidthM * (laneCount / 2); // referentni radijus za s
  const ringLengthM = 2 * Math.PI * refRadiusM;
/*
// ---------------------------
// Seeded RNG (isto kao u main.js, iz URL ?seed=...)
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

// helper for roundabout.js random usage (same rng as models)
let rand01 = () => rng();

function resetRng() {
  rng = makeMulberry32(hashSeed(seedValue));
  setRng(rng);
  rand01 = () => rng();
}*/

const rngCtl = initSeededRngFromUrl({ defaultSeed: 12345 });
const seedValue = rngCtl.seedValue;
const rand01 = rng01;

function resetRng() {
  rngCtl.resetRng();
}


// ---------------------------
// JSON logging (fokus: fantomska gužva / stop-and-go valovi)
// ---------------------------
const LOG_EVERY_SEC = 0.5;   // koliko često uzimamo "sample"
const TRAJ_EVERY_SEC = 0.5;  // koliko često logujemo trajektorije (s,v,lane) za sva vozila
const BIN_SIZE_M = 10;       // binovi za space-time heatmap (brzina/gustina po poziciji)
const JAM_V_KMH = 10;        // prag za "spora/zaustavljena" vozila -> detekcija gužve
const JAM_BIN_V_KMH = 25;     // prag (km/h) za jam binove (space–time)
const JAM_MIN_LEN_M = 20;      // minimalna dužina jamm-a (m) da ga smatramo prisutnim
const JAM_MIN_LEN_OFF_M = 10;  // histereza: jam nestaje tek kad padne ispod ovoga
const JAM_BIN_MIN_COUNT = 2;   // bin mora imati bar ovoliko vozila (ukupno preko traka)
const DET_RANGE_M = 50;      // +/- opseg oko virtualnog detektora za lokalnu gustinu/brzinu
const DET_WINDOW_SEC = 30;   // prozor za flow (vozila/h) po detektoru

const nBinsRing = Math.max(1, Math.ceil(ringLengthM / BIN_SIZE_M));

function circDist(a, b, L) {
  const d = Math.abs(a - b);
  return Math.min(d, L - d);
}

function crossedDetector(prevS, curS, detS, L) {
  if (prevS === undefined || prevS === null) return false;
  if (curS >= prevS) {
    return (prevS < detS && curS >= detS);
  } else {
    // wrap: treat detS possibly in [0, L) or shifted by +L
    const detU = (detS < prevS) ? (detS + L) : detS;
    return (prevS < detU && (curS + L) >= detU);
  }
}

function computeBinsRing(vehAll) {
  const cnt = Array.from({ length: laneCount }, () => new Array(nBinsRing).fill(0));
  const vSum = Array.from({ length: laneCount }, () => new Array(nBinsRing).fill(0));

  for (const v of vehAll) {
    const lane = v.lane | 0;
    const i = Math.max(0, Math.min(nBinsRing - 1, Math.floor(v.s / BIN_SIZE_M)));
    cnt[lane][i] += 1;
    vSum[lane][i] += v.v * 3.6;
  }

  const speedKmh = cnt.map((arr, lane) => arr.map((c, i) => c > 0 ? (vSum[lane][i] / c) : null));
  return { binSizeM: BIN_SIZE_M, nBins: nBinsRing, count: cnt, speedKmh };
}

function computeJamFromBins(bins) {
  // Jam detekcija iz space–time binova (robustnije od "spori veh" kad nema potpunog stajanja).
  // Označi bin kao "jam" ako je prosječna brzina mala i ima dovoljno vozila.
  const nBins = bins.nBins;
  const jamMask = new Array(nBins).fill(false);

  for (let i = 0; i < nBins; i++) {
    let cTot = 0;
    let vSum = 0;
    for (let ln = 0; ln < laneCount; ln++) {
      const c = bins.count[ln][i] | 0;
      const vk = bins.speedKmh[ln][i];
      if (c > 0 && vk !== null) {
        cTot += c;
        vSum += vk * c;
      }
    }
    if (cTot >= JAM_BIN_MIN_COUNT) {
      const vMean = vSum / cTot;
      if (vMean <= JAM_BIN_V_KMH) jamMask[i] = true;
    }
  }

  // Najduži uzastopni niz jam binova na kružnici
  let bestLen = 0;
  let bestEnd = -1;

  // dupliraj masku da uhvati wrap-around
  let curLen = 0;
  for (let i = 0; i < 2 * nBins; i++) {
    const isJam = jamMask[i % nBins];
    if (isJam) {
      curLen++;
      if (curLen > bestLen) {
        bestLen = curLen;
        bestEnd = i; // inclusive (u "duplom" indeksiranju)
      }
    } else {
      curLen = 0;
    }
  }

  // Clamp: niz preko nBins nema smisla (cijeli ring)
  bestLen = Math.min(bestLen, nBins);

  const jamLengthM = bestLen * bins.binSizeM;
  if (bestLen === 0) return { present: false, by: "bins", jamLengthM: 0, nJamBins: 0 };

  // start = end - len + 1 (u duplom prostoru), mapiraj na [0..nBins)
  const startIdx = ((bestEnd - bestLen + 1) % nBins + nBins) % nBins;
  const jamStartS = startIdx * bins.binSizeM;
  const jamCenterS = (jamStartS + jamLengthM * 0.5) % ringLengthM;

  return {
    present: jamLengthM >= JAM_MIN_LEN_M,
    by: "bins",
    nJamBins: bestLen,
    jamLengthM,
    jamStartS,
    jamCenterS
  };
}



function computeHeadways(vehAll) {
  // Returns per-lane headway histograms (time + space) to study stability/stop&go waves
  const lanes = Array.from({ length: laneCount }, () => []);
  for (const v of vehAll) {
    const ln = (v.lane | 0);
    if (ln >= 0 && ln < laneCount) lanes[ln].push(v);
  }
  for (const arr of lanes) arr.sort((a, b) => a.s - b.s);

  const timeBins = makeHistBins(0, 6, 30);   // 0..6s (fine enough)
  const gapBins = makeHistBins(0, 60, 30);   // 0..60m

  const perLane = [];
  for (let ln = 0; ln < laneCount; ln++) {
    const arr = lanes[ln];
    const n = arr.length;
    const timeHist = new Array(timeBins.n).fill(0);
    const gapHist = new Array(gapBins.n).fill(0);

    let meanTh = 0;
    let meanGap = 0;

    if (n >= 2) {
      for (let i = 0; i < n; i++) {
        const cur = arr[i];
        const nxt = arr[(i + 1) % n];
        let gap = nxt.s - cur.s;
        if (gap <= 0) gap += ringLengthM;
        // Note: vehicles are points -> "gap" is center distance; OK for analysis here.
        const v = Math.max(0.1, cur.v);  // m/s
        const th = Math.min(10, gap / v);

        meanTh += th;
        meanGap += gap;

        binInto(timeHist, timeBins, th);
        binInto(gapHist, gapBins, gap);
      }
      meanTh /= n;
      meanGap /= n;
    }

    perLane.push({
      lane: ln,
      n,
      timeHeadwaySec: { mean: meanTh, bins: timeBins, hist: timeHist },
      spaceGapM: { mean: meanGap, bins: gapBins, hist: gapHist }
    });
  }

  return { perLane };
}

function makeHistBins(min, max, n) {
  return { min, max, n, step: (max - min) / n };
}

function binInto(hist, bins, x) {
  if (x <= bins.min) { hist[0]++; return; }
  if (x >= bins.max) { hist[bins.n - 1]++; return; }
  const i = Math.max(0, Math.min(bins.n - 1, Math.floor((x - bins.min) / bins.step)));
  hist[i]++;
}

function computeJamMetrics(vehAll) {
  const slow = vehAll
    .filter(v => (v.v * 3.6) < JAM_V_KMH)
    .map(v => v.s)
    .sort((a, b) => a - b);

  const n = slow.length;
  if (n < 3) return { present: false, nSlow: n };

  // largest gap on circle -> complement is jam cluster length
  let maxGap = -1;
  let maxIdx = 0;
  for (let i = 0; i < n - 1; i++) {
    const g = slow[i + 1] - slow[i];
    if (g > maxGap) { maxGap = g; maxIdx = i; }
  }
  const wrapGap = (slow[0] + ringLengthM) - slow[n - 1];
  if (wrapGap > maxGap) { maxGap = wrapGap; maxIdx = n - 1; }

  const jamLengthM = Math.max(0, ringLengthM - maxGap);

  // jam starts right after the max gap
  const jamStart = slow[(maxIdx + 1) % n];
  const jamCenter = (jamStart + jamLengthM * 0.5) % ringLengthM;

  return {
    present: jamLengthM > 5,
    nSlow: n,
    jamLengthM,
    jamStartS: jamStart,
    jamCenterS: jamCenter
  };
}

function computeGlobal(vehAll) {
  const N = vehAll.length;
  const vArr = new Array(N);
  const aArr = new Array(N);
  const laneVSum = new Array(laneCount).fill(0);
  const laneCnt = new Array(laneCount).fill(0);

  for (let i = 0; i < N; i++) {
    const v = vehAll[i];
    const vk = v.v * 3.6;
    vArr[i] = vk;
    aArr[i] = (typeof v.acc === 'number') ? v.acc : 0;
    const ln = (v.lane | 0);
    if (ln >= 0 && ln < laneCount) {
      laneVSum[ln] += vk;
      laneCnt[ln] += 1;
    }
  }

  const vStats = basicStats(vArr);
  const aStats = basicStats(aArr);

  const densPerLane = laneCount ? (N / laneCount) / (ringLengthM / 1000) : 0;
  const densTotal = N / (ringLengthM / 1000);

  let nStopped = 0;
  let nHard = 0;
  for (let i = 0; i < N; i++) {
    if (vArr[i] < 0.5) nStopped += 1;        // ~0 km/h
    if (aArr[i] <= -4.0) nHard += 1;         // hard brake threshold
  }

  const laneMeanVKmh = laneVSum.map((s, i) => laneCnt[i] ? (s / laneCnt[i]) : 0);

  return {
    N,
    densPerLane,
    densTotal,
    speed: vStats,
    acc: aStats,
    stopFrac: N ? (nStopped / N) : 0,
    hardBrakeFrac: N ? (nHard / N) : 0,
    laneMeanVKmh
  };
}

function basicStats(arr) {
  const n = arr.length;
  if (!n) return { mean: 0, std: 0, min: 0, p10: 0, p50: 0, p90: 0, max: 0 };
  // copy + sort once (n is small ~ few hundred)
  const srt = arr.slice().sort((a, b) => a - b);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += srt[i];
  const mean = sum / n;
  let varSum = 0;
  for (let i = 0; i < n; i++) {
    const d = srt[i] - mean;
    varSum += d * d;
  }
  const std = Math.sqrt(varSum / n);
  const p10 = quantileSorted(srt, 0.10);
  const p50 = quantileSorted(srt, 0.50);
  const p90 = quantileSorted(srt, 0.90);
  return { mean, std, min: srt[0], p10, p50, p90, max: srt[n - 1] };
}

function quantileSorted(sortedArr, q) {
  const n = sortedArr.length;
  if (n === 0) return 0;
  const x = (n - 1) * q;
  const i0 = Math.floor(x);
  const i1 = Math.min(n - 1, i0 + 1);
  const t = x - i0;
  return sortedArr[i0] * (1 - t) + sortedArr[i1] * t;
}

function makeDetector(label, sDet) {
  return {
    label,
    sDet,
    passTimes: [],
    totalPasses: 0,
    last: null
  };
}

const detectors = [
  makeDetector('D0', 0),
  makeDetector('D1', ringLengthM * 0.25),
  makeDetector('D2', ringLengthM * 0.5),
  makeDetector('D3', ringLengthM * 0.75)
];

  // Sad kad su geometry + detectors spremni, inicijalizuj log
  initLog();
  updateLogInfo();


function updateDetectors(tNow, vehAll, prevSById) {
  // prune times
  const cutoff = tNow - DET_WINDOW_SEC;
  for (const d of detectors) {
    while (d.passTimes.length && d.passTimes[0] < cutoff) d.passTimes.shift();
  }

  // crossing events
  for (const v of vehAll) {
    const prevS = prevSById.get(v.id);
    for (const d of detectors) {
      if (crossedDetector(prevS, v.s, d.sDet, ringLengthM)) {
        d.passTimes.push(tNow);
        d.totalPasses += 1;
        logPassage(tNow, d.label, v);
      }
    }
  }

  // local density/speed around detector
  for (const d of detectors) {
    const laneCnt = new Array(laneCount).fill(0);
    const laneVsum = new Array(laneCount).fill(0);

    for (const v of vehAll) {
      const dist = circDist(v.s, d.sDet, ringLengthM);
      if (dist <= DET_RANGE_M) {
        laneCnt[v.lane] += 1;
        laneVsum[v.lane] += v.v * 3.6;
      }
    }

    const laneSpeedKmh = laneCnt.map((c, i) => c ? laneVsum[i] / c : null);
    const segKm = (2 * DET_RANGE_M) / 1000;
    const laneDensityVehKm = laneCnt.map(c => segKm > 0 ? (c / segKm) : 0);

    const flowVehH = (d.passTimes.length / Math.max(1e-6, DET_WINDOW_SEC)) * 3600;

    d.last = {
      t: tNow,
      flowVehH,
      laneSpeedKmh,
      laneDensityVehKm
    };
  }
}


function initLog() {
  logData = {
    meta: {
      scenario: 'roundabout',
      seed: seedValue,
      createdAt: new Date().toISOString(),

      // Simulation timing (actual dt varies with rAF; we cap it in the loop)
      dtTarget: 0.04,
      dtCap: 0.15,

      logEverySec: LOG_EVERY_SEC,
      trajEverySec: TRAJ_EVERY_SEC,

      ring: { lengthM: ringLengthM, laneCount },
      geometry: { innerRadiusM, laneWidthM, refRadiusM },

      model: {
        idm: { a: idm.a, b: idm.b, v0: idm.v0, T: idm.T, s0: idm.s0 },
        mobil: { politeness: mobil.p, bSafe: mobil.bSafe, threshold: mobil.threshold, biasRight: mobil.bBiasRight }
      },

      jam: { vehSpeedThrKmh: JAM_V_KMH, binSpeedThrKmh: JAM_BIN_V_KMH, minLenM: JAM_MIN_LEN_M, minLenOffM: JAM_MIN_LEN_OFF_M, binMinCount: JAM_BIN_MIN_COUNT },

      bins: { binSizeM: BIN_SIZE_M, nBins: nBinsRing },
      detectors: {
        rangeM: DET_RANGE_M,
        windowSec: DET_WINDOW_SEC,
        positionsS: detectors.map(d => ({ label: d.label, sDet: d.sDet }))
      }
    },

    samples: [],
    events: [],
    passages: [],
    traj: []
  };

  lastSampleT = -1e9;
  lastTrajT = -1e9;
}

function logEvent(type, tNow, payload = {}) {
  if (!logData || !logData.events) return;
  logData.events.push({ t: tNow, type, ...payload });
}

function logPassage(tNow, detLabel, veh) {
  // passages služe za N-curves / outflow / delay analize
  // čuvamo minimalan skup polja da JSON ostane mali
  if (!logData || !logData.passages) return;
  logData.passages.push({
    t: tNow,
    det: detLabel,
    id: veh.id,
    lane: veh.lane,
    s: veh.s,
    vKmh: veh.v * 3.6
  });
}


function logSample(tNow, vehAll) {
  // global + bins + detectors + jam metrics
  const global = computeGlobal(vehAll);
  const bins = computeBinsRing(vehAll);
  const detObj = {};
  const detTotals = {};
  for (const d of detectors) {
    detObj[d.label] = d.last ? { ...d.last } : null;
    detTotals[d.label] = d.totalPasses;
  }
  const jamVeh = computeJamMetrics(vehAll);
  const jamBins = computeJamFromBins(bins);
  const jam = {
    present: jamVeh.present || jamBins.present,
    // prefer longer jam length if both exist
    jamLengthM: Math.max(jamVeh.jamLengthM || 0, jamBins.jamLengthM || 0),
    jamStartS: (jamBins.present ? jamBins.jamStartS : jamVeh.jamStartS),
    jamCenterS: (jamBins.present ? jamBins.jamCenterS : jamVeh.jamCenterS),
    nSlow: jamVeh.nSlow || 0,
    by: { veh: jamVeh, bins: jamBins }
  };
  const headways = computeHeadways(vehAll);

  logData.samples.push({
    t: tNow,
    global,
    jam,
    headways,
    detectors: detObj,
    detectorTotals: detTotals,
    bins
  });
  return jam;
}

function logTraj(tNow, vehAll) {
  const ids = new Array(vehAll.length);
  const s = new Array(vehAll.length);
  const v = new Array(vehAll.length);
  const lane = new Array(vehAll.length);

  for (let i = 0; i < vehAll.length; i++) {
    const vv = vehAll[i];
    ids[i] = vv.id;
    s[i] = vv.s;
    v[i] = vv.v * 3.6; // km/h
    lane[i] = vv.lane;
  }

  logData.traj.push({
    t: tNow,
    traj: { ids, s, vKmh: v, lane }
  });
}

function updateLogInfo() {
  const el = document.getElementById('logInfo');
  if (!el || !logData) return;
  const trajN = logData.traj ? logData.traj.length : 0;
  el.textContent = `Samples: ${logData.samples.length} | Traj: ${trajN} | Events: ${logData.events.length} | Seed: ${seedValue}`;
}

function downloadLog() {
  if (!logData) return;
  const blob = new Blob([JSON.stringify(logData)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `phantomflow_roundabout_seed-${seedValue}_${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function clearLog() {
  initLog();
  updateLogInfo();
}

  // Skala za crtanje
  const outerRadiusM = innerRadiusM + laneWidthM * laneCount;
  const pxPerM_target = 4.5; // laneWidthM=4 -> ~18px like main.js
  const pxPerM_fit = (Math.min(canvas.width, canvas.height) * 0.5 - 40) / outerRadiusM;
  const pxPerM = Math.min(pxPerM_target, pxPerM_fit);
  const cx = canvas.width  * 0.5;
  const cy = canvas.height * 0.55;

  const radiusPx = (rM) => rM * pxPerM;

  // ---------------------------
  // Network
  // ---------------------------
  const main = new Road({
    id: 'main',
    length: ringLengthM,
    laneCount,
    isRing: true,
    speedProfile: null
  });

  const ramp = new Road({
    id: 'ramp',
    length: 1,
    laneCount: 1,
    isRing: false,
    speedProfile: null
  });

  const net = {
    time: 0,
    roads: { main, ramp },
    // merge ne koristimo, ali stepNetwork očekuje da postoji
    merge: { toLane: 0, toS: 0, triggerRampS: 0, regionHalfLength: 0, tryCount: 0 },

    // heterogenost vozila
    hetero: {
      truckFraction: 0.12,
      v0Spread: 0.18,
      truckV0Mult: 0.78,
      truckLength: 7.5,
      carLength: 4.5
    },

    // stochastic acceleration noise (set 0 for reproducible stable flow until user brake pulse)
    noiseAmp: 0.0,


    // phantom auto-pulse isključen (mi ručno triggerujemo)
    phantom: {
      enabled: false,
      pulseEvery: 1e9,
      pulseDuration: 0,
      pulseDecel: 0,
      nextPulseTime: 1e9
    }
  };

  const idCounter = { nextId: 1 };

function buildVehicles(perLane) {
  // reset stanja
  net.time = 0;
  idCounter.nextId = 1;
  main.lanes = Array.from({ length: laneCount }, () => []);

  const L = main.length;
  const n = Math.max(0, perLane | 0);
  if (n === 0) return;

  // Ravnomjeran razmak U SVAKOJ TRACI (bez startne gužve),
  // plus mali "phase" po traci da vozila ne budu tačno poravnata između traka
  const spacing = L / n;

  // Ako je spacing premali u odnosu na minimalni razmak + dužinu auta,
  // gužva je fizički neizbježna (fundamental diagram), pa samo upozorimo.
  const minWanted = (idm.s0 ?? 4.0) + 4.5 + 1.0;
  if (spacing < minWanted) {
    console.warn(
      `[roundabout] perLane=${n} je prevelik za dužinu kruga (spacing=${spacing.toFixed(2)}m < ${minWanted.toFixed(2)}m). ` +
      `Početna gužva je očekivana.`
    );
  }

  for (let lane = 0; lane < laneCount; lane++) {
    // fazni pomak da se između traka ne formiraju "kolone" koje izazivaju agresivno prestrojavanje
    const phase = (lane / laneCount) * (0.7 * spacing);

    for (let k = 0; k < n; k++) {
      const s = (k * spacing + phase) % L;

      // Kreni blizu željene brzine, da ne "nabija" odmah u druge
      const vInit = idm.v0 * 0.9 * (0.95 + 0.10 * rand01());

      const veh = spawnVehicle(net, main, { id: idCounter.nextId++, lane, s, v: vInit });
      // za lane_change logovanje
      veh.prevLane = lane;
    }
  }
/*
        for (let lane = 0; lane < laneCount; lane++) {
          for (let k = 0; k < n; k++) {
            // mali offset po traci da se ne poklope baš svi
            const s = (k / n) * L + lane * 0.5;
            const vInit = idm.v0 * 0.55 * (0.9 + 0.2 * Math.random());
            spawnVehicle(net, main, { id: idCounter.nextId++, lane, s, v: vInit });
          }
        }
*/
  main.sortLanes();
}


  // ---------------------------
  // Manualni brake pulse
  // ---------------------------
  function maybeTriggerBreakPulse() {
    const vehs = [];
    for (let l = 0; l < laneCount; l++) vehs.push(...main.lanes[l]);
    if (vehs.length === 0) return;

    const pick = vehs[(rand01() * vehs.length) | 0];
    const duration = 2.0 + 1.0 * rand01();
    const decel = -6.0 - 2.0 * rand01(); // m/s^2

    pick.extraBrake = decel;
    pick.brakeUntil = net.time + duration;

    return { id: pick.id, lane: pick.lane, s: pick.s, duration, decel };
  }

  // expose for debugging / manual calls
  window.maybeTriggerBreakPulse = maybeTriggerBreakPulse;

  // ---------------------------
  // UI binding
  // ---------------------------
  if (countSlider) {
    // Forsiraj početnu vrijednost sa HTML defaulta (sprječava Chrome restore na staru vrijednost)
    const dvRaw = (countSlider.defaultValue || countSlider.getAttribute('value') || '20');
    const dv = parseInt(dvRaw, 10);
    countSlider.value = String(Number.isFinite(dv) && dv > 0 ? dv : 20);
    const updateLabel = () => { if (countValue) countValue.textContent = String(countSlider.value); };
    updateLabel();

    countSlider.addEventListener('input', () => {
      updateLabel();
      resetRng(); clearLog(); buildVehicles(parseInt(countSlider.value, 10));
    });
  }

  if (brakeBtn) {
    brakeBtn.addEventListener('click', () => {
      const info = maybeTriggerBreakPulse();
      if (info) logEvent('brake_pulse', net.time, { ...info, trigger: 'user' });
      updateLogInfo();
    });
  }

  let running = true;
  if (pauseBtn) {
    pauseBtn.addEventListener('click', () => {
      running = !running;
      pauseBtn.textContent = running ? 'Pause' : 'Resume';
      if (simStatus) simStatus.textContent = running ? 'RUN' : 'PAUSE';
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      const n = countSlider ? parseInt(countSlider.value, 10) : 20;
      resetRng(); clearLog(); buildVehicles(n);
    });
  }

  // Param sliders -> update idm/mobil
  const setText = (el, s) => { if (el) el.textContent = s; };

  if (v0Slider) v0Slider.addEventListener('input', () => {
    idm.v0 = parseFloat(v0Slider.value) / 3.6; // km/h -> m/s
    setText(v0Value, `${parseInt(v0Slider.value, 10)} km/h`);
  });
  if (TSlider) TSlider.addEventListener('input', () => {
    idm.T = parseFloat(TSlider.value);
    setText(TValue, `${idm.T.toFixed(1)} s`);
  });
  if (aSlider) aSlider.addEventListener('input', () => {
    idm.a = parseFloat(aSlider.value);
    setText(aValue, `${idm.a.toFixed(1)} m/s²`);
  });
  if (bSlider) bSlider.addEventListener('input', () => {
    idm.b = parseFloat(bSlider.value);
    setText(bValue, `${idm.b.toFixed(1)} m/s²`);
  });
  if (pSlider) pSlider.addEventListener('input', () => {
    mobil.p = parseFloat(pSlider.value);
    setText(pValue, mobil.p.toFixed(2));
     console.log(`[roundabout][UI] mobil.p = ${mobil.p}`);
  });
  if (thrSlider) thrSlider.addEventListener('input', () => {
    mobil.bThr = parseFloat(thrSlider.value);
    setText(thrValue, mobil.bThr.toFixed(2));
    console.log(`[roundabout][UI] mobil.bThr = ${mobil.bThr}`);
  });

  // init labels based on defaults (dispatch will run listeners if sliders exist)
  // if slider doesn't exist, set reasonable defaults
  if (!v0Slider) { idm.v0 = 110 / 3.6; setText(v0Value, '110 km/h'); }
  if (!TSlider)  { idm.T = 1.4; setText(TValue, '1.4 s'); }
  if (!aSlider)  { idm.a = 1.0; setText(aValue, '1.0 m/s²'); }
  if (!bSlider)  { idm.b = 2.5; setText(bValue, '2.5 m/s²'); }
  if (!pSlider)  { mobil.p = 0.2; setText(pValue, '0.20'); }
  if (!thrSlider){ mobil.bThr = 0.35; setText(thrValue, '0.35'); }

  // Build initial
  const initialN = countSlider ? Math.max(0, parseInt(countSlider.value || '20', 10) || 0) : 20;
  if (countValue) countValue.textContent = String(initialN);
  resetRng(); clearLog(); buildVehicles(initialN);

  // ---------------------------
  // Render
  // ---------------------------
  function drawRoad() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // grass background (match main.js)
    ctx.fillStyle = '#4b7a33';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // match main.js look & feel: thick white border + gray asphalt + dashed lane markers
    const laneWidthPx = laneWidthM * pxPerM; // ~18px
    const edgeWidthPx = 4;

    const roadMidRpx = radiusPx(innerRadiusM + laneWidthM * laneCount / 2);
    const roadWidthPx = laneWidthPx * laneCount;

    ctx.save();
    ctx.translate(cx, cy);

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // outer border
    ctx.beginPath();
    ctx.arc(0, 0, roadMidRpx, 0, Math.PI * 2);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = roadWidthPx + 2 * edgeWidthPx;
    ctx.stroke();

    // asphalt
    ctx.beginPath();
    ctx.arc(0, 0, roadMidRpx, 0, Math.PI * 2);
    ctx.strokeStyle = '#555555';
    ctx.lineWidth = roadWidthPx;
    ctx.stroke();

    // dashed lane separators (between lanes)
    ctx.setLineDash([24, 18]);
    ctx.strokeStyle = '#dcdcdc';
    ctx.lineWidth = 2;
    for (let i = 1; i < laneCount; i++) {
      const r = radiusPx(innerRadiusM + laneWidthM * i);
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // subtle inner/outer highlight (optional)
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, radiusPx(innerRadiusM) + 1, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, radiusPx(innerRadiusM + laneWidthM * laneCount) - 1, 0, Math.PI * 2);
    ctx.stroke();

    ctx.restore();
  }

  function drawVehicles() {
    const vehAll = [];
    for (let l = 0; l < laneCount; l++) vehAll.push(...main.lanes[l]);

    // same color logic as main.js (speed ratio to desired v0)
    function speedColor(ratio) {
      if (ratio < 0.35) return '#d32f2f';
      if (ratio < 0.65) return '#fbc02d';
      return '#2e7d32';
    }

    for (const v of vehAll) {
      const s = v.s;
      const angle = (s / ringLengthM) * Math.PI * 2 - Math.PI / 2; // start at top
      const rM = innerRadiusM + laneWidthM * (v.lane + 0.5);
      const rPx = radiusPx(rM);

      const x = cx + rPx * Math.cos(angle);
      const y = cy + rPx * Math.sin(angle);

      const radius = 4;

      const v0loc = (idm.v0 || 1) * (v.v0Mult || 1);
      const ratio = v.v / v0loc;
      const fill = speedColor(ratio);

      ctx.beginPath();
      ctx.arc(x, y, radius, 0, 2 * Math.PI);
      ctx.fillStyle = fill;
      ctx.fill();

      ctx.lineWidth = 1;
      ctx.strokeStyle = '#000';
      ctx.stroke();

      // braking highlight (match main.js)
      if (v.acc < -1.0) {
        ctx.beginPath();
        ctx.arc(x, y, radius + 2, 0, 2 * Math.PI);
        ctx.strokeStyle = 'rgba(255,0,0,0.55)';
        ctx.lineWidth = 3;
        ctx.stroke();
      }
    }
  }

  function drawHud() {
    // simple HUD (top-left)
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(14, 14, 270, 84);
    ctx.fillStyle = '#fff';
    ctx.font = '12px system-ui, sans-serif';

    const vehAll = [];
    for (let l = 0; l < laneCount; l++) vehAll.push(...main.lanes[l]);

    let vMean = 0;
    for (const v of vehAll) vMean += v.v;
    vMean = vehAll.length ? vMean / vehAll.length : 0;

    const dens = vehAll.length / (ringLengthM / 1000); // veh/km (ukupno)
    ctx.fillText(`t = ${net.time.toFixed(1)} s`, 26, 36);
    ctx.fillText(`Vozila ukupno: ${vehAll.length} (3 trake)`, 26, 54);
    ctx.fillText(`Prosj. brzina: ${(vMean * 3.6).toFixed(1)} km/h`, 26, 72);
    ctx.fillText(`Gustina (ukupno): ${dens.toFixed(1)} veh/km`, 26, 90);

    ctx.restore();
  }

  // ---------------------------
  // Loop
  // ---------------------------

// helpers for logging detectors/events
let prevSById = null;
const hardBrakeState = new Map(); // id -> bool
let jamPrevPresent = false;

  let lastTs = null;

// ===== DEBUG: periodični ispis parametara =====
let lastParamPrintT = -1e9;
const PARAM_PRINT_EVERY_SEC = 2.0; // ispis svake 2 sekunde simulacije
let lastLcCount = 0;


  function loop(ts) {
    if (lastTs === null) lastTs = ts;
    const dtReal = (ts - lastTs) / 1000;
    lastTs = ts;

    if (running) {
      const dtSim = clamp(dtReal, 0, 0.15);

// snapshot prethodne pozicije (za detektore / crossing)
const vehAllBefore = main.allVehicles();


prevSById = new Map();
for (const v of vehAllBefore) prevSById.set(v.id, v.s);
      const h = 0.04; // substep
      const nSteps = Math.max(1, Math.ceil(dtSim / h));
      for (let i = 0; i < nSteps; i++) stepNetwork(net, idm, mobil, dtSim / nSteps);
    }


// ---- logging & detectors ----
const vehAll = main.allVehicles();

// ===== DEBUG: inicijalizuj prevLane ako nije postavljen (da lane-change log radi) =====
for (const v of vehAll) {
  if (v.prevLane === undefined || v.prevLane === null) v.prevLane = v.lane;
}

// ===== DEBUG: periodični ispis parametara + raspodjela po trakama + lane-change count =====
if ((net.time - lastParamPrintT) >= PARAM_PRINT_EVERY_SEC) {
  const laneCnt = new Array(laneCount).fill(0);
  for (const v of vehAll) laneCnt[v.lane]++;

  // koliko lane_change eventova imamo do sada (ako log radi)
  const lcTotal = (logData && logData.events)
    ? logData.events.filter(e => e.type === 'lane_change').length
    : 0;

  const lcDelta = lcTotal - lastLcCount;
  lastLcCount = lcTotal;

  console.log(
    `[roundabout][t=${net.time.toFixed(1)}] ` +
    `MOBIL{p=${mobil.p}, bThr=${mobil.bThr}, bSafe=${mobil.bSafe}, bBiasRight=${mobil.bBiasRight}} ` +
    `IDM{v0=${(idm.v0*3.6).toFixed(1)}km/h, T=${idm.T}, a=${idm.a}, b=${idm.b}} ` +
    `laneCnt=[${laneCnt.join(', ')}] ` +
    `laneChange+${lcDelta}`
  );

  lastParamPrintT = net.time;
}

// update detectors using prev positions captured before step
if (prevSById) updateDetectors(net.time, vehAll, prevSById);

// lane-change & hard-brake events
for (const v of vehAll) {
  if (v.prevLane !== undefined && v.prevLane !== null && v.prevLane !== v.lane) {
    logEvent('lane_change', net.time, {
      id: v.id,
      from: v.prevLane,
      to: v.lane,
      s: v.s,
      vKmh: v.v * 3.6
    });
    // prevent repeated logging
    v.prevLane = v.lane;
  }

  const wasHard = hardBrakeState.get(v.id) === true;
  const isHard = (v.acc <= -4.0);
  if (!wasHard && isHard) {
    logEvent('hard_brake', net.time, { id: v.id, lane: v.lane, s: v.s, acc: v.acc, vKmh: v.v * 3.6 });
    hardBrakeState.set(v.id, true);
  } else if (wasHard && !isHard) {
    hardBrakeState.set(v.id, false);
  }
}


// periodic samples 
if ((net.time - lastSampleT) >= LOG_EVERY_SEC) {
  const jamNow = logSample(net.time, vehAll);
  const jamLen = (jamNow && typeof jamNow.jamLengthM === 'number') ? jamNow.jamLengthM : 0;
  const jamPresentNow = jamPrevPresent ? (jamLen >= JAM_MIN_LEN_OFF_M) : (jamLen >= JAM_MIN_LEN_M);

  if (!jamPrevPresent && jamPresentNow) logEvent('jam_on', net.time, jamNow);
  if (jamPrevPresent && !jamPresentNow) logEvent('jam_off', net.time, jamNow);
  jamPrevPresent = jamPresentNow;

  lastSampleT = net.time;
  updateLogInfo();
}
if ((net.time - lastTrajT) >= TRAJ_EVERY_SEC) {
  logTraj(net.time, vehAll);
  lastTrajT = net.time;
  updateLogInfo();
}

    drawRoad();
    drawVehicles();
    drawHud();

    requestAnimationFrame(loop);
  }

  requestAnimationFrame(loop);
}