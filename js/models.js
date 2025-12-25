// models.js
// MOVSIM-ish network + stronger jam dynamics:
// - per-vehicle desired speed multiplier (heterogeneity)
// - optional trucks (longer, slower)
// - more aggressive merge (creates braking / shockwaves)
// - occasional brake pulse (phantom jams)
// - keep hard no-overlap but less "stabilizing"

function myTanh(x) {
  if (x > 50) return 1;
  if (x < -50) return -1;
  const e2x = Math.exp(2 * x);
  return (e2x - 1) / (e2x + 1);
}

// -----------------------
// ACC (IDM+CAH)
// -----------------------
export const defaultIdmParams = {
  v0: 30,      // desired speed (m/s)
  T: 1.4,
  s0: 4.0,
  a: 0.3,
  b: 1.5,
  cool: 0.9,
  bmax: 10.0
};

function accACC(s, v, vl, al, params) {
  const { v0, T, s0, a, b, cool, bmax } = params;

  const v0eff = Math.max(v0, 1e-5);
  const aeff = a;

  const accFree = aeff * (1 - Math.pow(v / v0eff, 4));

  const sStar =
    s0 +
    Math.max(
      0,
      v * T + (0.5 * v * (v - vl)) / Math.sqrt(Math.max(1e-6, aeff * b))
    );

  const sEff = Math.max(s, s0);
  const accInt = -aeff * Math.pow(sStar / sEff, 2);

  const accIDM = Math.min(accFree, aeff + accInt);

  // CAH
  let accCAH;
  if (vl * (v - vl) < -2 * s * al) {
    accCAH = (v * v * al) / (vl * vl - 2 * s * al);
  } else {
    accCAH =
      al -
      ((v - vl) * (v - vl)) /
        (2 * Math.max(s, 0.01)) *
        (v > vl ? 1 : 0);
  }
  accCAH = Math.min(accCAH, aeff);

  const accMix =
    accIDM > accCAH
      ? accIDM
      : accCAH + b * myTanh((accIDM - accCAH) / b);

  const accACCval = cool * accMix + (1 - cool) * accIDM;

  return Math.max(-bmax, accACCval);
}

// -----------------------
// MOBIL
// -----------------------
export const defaultMobilParams = {
  bSafe: 2.0,
  bSafeMax: 4.0,
  p: 0.1,
  bThr: 0.2,
  bBiasRight: 0.0,
  cooldown: 3.0
};

function bSafeActual(v, mobilParams, idmParamsBase) {
  const vrel = Math.max(0, Math.min(1, v / Math.max(1e-6, idmParamsBase.v0)));
  return vrel * mobilParams.bSafe + (1 - vrel) * mobilParams.bSafeMax;
}

function mobilEvaluateMove({
  veh,
  accOld,
  accNew,
  accLagOld,
  accLagNew,
  toRight,
  mobilParams,
  idmParamsBase
}) {
  const signRight = toRight ? 1 : -1;

  const bSafe = bSafeActual(veh.v, mobilParams, idmParamsBase);
  const safe = accLagNew >= -bSafe;

  const politeness = mobilParams.p;
  const bias = signRight * mobilParams.bBiasRight;

  const incentive =
    (accNew - accOld) + politeness * (accLagNew - accLagOld) - mobilParams.bThr + bias;

  return { safe, incentive };
}

// -----------------------
// Data model
// -----------------------
export class Vehicle {
  constructor({ id, s, v, lane, roadId, length = 4.5, v0Mult = 1.0, isTruck = false }) {
    this.id = id;
    this.s = s;
    this.v = v;
    this.lane = lane;
    this.roadId = roadId;
    this.length = length;

    // heterogeneity:
    this.v0Mult = v0Mult;
    this.isTruck = isTruck;

    // dynamics / rendering helpers:
    this.acc = 0;
    this.prevLane = lane;
    this.lastLaneChangeTime = -1e9;
    this.laneChangeStartTime = -1e9;

    // phantom jam trigger:
    this.brakeUntil = -1e9;     // time until extra braking applies
    this.extraBrake = 0;        // m/s^2 (negative)
  }
}

