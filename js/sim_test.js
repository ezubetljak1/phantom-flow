/*import { step, defaultIdmParams, defaultMobilParams } from './models.js';

const state = {
  roadLength: 1000,
  laneCount: 4,        // 3 kružne + 1 rampa
  isRing: true,        // glavne trake su prsten
  mainLaneCount: 3,
  rampLaneIndex: 3,
  rampStart: 200,
  rampEnd: 350,
  vehicles: [
    // par vozila na kružnim trakama
    { id: 0, x: 50,  v: 20, lane: 0, length: 4.5, acc: 0 },
    { id: 1, x: 120, v: 22, lane: 1, length: 4.5, acc: 0 },
    { id: 2, x: 300, v: 18, lane: 2, length: 4.5, acc: 0 },
    { id: 3, x: 600, v: 25, lane: 1, length: 4.5, acc: 0 },
    { id: 4, x: 850, v: 27, lane: 0, length: 4.5, acc: 0 },

    // jedno auto na rampi, u zoni spajanja
    { id: 5, x: 220, v: 12, lane: 3, length: 4.5, acc: 0 },

    // još jedno auto na rampi iza njega, da se vidi gužva
    { id: 6, x: 210, v: 10, lane: 3, length: 4.5, acc: 0 }
  ]
};


function tick() {
  step(state, defaultIdmParams, defaultMobilParams, 0.1);
  // kasnije ovdje pozoveš draw(state) za vizualizaciju
}


function logState(t) {
  console.log(`\n=== t = ${t.toFixed(1)} s ===`);
  for (const veh of state.vehicles) {
    console.log(
      `id=${veh.id} lane=${veh.lane} x=${veh.x.toFixed(1)}m ` +
      `v=${(veh.v * 3.6).toFixed(1)}km/h a=${veh.acc.toFixed(2)}m/s^2`
    );
  }
}

// ---------------------------
// Test 1: da li sve "diše"
// ---------------------------

function runBasicTest() {
  const dt = 0.5;      // vremenski korak (s)
  const steps = 40;    // ukupno 20 s simulacije
  let t = 0;

  console.log('Pokrećem basic IDM+MOBIL test...');

  logState(t);

  for (let k = 1; k <= steps; k++) {
    step(state, defaultIdmParams, defaultMobilParams, dt);
    t += dt;

    // ispis svakih 5 koraka (svakih 2.5 s)
    if (k % 5 === 0) {
      logState(t);
    }
  }

  console.log('\nZavršeno. Provjeri gore u logu da li:');
  console.log('- brzine idu prema v0 (~30 m/s = 108 km/h) kad je put slobodan,');
  console.log('- vozila na rampi (lane 3) prelaze u lane 2 između x≈200 i x≈350,');
  console.log('- nakon rampEnd više nema auta na lane 3.');
}

runBasicTest();*/
// sim_seed_sanity.js
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

function fingerprint(seed) {
  const rng = makeMulberry32(hashSeed(seed));
  // napravi “fingerprint” od 100 random brojeva
  let sum = 0;
  let sum2 = 0;
  for (let i = 0; i < 100; i++) {
    const x = rng();
    sum += x;
    sum2 += x * x;
  }
  return { sum: sum.toFixed(12), sum2: sum2.toFixed(12) };
}

const seed = process.argv[2] ?? "demo-seed";
console.log("seed:", seed);
console.log("fingerprint:", fingerprint(seed));
