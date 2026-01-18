// -----------------------
// Global RNG hook (seeded from main.js)
// -----------------------
let _rng = Math.random;

export function setRng(fn) {
  _rng = (typeof fn === 'function') ? fn : Math.random;
}

export function hashSeed(seed) {
  if (seed == null) return 0x12345;

  if (typeof seed === 'number' && Number.isFinite(seed)) {
    return (seed >>> 0);
  }

  const str = String(seed);
  let h = 2166136261 >>> 0; // FNV offset basis
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619); // FNV prime
  }
  return h >>> 0;
}

/** Mulberry32 RNG: vraća float u [0,1) */
export function makeMulberry32(seedU32) {
  let a = (seedU32 >>> 0);
  return function rng() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Parsira seed iz URL-a. Ako nema ?seed=, vraća defaultSeed.
 * - Ako je čisti integer string -> Number
 * - Inače -> string
 */
export function parseSeedFromUrl({ paramName = 'seed', defaultSeed = 12345 } = {}) {
  const urlParams = new URLSearchParams(window.location.search);
  const seedParam = urlParams.get(paramName);

  if (seedParam === null) return defaultSeed;

  // integer (može i negativan)
  if (/^-?\d+$/.test(seedParam)) return Number(seedParam);

  return seedParam;
}

/**
 * Inicijalizuje deterministički RNG iz URL-a i poveže ga sa models.js (setRng).
 * Vraća API: rand01(), resetRng(), reseed(newSeed), getSeedValue(), getSeedU32(), getRngFn()
 */
export function initSeededRngFromUrl(opts = {}) {
  const seedValue = parseSeedFromUrl(opts);
  return initSeededRng(seedValue);
}

export function rng01(){
    return _rng();
}

/**
 * Ista stvar kao initSeededRngFromUrl, ali prima seed direktno.
 */
export function initSeededRng(seedValue) {
  const seedU32 = hashSeed(seedValue);

  // držimo rngFn u varijabli da rand01() ostane ista referenca
  let rngFn = makeMulberry32(seedU32);

  // ubaci RNG u simulaciju
  setRng(rngFn);

  function rand01() {
    return rngFn();
  }

  function resetRng() {
    rngFn = makeMulberry32(seedU32);
    setRng(rngFn);
  }

  function reseed(newSeedValue) {
    const newU32 = hashSeed(newSeedValue);
    rngFn = makeMulberry32(newU32);
    setRng(rngFn);
    return { seedValue: newSeedValue, seedU32: newU32 };
  }

  function getRngFn() {
    return rngFn;
  }

  return {
    seedValue,
    seedU32,
    rand01,
    resetRng,
    reseed,
    getRngFn
  };
}