export class Road {
  constructor({ id, length, laneCount, isRing = false, speedProfile = null }) {
    this.id = id;
    this.length = length;
    this.laneCount = laneCount;
    this.isRing = isRing;
    this.speedProfile = speedProfile; // function(s)-> factor (0..1)

    this.lanes = Array.from({ length: laneCount }, () => []);
  }

  allVehicles() {
    const out = [];
    for (let l = 0; l < this.laneCount; l++) out.push(...this.lanes[l]);
    return out;
  }

  sortLanes() {
    for (let l = 0; l < this.laneCount; l++) {
      this.lanes[l].sort((a, b) => a.s - b.s);
    }
  }
}

// local IDM params with v0(s) and per-vehicle multiplier
function localIdmParams(road, s, idmParamsBase, veh) {
  const f = road.speedProfile ? road.speedProfile(s) : 1.0;
  const m = veh?.v0Mult ?? 1.0;
  return { ...idmParamsBase, v0: idmParamsBase.v0 * f * m };
}

// -----------------------
// Network creation
// -----------------------
export function createNetwork({
  mainLength = 920,
  mainLaneCount = 3,
  rampLength = 140,

  mergeMainS = 280,
  mergeMainLane = 2,
  mergeTriggerRampS = 110,

  mergeRegionHalfLength = 45,
  mergeTryCount = 7,

  // speed profile (curve matters)
  curveStartS = 360,
  curveLength = 200,
  curveFactor = 0.70,
  postCurveLength = 80,
  postCurveFactor = 0.85,

  // heterogeneity
  truckFraction = 0.12,      // ~12% trucks
  v0Spread = 0.18,           // ± spread (normal-ish)
  truckV0Mult = 0.78,        // trucks slower
  truckLength = 7.5,
  carLength = 4.5,

  // phantom jam
  brakePulseEvery = 1e9,    // seconds between attempts
  brakePulseDuration = 1.6,  // seconds
  brakePulseDecel = 3.2,      // extra braking magnitude (m/s^2)
  phantomEnabled = false // da li je dozvoljeno random kocenje vozaca za stvaranje fantomske guzve
} = {}) {
  const mainSpeedProfile = (s) => {
    if (s >= curveStartS && s <= curveStartS + curveLength) return curveFactor;
    if (s > curveStartS + curveLength && s < curveStartS + curveLength + postCurveLength) return postCurveFactor;
    return 1.0;
  };

  const main = new Road({
    id: 'main',
    length: mainLength,
    laneCount: mainLaneCount,
    isRing: false,
    speedProfile: mainSpeedProfile
  });

  const ramp = new Road({
    id: 'ramp',
    length: rampLength,
    laneCount: 1,
    isRing: false,
    speedProfile: null
  });

  return {
    time: 0,
    roads: { main, ramp },
    merge: {
      toLane: mergeMainLane,
      toS: mergeMainS,
      triggerRampS: Math.min(mergeTriggerRampS, rampLength - 1),
      regionHalfLength: mergeRegionHalfLength,
      tryCount: mergeTryCount
    },

    // heterogeneity config
    hetero: { truckFraction, v0Spread, truckV0Mult, truckLength, carLength },

    // phantom jams config/state
    phantom: {
      enabled: phantomEnabled,
      pulseEvery: brakePulseEvery,
      pulseDuration: brakePulseDuration,
      pulseDecel: brakePulseDecel,
      nextPulseTime: 8.0 // first pulse after ~8s
    }
  };
}

// -----------------------
// Neighbor helpers
// -----------------------
function findNeighborsAtS(laneVehiclesSorted, sQuery) {
  if (laneVehiclesSorted.length === 0) return { leader: null, follower: null };

  let lo = 0, hi = laneVehiclesSorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (laneVehiclesSorted[mid].s < sQuery) lo = mid + 1;
    else hi = mid;
  }
  const leader = lo < laneVehiclesSorted.length ? laneVehiclesSorted[lo] : null;
  const follower = lo > 0 ? laneVehiclesSorted[lo - 1] : null;
  return { leader, follower };
}

