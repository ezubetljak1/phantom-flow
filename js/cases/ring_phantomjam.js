// ./js/cases/ring_phantomjam.js
function $(id) { return document.getElementById(id); }
function setSlider(id, value) {
  const el = $(id); if (!el) throw new Error(`Missing #${id}`);
  el.value = String(value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}
function click(id) { const el = $(id); if (!el) throw new Error(`Missing #${id}`); el.click(); }

function readSamples() {
  const t = $("logInfo")?.textContent || "";
  const m = t.match(/Samples:\s*(\d+)/i);
  return m ? Number(m[1]) : 0;
}
async function waitSamples(target, timeoutMs = 300000) {
  const t0 = performance.now();
  while (readSamples() < target) {
    if (performance.now() - t0 > timeoutMs) throw new Error("Timeout");
    await new Promise(r => setTimeout(r, 200));
  }
}

export async function runCase() {
  setSlider("ringCountSlider", 32);

  setSlider("v0Slider", 110);
  setSlider("TSlider", 1.4);
  setSlider("aSlider", 1.0);
  setSlider("bSlider", 2.5);
  setSlider("pSlider", 0.1);
  setSlider("thrSlider", 0.35);

  click("resetBtn");
  click("clearLogBtn");

  // sačekaj ~120 samples (0.5s) ≈ 60s, pa okini “random kočenje”
  await waitSamples(120);
  click("brakePulseBtn");

  // ukupno ~1800 samples ≈ 15 min
  await waitSamples(1800);

  click("pauseBtn");
  click("downloadLogBtn");
}
