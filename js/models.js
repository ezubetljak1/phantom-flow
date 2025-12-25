// models.js

// -----------------------
// Helper: tanh
// -----------------------
function myTanh(x) {
  if (x > 50) return 1;
  if (x < -50) return -1;
  const e2x = Math.exp(2 * x);
  return (e2x - 1) / (e2x + 1);
}

// -----------------------
// ACC (IDM+CAH) – longitudinal model
// -----------------------

export const defaultIdmParams = {
  v0: 30,      // željena brzina (m/s)
  T: 1.8,      // time headway (s)
  s0: 4.0,     // minimalni razmak (m)
  a: 1.0,      // max ugodno ubrzanje
  b: 1.5,      // ugodno kočenje
  cool: 0.9,   // mix faktor između IDM i CAH
  bmax: 10.0   // maksimalno dozvoljeno kočenje (|a|)
};

// ACC deterministička akceleracija (bez šuma)
function accACC(s, v, vl, al, params) {
  const { v0, T, s0, a, b, cool, bmax } = params;

  // efektivni parametri (ovdje nema speedlimit / driverfactor)
  let v0eff = v0;
  const aeff = a;

  if (v0eff < 1e-5) return 0;

  // free-road član (IDM)
  const accFree = aeff * (1 - Math.pow(v / v0eff, 4));

  // desired gap s*
  const sStar =
    s0 +
    Math.max(
      0,
      v * T + (0.5 * v * (v - vl)) / Math.sqrt(aeff * b)
    );

  // interakcijski član
  const sEff = Math.max(s, s0);
  const accInt = -aeff * Math.pow(sStar / sEff, 2);

  // IDM+ (ne dozvoli previše pozitivan acc kad smo blizu)
  const accIDM = Math.min(accFree, aeff + accInt);

  // CAH – collision avoidance heuristic
  let accCAH;
  if (vl * (v - vl) < -2 * s * al) {
    // "braking leader" situation
    accCAH = (v * v * al) / (vl * vl - 2 * s * al);
  } else {
    accCAH =
      al -
      ((v - vl) * (v - vl)) /
        (2 * Math.max(s, 0.01)) *
        (v > vl ? 1 : 0);
  }
  accCAH = Math.min(accCAH, aeff);

  // mix IDM i CAH
  const accMix =
    accIDM > accCAH
      ? accIDM
      : accCAH + b * myTanh((accIDM - accCAH) / b);

  const accACC = cool * accMix + (1 - cool) * accIDM;

  // clamp na maksimalno kočenje
  return Math.max(-bmax, accACC);
}

// -----------------------
// MOBIL lane-change model
// -----------------------

export const defaultMobilParams = {
  bSafe: 2.0,       // "sigurno" kočenje (~m/s^2) pri višim brzinama
  bSafeMax: 4.0,    // dopušteno jače kočenje pri manjim brzinama
  p: 0.3,           // politeness faktor
  bThr: 0.2,        // prag koristi lane change-a
  bBiasRight: 0.0,  // bez desno/left bias-a za sada
  cooldown: 3.0     // minimalni razmak između dva LC istog vozila (s)
};

function mobilRealizeLaneChange(
  vrel,        // v / v0, [0,1]
  acc,         // vlastita akceleracija na staroj traci
  accNew,      // vlastita akceleracija na novoj traci
  accLagNew,   // akceleracija novog followera nakon lane-change-a
  toRight,     // bool
  params
) {
  const { bSafe, bSafeMax, p, bThr, bBiasRight } = params;

  const signRight = toRight ? 1 : -1;
  const bSafeActual = vrel * bSafe + (1 - vrel) * bSafeMax;

  // ekstremni bias
  if (signRight * bBiasRight > 40) {
    return true;
  }

  // safety kriterij: follower nakon LC ne smije previše kočiti
  if (accLagNew < Math.min(-bSafeActual, -Math.abs(bBiasRight))) {
    return false;
  }

  // incentive kriterij 
  let dacc =
    accNew - acc +
    p * accLagNew +
    bBiasRight * signRight -
    bThr;

  // hard-prohibit LC protiv bias-a ako |bias|>9 (ovdje nema efekta jer je 0)
  if (bBiasRight * signRight < -9) {
    dacc = -1;
  }

  return dacc > 0;
}