function findLeaderForVeh(laneVehiclesSorted, veh) {
  const idx = laneVehiclesSorted.indexOf(veh);
  const leader = idx >= 0 && idx < laneVehiclesSorted.length - 1 ? laneVehiclesSorted[idx + 1] : null;
  const follower = idx > 0 ? laneVehiclesSorted[idx - 1] : null;
  return { leader, follower };
}

function gapToLeader(veh, leader, idmParamsLocal) {
  if (!leader) return { s: 1e6, vLead: veh.v, aLead: 0 };
  const dx = leader.s - veh.s;
  const gap = Math.max(0.01, dx - veh.length);
  return { s: Math.max(gap, idmParamsLocal.s0), vLead: leader.v, aLead: leader.acc || 0 };
}

function gapFollowerAfterInsert(follower, insertedVeh, idmParamsLocal) {
  if (!follower) return { s: 1e6, vLead: insertedVeh.v, aLead: insertedVeh.acc || 0 };
  const dx = insertedVeh.s - follower.s;
  const gap = Math.max(0.01, dx - follower.length);
  return { s: Math.max(gap, idmParamsLocal.s0), vLead: insertedVeh.v, aLead: insertedVeh.acc || 0 };
}

// -----------------------
// Accelerations
// -----------------------
function calcAccelerationsForRoad(road, idmParamsBase) {
  road.sortLanes();

  for (let l = 0; l < road.laneCount; l++) {
    const laneVeh = road.lanes[l];
    for (const veh of laneVeh) {
      const idmLocal = localIdmParams(road, veh.s, idmParamsBase, veh);
      const { leader } = findLeaderForVeh(laneVeh, veh);
      const { s, vLead, aLead } = gapToLeader(veh, leader, idmLocal);
      veh.acc = accACC(s, veh.v, vLead, aLead, idmLocal);
    }
  }
}

// -----------------------
// Lane change main
// -----------------------
function laneChangeMain(roadMain, netTime, idmParamsBase, mobilParams) {
  roadMain.sortLanes();
  const laneChanges = [];

  for (let lane = 0; lane < roadMain.laneCount; lane++) {
    const laneVeh = roadMain.lanes[lane];

    for (const veh of laneVeh) {
      if (netTime - veh.lastLaneChangeTime < mobilParams.cooldown) continue;

      // OLD lane
      const idmLocalOld = localIdmParams(roadMain, veh.s, idmParamsBase, veh);
      const { leader: leaderOld, follower: followerOld } = findLeaderForVeh(laneVeh, veh);
      const { s: sOld, vLead: vLeadOld, aLead: aLeadOld } = gapToLeader(veh, leaderOld, idmLocalOld);
      const accOld = accACC(sOld, veh.v, vLeadOld, aLeadOld, idmLocalOld);

      let accLagOld = 0;
      if (followerOld) {
        const idmLocalFolOld = localIdmParams(roadMain, followerOld.s, idmParamsBase, followerOld);
        const { s: sLagOld, vLead, aLead } = gapFollowerAfterInsert(followerOld, veh, idmLocalFolOld);
        accLagOld = accACC(sLagOld, followerOld.v, vLead, aLead, idmLocalFolOld);
      }

      let bestLane = lane;
      let bestIncentive = -1e9;

      const candidates = [];
      if (lane > 0) candidates.push(lane - 1);
      if (lane < roadMain.laneCount - 1) candidates.push(lane + 1);

      for (const targetLane of candidates) {
        const targetVeh = roadMain.lanes[targetLane];
        const { leader: leaderNew, follower: followerNew } = findNeighborsAtS(targetVeh, veh.s);

        const idmLocalNew = localIdmParams(roadMain, veh.s, idmParamsBase, veh);
        const { s: sNew, vLead: vLeadNew, aLead: aLeadNew } = gapToLeader(veh, leaderNew, idmLocalNew);
        const accNew = accACC(sNew, veh.v, vLeadNew, aLeadNew, idmLocalNew);

        let accLagNew = 0;
        if (followerNew) {
          const idmLocalFolNew = localIdmParams(roadMain, followerNew.s, idmParamsBase, followerNew);
          const { s: sLagNew, vLead, aLead } = gapFollowerAfterInsert(followerNew, veh, idmLocalFolNew);
          accLagNew = accACC(sLagNew, followerNew.v, vLead, aLead, idmLocalFolNew);
        }

        const toRight = targetLane > lane;
        const { safe, incentive } = mobilEvaluateMove({
          veh,
          accOld,
          accNew,
          accLagOld,
          accLagNew,
          toRight,
          mobilParams,
          idmParamsBase
        });

        if (safe && incentive > bestIncentive) {
          bestIncentive = incentive;
          bestLane = targetLane;
        }
      }

      if (bestLane !== lane && bestIncentive > 0) {
        laneChanges.push({ veh, fromLane: lane, toLane: bestLane });
      }
    }
  }

  for (const ch of laneChanges) {
    const veh = ch.veh;
    const oldArr = roadMain.lanes[ch.fromLane];
    const idx = oldArr.indexOf(veh);
    if (idx >= 0) oldArr.splice(idx, 1);

    veh.prevLane = veh.lane;
    veh.lane = ch.toLane;
    veh.lastLaneChangeTime = netTime;
    veh.laneChangeStartTime = netTime;

    roadMain.lanes[ch.toLane].push(veh);
  }

  roadMain.sortLanes();
}

