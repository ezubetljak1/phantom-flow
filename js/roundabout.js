// roundabout.js


import { Road, spawnVehicle, defaultIdmParams, accACC } from './models.js';
import { initSeededRngFromUrl, rng01 } from './utils/rng.js';

let usePerDirInflow = true; // <— uključi za D1

// SIMULACIONI SLUCAJ D1
// total: 1800 veh/h
// D1-0 simetricno                        450 450 450 450
// D1-1 jedan dominantni                  900 300 300 300
// D1-2 dva dominantna susjeda            700 700 200 200
// D1-3 NS dominantan ali asimetricno     350 700 350 400
// D1-4 jaka asimetrija                   800 100 800 100

let inflowByDir = { E: 800, N: 100, W: 800, S: 100 }; // veh/h (primjer)

// ---------------------------
// Small helpers
// ---------------------------
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

function forwardDist(sFrom, sTo, L) {
  let d = sTo - sFrom;
  if (d < 0) d += L;
  return d;
}

function crossedForward(prevS, curS, s0, L) {
  if (prevS === curS) return false;
  const dPrevToCur = forwardDist(prevS, curS, L);
  const dPrevToS0 = forwardDist(prevS, s0, L);
  return dPrevToS0 > 0 && dPrevToS0 <= dPrevToCur;
}

