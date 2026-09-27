/*
 * PARS Frontier training.
 *
 * Two kinds of learning, both done by playing simulated years:
 *   1. Knowledge: every year inherits what earlier years learned (crop
 *      limits, well odds, real power output, disaster lessons) and adds
 *      its own.
 *   2. Decision weights ("brain"): a cross-entropy method searches the
 *      colony's priority weights. Every candidate plays the same set of
 *      games (same scenarios and seeds), so candidates are compared fairly.
 *
 * Works in Node (CLI at the bottom) and in the browser (FRONTIER_TRAIN).
 *
 *   node pars/web/static/frontier-train.js [--generations 12] [--pop 14] [--years 40] [--out path]
 */
(function (root) {
  "use strict";
  const isNode = typeof module !== "undefined" && module.exports;
  const F = isNode ? require("./frontier-engine.js") : root.FRONTIER;
  const D = isNode ? require("./frontier-data.js") : root.FRONTIER_DATA;

  // Search space: name -> [min, max, log-scale?]
  const SPACE = {
    safety: [0.3, 3, true], warmth: [0.3, 3, true], fuel: [0.3, 3, true], water: [0.3, 3, true],
    waterSource: [0.3, 3, true], food: [0.3, 3, true], farming: [0.3, 3, true], power: [0.3, 3, true],
    growth: [0.2, 3, true], crisisDamp: [0, 0.95, false], fieldsMult: [0.5, 1.8, false],
    woodStock: [2, 20, false], scrapStock: [2, 20, false], fireResponse: [0.3, 3, true],
    repair: [0.3, 3, true], boilBias: [0.5, 3, true],
  };
  const KEYS = Object.keys(SPACE);
  const toUnit = (k, v) => { const [lo, hi, lg] = SPACE[k]; return lg ? (Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo)) : (v - lo) / (hi - lo); };
  const fromUnit = (k, u) => { const [lo, hi, lg] = SPACE[k]; u = Math.max(0, Math.min(1, u)); return lg ? Math.exp(Math.log(lo) + u * (Math.log(hi) - Math.log(lo))) : lo + u * (hi - lo); };
  const vecToBrain = (vec) => Object.fromEntries(KEYS.map((k, i) => [k, Math.round(fromUnit(k, vec[i]) * 1000) / 1000]));
  const brainToVec = (b) => KEYS.map((k) => toUnit(k, b[k]));

  // One number per year. A thriving colony scores highest, then surviving,
  // then how long it lasted; checklist items and lives matter too.
  function episodeScore(f) {
    const c = f.checklist();
    const base = f.outcome === "THRIVING" ? 100 : f.outcome === "SURVIVED" ? 55 : 40 * (f.day / 360);
    return base + c.filter((x) => x.ok).length * 4 + Math.min(14, f.alive.length) * 1.5 - f.stats.deaths * 3;
  }
  function playYear(opts) {
    const f = new F.Frontier(opts);
    while (f.running) f.tick();
    return f;
  }

  // Deterministic PRNG for sampling candidates.
  function rng(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function gauss(r) { let u = 0, v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

  const SCENARIOS = Object.keys(D.SCENARIOS);

  // ---- 1. knowledge: live `years` simulated years in rotation
  function* gatherKnowledge({ years = 40, seedBase = 5000, knowledge = null, brain = null } = {}) {
    let k = knowledge;
    for (let y = 0; y < years; y++) {
      const scenario = SCENARIOS[y % SCENARIOS.length];
      const hazards = y % 3 === 2 ? "frequent" : "normal";
      const f = playYear({ scenario, seed: seedBase + y, hazards, knowledge: k, brain });
      k = f.exportKnowledge(k);
      yield { year: y + 1, scenario, outcome: f.outcome, score: episodeScore(f), knowledge: k };
    }
  }

  // ---- 2. decision weights: cross-entropy method
  function episodesFor(gen, perScenario, seedBase) {
    const eps = [];
    for (const scenario of SCENARIOS) for (let i = 0; i < perScenario; i++) {
      eps.push({ scenario, seed: seedBase + gen * 97 + i * 13, hazards: i % 2 ? "frequent" : "normal" });
    }
    return eps;
  }
  function evaluate(brain, episodes, knowledge) {
    let total = 0;
    for (const e of episodes) total += episodeScore(playYear({ ...e, brain, knowledge }));
    return total / episodes.length;
  }
  function* trainBrain({ generations = 12, pop = 14, elite = 4, perScenario = 2, seedBase = 20000, knowledge = null, start = null, sampleSeed = 7 } = {}) {
    const r = rng(sampleSeed);
    let mean = brainToVec({ ...F.DEFAULT_BRAIN, ...(start || {}) });
    let sigma = KEYS.map(() => 0.18);
    let best = { brain: vecToBrain(mean), fitness: -Infinity };
    for (let g = 0; g < generations; g++) {
      const eps = episodesFor(g, perScenario, seedBase);
      const cands = [mean.slice()]; // always re-test the current mean
      while (cands.length < pop) cands.push(mean.map((m, i) => Math.max(0, Math.min(1, m + sigma[i] * gauss(r)))));
      const scored = [];
      for (const vec of cands) {
        const brain = vecToBrain(vec);
        scored.push({ vec, brain, fitness: evaluate(brain, eps, knowledge) });
        yield { phase: "candidate", generation: g + 1, done: scored.length, of: cands.length };
      }
      scored.sort((a, b) => b.fitness - a.fitness);
      const top = scored.slice(0, elite);
      mean = KEYS.map((_, i) => top.reduce((a, c) => a + c.vec[i], 0) / elite);
      sigma = KEYS.map((_, i) => Math.max(0.03, Math.sqrt(top.reduce((a, c) => a + (c.vec[i] - mean[i]) ** 2, 0) / elite) * 1.1));
      if (top[0].fitness > best.fitness) best = { brain: top[0].brain, fitness: top[0].fitness };
      yield { phase: "generation", generation: g + 1, bestFitness: top[0].fitness, meanFitness: scored.reduce((a, c) => a + c.fitness, 0) / scored.length, defaultFitness: g === 0 ? scored[0].fitness : null, brain: vecToBrain(mean), best };
    }
  }

  // ---- held-out comparison
  function compare({ seeds = 20, seedBase = 90000, knowledge = null, brain = null, hazards = ["normal", "frequent"] } = {}) {
    const rows = {};
    for (const scenario of SCENARIOS) for (const hz of hazards) {
      const r = { THRIVING: 0, SURVIVED: 0, PERISHED: 0, score: 0, deaths: 0 };
      for (let i = 0; i < seeds; i++) {
        const f = playYear({ scenario, seed: seedBase + i, hazards: hz, knowledge, brain });
        r[f.outcome]++; r.score += episodeScore(f); r.deaths += f.stats.deaths;
      }
      r.score = Math.round(r.score / seeds * 10) / 10;
      rows[`${scenario}/${hz}`] = r;
    }
    return rows;
  }

  function drain(gen, onStep) { let last; for (const v of gen) { last = v; if (onStep) onStep(v); } return last; }

  const api = { SPACE, episodeScore, playYear, gatherKnowledge, trainBrain, compare, drain, vecToBrain, brainToVec };
  if (isNode) module.exports = api;
  else root.FRONTIER_TRAIN = api;

  // ------------------------------------------------------------ CLI
  if (isNode && require.main === module) {
    const fs = require("fs");
    const path = require("path");
    const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
    const years = +arg("years", 40), generations = +arg("generations", 12), pop = +arg("pop", 14), perScenario = +arg("per-scenario", 4);
    const out = arg("out", path.join(__dirname, "frontier-brain.js"));
    const evalSeeds = +arg("eval-seeds", 20);
    const t0 = Date.now();
    const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);

    log(`Stage 1: living ${years} simulated years to build knowledge...`);
    const kRun = [];
    const k = drain(gatherKnowledge({ years }), (s) => { kRun.push({ year: s.year, scenario: s.scenario, outcome: s.outcome, score: Math.round(s.score) }); if (s.year % 10 === 0) log(`  year ${s.year}: ${s.scenario} ${s.outcome}`); }).knowledge;

    log(`Stage 2: evolving decision weights (${generations} generations x ${pop} candidates)...`);
    const curve = [];
    const last = drain(trainBrain({ generations, pop, perScenario, knowledge: k }), (s) => {
      if (s.phase === "generation") { curve.push({ generation: s.generation, best: Math.round(s.bestFitness * 10) / 10, mean: Math.round(s.meanFitness * 10) / 10 }); log(`  gen ${s.generation}: best ${s.bestFitness.toFixed(1)}  mean ${s.meanFitness.toFixed(1)}`); }
    });
    const brain = last.brain; // the final distribution mean generalises better than a lucky best

    log(`Stage 3: held-out evaluation on ${evalSeeds} unseen seeds per scenario and hazard level...`);
    const novice = compare({ seeds: evalSeeds });
    const knowOnly = compare({ seeds: evalSeeds, knowledge: k });
    const trained = compare({ seeds: evalSeeds, knowledge: k, brain });
    const sum = (rows) => { const v = Object.values(rows); const n = v.reduce((a, r) => a + r.THRIVING + r.SURVIVED + r.PERISHED, 0); return { thriving: v.reduce((a, r) => a + r.THRIVING, 0) / n, perished: v.reduce((a, r) => a + r.PERISHED, 0) / n, score: v.reduce((a, r) => a + r.score, 0) / v.length, deaths: v.reduce((a, r) => a + r.deaths, 0) / n }; };
    const summary = { novice: sum(novice), knowledgeOnly: sum(knowOnly), trained: sum(trained) };
    for (const [name, s] of Object.entries(summary)) log(`  ${name.padEnd(14)} thriving ${(s.thriving * 100).toFixed(0)}%  perished ${(s.perished * 100).toFixed(0)}%  score ${s.score.toFixed(1)}  deaths/yr ${s.deaths.toFixed(2)}`);

    const payload = {
      meta: { created: new Date().toISOString().slice(0, 10), years, generations, pop, perScenario, evalSeeds, knowledgeRun: kRun, curve, summary, byScenario: { novice, knowledgeOnly: knowOnly, trained } },
      brain, knowledge: k,
    };
    fs.writeFileSync(out, `/* Generated by frontier-train.js. Do not edit by hand. */\n(function (root) {\n  const TRAINED = ${JSON.stringify(payload)};\n  if (typeof module !== "undefined" && module.exports) module.exports = TRAINED; else root.FRONTIER_TRAINED = TRAINED;\n})(typeof window !== "undefined" ? window : globalThis);\n`);
    log(`Wrote ${out}`);
  }
})(typeof window !== "undefined" ? window : globalThis);
