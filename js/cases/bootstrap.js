// ./js/cases/bootstrap.js
function getParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

async function boot() {
  const caseName = getParam("case");
  if (!caseName) return;

  try {
    const mod = await import(`./${caseName}.js`);
    if (typeof mod.runCase === "function") {
      await mod.runCase();
    } else {
      console.warn(`[cases] ${caseName}.js nema export runCase()`);
    }
  } catch (e) {
    console.error("[cases] Ne mogu učitati case:", caseName, e);
  }
}

// sačekaj da se DOM i main/roundabout inicijalizuju
window.addEventListener("load", () => {
  // mali delay da se UI + listeners sigurno nakače
  setTimeout(boot, 250);
});
