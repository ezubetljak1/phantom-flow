// main.js
import { step, defaultIdmParams, defaultMobilParams } from './models.js';

// ---------------------------
// Inicijalno stanje
// ---------------------------

const state = {
  roadLength: 1000,
  laneCount: 4,       // 3 kružne + 1 rampa
  isRing: true,
  mainLaneCount: 3,   // lane 0,1,2
  rampLaneIndex: 3,   // lane 3 je rampa
  rampStart: 200,
  rampEnd: 350,
  vehicles: []
};

// ---------------------------
// Generisanje vozila
// ---------------------------

let nextId = 0;
const baseSpeed = 24; // oko 86 km/h

// 1) Glavne trake (0,1,2)
// npr. po 12 vozila po traci = 36 ukupno
for (let lane = 0; lane < state.mainLaneCount; lane++) {
  const nCars = 5;
  for (let k = 0; k < nCars; k++) {
    const x = (k * state.roadLength) / nCars + lane * 5; // malo pomjeranje po lane-u
    // mala varijacija brzine oko baseSpeed
    const v = baseSpeed + (Math.random()) * 4; // ±2 m/s

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

// 2) Vozila na rampi (lane 3)
// npr. 6 vozila između 130 m i 190 m
const nRampCars = 6;
for (let k = 0; k < nRampCars; k++) {
  const x = 130 + (k * (190 - 130)) / (nRampCars - 1); // od 130 do 190
  const v = 15 + (Math.random() - 0.5) * 4; // sporiji od glavnog toka

  state.vehicles.push({
    id: nextId++,
    x,
    v,
    lane: state.rampLaneIndex,
    length: 4.5,
    acc: 0
  });
}

console.log(`Inicijalizirano vozila: ${state.vehicles.length}`);

// ---------------------------
// Canvas setup
// ---------------------------

const canvas = document.getElementById('simCanvas');
const ctx = canvas.getContext('2d');

const W = canvas.width;
const H = canvas.height;
const cx = W / 2;
const cy = H / 2;

// geometrija kružnih traka
const baseRadius = 200;   // radijus najunutrašnje trake
const laneWidth = 20;     // razmak između traka

// za rampu – nacrtamo kao radijalnu liniju
const rampAngle = (() => {
  const mid = (state.rampStart + state.rampEnd) / 2;
  return (mid / state.roadLength) * 2 * Math.PI - Math.PI / 2;
})(); // -π/2 da 0m bude na vrhu

const rampOuterRadius = baseRadius + (state.mainLaneCount + 3) * laneWidth; // koliko van kruga izlazi rampa

// ---------------------------
// Crtanje
// ---------------------------

function drawRoad() {
  ctx.save();
  ctx.translate(cx, cy);

  // kružne trake
  for (let lane = 0; lane < state.mainLaneCount; lane++) {
    const r = baseRadius + lane * laneWidth;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, 2 * Math.PI);
    ctx.strokeStyle = lane === 0 ? '#444' : '#333';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // rampa kao radijalna "grana"
  const rMerge = baseRadius + (state.mainLaneCount - 0.5) * laneWidth;
  ctx.beginPath();
  ctx.moveTo(rMerge * Math.cos(rampAngle), rMerge * Math.sin(rampAngle));
  ctx.lineTo(rampOuterRadius * Math.cos(rampAngle), rampOuterRadius * Math.sin(rampAngle));
  ctx.strokeStyle = '#555';
  ctx.lineWidth = 3;
  ctx.stroke();

  ctx.restore();
}

function drawVehicles() {
  ctx.save();
  ctx.translate(cx, cy);

  for (const veh of state.vehicles) {
    if (veh.lane === state.rampLaneIndex) {
      // vozila na rampi – pozicioniramo ih duž radijalne linije
      const { rampStart, rampEnd } = state;
      const t = Math.min(
        1,
        Math.max(0, (veh.x - rampStart) / (rampEnd - rampStart))
      );
      const rMerge = baseRadius + (state.mainLaneCount - 0.5) * laneWidth;
      const r = rampOuterRadius - t * (rampOuterRadius - rMerge);

      const x = r * Math.cos(rampAngle);
      const y = r * Math.sin(rampAngle);

      ctx.beginPath();
      ctx.arc(x, y, 5, 0, 2 * Math.PI);
      ctx.fillStyle = '#ffcc00';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#000';
      ctx.stroke();
    } else {
      // vozila na kružnim trakama
      const theta = (veh.x / state.roadLength) * 2 * Math.PI - Math.PI / 2;
      const r = baseRadius + veh.lane * laneWidth;

      const x = r * Math.cos(theta);
      const y = r * Math.sin(theta);

      ctx.beginPath();
      ctx.arc(x, y, 5, 0, 2 * Math.PI);
      ctx.fillStyle =
        veh.lane === 0 ? '#4caf50' :
        veh.lane === 1 ? '#2196f3' :
        '#e91e63';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#000';
      ctx.stroke();
    }
  }

  ctx.restore();
}

function draw() {
  ctx.clearRect(0, 0, W, H);

  // pozadina
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);

  drawRoad();
  drawVehicles();
}

// ---------------------------
// Simulacija
// ---------------------------

const idmParams = { ...defaultIdmParams };
const mobilParams = { ...defaultMobilParams };

// malo prilagodimo 
/*
idmParams.T  = 1.8;
idmParams.s0 = 4.0;

mobilParams.p       = 0.3;
mobilParams.bThr    = 0.3;
mobilParams.bSafe   = 2.0;
mobilParams.bSafeMax= 4.0;
mobilParams.cooldown = 3.0;
*/

// fixed-timestep simulacija
let lastTime = performance.now();
let simTime = 0;
const dt = 0.1;       // 0.1 s simulacijskog vremena po step-u
let accumulator = 0;

function loop(timestamp) {
  const frameTime = (timestamp - lastTime) / 1000; // u sekundama
  lastTime = timestamp;

  // da ne poludi ako tab stoji minimiziran
  const clampedFrameTime = Math.min(frameTime, 0.25);
  accumulator += clampedFrameTime;

  while (accumulator >= dt) {
    step(state, idmParams, mobilParams, dt);
    simTime += dt;
    accumulator -= dt;
  }

  draw();
  requestAnimationFrame(loop);
}

// inicijalni draw pa start petlje
draw();
requestAnimationFrame(loop);