// -----------------------
// Lanes & helperi
// -----------------------

function isRingLane(state, laneIndex) {
  return (
    state.isRing &&
    laneIndex >= 0 &&
    laneIndex < state.mainLaneCount
  );
}

function groupVehiclesByLane(state) {
  const lanes = Array.from(
    { length: state.laneCount },
    () => []
  );
  for (const veh of state.vehicles) {
    lanes[veh.lane].push(veh);
  }
  // sort po x
  for (const lane of lanes) {
    lane.sort((a, b) => a.x - b.x);
  }
  return lanes;
}

function findLeaderFollowerInLane(
  laneVehicles,
  veh,
  state,
  laneIndex
) {
  const isRing = isRingLane(state, laneIndex);
  const L = state.roadLength;

  if (laneVehicles.length === 0) {
    return { leader: null, follower: null };
  }

  const idx = laneVehicles.indexOf(veh);
  if (idx === -1) {
    // vozilo nije trenutno u toj traci, tražimo gdje bi upalo
    let insertPos = 0;
    while (
      insertPos < laneVehicles.length &&
      laneVehicles[insertPos].x < veh.x
    ) {
      insertPos++;
    }
    const leader =
      insertPos < laneVehicles.length
        ? laneVehicles[insertPos]
        : isRing
        ? laneVehicles[0]
        : null;
    const follower =
      insertPos > 0
        ? laneVehicles[insertPos - 1]
        : isRing
        ? laneVehicles[laneVehicles.length - 1]
        : null;
    return { leader, follower };
  } else {
    const leader =
      idx < laneVehicles.length - 1
        ? laneVehicles[idx + 1]
        : isRing
        ? laneVehicles[0]
        : null;
    const follower =
      idx > 0
        ? laneVehicles[idx - 1]
        : isRing
        ? laneVehicles[laneVehicles.length - 1]
        : null;
    return { leader, follower };
  }
}

// gap i info o lideru
function gapAndLeader(veh, leader, state, laneIndex) {
  const L = state.roadLength;
  const isRing = isRingLane(state, laneIndex);

  if (!leader) {
    // nema lidera => slobodan put
    return {
      s: 1e6,
      vLead: veh.v,
      aLead: 0
    };
  }

  let dx = leader.x - veh.x;
  if (isRing) {
    if (dx <= 0) dx += L;
  }

  const s = dx - veh.length;
  return {
    s: Math.max(s, 0.01),
    vLead: leader.v,
    aLead: leader.acc || 0
  };
}

// nakon lane-change-a, follower u target traci vidi ovog veh kao lidera
function gapFollowerAfterLC(follower, veh, state, laneIndex) {
  const L = state.roadLength;
  const isRing = isRingLane(state, laneIndex);

  let dx = veh.x - follower.x;
  if (isRing) {
    if (dx <= 0) dx += L;
  }

  const s = dx - follower.length;
  return {
    s: Math.max(s, 0.01),
    vLead: veh.v,
    aLead: veh.acc || 0
  };
}

// -----------------------
// 1) Izračun ACC akceleracija
// -----------------------

function calcAccelerations(state, accParams) {
  const lanes = groupVehiclesByLane(state);
  state.minGapDebug = Infinity;

  for (let laneIndex = 0; laneIndex < lanes.length; laneIndex++) {
    const laneVehicles = lanes[laneIndex];
    for (const veh of laneVehicles) {
      const { leader } = findLeaderFollowerInLane(
        laneVehicles,
        veh,
        state,
        laneIndex
      );
      const { s, vLead, aLead } = gapAndLeader(
        veh,
        leader,
        state,
        laneIndex
      );
      const acc = accACC(s, veh.v, vLead, aLead, accParams);
      veh.acc = acc;

      if (leader && s < state.minGapDebug) {
        state.minGapDebug = s;
      }
    }
  }
}

// -----------------------
// 2) Lane-change (MOBIL + rampa)
// -----------------------