// -----------------------
// Aggressive merge (creates braking waves)
// -----------------------
function mergeFromRamp(net, idmParamsBase, mobilParams) {
  const ramp = net.roads.ramp;
  const main = net.roads.main;

  ramp.sortLanes();
  main.sortLanes();

  const rampLane = ramp.lanes[0];
  const targetLaneIdx = net.merge.toLane;
  const targetLane = main.lanes[targetLaneIdx];

  const mergeS = net.merge.toS;
  const half = net.merge.regionHalfLength;
  const tries = Math.max(1, net.merge.tryCount);

  const merged = [];

  for (const veh of rampLane) {
    if (veh.s < net.merge.triggerRampS) continue;

    let best = null;

    for (let k = 0; k < tries; k++) {
      const alpha = tries === 1 ? 0.5 : k / (tries - 1);
      const candS = Math.max(0, mergeS - half + alpha * (2 * half));

      const { leader: leaderNew, follower: followerNew } = findNeighborsAtS(targetLane, candS);

      const oldS = veh.s;
      veh.s = candS;

      // evaluate ramp-vehicle accel on main
      const idmLocalAtCand = localIdmParams(main, candS, idmParamsBase, veh);
      const { s: sNew, vLead: vLeadNew, aLead: aLeadNew } = gapToLeader(veh, leaderNew, idmLocalAtCand);
      const accNew = accACC(sNew, veh.v, vLeadNew, aLeadNew, idmLocalAtCand);

      // follower safety (RELAXED compared to before -> more jams)
      let accLagNew = 0;
      if (followerNew) {
        const idmLocalFol = localIdmParams(main, followerNew.s, idmParamsBase, followerNew);
        const { s: sLagNew, vLead, aLead } = gapFollowerAfterInsert(followerNew, veh, idmLocalFol);
        accLagNew = accACC(sLagNew, followerNew.v, vLead, aLead, idmLocalFol);
      }

      // relaxed: allow follower to brake somewhat harder than bSafe
      const bSafe = bSafeActual(veh.v, mobilParams, idmParamsBase);
      const safeRelaxed = accLagNew >= -(bSafe + 1.0); // <-- ključ: više “guranja”

      // gap ahead: leaderNew is ahead of inserted veh
      // condition: (leaderNew.s - veh.s - veh.length) >= s0 + buffer
      const gapAheadOk = !leaderNew || (leaderNew.s - veh.s) >= (veh.length + idmLocalAtCand.s0 + 0.5);

      // gap behind: followerNew is behind inserted veh
      // condition: (veh.s - followerNew.s - followerNew.length) >= s0 + buffer
      const gapBehindOk = !followerNew || (veh.s - followerNew.s) >= (followerNew.length + idmLocalAtCand.s0 + 0.5);

      veh.s = oldS;

      if (!(safeRelaxed && gapAheadOk && gapBehindOk)) continue;

      // choose candidate with best (highest) accNew
      if (!best || accNew > best.accNew) best = { candS, accNew };
    }

    if (best) merged.push({ veh, candS: best.candS });
  }

  if (merged.length === 0) return;

  merged.sort((a, b) => b.veh.s - a.veh.s);

  for (const { veh, candS } of merged) {
    const idx = rampLane.indexOf(veh);
    if (idx >= 0) rampLane.splice(idx, 1);

    veh.roadId = 'main';
    veh.prevLane = veh.lane;
    veh.lane = targetLaneIdx;
    veh.lastLaneChangeTime = net.time;
    veh.laneChangeStartTime = net.time;
    veh.s = candS;

    // little "merge disturbance": brief small brake to create wave
    veh.brakeUntil = Math.max(veh.brakeUntil, net.time + 0.7);
    veh.extraBrake = -0.4;

    targetLane.push(veh);
  }

  main.sortLanes();
}

