// ./js/cases/main_freeflow.js
function $(id) { return document.getElementById(id); }

function setSlider(id, value) {
  const el = $(id);
  if (!el) throw new Error(`Missing element #${id}`);
  el.value = String(value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function click(id) {
  const el = $(id);
  if (!el) throw new Error(`Missing button #${id}`);
  el.click();
}

function readSamples() {
  const el = $("logInfo");
  if (!el) return 0;
  // main: "log: 123 samples"
  const m = el.textContent.match(/log:\s*(\d+)\s*samples/i);
  return m ? Number(m[1]) : 0;
}

async function waitSamples(target, timeoutMs = 180000) {
  const t0 = performance.now();
  while (readSamples() < target) {
    if (performance.now() - t0 > timeoutMs) throw new Error("Timeout čekajući sample-ove");
    await new Promise(r => setTimeout(r, 200));
  }
}

export async function runCase() {
  // IDM
  setSlider("v0Slider", 120);
  setSlider("TSlider", 1.4);
  setSlider("aSlider", 1.0);
  setSlider("bSlider", 2.0);

  // MOBIL
  setSlider("pSlider", 0.2);
  setSlider("thrSlider", 0.35);

  // inflow
  setSlider("mainInflowSlider", 1800);
  setSlider("rampInflowSlider", 200);

  // reset + clear log (redoslijed nije kritičan, ali ovako je “čisto”)
  click("resetBtn");
  click("clearLogBtn");

  // 600 samples ≈ 10 min (ako LOG_EVERY_SEC=1s)
  await waitSamples(610);

  click("pauseBtn");       // zamrzni da ti vrijeme ne “bježi”
  click("downloadLogBtn"); // skini JSON
}
