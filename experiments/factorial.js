// E34: synergy search. Each technique is an on/off switch; a fractional factorial
// design tests many combinations at once on the same seeds, so we can measure
// not just what each switch does alone but what pairs do together beyond the
// sum of their parts (two weak ideas that only work in combination).
//
// Run:     node experiments/factorial.js run <seedsPerHazard> <seedBase> <scenarios> <out.json> [workers]
// Analyse: node experiments/factorial.js analyse <out.json> [scenario|all]
const path = require("path");
const fs = require("fs");
const wt = require("worker_threads");
const ENGINE_DIR = path.join(__dirname, "../pars/web/static");

// Each factor: [low, high] settings, applied as Frontier options or brain overrides.
const FACTORS = [
  { k: "A", name: "learnStructure", opt: "learnStructure", lo: false, hi: true },
  { k: "B", name: "curiosity", brain: "curiosity", lo: 0, hi: 0.5 },
  { k: "C", name: "frostCover", brain: "frostCover", lo: 0, hi: 1 },
  { k: "D", name: "storage", brain: "storage", lo: 0, hi: 1 },
  { k: "E", name: "waterCare", brain: "waterCare", lo: 0, hi: 1 },
  { k: "F", name: "fieldsMult", brain: "fieldsMult", lo: 0.9, hi: 1.25 },
  { k: "G", name: "coverPatch", brain: "coverPatch", lo: 0, hi: 1 },
  { k: "H", name: "coverBrace", brain: "coverBrace", lo: 0, hi: 1 },
  { k: "J", name: "learnYields", opt: "learnYields", lo: false, hi: true },
  { k: "K", name: "learnPower", opt: "learnPower", lo: false, hi: true },
];

// 2^(10-3) design, 128 runs: 7 base factors in full, 3 generated as products.
// Generators chosen so the defining relation has no word shorter than 5
// (resolution V): main effects and two-way interactions are not aliased with
// each other or with any other main effect / two-way interaction.
function design() {
  const nb = 7, gens = [[0, 1, 2, 3, 4], [0, 1, 2, 5, 6], [0, 3, 5, 6]];
  // Validate resolution: every product of a non-empty subset of generator words must have length >= 5.
  const words = gens.map((g, i) => new Set([...g, nb + i]));
  for (let m = 1; m < 1 << words.length; m++) {
    let w = new Set();
    words.forEach((s, i) => { if (m & (1 << i)) for (const x of s) w.has(x) ? w.delete(x) : w.add(x); });
    if (w.size < 5) throw new Error(`design resolution < V: word ${[...w].map((i) => FACTORS[i].k).join("")}`);
  }
  const runs = [];
  for (let r = 0; r < 1 << nb; r++) {
    const x = Array.from({ length: nb }, (_, i) => ((r >> i) & 1 ? 1 : -1));
    for (const g of gens) x.push(g.reduce((p, i) => p * x[i], 1));
    runs.push(x);
  }
  return runs;
}

function optsFor(x) {
  const o = { brain: {} };
  FACTORS.forEach((f, i) => { const v = x[i] > 0 ? f.hi : f.lo; if (f.opt) o[f.opt] = v; else o.brain[f.brain] = v; });
  return o;
}

