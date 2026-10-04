// Paired A/B of two brain settings on one engine (identical seeds).
// node experiments/ab_brain.js '<brainA json>' '<brainB json>' N seedBase scenarios [workers]
// ENGINE_DIR selects an engine copy (default: the repo's).
const path = require("path");
const wt = require("worker_threads");
const DIR = process.env.ENGINE_DIR || path.join(__dirname, "../pars/web/static");
if (!wt.isMainThread) {
  const T = require(DIR + "/frontier-train.js"), F = require(DIR + "/frontier-engine.js");
  wt.parentPort.on("message", (jobs) => wt.parentPort.postMessage(jobs.map((j) => {
    const { opts = {}, ...b } = j.brain;
    const f = T.playYear({ scenario: j.scenario, hazards: j.hazards, seed: j.seed, ...opts, brain: { ...F.DEFAULT_BRAIN, ...b } });
    return { ...j, s: T.episodeScore(f), o: f.outcome };
  })));
  return;
}
const [BA, BB, N = 100, BASE = 90000, SCS = "red_planet", W = 4] = process.argv.slice(2);
const A = JSON.parse(BA), B = JSON.parse(BB);
const jobs = [];
for (const scenario of SCS.split(",")) for (const hazards of ["normal", "frequent"]) for (let i = 0; i < +N; i++)
  for (const [arm, brain] of [["a", A], ["b", B]]) jobs.push({ arm, brain, scenario, hazards, seed: +BASE + i });
const res = []; let next = 0;
const ws = Array.from({ length: +W }, () => new wt.Worker(__filename));
const feed = (w) => { if (next >= jobs.length) return w.terminate(); w.postMessage(jobs.slice(next, next + 8)); next += 8; };
ws.forEach((w) => { w.on("message", (r) => { res.push(...r); if (res.length === jobs.length) report(); feed(w); }); feed(w); });
function report() {
  const m = (x) => x.reduce((p, q) => p + q, 0) / x.length, se = (x) => Math.sqrt(x.reduce((p, q) => p + (q - m(x)) ** 2, 0) / (x.length * (x.length - 1)));
  const key = (r) => `${r.scenario}|${r.hazards}|${r.seed}`;
  const a = new Map(res.filter((r) => r.arm === "a").map((r) => [key(r), r])), b = new Map(res.filter((r) => r.arm === "b").map((r) => [key(r), r]));
  for (const sc of [...SCS.split(","), "all"]) {
    const ks = [...a.keys()].filter((k) => sc === "all" || k.startsWith(sc + "|"));
    const d = ks.map((k) => a.get(k).s - b.get(k).s), c = (M, o) => ks.filter((k) => M.get(k).o === o).length;
    console.log(`${sc.padEnd(12)} A−B ${m(d).toFixed(2).padStart(6)} ± ${se(d).toFixed(2)} (${d.length} games)  thriving ${c(b, "THRIVING")}→${c(a, "THRIVING")}  perished ${c(b, "PERISHED")}→${c(a, "PERISHED")}`);
  }
}