function changeLanes(state, accParams, mobilParams) {
  const lanes = groupVehiclesByLane(state);
  const laneChanges = [];

  const now = state.time || 0;
  const cooldown = mobilParams.cooldown || 3;

  for (let laneIndex = 0; laneIndex < lanes.length; laneIndex++) {
    const laneVehicles = lanes[laneIndex];

    for (const veh of laneVehicles) {
      if (
        veh.lastLaneChangeTime !== undefined &&
        now - veh.lastLaneChangeTime < cooldown
      ) {
        continue;
      }

      // kandidati traka
      const candidates = [];

      if (laneIndex === state.rampLaneIndex) {
        // rampa može samo u vanjsku glavnu traku (npr. 2)
        const mergeLane = state.mainLaneCount - 1;
        candidates.push(mergeLane);
      } else {
        // glavne trake: lijevo/desno unutar [0, mainLaneCount-1]
        const left = laneIndex - 1;
        const right = laneIndex + 1;
        if (left >= 0 && left < state.mainLaneCount)
          candidates.push(left);
        if (right >= 0 && right < state.mainLaneCount)
          candidates.push(right);
      }

      if (candidates.length === 0) continue;

      const accOld = veh.acc || 0;
      let chosenLane = laneIndex;

      for (const targetLane of candidates) {
        if (targetLane === laneIndex) continue;

        const toRight = targetLane > laneIndex;
        const targetLaneVehicles = lanes[targetLane];

        // lider/follower u target traci
        const { leader: leaderNew, follower: followerNew } =
          findLeaderFollowerInLane(
            targetLaneVehicles,
            veh,
            state,
            targetLane
          );

        const { s: sNew, vLead: vLeadNew, aLead: aLeadNew } =
          gapAndLeader(veh, leaderNew, state, targetLane);
        const accNew = accACC(
          sNew,
          veh.v,
          vLeadNew,
          aLeadNew,
          accParams
        );

        let accLagNew = 0; // akceleracija novog followera nakon LC

        if (followerNew) {
          const { s: sLagNew, vLead, aLead } =
            gapFollowerAfterLC(
              followerNew,
              veh,
              state,
              targetLane
            );
          accLagNew = accACC(
            sLagNew,
            followerNew.v,
            vLead,
            aLead,
            accParams
          );
        }

        const vrel = Math.max(
          0,
          Math.min(1, veh.v / accParams.v0)
        );

        const ok = mobilRealizeLaneChange(
          vrel,
          accOld,
          accNew,
          accLagNew,
          toRight,
          mobilParams
        );

        if (ok) {
          chosenLane = targetLane;
          break; // prva dobra odluka je dovoljna
        }
      }

      if (chosenLane !== laneIndex) {
        laneChanges.push({ veh, newLane: chosenLane });
      }
    }
  }

  // primijeni lane-change (BITNO za animaciju!)
  // primjena lane-change odluka
  for (const { veh, newLane } of laneChanges) {
    // zapamti staru traku – koristi se za animaciju
    veh.prevLane = veh.lane;

    // nova traka
    veh.lane = newLane;

    // vrijeme zadnjeg lane-change-a (za cooldown + animaciju)
    veh.lastLaneChangeTime = now;
    veh.laneChangeStartTime = now;
  }
}


// -----------------------
// 3) Update brzina i pozicija
// -----------------------

function updateSpeedPositions(state, dt) {
  const L = state.roadLength;
  const noiseAmp = 0.5; // ~m/s^2, poigraj se 0.2–1.0

  for (const veh of state.vehicles) {
    const aDet = veh.acc || 0;

    // mali random “gas/kočenje”
    const noise = (Math.random() - 0.5) * 2 * noiseAmp;
    const a = aDet + noise;

    veh.v = Math.max(0, veh.v + a * dt);
    veh.x = veh.x + veh.v * dt + 0.5 * a * dt * dt;

    // ring-wrap za glavne trake
    if (isRingLane(state, veh.lane)) {
      veh.x = ((veh.x % L) + L) % L;
    }

    // rampa: ako je iza rampEnd i još je na rampi, prisilno u merge traku
    if (
      veh.lane === state.rampLaneIndex &&
      veh.x > state.rampEnd
    ) {
      veh.lane = state.mainLaneCount - 1; // npr. 2
    }
  }
}


// -----------------------
// Glavna step funkcija
// -----------------------

export function step(
  state,
  idmParams = defaultIdmParams,
  mobilParams = defaultMobilParams,
  dt = 0.1
) {
  if (state.time === undefined) state.time = 0;
  state.time += dt;

  calcAccelerations(state, idmParams);
  changeLanes(state, idmParams, mobilParams);
  updateSpeedPositions(state, dt);
}
