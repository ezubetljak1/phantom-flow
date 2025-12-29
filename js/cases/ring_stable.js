// ./js/cases/ring_stable.js
function $(id) { return document.getElementById(id); }
function setSlider(id, value) {
  const el = $(id); if (!el) throw new Error(`Missing #${id}`);
  el.value = String(value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}
function click(id) { const el = $(id); if (!el) throw new Error(`Missing #${id}`); el.click(); }

function readSamples() {
  // roundabout: "Samples: X | Traj: ..."
  const t = $("logInfo")?.textContent || "";
  const m = t.match(/Samples:\s*(\d+)/i);
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
  // ring density
  setSlider("ringCountSlider", 18);

  // model params (default-ish)
  setSlider("v0Slider", 110);
  setSlider("TSlider", 1.4);
  setSlider("aSlider", 1.0);
  setSlider("bSlider", 2.5);
  setSlider("pSlider", 0.1);
  setSlider("thrSlider", 0.35);

  click("resetBtn");
  click("clearLogBtn");

  // LOG_EVERY_SEC=0.5 → 1200 samples ≈ 10 min
  await waitSamples(1200);

  click("pauseBtn");
  click("downloadLogBtn");
}
