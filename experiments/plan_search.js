// E27: decision-time planning by imagination ("think before you commit").
// Every K days the colony imagines H days ahead under each candidate
// strategy, R times with different futures (fresh randomness), scores each
// imagined future, and follows the best strategy until the next decision.
// Usage: node experiments/plan_search.js <games> <seedBase> <scenarios> [K H R]
const wt = require("worker_threads");
const path = require("path");
const ENGINE = path.join(__dirname, "../pars/web/static/frontier-engine.js");
const F = require(ENGINE);
const T = require(path.join(__dirname, "../pars/web/static/frontier-train.js"));

const STRATEGIES = {
  asIs: {},
  food: { food: 1.8, farming: 1.8 },
  power: { power: 2 },
  expand: { fieldsMult: 1.25, farming: 1.3 },
  cautious: { growth: 0.3, safety: 1.5, warmth: 1.3 },
};
const withStrategy = (base, k) => { const b = { ...base }; for (const [key, m] of Object.entries(STRATEGIES[k])) b[key] = base[key] * m; return b; };

// value of an imagined future: a cheap stand-in for the year-end score
function value(f, deathsBefore) {
  const pop = Math.max(1, f.alive.length);
  const ok = f.checklist().filter((c) => c.ok).length;
  const harvested = (f.recentHarvest || []).filter(([d]) => d >= f.day - 45).reduce((a, [, x]) => a + x, 0);
  return ok * 4 + Math.min(14, f.alive.length) * 1.5 - (f.stats.deaths - deathsBefore) * 10 + Math.min(90, f.inv.food / pop) * 0.3 + (harvested / pop) * 0.5;
}

function playPlanned(opts, K, H, R, oracle = false, objective = "mean", trigger = "clock") {
  const f = new F.Frontier(opts);
  const base = { ...f.brain };
  const picks = {};
  let decision = 0, lastEvent = "";
  while (f.running) {
    // "event": re-plan when a disaster shows up in the 3-day forecast or
    // starts (the foresight a colony really has), plus a slow clock
    const ev = (f.disaster ? "now:" + f.disaster.type : "") + "|" + f.forecast.map((w) => w.event || "").join(",");
    const fresh = trigger === "event" && ev !== lastEvent && /[a-z]/.test(ev.replace(/now:|\|/g, ""));
    lastEvent = ev;
    if (f.day % K === 0 || fresh) {
      let best = null;
      for (const k of Object.keys(STRATEGIES)) {
        let v = 0; const vals = [];
        for (let r = 0; r < R; r++) {
          const c = f.imagine(opts.seed * 7919 + decision * 101 + r * 13 + 1, oracle);
          c.brain = withStrategy(base, k);
          const d0 = c.stats.deaths;
          if (H > 0) { for (let d = 0; d < H && c.running; d++) c.tick(); v += value(c, d0) / R; }
          else { while (c.running) c.tick(); const sc = T.episodeScore(c); v += sc / R; vals.push(sc); } // H = 0: imagine to year end, true score
        }
        // risk-averse: judge a strategy by the mean of its worst half of imagined futures (CVaR-50)
        if (objective === "worst" && vals.length) { vals.sort((x, y) => x - y); const h = Math.max(1, Math.floor(vals.length / 2)); v = vals.slice(0, h).reduce((p, q) => p + q, 0) / h; }
        if (!best || v > best.v) best = { k, v };
      }
      f.brain = withStrategy(base, best.k);
      picks[best.k] = (picks[best.k] || 0) + 1;
      decision++;
    }
    f.tick();
  }
  return { s: T.episodeScore(f), o: f.outcome, picks };
}

if (!wt.isMainThread) {
  const { K, H, R, oracle, objective, trigger } = wt.workerData;
  wt.parentPort.on("message", ({ id, jobs }) => wt.parentPort.postMessage({ id, res: jobs.map((j) => {
    if (j.planned) return playPlanned(j.opts, K, H, R, oracle, objective, trigger);
    const f = T.playYear(j.opts); return { s: T.episodeScore(f), o: f.outcome };
  }) }));
  return;
}
const [N = 20, BASE = 82000, SCS = "red_planet", K = 20, H = 45, R = 2, ORACLE = "0", OBJ = "mean", TRIG = "clock"] = process.argv.slice(2);
const W = 4, ws = Array.from({ length: W }, () => new wt.Worker(__filename, { workerData: { K: +K, H: +H, R: +R, oracle: ORACLE === "1", objective: OBJ, trigger: TRIG } }));
let nid = 0; const pend = new Map(); ws.forEach((w) => w.on("message", ({ id, res }) => { pend.get(id)(res); pend.delete(id); }));
const run = async (jobs) => { const out = new Array(jobs.length); await Promise.all(ws.map((w, k) => new Promise((res) => { const idx = jobs.map((_, i) => i).filter((i) => i % W === k); const id = nid++; pend.set(id, (r) => { r.forEach((x, j) => { out[idx[j]] = x; }); res(); }); w.postMessage({ id, jobs: idx.map((i) => jobs[i]) }); }))); return out; };
(async () => {
  const SC = SCS.split(","); const eps = [];
  for (const scenario of SC) for (const hazards of ["normal", "frequent"]) for (let i = 0; i < +N; i++) eps.push({ scenario, hazards, seed: +BASE + i });
  const [a, b] = await Promise.all([run(eps.map((opts) => ({ opts, planned: true }))), run(eps.map((opts) => ({ opts })))]);
  const m = (x) => x.reduce((p, q) => p + q, 0) / x.length, se = (x) => Math.sqrt(x.reduce((p, q) => p + (q - m(x)) ** 2, 0) / (x.length * (x.length - 1)));
  for (const sc of SC) {
    const idx = eps.map((e, i) => (e.scenario === sc ? i : -1)).filter((i) => i >= 0);
    const d = idx.map((i) => a[i].s - b[i].s), c = (r, o) => idx.filter((i) => r[i].o === o).length;
    const picks = {}; for (const i of idx) for (const [k, v] of Object.entries(a[i].picks)) picks[k] = (picks[k] || 0) + v;
    console.log(`${sc.padEnd(12)} planned - plain ${m(d).toFixed(2)} ± ${se(d).toFixed(2)} (${d.length} games)  thriving ${c(b, "THRIVING")}→${c(a, "THRIVING")}  perished ${c(b, "PERISHED")}→${c(a, "PERISHED")}  picks ${JSON.stringify(picks)}`);
  }
  ws.forEach((w) => w.terminate());
})();