function downloadJson(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function safeText(id, txt) {
  const el = document.getElementById(id);
  if (el) el.textContent = txt;
}

function showBlock(id, show) {
  const el = document.getElementById(id);
  if (el) el.style.display = show ? '' : 'none';
}

// ---------------------------
// IDM + ACC (kept local to match models.js behaviour style-wise)
// ---------------------------
function localIdmParamsForVeh(base, veh) {
  return { ...base, v0: base.v0 * (veh?.v0Mult ?? 1.0) };
}

function sampleStraight(A, B, stepM = 2.0) {
  const dx = B.x - A.x, dy = B.y - A.y;
  const L = Math.hypot(dx, dy);
  const n = Math.max(2, Math.ceil(L / stepM));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push({ x: A.x + dx * t, y: A.y + dy * t });
  }
  return pts;
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

// ---------------------------
// Main entry
// ---------------------------
export function runRoundaboutTreiber() {
  // Canvas + UI
  const canvas = document.getElementById('simCanvas');
  if (!canvas) throw new Error('Missing #simCanvas');
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;

  // Scenario label (if exists)
  const h1 = document.querySelector('h1');
  safeText('scenarioValue', 'Kružna (Treiber)');

  // Controls visibility: hide ringCtrl (old roundabout), show treiberCtrl if present
  showBlock('ringCtrl', false);
  showBlock('treiberCtrl', true);


  // Det labels (if exist)
  safeText('det1Label', 'Ring D1');
  safeText('det2Label', 'Ring D2');
  safeText('det3Label', 'Ring D3');

  // Seeded RNG shared
  const rngCtl = initSeededRngFromUrl({ defaultSeed: 12345 });

  // ---------------------------
  // Geometry (world meters) -> canvas pixels (like roundabout.js)
  // We design a "proper" roundabout: ring + separated entry/exit roads with curved connectors.
  // ---------------------------
  const laneWidthM = 5.8;
  const edgeWidthPx = 4;    // like main.js

  const ringInnerRadiusM = 22.0;
  const ringRefRadiusM   = ringInnerRadiusM + laneWidthM * 0.5; // centerline radius
  const ringOuterRadiusM = ringInnerRadiusM + laneWidthM;

  const armLenM   = 85.0;   // approach/exit length (incl. curve)
  const curveLenM = 30.0;   // last part bends into/out of ring
  const sepM      = laneWidthM * 1.65; // separation between entry and exit centerlines
  const alpha     = 0.38;   // entry/exit shift relative to arm axis

  // scale (same style as roundabout.js)
  const outerExtentM = ringOuterRadiusM + armLenM + 8;
  const pxPerM_target = 4.5;
  const pxPerM_fit = (Math.min(W, H) * 0.5 - 40) / outerExtentM;
  const pxPerM = Math.min(pxPerM_target, pxPerM_fit);
  const cx = W * 0.5;
  const cy = H * 0.55;

  function w2c(xm, ym) { return { x: cx + xm * pxPerM, y: cy - ym * pxPerM }; }

  // ---------------------------
  // Arm definitions (0:E, 1:N, 2:W, 3:S), CCW angles
  // ---------------------------
  const arms = [
    { name: 'E', theta: 0 },
    { name: 'N', theta: Math.PI / 2 },
    { name: 'W', theta: Math.PI },
    { name: 'S', theta: (3 * Math.PI) / 2 },
  ];

  function dir(theta) { return { x: Math.cos(theta), y: Math.sin(theta) }; }

// CW normal (desna strana u odnosu na smjer kretanja ka centru)
function perpCW(u) { return { x: u.y, y: -u.x }; }

// Straight-only geometry (bez Bezier krivulja)
const attachRadiusM = ringOuterRadiusM + 1.5;   // gdje “dolazi” cesta do kružnog
const geom = arms.map((a) => {
  const u = dir(a.theta);        // osa kraka (od centra prema van)
  const n = perpCW(u);           // “desno” u odnosu na kretanje ka centru

  // Ulazna traka treba biti desno (gledano u smjeru kretanja ka centru),
  // izlazna lijevo -> zato su offseti suprotni.
  const entryOff = { x: -n.x * (sepM * 0.5), y: -n.y * (sepM * 0.5) };
const exitOff  = { x:  n.x * (sepM * 0.5), y:  n.y * (sepM * 0.5) };

 // const temp = entryOff;
 // entryOff = exitOff;
 // exitOff = temp;

  const exitTheta  = a.theta - alpha;
  const entryTheta = a.theta + alpha;

  // FAR i NEAR tačke (svijet/world koordinate, centar kružnog je (0,0))
  const P_entryFar  = { x: u.x * (attachRadiusM + armLenM) + entryOff.x, y: u.y * (attachRadiusM + armLenM) + entryOff.y };
  const P_entryNear = { x: u.x * attachRadiusM + entryOff.x,            y: u.y * attachRadiusM + entryOff.y };

  const P_exitNear  = { x: u.x * attachRadiusM + exitOff.x,             y: u.y * attachRadiusM + exitOff.y };
  const P_exitFar   = { x: u.x * (attachRadiusM + armLenM) + exitOff.x, y: u.y * (attachRadiusM + armLenM) + exitOff.y };

  // Za crtanje koristimo sample-ovane ravne linije
  const entryCenterline = sampleStraight(P_entryFar, P_entryNear, 2.0);
  const exitCenterline  = sampleStraight(P_exitNear, P_exitFar, 2.0);

  return {
    u,
    entryTheta,
    exitTheta,
    entryOff,
    exitOff,
    P_entryFar,
    P_entryNear,
    P_exitNear,
    P_exitFar,
    entryCenterline,
    exitCenterline,
  };
});


  // ---------------------------
  // Model + roads
  // ---------------------------
  const idm = { ...defaultIdmParams };
  idm.v0 = 17.0;  // ~60 km/h
  idm.T  = 1.3;
  idm.a  = 0.9;
  idm.b  = 2.0;

  // Hook existing IDM sliders (if present) like in other scenarios
  const v0Slider = document.getElementById('v0Slider');
  const TSlider  = document.getElementById('TSlider');
  const aSlider  = document.getElementById('aSlider');
  const bSlider  = document.getElementById('bSlider');

  function syncIdmUI() {
    safeText('v0Value', `${Math.round(idm.v0 * 3.6)} km/h`);
    safeText('TValue', idm.T.toFixed(1));
    safeText('aValue', idm.a.toFixed(1));
    safeText('bValue', idm.b.toFixed(1));
  }
  if (v0Slider) v0Slider.addEventListener('input', () => { idm.v0 = Number(v0Slider.value) / 3.6; syncIdmUI(); });
  if (TSlider)  TSlider.addEventListener('input',  () => { idm.T  = Number(TSlider.value); syncIdmUI(); });
  if (aSlider)  aSlider.addEventListener('input',  () => { idm.a  = Number(aSlider.value); syncIdmUI(); });
  if (bSlider)  bSlider.addEventListener('input',  () => { idm.b  = Number(bSlider.value); syncIdmUI(); });
  syncIdmUI();

  const prioritySelect = document.getElementById('prioritySelect'); // ring|entry
  const odSelect = document.getElementById('odSelect');            // all|right|straight|left
  const qInSlider = document.getElementById('treiberInflowSlider');
  const shareSlider = document.getElementById('treiberShareSlider');
  const brakeBtn = document.getElementById('treiberBrakePulseBtn');

  let priorityRule = (prioritySelect?.value === 'entry') ? 'entry' : 'ring';
  let odRule = odSelect?.value || 'all';
  let qInTotal = qInSlider ? Number(qInSlider.value) : 1800;         // veh/h
  let shareNS = shareSlider ? Number(shareSlider.value) / 100 : 0.5; // 0..1

  function syncTreiberUI() {
    safeText('treiberInflowValue', `${Math.round(qInTotal)} veh/h`);
    safeText('treiberShareValue', `${Math.round(shareNS * 100)}%`);
  }
  if (prioritySelect) prioritySelect.addEventListener('change', () => { priorityRule = (prioritySelect.value === 'entry') ? 'entry' : 'ring'; });
  if (odSelect) odSelect.addEventListener('change', () => { odRule = odSelect.value; });
  if (qInSlider) qInSlider.addEventListener('input', () => { qInTotal = Number(qInSlider.value); syncTreiberUI(); });
  if (shareSlider) shareSlider.addEventListener('input', () => { shareNS = Number(shareSlider.value) / 100; syncTreiberUI(); });
  if (qInSlider || shareSlider) syncTreiberUI();

  // Minimal net object (spawnVehicle expects net.hetero if you use heterogeneity)
  const net = {
    time: 0,
    hetero: {
      truckFraction: 0.08,
      truckLength: 8.8,
      carLength: 4.6,
      v0Spread: 0.10,
      truckV0Mult: 0.85,
    },
    noiseAmp: 0.0,
  };

  const ringLengthM = 2 * Math.PI * ringRefRadiusM;
  const ring = new Road({ id: 'ring', length: ringLengthM, laneCount: 1, isRing: true });

  const armRoadLenM = armLenM; // for the model, "approach length" equals drawn straight+curve length
  const inRoads = [];
  const outRoads = [];
  for (let i = 0; i < 4; i++) {
    inRoads.push(new Road({ id: `in${i}`, length: armRoadLenM, laneCount: 1, isRing: false }));
    outRoads.push(new Road({ id: `out${i}`, length: armRoadLenM, laneCount: 1, isRing: false }));
  }

  // ring positions (s) for entry/exit points (use same ref radius used for length)
  const entryS = geom.map(g => ((g.entryTheta * ringRefRadiusM) % ringLengthM + ringLengthM) % ringLengthM);
  const exitS  = geom.map(g => ((g.exitTheta  * ringRefRadiusM) % ringLengthM + ringLengthM) % ringLengthM);

  const idCounter = { nextId: 1 };

  // ---------------------------
  // OD + spawn
  // ---------------------------
  function pickExit(entryIdx) {
    const right = (entryIdx + 1) % 4;
    const straight = (entryIdx + 2) % 4;
    const left = (entryIdx + 3) % 4;

    if (odRule === 'right') return right;
    if (odRule === 'straight') return straight;
    if (odRule === 'left') return left;

    const r = rng01();
    if (r < 1 / 3) return right;
    if (r < 2 / 3) return straight;
    return left;
  }

  function canSpawnOnRoad(road, sSpawn, minGap = 10) {
    road.sortLanes();
    const lane = road.lanes[0];
    if (lane.length === 0) return true;
    const leader = lane[0];
    return (leader.s - sSpawn) >= ((net.hetero?.truckLength ?? 8.8) + minGap);
  }

  function trySpawnEntry(entryIdx, qVehPerHour, dt) {
    const p = (qVehPerHour / 3600) * dt;
    if (rng01() > p) return;

    const road = inRoads[entryIdx];
    if (!canSpawnOnRoad(road, 0, 12)) return;

    const vInit = idm.v0 * (0.55 + 0.25 * rng01());
    const veh = spawnVehicle(net, road, { id: idCounter.nextId++, lane: 0, s: 0, v: vInit });
    veh.entryIdx = entryIdx;
    veh.exitIdx = pickExit(entryIdx);
    veh.justMergedTime = -1e9;
    veh.prevLane = 0;
  }

  // ---------------------------
  // Ring neighbor search + merge acceptancef
  // ---------------------------
  function findRingNeighborsAt(sPos) {
    ring.sortLanes();
    const lane = ring.lanes[0];
    const n = lane.length;
    if (n === 0) return { leader: null, follower: null };

    let lo = 0, hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (lane[mid].s < sPos) lo = mid + 1;
      else hi = mid;
    }
    const leader = (lo < n) ? lane[lo] : lane[0];
    const follower = (lo > 0) ? lane[lo - 1] : lane[n - 1];
    return { leader, follower };
  }

  function mergeAccepts(veh, sPos) {
    const L = ring.length;
    const { leader, follower } = findRingNeighborsAt(sPos);

    const base = idm.s0 + 0.65 * veh.v * idm.T;

    let reqAhead = base + (leader ? leader.length : 0) + veh.length;
    let reqBehind = 0.75 * base + (follower ? follower.length : 0);

    if (priorityRule === 'ring') {
      reqAhead += 4.0;
      reqBehind += 6.0;
    } else {
      reqAhead = Math.max(6.0, reqAhead - 2.0);
      reqBehind = Math.max(4.0, reqBehind - 3.0);
    }

    const gapAhead = leader ? (forwardDist(sPos, leader.s, L) - leader.length) : 1e9;
    const gapBehind = follower ? (forwardDist(follower.s, sPos, L) - veh.length) : 1e9;

    return gapAhead >= reqAhead && gapBehind >= reqBehind;
  }

  const MERGE_ZONE = 16.0;

  function candidateMerge(entryIdx) {
    const road = inRoads[entryIdx];
    road.sortLanes();
    const lane = road.lanes[0];
    if (lane.length === 0) return null;

    const cand = lane[lane.length - 1];
    if (cand.s < road.length - MERGE_ZONE) return null;

    const sPos = entryS[entryIdx];
    return { veh: cand, ok: mergeAccepts(cand, sPos), sPos };
  }

  function doMerge(entryIdx, veh) {
    const inLane = inRoads[entryIdx].lanes[0];
    const idx = inLane.indexOf(veh);
    if (idx >= 0) inLane.splice(idx, 1);

    veh.roadId = 'ring';
    veh.lane = 0;
    veh.s = entryS[entryIdx];
    veh.justMergedTime = net.time;
    ring.lanes[0].push(veh);
  }

  function doExitFromRing(veh, exitIdx) {
    const lane = ring.lanes[0];
    const idx = lane.indexOf(veh);
    if (idx >= 0) lane.splice(idx, 1);

    const out = outRoads[exitIdx];
    veh.roadId = `out${exitIdx}`;
    veh.lane = 0;
    veh.s = 0;
    out.lanes[0].push(veh);
  }

  // ---------------------------
  // Longitudinal step (1 lane per road)
  // ---------------------------
  function computeLeaderData(road, laneVeh, iVeh) {
    const veh = laneVeh[iVeh];
    const L = road.length;

    if (laneVeh.length <= 1) return { gap: 1e9, vLead: veh.v, aLead: 0 };

    if (road.isRing) {
      const leader = laneVeh[(iVeh + 1) % laneVeh.length];
      const dist = forwardDist(veh.s, leader.s, L);
      const gap = Math.max(1e-3, dist - leader.length);
      return { gap, vLead: leader.v, aLead: leader.acc ?? 0 };
    }

    if (iVeh === laneVeh.length - 1) return { gap: 1e9, vLead: veh.v, aLead: 0 };

    const leader = laneVeh[iVeh + 1];
    const dist = leader.s - veh.s;
    const gap = Math.max(1e-3, dist - leader.length);
    return { gap, vLead: leader.v, aLead: leader.acc ?? 0 };
  }

  function stepRoadOneLane(road, dt, opts = {}) {
    road.sortLanes();
    const lane = road.lanes[0];

    for (let i = 0; i < lane.length; i++) {
      const veh = lane[i];
      const idmLocal = localIdmParamsForVeh(idm, veh);

      let { gap, vLead, aLead } = computeLeaderData(road, lane, i);

      if (opts.virtualStopForLead && i === lane.length - 1) {
        const distToEnd = road.length - veh.s;
        gap = Math.max(1e-3, distToEnd);
        vLead = 0;
        aLead = 0;
      }

      const acc = accACC(gap, veh.v, vLead, aLead, idmLocal);

      const extra = (net.time < (veh.brakeUntil ?? -1e9)) ? (veh.extraBrake ?? 0) : 0;
      veh.acc = acc + extra;
    }

    for (let i = 0; i < lane.length; i++) {
      const veh = lane[i];
      const sPrev = veh.s;
      const vPrev = veh.v;
      const a = veh.acc || 0;

      veh.prevS = sPrev;
      veh.prevV = vPrev;

      const vNew = Math.max(0, vPrev + a * dt);
      let sNew = sPrev + vPrev * dt + 0.5 * a * dt * dt;

      veh.v = vNew;
      veh.s = sNew;

      if (road.isRing) {
        veh.s = ((veh.s % road.length) + road.length) % road.length;
      } else {
        if (!opts.allowBeyondEnd) {
          if (veh.s > road.length) { veh.s = road.length; veh.v = 0; }
          if (veh.s < 0) { veh.s = 0; veh.v = 0; }
        }
      }
    }

    // no-overlap correction
    road.sortLanes();
    const minSpacing = idm.s0 + 0.8;

    for (let i = 1; i < lane.length; i++) {
      const follower = lane[i - 1];
      const leader = lane[i];
      const desiredMaxS = leader.s - follower.length - minSpacing;

      if (follower.s > desiredMaxS) {
        const prevS = (typeof follower.prevS === 'number') ? follower.prevS : follower.s;
        follower.s = Math.max(desiredMaxS, prevS);

        const vCap = Math.max(0, (follower.s - prevS) / dt);
        follower.v = Math.min(follower.v, leader.v, vCap);
        if (follower.s === prevS) follower.v = 0;
      }
    }

    // ring wrap correction
    if (road.isRing && lane.length > 1) {
      const first = lane[0];
      const last = lane[lane.length - 1];
      const virtualFirstS = first.s + road.length;
      const desiredMaxS = virtualFirstS - last.length - minSpacing;
      if (last.s > desiredMaxS) {
        const prevS = (typeof last.prevS === 'number') ? last.prevS : last.s;
        last.s = Math.min(Math.max(desiredMaxS, prevS), road.length - 1e-3);
        const vCap = Math.max(0, (last.s - prevS) / dt);
        last.v = Math.min(last.v, first.v, vCap);
        if (last.s === prevS) last.v = 0;
      }
    }
  }

  function removeExitedOutRoad(outRoad, buffer = 40) {
    const maxS = outRoad.length + buffer;
    outRoad.lanes[0] = outRoad.lanes[0].filter(v => v.s <= maxS);
  }

  // ---------------------------
  // Detectors on ring (3 markers)
  // ---------------------------
  const detWindow = 30.0;
  const dets = [
    { s: ringLengthM * 0.10, passages: [], flowVehPerH: 0, vMean: 0, density: 0 },
    { s: ringLengthM * 0.40, passages: [], flowVehPerH: 0, vMean: 0, density: 0 },
    { s: ringLengthM * 0.70, passages: [], flowVehPerH: 0, vMean: 0, density: 0 },
  ];

  function recordDetectorCrossings() {
    const L = ring.length;
    for (const veh of ring.lanes[0]) {
      const prevS = (typeof veh.prevS === 'number') ? veh.prevS : veh.s;
      for (const d of dets) {
        if (crossedForward(prevS, veh.s, d.s, L)) d.passages.push({ t: net.time, id: veh.id, v: veh.v });
      }
    }
  }

  function updateDetectorsUI() {
    for (const d of dets) {
      d.passages = d.passages.filter(p => net.time - p.t <= detWindow);
      d.flowVehPerH = (d.passages.length / detWindow) * 3600;
      d.vMean = d.passages.length ? (d.passages.reduce((s, p) => s + p.v, 0) / d.passages.length) : 0;
      d.density = ring.lanes[0].length / (ring.length / 1000);
    }

    const elFlow = [document.getElementById('det1Flow'), document.getElementById('det2Flow'), document.getElementById('det3Flow')];
    const elSpeed = [document.getElementById('det1Speed'), document.getElementById('det2Speed'), document.getElementById('det3Speed')];
    const elDen = [document.getElementById('det1Density'), document.getElementById('det2Density'), document.getElementById('det3Density')];

    for (let i = 0; i < dets.length; i++) {
      const d = dets[i];
      if (elFlow[i]) elFlow[i].textContent = `${d.flowVehPerH.toFixed(0)} veh/h`;
      if (elSpeed[i]) elSpeed[i].textContent = `${(d.vMean * 3.6).toFixed(1)} km/h`;
      if (elDen[i]) elDen[i].textContent = `${d.density.toFixed(0)} veh/km`;
    }
  }

  // ---------------------------
  // Logger (samples + events)
  // ---------------------------
  let logData = null;
  const LOG_DT = 0.5;
  let lastLogT = -1e9;

  function updateLogInfo() {
    const el = document.getElementById('logInfo');
    if (!el) return;
    if (!logData) { el.textContent = ''; return; }
    el.textContent = `samples: ${logData.samples.length}, events: ${logData.events.length}`;
  }

  function startLog() {
    logData = {
      meta: {
        scenario: 'roundaboutTreiber',
        createdAt: new Date().toISOString(),
        seed: rngCtl.seedValue,
        inflowByDir: { ...inflowByDir },
        usePerDirInflow,
      },
      params: {
        idm: { ...idm },
        geom: { laneWidthM, ringInnerRadiusM, armLenM, curveLenM, sepM, alpha },
      },
      events: [],
      samples: [],
    };
    updateLogInfo();
  }

  function logEvent(type, payload) {
    if (!logData) return;
    logData.events.push({ t: net.time, type, ...payload });
    updateLogInfo();
  }

  function logSample() {
    if (!logData) return;
    const nRing = ring.lanes[0].length;
    const nIn = inRoads.reduce((s, r) => s + r.lanes[0].length, 0);
    const nOut = outRoads.reduce((s, r) => s + r.lanes[0].length, 0);
    const vMeanRing = nRing ? ring.lanes[0].reduce((s, v) => s + v.v, 0) / nRing : 0;
    const queues = inRoads.map(r => r.lanes[0].filter(v => v.s > r.length - 12).length);

    logData.samples.push({
      t: net.time,
      priorityRule,
      odRule,
      qInTotal,
      shareNS,
      counts: { ring: nRing, in: nIn, out: nOut },
      vMeanRing,
      queues,
    });
    updateLogInfo();
  }

  const downloadLogBtn = document.getElementById('downloadLogBtn');
  const clearLogBtn = document.getElementById('clearLogBtn');
  if (downloadLogBtn) downloadLogBtn.onclick = () => {
    if (!logData) startLog();
    downloadJson(`phantomflow_roundaboutTreiber_seed-${rngCtl.seedValue}_${new Date().toISOString().replace(/[:.]/g,'-')}.json`, logData);
  };
  if (clearLogBtn) clearLogBtn.onclick = () => startLog();

  // ---------------------------
  // Pause / Reset
  // ---------------------------
  let running = true;
  const pauseBtn = document.getElementById('pauseBtn');
  const resetBtn = document.getElementById('resetBtn');
  const simStatus = document.getElementById('simStatus');

  if (pauseBtn) pauseBtn.onclick = () => {
    running = !running;
    if (simStatus) simStatus.textContent = running ? 'RUN' : 'PAUSE';
    pauseBtn.textContent = running ? 'Pause' : 'Resume';
  };

  function resetSim() {
    rngCtl.resetRng();
    net.time = 0;

    ring.lanes[0].length = 0;
    for (const r of inRoads) r.lanes[0].length = 0;
    for (const r of outRoads) r.lanes[0].length = 0;
    idCounter.nextId = 1;

    // seed a few vehicles on the ring
    const nSeed = 10;
    for (let k = 0; k < nSeed; k++) {
      const s = (k * ring.length) / nSeed;
      const v = idm.v0 * 0.6 * (0.95 + 0.10 * rng01());
      const veh = spawnVehicle(net, ring, { id: idCounter.nextId++, lane: 0, s, v });
      veh.entryIdx = -1;
      veh.exitIdx = Math.floor(rng01() * 4); // umjesto -1;
      veh.justMergedTime = -1e9;
      veh.prevLane = 0;
    }

    startLog();
    lastLogT = -1e9;
  }

  if (resetBtn) resetBtn.onclick = resetSim;

  // Phantom jam trigger: random brake pulse (like other scenarios)
  function randomBrakePulse() {
    const all = [];
    all.push(...ring.lanes[0]);
    for (const r of inRoads) all.push(...r.lanes[0]);
    for (const r of outRoads) all.push(...r.lanes[0]);
    if (all.length === 0) return;

    const veh = all[Math.floor(rng01() * all.length)];
    const decel = 3.0 + 2.0 * rng01();
    veh.extraBrake = -decel;          // NEGATIVE decel
    veh.brakeUntil = net.time + 1.2;

    logEvent('brakePulse', { vehId: veh.id, roadId: veh.roadId, decel });
  }
  if (brakeBtn) brakeBtn.onclick = randomBrakePulse;


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
    // grass (match main.js)
    ctx.fillStyle = '#4b7a33';
    ctx.fillRect(0, 0, W, H);

    // stroke all carriageways like main.js: white border then gray asphalt
    const laneWidthPx = laneWidthM * pxPerM;
    const roadWidthPx = laneWidthPx; // single lane carriageway
    const ringWidthPx = laneWidthPx; // single lane ring

    // Helper: world polyline -> canvas polyline
    function toCanvasPts(worldPts) {
      return worldPts.map(p => w2c(p.x, p.y));
    }

    // Entry + exit roads (each arm has 2 separate carriageways)
    for (const g of geom) {
      const entryPts = toCanvasPts(g.entryCenterline);
      const exitPts  = toCanvasPts(g.exitCenterline);

      // white edge
      strokePolyline(ctx, entryPts, '#ffffff', roadWidthPx +  edgeWidthPx, false, 0.85);
      strokePolyline(ctx, exitPts,  '#ffffff', roadWidthPx +  edgeWidthPx, false, 0.85);

      // asphalt
      strokePolyline(ctx, entryPts, '#555555', roadWidthPx - 2, false, 0.95);
      strokePolyline(ctx, exitPts,  '#555555', roadWidthPx - 2, false, 0.95);
    }

    // Ring: use arc strokes (same style as roundabout.js)
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, 1);
    const rPx = ringRefRadiusM * pxPerM;

    // white edge
    ctx.strokeStyle = '#ffffff';
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = ringWidthPx + 2 * edgeWidthPx;
    ctx.beginPath();
    ctx.arc(0, 0, rPx, 0, 2 * Math.PI);
    ctx.stroke();

    // asphalt
    ctx.strokeStyle = '#555555';
    ctx.globalAlpha = 0.95;
    ctx.lineWidth = ringWidthPx - 2;
    ctx.beginPath();
    ctx.arc(0, 0, rPx, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.restore();

    // Inner island (grass hole) to clean inside ring
    const innerHolePx = (ringInnerRadiusM - 0.4) * pxPerM;
    ctx.fillStyle = '#4b7a33';
    ctx.beginPath();
    ctx.arc(cx, cy, innerHolePx, 0, 2 * Math.PI);
    ctx.fill();

    // (Optional) faint dashed guide on ring (subtle, keeps "main" feel)
    /*
    ctx.save();
    ctx.translate(cx, cy);
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 2;
    ctx.setLineDash([10, 12]);
    ctx.beginPath();
    ctx.arc(0, 0, rPx, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.restore();*/
  }

  // Map vehicles to this geometry
  function mapRing(s) {
    const th = s / ringRefRadiusM;
    return w2c(ringRefRadiusM * Math.cos(th), ringRefRadiusM * Math.sin(th));
  }

