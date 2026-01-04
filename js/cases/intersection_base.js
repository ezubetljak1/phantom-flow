// ./js/cases/intersection_base.js
// http://127.0.0.1:5500/html/index.html?scenario=intersection&case=intersection_base&seed=111

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
async function waitSamples(target, timeoutMs = 900000) {
  const t0 = performance.now();
  while (readSamples() < target) {
    if (performance.now() - t0 > timeoutMs) throw new Error("Timeout");
    await new Promise(r => setTimeout(r, 200));
  }
}

export async function runCase() {
  setSlider("aSlider", 3.0);
  setSlider("interInflowSlider", 1500);

  await waitSamples(1200);

  click("pauseBtn");
  click("downloadLogBtn");
}