export function setPhantomEnabled(net, enabled) {
  if (!net.phantom) net.phantom = {};
  net.phantom.enabled = !!enabled;
}

// -----------------------
// Phantom jam pulse: periodically force a random car to brake briefly
// -----------------------
function maybeTriggerBrakePulse(net) {
  const ph = net.phantom;
  if (!ph || ph.enabled === false) return;
  if (net.time < ph.nextPulseTime) return;

  const main = net.roads.main;
  const candidates = [];

  // pick cars around/after merge (common jam location)
  const sMin = net.merge.toS - 30;
  const sMax = net.merge.toS + 200;

  for (const v of main.allVehicles()) {
    if (v.s >= sMin && v.s <= sMax && !v.isTruck) candidates.push(v);
  }

  if (candidates.length > 0) {
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    pick.brakeUntil = net.time + ph.pulseDuration;
    pick.extraBrake = -ph.pulseDecel;
  }

  ph.nextPulseTime = net.time + ph.pulseEvery * (0.8 + 0.4 * Math.random());
}

// -----------------------
// Integrate + enforce no-overlap
// -----------------------
function integrateAndEnforce(net, road, dt, idmParamsBase) {
  const noiseAmp = 0.9;

  // 1) Integrate (store previous state so we can clamp without moving backwards)
  for (let l = 0; l < road.laneCount; l++) {
    for (const veh of road.lanes[l]) {
      const sPrev = veh.s;
      const vPrev = veh.v;

      const aDet = veh.acc || 0;
      const noise = (Math.random() - 0.5) * 2 * noiseAmp;

      const extra = (net.time < veh.brakeUntil) ? (veh.extraBrake || 0) : 0;
      const a = aDet + noise + extra;

      // semi-explicit: position uses vPrev (reduces overshoot)
      const vNew = Math.max(0, vPrev + a * dt);
      let sNew = sPrev + vPrev * dt + 0.5 * a * dt * dt;

      veh.prevS = sPrev;
      veh.prevV = vPrev;

      veh.v = vNew;
      veh.s = sNew;
      veh.acc = a;
    }
  }

  // 2) Boundaries
  if (road.id === 'ramp') {
    for (const veh of road.lanes[0]) {
      if (veh.s > road.length) { veh.s = road.length; veh.v = 0; }
      if (veh.s < 0) { veh.s = 0; veh.v = 0; }
    }
  } else {
    for (let l = 0; l < road.laneCount; l++) {
      for (const veh of road.lanes[l]) {
        if (veh.s < 0) { veh.s = 0; veh.v = Math.min(veh.v, idmParamsBase.v0); }
      }
    }
  }

  // 3) Enforce no-overlap WITHOUT pushing cars backwards
  road.sortLanes();
  const minSpacing = idmParamsBase.s0 + 0.8;

  for (let l = 0; l < road.laneCount; l++) {
    const laneVeh = road.lanes[l];

    for (let i = 1; i < laneVeh.length; i++) {
      const follower = laneVeh[i - 1];
      const leader = laneVeh[i];

      // follower must satisfy: leader.s - follower.s - follower.length >= minSpacing
      const desiredMaxS = leader.s - follower.length - minSpacing;

      if (follower.s > desiredMaxS) {
        const prevS = (typeof follower.prevS === 'number') ? follower.prevS : follower.s;

        // never move backwards (if desiredMaxS < prevS, we keep prevS)
        follower.s = Math.max(desiredMaxS, prevS);

        // cap speed so it matches the clamped displacement (and never exceeds leader)
        const vCap = Math.max(0, (follower.s - prevS) / dt);
        follower.v = Math.min(follower.v, leader.v, vCap);

        // if we had to "freeze" at prevS, make it a full stop
        if (follower.s === prevS) follower.v = 0;
      }
    }
  }
}

