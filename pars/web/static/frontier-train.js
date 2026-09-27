/*
 * PARS Frontier training.
 *
 * Two kinds of learning, both done by playing simulated years:
 *   1. Knowledge: every year inherits what earlier years learned (crop
 *      limits, well odds, real power output, disaster lessons) and adds
 *      its own.
 *   2. Decision weights ("brain"): a cross-entropy method searches the
 *      colony's priority weights. Candidates are scored by their *advantage*
 *      over the starting brain on the very same games (same scenarios, seeds
 *      and disaster rolls), which removes most of the luck from the
 *      comparison.
 *
 * Nothing is shipped on faith: the CLI checks knowledge and brain on a
 * separate validation set and falls back to the untrained version when
 * training didn't help.
 *
 * Works in Node (CLI at the bottom, parallel via worker_threads) and in the
 * browser (FRONTIER_TRAIN, generators run in small slices).
 *
 *   node pars/web/static/frontier-train.js [--generations 12] [--pop 16] [--years 60] [--out path]
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
  const scoreYear = (opts) => episodeScore(playYear(opts));
  // Advantage per game is clipped so one freak year can't decide a generation.
  const CLIP = 35;
  const clipAdv = (a) => Math.max(-CLIP, Math.min(CLIP, a));

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

  // ---- 2. decision weights: cross-entropy method on paired advantages
  function episodesFor(gen, perScenario, seedBase) {
    const eps = [];
    for (const scenario of SCENARIOS) for (let i = 0; i < perScenario; i++) {
      eps.push({ scenario, seed: seedBase + gen * 997 + i * 31, hazards: i % 2 ? "frequent" : "normal" });
    }
    return eps;
  }
  function makeSampler(start, sampleSeed) {
    const r = rng(sampleSeed);
    return {
      mean: brainToVec({ ...F.DEFAULT_BRAIN, ...(start || {}) }),
      sigma: KEYS.map(() => 0.15),
      sample(pop) {
        const out = [this.mean.slice()];
        while (out.length < pop) out.push(this.mean.map((m, i) => Math.max(0, Math.min(1, m + this.sigma[i] * gauss(r)))));
        return out;
      },
      update(scored, elite) {
        const top = scored.slice().sort((a, b) => b.fitness - a.fitness).slice(0, elite);
        // move only part of the way to the elite: a noisy generation can't yank the mean
        const target = KEYS.map((_, i) => top.reduce((a, c) => a + c.vec[i], 0) / elite);
        this.mean = this.mean.map((m, i) => m + 0.6 * (target[i] - m));
        this.sigma = KEYS.map((_, i) => Math.max(0.03, Math.min(0.2, Math.sqrt(top.reduce((a, c) => a + (c.vec[i] - target[i]) ** 2, 0) / elite) * 1.15)));
        return top;
      },
    };
  }
  // Browser-friendly synchronous version (one candidate per yield).
  function* trainBrain({ generations = 12, pop = 14, elite = 4, perScenario = 2, seedBase = 20000, knowledge = null, start = null, sampleSeed = 7 } = {}) {
    const S = makeSampler(start, sampleSeed);
    const baseBrain = vecToBrain(S.mean);
    let best = { brain: baseBrain, fitness: 0 };
    for (let g = 0; g < generations; g++) {
      const eps = episodesFor(g, perScenario, seedBase);
      const baseline = eps.map((e) => scoreYear({ ...e, brain: baseBrain, knowledge }));
      const scored = [];
      for (const vec of S.sample(pop)) {
        const brain = vecToBrain(vec);
        const adv = eps.map((e, i) => clipAdv(scoreYear({ ...e, brain, knowledge }) - baseline[i]));
        scored.push({ vec, brain, fitness: adv.reduce((a, b) => a + b, 0) / adv.length });
        yield { phase: "candidate", generation: g + 1, done: scored.length, of: pop };
      }
      const top = S.update(scored, elite);
      if (top[0].fitness > best.fitness) best = { brain: top[0].brain, fitness: top[0].fitness };
      yield { phase: "generation", generation: g + 1, bestFitness: top[0].fitness, meanFitness: scored.reduce((a, c) => a + c.fitness, 0) / scored.length, brain: vecToBrain(S.mean), best };
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
  function summarize(rows) {
    const v = Object.values(rows);
    const n = v.reduce((a, r) => a + r.THRIVING + r.SURVIVED + r.PERISHED, 0);
    return { thriving: v.reduce((a, r) => a + r.THRIVING, 0) / n, perished: v.reduce((a, r) => a + r.PERISHED, 0) / n, score: v.reduce((a, r) => a + r.score, 0) / v.length, deaths: v.reduce((a, r) => a + r.deaths, 0) / n };
  }

  function drain(gen, onStep) { let last; for (const v of gen) { last = v; if (onStep) onStep(v); } return last; }

  const api = { SPACE, episodeScore, playYear, gatherKnowledge, trainBrain, compare, summarize, drain, vecToBrain, brainToVec };
  if (isNode) module.exports = api;
  else root.FRONTIER_TRAIN = api;

  // ------------------------------------------------------------ Node: parallel workers + CLI
  if (!isNode) return;
  const wt = require("worker_threads");
  if (!wt.isMainThread && wt.workerData && wt.workerData.frontierWorker) {
    // score a batch of games: [{opts}] -> [score]
    wt.parentPort.on("message", ({ id, jobs }) => {
      wt.parentPort.postMessage({ id, scores: jobs.map((o) => { const f = playYear(o); return { score: episodeScore(f), outcome: f.outcome, deaths: f.stats.deaths }; }) });
    });
    return;
  }
  if (require.main !== module) return;

  const fs = require("fs");
  const path = require("path");
  const os = require("os");
  const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
  const years = +arg("years", 60), generations = +arg("generations", 12), pop = +arg("pop", 16);
  const perScenario = +arg("per-scenario", 6), elite = +arg("elite", 4);
  const evalSeeds = +arg("eval-seeds", 24), valSeeds = +arg("val-seeds", 16);
  const out = arg("out", path.join(__dirname, "frontier-brain.js"));
  const nWorkers = Math.max(1, Math.min(+arg("workers", os.cpus().length), 16));
  const t0 = Date.now();
  const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);

  // worker pool: score many games in parallel
  const workers = Array.from({ length: nWorkers }, () => new wt.Worker(__filename, { workerData: { frontierWorker: true } }));
  let nextId = 0;
  const pending = new Map();
  workers.forEach((w) => w.on("message", ({ id, scores }) => { pending.get(id)(scores); pending.delete(id); }));
  async function scoreMany(jobs) { return (await playMany(jobs)).map((r) => r.score); }
  async function playMany(jobs) {
    const chunks = Array.from({ length: nWorkers }, () => []);
    jobs.forEach((j, i) => chunks[i % nWorkers].push({ j, i }));
    const results = new Array(jobs.length);
    await Promise.all(chunks.map((chunk, w) => chunk.length ? new Promise((res) => {
      const id = nextId++;
      pending.set(id, (scores) => { scores.forEach((s, k) => { results[chunk[k].i] = s; }); res(); });
      workers[w].postMessage({ id, jobs: chunk.map((c) => c.j) });
    }) : null));
    return results;
  }
  async function advantage(brain, eps, knowledge, baseline) {
    const s = await scoreMany(eps.map((e) => ({ ...e, brain, knowledge })));
    return s.map((v, i) => clipAdv(v - baseline[i]));
  }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const stderr = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length * (a.length - 1))); };
  function valEpisodes(seeds, base) {
    const eps = [];
    for (const scenario of SCENARIOS) for (const hazards of ["normal", "frequent"]) for (let i = 0; i < seeds; i++) eps.push({ scenario, seed: base + i, hazards });
    return eps;
  }

  (async () => {
    log(`Using ${nWorkers} worker threads.`);
    // ---- knowledge
    log(`Stage 1: living ${years} simulated years to build knowledge...`);
    const kRun = [];
    const k = drain(gatherKnowledge({ years }), (s) => { kRun.push({ year: s.year, scenario: s.scenario, outcome: s.outcome, score: Math.round(s.score) }); }).knowledge;
    const valEps = valEpisodes(valSeeds, 70000);
    const noviceVal = await scoreMany(valEps.map((e) => ({ ...e })));
    const knowVal = await scoreMany(valEps.map((e) => ({ ...e, knowledge: k })));
    const kAdv = knowVal.map((v, i) => v - noviceVal[i]);
    const useKnowledge = mean(kAdv) > -0.5; // knowledge is corrections toward the truth; keep unless it clearly hurts
    log(`  knowledge vs novice on validation: ${mean(kAdv) >= 0 ? "+" : ""}${mean(kAdv).toFixed(2)} ± ${stderr(kAdv).toFixed(2)} per year -> ${useKnowledge ? "keep" : "DISCARD"}`);
    const K = useKnowledge ? k : null;

    // ---- brain
    log(`Stage 2: evolving decision weights (${generations} generations x ${pop} candidates x ${perScenario * SCENARIOS.length} paired games)...`);
    const S = makeSampler(null, 11);
    const baseBrain = vecToBrain(S.mean);
    const curve = [];
    const hall = []; // best candidate of each generation, for validation
    for (let g = 0; g < generations; g++) {
      const eps = episodesFor(g, perScenario, 20000);
      const baseline = await scoreMany(eps.map((e) => ({ ...e, brain: baseBrain, knowledge: K })));
      const vecs = S.sample(pop);
      const scored = [];
      for (const vec of vecs) {
        const brain = vecToBrain(vec);
        const adv = await advantage(brain, eps, K, baseline);
        scored.push({ vec, brain, fitness: mean(adv) });
      }
      const top = S.update(scored, elite);
      hall.push({ brain: top[0].brain, trainFitness: top[0].fitness, generation: g + 1 });
      const meanF = mean(scored.map((c) => c.fitness));
      curve.push({ generation: g + 1, best: Math.round(top[0].fitness * 10) / 10, mean: Math.round(meanF * 10) / 10 });
      const sgn = (v) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}`;
      log(`  gen ${g + 1}: best ${sgn(top[0].fitness)}  mean ${sgn(meanF)} vs default (score points per year)`);
    }
    hall.push({ brain: vecToBrain(S.mean), trainFitness: null, generation: "final mean" });

    // ---- validation gate: pick the candidate that beats the default on unseen games
    log(`Stage 3: validating ${hall.length} candidates on ${valEps.length} unseen games...`);
    const baseVal = await scoreMany(valEps.map((e) => ({ ...e, brain: baseBrain, knowledge: K })));
    let pick = null;
    for (const h of hall) {
      const adv = await advantage(h.brain, valEps, K, baseVal);
      h.val = mean(adv); h.valErr = stderr(adv);
      if (!pick || h.val > pick.val) pick = h;
    }
    const accept = pick.val > 2 * pick.valErr && pick.val > 0.5;
    log(`  best on validation: generation ${pick.generation}, ${pick.val >= 0 ? "+" : ""}${pick.val.toFixed(2)} ± ${pick.valErr.toFixed(2)} -> ${accept ? "ACCEPT" : "REJECT (no reliable gain; shipping default decisions)"}`);
    const brain = accept ? pick.brain : null;

    // ---- final test on a third, untouched set of seeds
    log(`Stage 4: final test on ${evalSeeds} fresh seeds per place and disaster level...`);
    async function compareParallel(extra) {
      const cells = [];
      for (const scenario of SCENARIOS) for (const hazards of ["normal", "frequent"]) for (let i = 0; i < evalSeeds; i++) cells.push({ scenario, hazards, seed: 90000 + i, ...extra });
      const res = await playMany(cells);
      const rows = {};
      cells.forEach((c, i) => {
        const key = `${c.scenario}/${c.hazards}`;
        const r = rows[key] || (rows[key] = { THRIVING: 0, SURVIVED: 0, PERISHED: 0, score: 0, deaths: 0 });
        r[res[i].outcome]++; r.score += res[i].score / evalSeeds; r.deaths += res[i].deaths;
      });
      for (const r of Object.values(rows)) r.score = Math.round(r.score * 10) / 10;
      return rows;
    }
    const byScenario = { novice: await compareParallel({}), knowledgeOnly: await compareParallel({ knowledge: K }), trained: await compareParallel({ knowledge: K, brain }) };
    const summary = Object.fromEntries(Object.entries(byScenario).map(([n, r]) => [n, summarize(r)]));
    for (const [name, s] of Object.entries(summary)) log(`  ${name.padEnd(14)} thriving ${(s.thriving * 100).toFixed(0)}%  perished ${(s.perished * 100).toFixed(0)}%  score ${s.score.toFixed(1)}  deaths/yr ${s.deaths.toFixed(2)}`);

    const payload = {
      meta: {
        created: new Date().toISOString().slice(0, 10), years, generations, pop, perScenario, evalSeeds, valSeeds,
        knowledgeRun: kRun, curve, summary, byScenario,
        validation: { knowledge: { advantage: mean(kAdv), stderr: stderr(kAdv), kept: useKnowledge }, brain: { generation: pick.generation, advantage: pick.val, stderr: pick.valErr, accepted: accept } },
      },
      brain, knowledge: K,
    };
    fs.writeFileSync(out, `/* Generated by frontier-train.js. Do not edit by hand. */\n(function (root) {\n  const TRAINED = ${JSON.stringify(payload)};\n  if (typeof module !== "undefined" && module.exports) module.exports = TRAINED; else root.FRONTIER_TRAINED = TRAINED;\n})(typeof window !== "undefined" ? window : globalThis);\n`);
    log(`Wrote ${out}`);
    workers.forEach((w) => w.terminate());
  })();
})(typeof window !== "undefined" ? window : globalThis);
