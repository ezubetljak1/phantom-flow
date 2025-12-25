// main.js
import { step, defaultIdmParams, defaultMobilParams } from './models.js';

// ---------------------------
// 1) Simulacijsko stanje
// ---------------------------

const state = {
  roadLength: 920,   // dužina puta u "metrima"
  laneCount: 4,      // 3 glavne trake + 1 rampa
  isRing: false,     // otvorena U-raskrsnica sa ulazom i izlazom
  mainLaneCount: 3,  // lane 0,1,2 = glavne
  rampLaneIndex: 3,  // lane 3 = rampa
  rampStart: 200,
  rampEnd: 280,
  vehicles: []
};

let nextId = 0;

// početni broj vozila po glavnoj traci (seed gustina)
const initialMainCarsPerLane = 25;
const initialRampCars = 6;

// ---------------------------
// 2) Canvas i geometrija
// ---------------------------

const canvas = document.getElementById('simCanvas');
const ctx = canvas.getContext('2d');

const W = canvas.width;
const H = canvas.height;

// geometrija U-raskrsnice
const geom = {
  L: state.roadLength,

  // segmenti puta
  L_bottom: 360,
  L_curve: 200,
  L_top: state.roadLength - 360 - 200, // = 360

  xRight: 960,
  xLeft: 260,

  yTop: 115,
  yBottom: 520,

  cx: 260,
  cy: (115 + 520) / 2,
  R: (520 - 115) / 2,

  laneOffset: 18,

  // rampa – uvučena nadesno i poravnata s donjom trakom
  ramp: {
    s0: state.rampStart,
    s1: state.rampEnd,
    x0: 580,  // početak rampe (dolje desno)
    y0: 610,
    x1: 440,  // tačka spajanja u vanjsku traku
    y1: 542
  }
};

// ---------------------------
// 3) Inicializacija vozila
// ---------------------------

function seedVehicles() {
  state.vehicles = [];
  nextId = 0;

  const baseSpeed = defaultIdmParams.v0; // m/s

  // glavne trake – ravnomjerno raspoređeni
  for (let lane = 0; lane < state.mainLaneCount; lane++) {
    const nCars = initialMainCarsPerLane;
    for (let k = 0; k < nCars; k++) {
      const s = (k * state.roadLength) / nCars + lane * 5;
      const v = baseSpeed * (0.8 + 0.4 * Math.random());

      state.vehicles.push({
        id: nextId++,
        x: s,
        v,
        lane,
        length: 4.5,
        acc: 0
      });
    }
  }

  // par vozila na rampi da ne bude prazna na početku
  for (let k = 0; k < initialRampCars; k++) {
    const s = 130 + (k * (190 - 130)) / (initialRampCars - 1); // ispred rampe
    const v = 15 + (Math.random() - 0.5) * 4;

    state.vehicles.push({
      id: nextId++,
      x: s,
      v,
      lane: state.rampLaneIndex,
      length: 4.5,
      acc: 0
    });
  }
}

seedVehicles();

// ---------------------------
// 4) Mapiranje 1D pozicije -> (x,y)
// ---------------------------

function mapMainLane(s, laneIndex) {
  const g = geom;
  const { L_bottom, L_curve, L_top } = g;
  let x, y, tangentAngle;

  // otvoreni put: ne radimo wrap, samo clamp na 0
  if (s < 0) s = 0;

  if (s < L_bottom) {
    // donja ravna: desno -> lijevo
    const u = s / L_bottom;
    x = g.xRight - u * (g.xRight - g.xLeft);
    y = g.yBottom;
    tangentAngle = Math.PI;
  } else if (s < L_bottom + L_curve) {
    // polukružno
    const u = (s - L_bottom) / L_curve;
    const theta = Math.PI / 2 + u * Math.PI;
    x = g.cx + g.R * Math.cos(theta);
    y = g.cy + g.R * Math.sin(theta);
    tangentAngle = theta + Math.PI / 2;
  } else {
    // gornja ravna: lijevo -> desno
    const u = (s - L_bottom - L_curve) / L_top;
    x = g.xLeft + u * (g.xRight - g.xLeft);
    y = g.yTop;
    tangentAngle = 0;
  }

  // lane offset normalno na pravac kretanja
  const baseLane = 1; // lane 1 = srednja traka
  const offset = (laneIndex - baseLane) * g.laneOffset;
  const nAngle = tangentAngle - Math.PI / 2;

  x += offset * Math.cos(nAngle);
  y += offset * Math.sin(nAngle);

  return { x, y };
}