// -----------------------
// Spawn helpers
// -----------------------
function randnApprox() {
  // quick approx normal using sum of uniforms
  let s = 0;
  for (let i = 0; i < 6; i++) s += Math.random();
  return (s - 3); // mean 0
}

// ✅ FIX: spawn provjera mora znati dužinu NOVOG vozila (ne leader.length)
function canSpawnAt(road, lane, sSpawn, newLen, minGap) {
  road.sortLanes();
  const laneVeh = road.lanes[lane];
  const { leader } = findNeighborsAtS(laneVeh, sSpawn);
  if (!leader) return true;
  // require: leader.s - (sSpawn + newLen) >= minGap  =>  leader.s - sSpawn >= newLen + minGap
  return (leader.s - sSpawn) >= (newLen + minGap);
}

export function spawnVehicle(net, road, { id, lane, s, v }) {
  const h = net.hetero;

  const isTruck = Math.random() < h.truckFraction;
  const length = isTruck ? h.truckLength : h.carLength;

  // per-vehicle v0 multiplier (cars spread, trucks slower)
  let v0Mult = 1.0 + h.v0Spread * randnApprox();
  v0Mult = Math.max(0.70, Math.min(1.30, v0Mult));
  if (isTruck) v0Mult = Math.min(v0Mult, h.truckV0Mult);

  const veh = new Vehicle({ id, s, v, lane, roadId: road.id, length, v0Mult, isTruck });
  road.lanes[lane].push(veh);
  return veh;
}

function removeExitedMain(mainRoad, buffer = 120) {
  const maxS = mainRoad.length + buffer;
  for (let l = 0; l < mainRoad.laneCount; l++) {
    mainRoad.lanes[l] = mainRoad.lanes[l].filter(v => v.s <= maxS);
  }
}

// -----------------------
// Step
// -----------------------
export function stepNetwork(net, idmParamsBase = defaultIdmParams, mobilParams = defaultMobilParams, dt = 0.1) {
  net.time += dt;

  // phantom pulse (može ostati ovdje)
  maybeTriggerBrakePulse(net);

  // Lane-change i merge mijenjaju susjede -> radi ih prije računanja acc za integraciju
  laneChangeMain(net.roads.main, net.time, idmParamsBase, mobilParams);
  mergeFromRamp(net, idmParamsBase, mobilParams);

  // SADA izračunaj tačna ubrzanja za trenutno stanje traka
  calcAccelerationsForRoad(net.roads.main, idmParamsBase);
  calcAccelerationsForRoad(net.roads.ramp, idmParamsBase);

  // Integracija + overlap enforce
  integrateAndEnforce(net, net.roads.main, dt, idmParamsBase);
  integrateAndEnforce(net, net.roads.ramp, dt, idmParamsBase);

  removeExitedMain(net.roads.main, 120);
}


export function getAllVehicles(net) {
  return [...net.roads.main.allVehicles(), ...net.roads.ramp.allVehicles()];
}

export function trySpawnMain(net, lane, sSpawn, vInit, idCounterRef, minGap = 8) {
  const main = net.roads.main;
  // conservative: assume the longest possible vehicle could spawn here
  const newLen = net.hetero?.truckLength ?? 7.5;
  if (!canSpawnAt(main, lane, sSpawn, newLen, minGap)) return false;
  spawnVehicle(net, main, { id: idCounterRef.nextId++, lane, s: sSpawn, v: vInit });
  return true;
}

export function trySpawnRamp(net, sSpawn, vInit, idCounterRef, minGap = 8) {
  const ramp = net.roads.ramp;
  const newLen = net.hetero?.truckLength ?? 7.5;
  if (!canSpawnAt(ramp, 0, sSpawn, newLen, minGap)) return false;
  spawnVehicle(net, ramp, { id: idCounterRef.nextId++, lane: 0, s: sSpawn, v: vInit });
  return true;
}
