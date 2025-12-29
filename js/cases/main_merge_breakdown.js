// ./js/cases/main_merge_breakdown.js
function $(id) { return document.getElementById(id); }
function setSlider(id, value) {
  const el = $(id); if (!el) throw new Error(`Missing #${id}`);
  el.value = String(value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}
function click(id) {
  const el = $(id); if (!el) throw new Error(`Missing #${id}`);
  el.click();
}
function readSamples() {
  const el = $("logInfo");
  const m = el?.textContent?.match(/log:\s*(\d+)\s*samples/i);
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
  // zadrži iste modele kao baseline
  setSlider("v0Slider", 120);
  setSlider("TSlider", 1.4);
  setSlider("aSlider", 1.0);
  setSlider("bSlider", 2.0);
  setSlider("pSlider", 0.2);
  setSlider("thrSlider", 0.35);

  // demand visok → breakdown na merge
  setSlider("mainInflowSlider", 3600);
  setSlider("rampInflowSlider", 1200);

  click("resetBtn");
  click("clearLogBtn");

  // 900 samples ≈ 15 min
  await waitSamples(610);

  click("pauseBtn");
  click("downloadLogBtn");
}
