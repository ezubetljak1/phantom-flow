// roundabout.js
// 3-trake kružna raskrsnica (ring road) bez inflow-a
// Kontrole:
// - Slider "Vozila / traka" (ringCountSlider)
// - Dugme "Random kočenje" (brakePulseBtn) -> maybeTriggerBreakPulse()

import {
  Road,
  spawnVehicle,
  stepNetwork,
  defaultIdmParams,
  defaultMobilParams
} from './models.js';

export function runRoundabout() {
  const canvas = document.getElementById('simCanvas');
  const ctx = canvas.getContext('2d');

  // Update naslov / opis
  const h1 = document.querySelector('h1');
  const info = document.getElementById('info');
  if (h1) h1.textContent = 'Phantom Flow – Kružna raskrsnica';
  if (info) info.textContent = 'IDM + MOBIL, 3 trake, bez inflow-a (broj vozila po traci + random kočenje)';

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

  // Reuse postojećih slider-a ako želiš fino podešavanje IDM/MOBIL
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
  if (pSlider)  { pSlider.min = 0.0;  pSlider.max = 1.0;  pSlider.step = 0.01; }
  if (thrSlider){ thrSlider.min = 0.0;thrSlider.max = 1.0;thrSlider.step = 0.01; }

  // Default vrijednosti (možeš mijenjati)
  setSlider(v0Slider, 110);
  setSlider(TSlider,  1.4);
  setSlider(aSlider,  1.0);
  setSlider(bSlider,  2.5);
  setSlider(pSlider,  0.2);
  setSlider(thrSlider,0.35);

  // ---------------------------
  // Ring geometrija (fizičke jedinice)
  // ---------------------------
  const laneCount = 3;
  const innerRadiusM = 95;   // unutrašnji rub kružnog toka
  const laneWidthM  = 5.8;   // širina trake (m)  (deblje trake)   // širina trake (m)  (deblje trake)
  const refRadiusM  = innerRadiusM + laneWidthM * (laneCount / 2); // referentni radijus za s
  const ringLengthM = 2 * Math.PI * refRadiusM;

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
      truckFraction: 0.0,
      v0Spread: 0.10,
      truckV0Mult: 0.75,
      truckLength: 12.0,
      carLength: 7.5
    },

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
      const vInit = idm.v0 * 0.9 * (0.95 + 0.10 * Math.random());

      spawnVehicle(net, main, { id: idCounter.nextId++, lane, s, v: vInit });
    }
  }

  main.sortLanes();
}


  // ---------------------------
  // Manualni brake pulse
  // ---------------------------
  function maybeTriggerBreakPulse() {
    // (namjerno zadržan naziv koji si naveo: Break)
    const vehs = [];
    for (let l = 0; l < laneCount; l++) vehs.push(...main.lanes[l]);
    if (vehs.length === 0) return;

    const pick = vehs[(Math.random() * vehs.length) | 0];
    const duration = 2.0 + 1.0 * Math.random();
    const decel = -6.0 - 2.0 * Math.random(); // m/s^2

    pick.extraBrake = decel;
    pick.brakeUntil = net.time + duration;
  }

  // expose for debugging / manual calls
  window.maybeTriggerBreakPulse = maybeTriggerBreakPulse;

  // ---------------------------
  // UI binding
  // ---------------------------
  if (countSlider) {
    // osiguraj da startno imamo vozila (ako je slider 0 ili prazan)
    const v0 = parseInt(countSlider.value, 10);
    if (!Number.isFinite(v0) || v0 <= 0) countSlider.value = '20';
    const updateLabel = () => { if (countValue) countValue.textContent = String(countSlider.value); };
    updateLabel();

    // Rebuild je ok jer nema inflow-a; ako želiš kasnije "smooth add/remove", možemo dodati.
    countSlider.addEventListener('input', () => {
      updateLabel();
      buildVehicles(parseInt(countSlider.value, 10));
    });
  }

  if (brakeBtn) {
    brakeBtn.addEventListener('click', () => {
      maybeTriggerBreakPulse();
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
      buildVehicles(n);
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
  });
  if (thrSlider) thrSlider.addEventListener('input', () => {
    mobil.thr = parseFloat(thrSlider.value);
    setText(thrValue, mobil.thr.toFixed(2));
  });

  // init labels based on defaults (dispatch will run listeners if sliders exist)
  // if slider doesn't exist, set reasonable defaults
  if (!v0Slider) { idm.v0 = 110 / 3.6; setText(v0Value, '110 km/h'); }
  if (!TSlider)  { idm.T = 1.4; setText(TValue, '1.4 s'); }
  if (!aSlider)  { idm.a = 1.0; setText(aValue, '1.0 m/s²'); }
  if (!bSlider)  { idm.b = 2.5; setText(bValue, '2.5 m/s²'); }
  if (!pSlider)  { mobil.p = 0.2; setText(pValue, '0.20'); }
  if (!thrSlider){ mobil.thr = 0.35; setText(thrValue, '0.35'); }

  // Build initial
  const initialN = countSlider ? Math.max(0, parseInt(countSlider.value || '20', 10) || 0) : 20;
  if (countValue) countValue.textContent = String(initialN);
  buildVehicles(initialN);

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
  let lastTs = null;

  function loop(ts) {
    if (lastTs === null) lastTs = ts;
    const dtReal = (ts - lastTs) / 1000;
    lastTs = ts;

    if (running) {
      const dtSim = clamp(dtReal, 0, 0.15);
      const h = 0.04; // substep
      const nSteps = Math.max(1, Math.ceil(dtSim / h));
      for (let i = 0; i < nSteps; i++) stepNetwork(net, idm, mobil, dtSim / nSteps);
    }

    drawRoad();
    drawVehicles();
    drawHud();

    requestAnimationFrame(loop);
  }

  requestAnimationFrame(loop);
}