if (!wt.isMainThread) {
  const T = require(ENGINE_DIR + "/frontier-train.js");
  const F = require(ENGINE_DIR + "/frontier-engine.js");
  wt.parentPort.on("message", (jobs) => {
    const out = jobs.map((j) => {
      const o = optsFor(j.x);
      const f = T.playYear({ scenario: j.scenario, hazards: j.hazards, seed: j.seed, ...o, brain: { ...F.DEFAULT_BRAIN, ...o.brain } });
      return { ...j, s: T.episodeScore(f), o: f.outcome, d: f.stats.deaths };
    });
    wt.parentPort.postMessage(out);
  });
  return;
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "run") {
  const [S = 10, BASE = 87000, SCS = "river_flood,ash_winter,dry_country,after_wave,red_planet", OUT = "factorial.json", W = 4] = rest;
  const runs = design();
  const jobs = [];
  for (const scenario of SCS.split(",")) for (const hazards of ["normal", "frequent"]) for (let i = 0; i < +S; i++)
    runs.forEach((x, r) => jobs.push({ r, x, scenario, hazards, seed: +BASE + i }));
  // Interleave so partial results are balanced; chunks keep messaging cheap.
  const results = [];
  let next = 0, done = 0;
  const t0 = Date.now();
  const CH = 16;
  const save = () => fs.writeFileSync(OUT, JSON.stringify({ factors: FACTORS, results }));
  const ws = Array.from({ length: +W }, () => new wt.Worker(__filename));
  const feed = (w) => { if (next >= jobs.length) { w.terminate(); return; } w.postMessage(jobs.slice(next, next + CH)); next += CH; };
  ws.forEach((w) => {
    w.on("message", (res) => {
      results.push(...res); done += res.length;
      if (done % 640 < CH) { save(); console.log(`${done}/${jobs.length} games, ${((Date.now() - t0) / 60000).toFixed(1)} min`); }
      if (done === jobs.length) { save(); console.log("done"); }
      feed(w);
    });
    feed(w);
  });
} else if (mode === "analyse") {
  const [IN = "factorial.json", WHICH = "all"] = rest;
  const { factors, results } = JSON.parse(fs.readFileSync(IN, "utf8"));
  const scs = WHICH === "all" ? [...new Set(results.map((r) => r.scenario))] : WHICH.split(",");
  const m = (a) => a.reduce((p, q) => p + q, 0) / a.length;
  const se = (a) => Math.sqrt(a.reduce((p, q) => p + (q - m(a)) ** 2, 0) / (a.length * (a.length - 1)));
  for (const sc of [...scs, ...(scs.length > 1 ? ["(pooled)"] : [])]) {
    const rs = results.filter((r) => sc === "(pooled)" ? scs.includes(r.scenario) : r.scenario === sc);
    // Each (scenario, hazard, seed) block played every design run: one full replicate.
    const blocks = new Map();
    for (const r of rs) { const b = `${r.scenario}|${r.hazards}|${r.seed}`; if (!blocks.has(b)) blocks.set(b, []); blocks.get(b).push(r); }
    const full = [...blocks.values()].filter((b) => b.length === 128);
    if (full.length < 2) { console.log(`${sc}: only ${full.length} complete replicates`); continue; }
    const contrast = (fn) => full.map((b) => m(b.filter((r) => fn(r.x) > 0).map((r) => r.s)) - m(b.filter((r) => fn(r.x) < 0).map((r) => r.s)));
    console.log(`\n=== ${sc}: ${full.length} replicates × 128 combinations (${full.length * 128} games) ===`);
    console.log(`mean score ${m(full.flat().map((r) => r.s)).toFixed(1)}`);
    const main = factors.map((f, i) => { const c = contrast((x) => x[i]); return { f, eff: m(c), se: se(c) }; });
    console.log("Main effects (switch on − off, averaged over everything else):");
    for (const e of main) console.log(`  ${e.f.k} ${e.f.name.padEnd(15)} ${e.eff.toFixed(2).padStart(6)} ± ${e.se.toFixed(2)}${Math.abs(e.eff) > 2 * e.se ? "  *" : ""}`);
    // Interaction = joint effect beyond additive = y++ − y+− − y−+ + y−− (averaged over the rest),
    // i.e. twice the classical AB effect: the extra points from having both on.
    const pairs = [];
    for (let i = 0; i < factors.length; i++) for (let j = i + 1; j < factors.length; j++) {
      const c = contrast((x) => x[i] * x[j]).map((v) => 2 * v);
      pairs.push({ i, j, eff: m(c), se: se(c) });
    }
    pairs.sort((a, b) => Math.abs(b.eff) / b.se - Math.abs(a.eff) / a.se);
    console.log("Two-way interactions, strongest first (extra points when both are on, beyond the sum of each alone):");
    for (const p of pairs.slice(0, 10)) {
      const a = main[p.i], b = main[p.j];
      const tag = p.eff > 3 * p.se && a.eff <= a.se && b.eff <= b.se ? "  SYNERGY (each weak alone)" : p.eff > 3 * p.se ? "  synergy" : p.eff < -3 * p.se ? "  clash" : "";  // 3 SE: 45 pairs per place
      console.log(`  ${factors[p.i].name} × ${factors[p.j].name}`.padEnd(36) + `${p.eff.toFixed(2).padStart(6)} ± ${p.se.toFixed(2)}${tag}`);
    }
    // Best combinations by cell mean, with the shipped default for reference.
    const cell = new Map();
    for (const r of full.flat()) { if (!cell.has(r.r)) cell.set(r.r, { x: r.x, s: [] }); cell.get(r.r).s.push(r.s); }
    const top = [...cell.values()].map((c) => ({ ...c, mean: m(c.s) })).sort((a, b) => b.mean - a.mean).slice(0, 3);
    console.log("Best 3 combinations (raw; winner's-curse inflated, confirm on fresh seeds):");
    for (const c of top) console.log(`  ${c.mean.toFixed(1)}  ` + factors.map((f, i) => (c.x[i] > 0 ? f.k : f.k.toLowerCase())).join(""));
  }
} else {
  console.log("usage: factorial.js run|analyse ...");
}
