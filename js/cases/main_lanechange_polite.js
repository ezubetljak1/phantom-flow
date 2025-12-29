// ./js/cases/main_lanechange_polite.js
function $(id) { return document.getElementById(id); }
function setSlider(id, value) {
  const el = $(id); if (!el) throw new Error(`Missing #${id}`);
  el.value = String(value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}
function click(id) { const el = $(id); if (!el) throw new Error(`Missing #${id}`); el.click(); }
function readSamples() {
  const m = $("logInfo")?.textContent?.match(/log:\s*(\d+)\s*samples/i);
  return m ? Number(m[1]) : 0;
}
async function waitSamples(target, timeoutMs = 240000) {
  const t0 = performance.now();
  while (readSamples() < target) {
    if (performance.now() - t0 > timeoutMs) throw new Error("Timeout");
    await new Promise(r => setTimeout(r, 200));
  }
}

export async function runCase() {
  setSlider("v0Slider", 120);
  setSlider("TSlider", 1.4);
  setSlider("aSlider", 0.3);
  setSlider("bSlider", 2.0);

  // polite
  setSlider("pSlider", 0.8);
  setSlider("thrSlider", 0.45);

  // isti demand kao breakdown test
  setSlider("mainInflowSlider", 4500);
  setSlider("rampInflowSlider", 1200);

  click("resetBtn");
  click("clearLogBtn");

  await waitSamples(900);
  click("pauseBtn");
  click("downloadLogBtn");
}