function mapIn(entryIdx, s) {
  const g = geom[entryIdx];
  const t = clamp(s / armRoadLenM, 0, 1);
  const A = g.P_entryFar;
  const B = g.P_entryNear;
  const x = A.x + (B.x - A.x) * t;
  const y = A.y + (B.y - A.y) * t;
  return w2c(x, y);
}

function mapOut(exitIdx, s) {
  const g = geom[exitIdx];
  const t = clamp(s / armRoadLenM, 0, 1);
  const A = g.P_exitNear;
  const B = g.P_exitFar;
  const x = A.x + (B.x - A.x) * t;
  const y = A.y + (B.y - A.y) * t;
  return w2c(x, y);
}

  function drawVehicles() {
    for (const veh of ring.lanes[0]) {
      const p = mapRing(veh.s);
      drawVehicleDot(p.x, p.y, veh);
    }
    for (let i = 0; i < 4; i++) {
      for (const veh of inRoads[i].lanes[0]) {
        const p = mapIn(i, veh.s);
        drawVehicleDot(p.x, p.y, veh);
      }
      for (const veh of outRoads[i].lanes[0]) {
        const p = mapOut(i, veh.s);
        drawVehicleDot(p.x, p.y, veh);
      }
    }
  }

  // ---------------------------
  // Simulation step
  // ---------------------------
  function stepSim(dt) {
    net.time += dt;

    // Inflow split NS vs EW
//    const qNS = qInTotal * shareNS;
 //   const qEW = qInTotal * (1 - shareNS);
   // const qPerEntry = [qEW / 2, qNS / 2, qEW / 2, qNS / 2];


   let qPerEntry;

  if (usePerDirInflow) {
  // indeksni redoslijed mora pratiti arms: [E,N,W,S]
    qPerEntry = [
      inflowByDir.E ?? 0,
      inflowByDir.N ?? 0,
      inflowByDir.W ?? 0,
      inflowByDir.S ?? 0,
    ];
  } else {
    const qNS = qInTotal * shareNS;
    const qEW = qInTotal * (1 - shareNS);
    qPerEntry = [qEW / 2, qNS / 2, qEW / 2, qNS / 2];
  }

    for (let i = 0; i < 4; i++) trySpawnEntry(i, qPerEntry[i], dt);

    // Decide which approach leaders must yield (virtual stopline)
    const stopLeadIds = new Set();
    for (let i = 0; i < 4; i++) {
      const c = candidateMerge(i);
      if (c && !c.ok) stopLeadIds.add(c.veh.id);
    }

    // Step ring + out roads
    stepRoadOneLane(ring, dt, {});
    for (const r of outRoads) stepRoadOneLane(r, dt, { allowBeyondEnd: true });

    // Step in roads (some stop at yield)
    for (const r of inRoads) {
      r.sortLanes();
      const lane = r.lanes[0];
      const lead = lane.length ? lane[lane.length - 1] : null;
      const needStop = lead ? stopLeadIds.has(lead.id) : false;
      stepRoadOneLane(r, dt, { virtualStopForLead: needStop });
    }

    // Exits
    const ringSnapshot = [...ring.lanes[0]];
    for (const veh of ringSnapshot) {
      if (veh.exitIdx == null || veh.exitIdx < 0) continue;
      if (net.time - (veh.justMergedTime ?? -1e9) < 0.6) continue;

      const prevS = (typeof veh.prevS === 'number') ? veh.prevS : veh.s;
      const sExit = exitS[veh.exitIdx];
      if (crossedForward(prevS, veh.s, sExit, ring.length)) {
        doExitFromRing(veh, veh.exitIdx);
        logEvent('exit', { vehId: veh.id, exitIdx: veh.exitIdx });
      }
    }

    // Merges (after exits)
    for (let i = 0; i < 4; i++) {
      const c = candidateMerge(i);
      if (c && c.ok) {
        doMerge(i, c.veh);
        logEvent('merge', { vehId: c.veh.id, entryIdx: i, exitIdx: c.veh.exitIdx });
      }
    }

    for (const r of outRoads) removeExitedOutRoad(r);

    // detectors + logger
    recordDetectorCrossings();
    updateDetectorsUI();

    if (!logData) startLog();
    if (net.time - lastLogT >= LOG_DT) {
      lastLogT = net.time;
      logSample();
    }
  }

  // ---------------------------
  // RAF loop (like main.js)
  // ---------------------------
  const simDt = 0.1;
  let lastTs = null;

  function loop(ts) {
    if (lastTs === null) lastTs = ts;

    if (running) {
      const dtMs = ts - lastTs;
      const steps = clamp(Math.round(dtMs / (simDt * 1000)), 1, 8);
      for (let i = 0; i < steps; i++) stepSim(simDt);
    }
    lastTs = ts;

    drawBackground();
    drawVehicles();

    requestAnimationFrame(loop);
  }

  // boot
  resetSim();
  requestAnimationFrame(loop);
}