function mapRamp(s) {
  const r = geom.ramp;
  let t = (s - r.s0) / (r.s1 - r.s0);
  t = Math.max(0, Math.min(1, t));

  const x = r.x0 + t * (r.x1 - r.x0);
  const y = r.y0 + t * (r.y1 - r.y0);

  return { x, y };
}

function worldToCanvas(veh) {
  if (veh.lane === state.rampLaneIndex) {
    return mapRamp(veh.x);
  }
  return mapMainLane(veh.x, veh.lane);
}

// ---------------------------
// 5) Crtanje pozadine
// ---------------------------

function drawBackground() {
  const laneWidth = 18;
  const edgeWidth = 4;

  // trava
  ctx.fillStyle = '#4b7a33';
  ctx.fillRect(0, 0, W, H);

  function strokeRingAtLane(laneIdx, styleCb) {
    ctx.beginPath();
    let first = true;
    for (let s = 0; s <= geom.L; s += 5) {
      const { x, y } = mapMainLane(s, laneIdx);
      if (first) {
        ctx.moveTo(x, y);
        first = false;
      } else {
        ctx.lineTo(x, y);
      }
    }
    styleCb();
  }

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // vanjski bijeli rub
  strokeRingAtLane(1, () => {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3 * laneWidth + 2 * edgeWidth;
    ctx.stroke();
  });

  // asfalt
  strokeRingAtLane(1, () => {
    ctx.strokeStyle = '#555555';
    ctx.lineWidth = 3 * laneWidth;
    ctx.stroke();
  });

  // isprekidane linije između traka
  ctx.setLineDash([24, 18]);
  [0.5, 1.5].forEach(midLane => {
    strokeRingAtLane(midLane, () => {
      ctx.strokeStyle = '#dcdcdc';
      ctx.lineWidth = 2;
      ctx.stroke();
    });
  });
  ctx.setLineDash([]);

  // --- rampa ---
  function strokeRamp(style, lineWidth, dashed = false, tEnd = 1.0) {
    ctx.beginPath();
    let first = true;
    for (let t = 0; t <= tEnd + 1e-3; t += 0.02) {
      const r = geom.ramp;
      const x = r.x0 + t * (r.x1 - r.x0);
      const y = r.y0 + t * (r.y1 - r.y0);
      if (first) {
        ctx.moveTo(x, y);
        first = false;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.strokeStyle = style;
    ctx.lineWidth = lineWidth;
    if (dashed) ctx.setLineDash([24, 18]);
    ctx.stroke();
    if (dashed) ctx.setLineDash([]);
  }

  // rub rampe – kraće
  strokeRamp('#ffffff', laneWidth + 2 * edgeWidth, false, 0.8);

  // tijelo rampe – malo duže
  strokeRamp('#555555', laneWidth - 2, false, 0.92);
}

// ---------------------------
// 6) Crtanje vozila
// ---------------------------

function drawVehicles() {
  for (const veh of state.vehicles) {
    const { x, y } = worldToCanvas(veh);

    ctx.beginPath();
    ctx.arc(x, y, 6, 0, 2 * Math.PI);

    if (veh.lane === state.rampLaneIndex) {
      ctx.fillStyle = '#ffcc00'; // rampa
    } else if (veh.lane === 0) {
      ctx.fillStyle = '#4caf50';
    } else if (veh.lane === 1) {
      ctx.fillStyle = '#2196f3';
    } else {
      ctx.fillStyle = '#e91e63';
    }

    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#000';
    ctx.stroke();
  }
}

// ---------------------------
// 7) Maska desne strane (da ne vidimo izlaz)
// ---------------------------

function maskRightSide() {
  const maskStart = geom.xRight - 40; // sakrij zadnjih ~40px
  ctx.fillStyle = '#4b7a33';
  ctx.fillRect(maskStart, 0, W - maskStart, H);
}

// ---------------------------
// 8) Dinamički inflow / outflow
// ---------------------------

// Car-following i lane-change parametri (kopija defaulta)
const idmParams = { ...defaultIdmParams };
const mobilParams = { ...defaultMobilParams };

// inflow parametri (vozila / sat)
let mainInflowPerHour = 3600; // ~1000 veh/h po traci
let rampInflowPerHour = 600;

const mainSpawnAccumulators = new Array(state.mainLaneCount).fill(0);
let rampSpawnAccumulator = 0;

// pokušaj ubacivanja vozila na glavnoj traci
function trySpawnOnMain(lane, sSpawn, speed) {
  const minGap = 8; // minimalni razmak (m) do postojećih vozila na ulazu
  const laneVeh = state.vehicles.filter(v => v.lane === lane);

  for (const v of laneVeh) {
    if (Math.abs(v.x - sSpawn) < minGap) return false;
  }

  state.vehicles.push({
    id: nextId++,
    x: sSpawn,
    v: speed,
    lane,
    length: 4.5,
    acc: 0
  });
  return true;
}

function spawnMainVehicles(dt) {
  const totalRatePerSec = mainInflowPerHour / 3600;
  if (totalRatePerSec <= 0) return;

  const laneRatePerSec = totalRatePerSec / state.mainLaneCount;
  const sSpawn = 10; // ulaz malo iza maskiranog dijela

  for (let lane = 0; lane < state.mainLaneCount; lane++) {
    mainSpawnAccumulators[lane] += laneRatePerSec * dt;

    while (mainSpawnAccumulators[lane] >= 1.0) {
      const vInit = idmParams.v0 * (0.8 + 0.4 * Math.random());
      const ok = trySpawnOnMain(lane, sSpawn, vInit);
      if (!ok) {
        // ulaz je blokiran – čekaćemo sljedeći put
        break;
      }
      mainSpawnAccumulators[lane] -= 1.0;
    }
  }
}

// ubacivanje vozila na rampu
function trySpawnOnRamp(sSpawn, speed) {
  const minGap = 8;
  const laneVeh = state.vehicles.filter(
    v => v.lane === state.rampLaneIndex
  );

  for (const v of laneVeh) {
    if (Math.abs(v.x - sSpawn) < minGap) return false;
  }

  state.vehicles.push({
    id: nextId++,
    x: sSpawn,
    v: speed,
    lane: state.rampLaneIndex,
    length: 4.5,
    acc: 0
  });
  return true;
}

function spawnRampVehicles(dt) {
  const ratePerSec = rampInflowPerHour / 3600;
  if (ratePerSec <= 0) return;

  rampSpawnAccumulator += ratePerSec * dt;

  const sMin = state.rampStart - 80;
  const sMax = state.rampStart - 10;

  while (rampSpawnAccumulator >= 1.0) {
    const sSpawn = sMin + Math.random() * (sMax - sMin);
    const vInit = 15 + (Math.random() - 0.5) * 3;

    const ok = trySpawnOnRamp(sSpawn, vInit);
    if (!ok) {
      break;
    }
    rampSpawnAccumulator -= 1.0;
  }
}

// brisanje vozila koja su “izašla” iz modela
function removeExitedVehicles() {
  const maxS = state.roadLength + 120;
  state.vehicles = state.vehicles.filter(veh => veh.x <= maxS);
}

// ---------------------------
// 9) UI – slideri
// ---------------------------

function setupSliders() {
  const byId = (id) => document.getElementById(id);

  const v0Slider = byId('v0Slider');
  const v0Value  = byId('v0Value');
  const TSlider  = byId('TSlider');
  const TValue   = byId('TValue');
  const aSlider  = byId('aSlider');
  const aValue   = byId('aValue');
  const bSlider  = byId('bSlider');
  const bValue   = byId('bValue');

  const pSlider   = byId('pSlider');
  const pValue    = byId('pValue');
  const thrSlider = byId('thrSlider');
  const thrValue  = byId('thrValue');

  const mainInflowSlider = byId('mainInflowSlider');
  const mainInflowValue  = byId('mainInflowValue');
  const rampInflowSlider = byId('rampInflowSlider');
  const rampInflowValue  = byId('rampInflowValue');

  // inicijalne vrijednosti slidera
  v0Slider.value = (idmParams.v0 * 3.6).toFixed(0);
  TSlider.value  = idmParams.T.toFixed(1);
  aSlider.value  = idmParams.a.toFixed(1);
  bSlider.value  = idmParams.b.toFixed(1);

  pSlider.value   = mobilParams.p.toFixed(2);
  thrSlider.value = mobilParams.bThr.toFixed(2);

  mainInflowSlider.value = mainInflowPerHour.toFixed(0);
  rampInflowSlider.value = rampInflowPerHour.toFixed(0);

  function updateV0() {
    const kmh = Number(v0Slider.value);
    idmParams.v0 = kmh / 3.6;
    v0Value.textContent = kmh.toFixed(0) + ' km/h';
  }
  function updateT() {
    const T = Number(TSlider.value);
    idmParams.T = T;
    TValue.textContent = T.toFixed(1) + ' s';
  }
  function updateA() {
    const a = Number(aSlider.value);
    idmParams.a = a;
    aValue.textContent = a.toFixed(1) + ' m/s²';
  }
  function updateB() {
    const b = Number(bSlider.value);
    idmParams.b = b;
    bValue.textContent = b.toFixed(1) + ' m/s²';
  }
  function updateP() {
    const p = Number(pSlider.value);
    mobilParams.p = p;
    pValue.textContent = p.toFixed(2);
  }
  function updateThr() {
    const thr = Number(thrSlider.value);
    mobilParams.bThr = thr;
    thrValue.textContent = thr.toFixed(2) + ' m/s²';
  }
  function updateMainInflow() {
    mainInflowPerHour = Number(mainInflowSlider.value);
    mainInflowValue.textContent =
      mainInflowPerHour.toFixed(0) + ' veh/h';
  }
  function updateRampInflow() {
    rampInflowPerHour = Number(rampInflowSlider.value);
    rampInflowValue.textContent =
      rampInflowPerHour.toFixed(0) + ' veh/h';
  }

  v0Slider.addEventListener('input', updateV0);
  TSlider.addEventListener('input', updateT);
  aSlider.addEventListener('input', updateA);
  bSlider.addEventListener('input', updateB);

  pSlider.addEventListener('input', updateP);
  thrSlider.addEventListener('input', updateThr);

  mainInflowSlider.addEventListener('input', updateMainInflow);
  rampInflowSlider.addEventListener('input', updateRampInflow);

  // inicijalni tekst
  updateV0();
  updateT();
  updateA();
  updateB();
  updateP();
  updateThr();
  updateMainInflow();
  updateRampInflow();
}

// ---------------------------
// 10) Simulacijska petlja
// ---------------------------

let lastTime = performance.now();
let simTime = 0;
const dt = 0.05;
let accumulator = 0;

function renderFrame() {
  ctx.clearRect(0, 0, W, H);
  drawBackground();
  drawVehicles();
  maskRightSide(); // sakrij izlaz
}

function loop(timestamp) {
  const frameTime = (timestamp - lastTime) / 1000;
  lastTime = timestamp;

  const clamped = Math.min(frameTime, 0.25);
  accumulator += clamped;

  while (accumulator >= dt) {
    // dinamičko ubacivanje/izbacivanje vozila
    spawnMainVehicles(dt);
    spawnRampVehicles(dt);

    step(state, idmParams, mobilParams, dt);
    simTime += dt;
    accumulator -= dt;

    removeExitedVehicles();
  }

  renderFrame();
  requestAnimationFrame(loop);
}

// start
setupSliders();
renderFrame();
requestAnimationFrame(loop);
