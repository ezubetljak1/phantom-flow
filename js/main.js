// main.js
import { step, defaultIdmParams, defaultMobilParams } from './models.js';

// ---------------------------
// 1) Simulacijsko stanje
// ---------------------------

const state = {
  roadLength: 920,   // ukupna dužina prstena u "metrima"
  laneCount: 4,      // 3 glavne trake + 1 rampa
  isRing: true,      // glavne trake čine prsten
  mainLaneCount: 3,  // lane 0,1,2 = glavne
  rampLaneIndex: 3,  // lane 3 = rampa
  rampStart: 200,
  rampEnd: 280,
  vehicles: []
};

let nextId = 0;
const baseSpeed = 24; // ~86 km/h

// --- vozila na glavnim trakama ---
for (let lane = 0; lane < state.mainLaneCount; lane++) {
  const nCars = 30;
  for (let k = 0; k < nCars; k++) {
    const x = (k * state.roadLength) / nCars + lane * 5;
    const v = baseSpeed + (Math.random() - 0.5) * 4;

    state.vehicles.push({
      id: nextId++,
      x: x % state.roadLength,
      v,
      lane,
      length: 4.5,
      acc: 0
    });
  }
}

// --- vozila na rampi ---
const nRampCars = 6;
for (let k = 0; k < nRampCars; k++) {
  const x = 130 + (k * (190 - 130)) / (nRampCars - 1); // s u dometu rampe
  const v = 15 + (Math.random() - 0.5) * 4;

  state.vehicles.push({
    id: nextId++,
    x,
    v,
    lane: state.rampLaneIndex,
    length: 4.5,
    acc: 0
  });
}

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

  // segmenti prstena
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

  // rampa – rotirana nadesno i poravnata s donjom trakom
  ramp: {
    s0: state.rampStart,
    s1: state.rampEnd,
    x0: 580,  // početak rampe
    y0: 610,
    x1: 440,  // tačka spajanja
    y1: 542
  }
};

// ---------------------------
// 3) Mapiranje 1D pozicije -> (x,y)
// ---------------------------

function mapMainLane(s, laneIndex) {
  const g = geom;
  const L = g.L;

  // wrap u [0, L)
  s = ((s % L) + L) % L;

  const { L_bottom, L_curve, L_top } = g;
  let x, y, tangentAngle;

  if (s < L_bottom) {
    // donja ravna: desno -> lijevo
    const u = s / L_bottom;
    x = g.xRight - u * (g.xRight - g.xLeft);
    y = g.yBottom;
    tangentAngle = Math.PI;
  } else if (s < L_bottom + L_curve) {
    // polukružni dio
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

// ---------------------------
// 3a) Lane-change progres i efektivna traka
// ---------------------------

const LANE_CHANGE_DURATION = 1.2; // s, da bude bas vidljivo

function laneChangeProgress(veh, now) {
  if (
    veh.prevLane === undefined ||
    veh.laneChangeStartTime === undefined
  ) {
    return 0;
  }

  const tau = (now - veh.laneChangeStartTime) / LANE_CHANGE_DURATION;

  if (tau >= 1) {
    // animacija završena – očisti state
    veh.prevLane = undefined;
    veh.laneChangeStartTime = undefined;
    return 0;
  }

  return Math.max(0, tau);
}

function worldToCanvasWithProgress(veh, tLC) {
  if (veh.lane === state.rampLaneIndex) {
    return mapRamp(veh.x);
  }

  let laneIdx = veh.lane;

  if (
    tLC > 0 &&
    veh.prevLane !== undefined &&
    veh.prevLane !== veh.lane
  ) {
    // glatko pređi sa prevLane na lane
    laneIdx = veh.prevLane + (veh.lane - veh.prevLane) * tLC;
  }

  return mapMainLane(veh.x, laneIdx);
}

// ---------------------------
// 4) Crtanje pozadine
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
// 5) Boje i crtanje vozila (sa promjenom boje)
// ---------------------------

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const bigint = parseInt(h, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return { r, g, b };
}

function rgbToHex(r, g, b) {
  const toHex = (x) => x.toString(16).padStart(2, '0');
  return '#' + toHex(r) + toHex(g) + toHex(b);
}

function lerpColor(c1, c2, t) {
  const a = hexToRgb(c1);
  const b = hexToRgb(c2);
  const r = Math.round(a.r + (b.r - a.r) * t);
  const g = Math.round(a.g + (b.g - a.g) * t);
  const b2 = Math.round(a.b + (b.b - a.b) * t);
  return rgbToHex(r, g, b2);
}

function baseColorForLane(lane) {
  if (lane === state.rampLaneIndex) return '#ffcc00'; // rampa
  if (lane === 0) return '#4caf50';
  if (lane === 1) return '#2196f3';
  return '#e91e63';
}

function drawVehicles() {
  for (const veh of state.vehicles) {
    const tLC = laneChangeProgress(veh, simTime);
    const { x, y } = worldToCanvasWithProgress(veh, tLC);

    // boja: ako mijenja traku → blend između osnovne boje i bijele
    const baseColor = baseColorForLane(veh.lane);
    let fillColor = baseColor;

    if (tLC > 0) {
      // prvo pola vremena ide prema bijeloj, drugo pola se vraća
      const tBlink = tLC < 0.5 ? tLC * 2 : (1 - tLC) * 2;
      fillColor = lerpColor(baseColor, '#ffffff', tBlink);
    }

    ctx.beginPath();
    ctx.arc(x, y, 6, 0, 2 * Math.PI);
    ctx.fillStyle = fillColor;
    ctx.fill();

    // ako mijenja traku, daj mu jači crni outline
    ctx.lineWidth = tLC > 0 ? 2 : 1;
    ctx.strokeStyle = '#000';
    ctx.stroke();
  }
}

// ---------------------------
// 6) Maska desne strane (da ništa ne vidimo tamo)
// ---------------------------

function maskRightSide() {
  const maskStart = geom.xRight - 40; // po potrebi promijeni na 20–40
  ctx.fillStyle = '#4b7a33';
  ctx.fillRect(maskStart, 0, W - maskStart, H);
}

// ---------------------------
// 7) Simulacijska petlja
// ---------------------------

const idmParams = { ...defaultIdmParams };
const mobilParams = { ...defaultMobilParams };

let lastTime = performance.now();
let simTime = 0;
const dt = 0.1;
let accumulator = 0;

function renderFrame() {
  ctx.clearRect(0, 0, W, H);
  drawBackground();
  drawVehicles();
  maskRightSide(); // NA KRAJU: sakrij desni dio (put + auta)
}

function loop(timestamp) {
  const frameTime = (timestamp - lastTime) / 1000;
  lastTime = timestamp;

  const clamped = Math.min(frameTime, 0.25);
  accumulator += clamped;

  while (accumulator >= dt) {
    step(state, idmParams, mobilParams, dt);
    simTime += dt;
    accumulator -= dt;
  }

  renderFrame();
  requestAnimationFrame(loop);
}

// start
renderFrame();
requestAnimationFrame(loop);
