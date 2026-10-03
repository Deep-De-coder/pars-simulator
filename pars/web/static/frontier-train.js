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
    repair: [0.3, 3, true], boilBias: [0.5, 3, true], coverPatch: [0, 2.5, false], coverBrace: [0, 2.5, false], coverGain: [0.2, 3, true], waterCare: [0, 1.5, false], frostCover: [0, 2.5, false], storage: [0, 3, false], reviseBIC: [2, 20, true], curiosity: [0, 2, false], shrink: [1, 20, true],
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

  // ---- knowledge is applied in parts; the trainer checks each part per place
  const PARTS = ["cropLimits", "cropYields", "place", "boilWater", "fireAware", "quakeWait", "mixCrops", "ashFertile"];
  const LESSON_TEXT = { boilWater: /boil/i, fireAware: /firebreak/i, quakeWait: /aftershock/i, mixCrops: /blight/i, ashFertile: /\bash\b/i };
  function filterKnowledge(k, parts, scenario) {
    if (!k || !parts || !parts.length) return null;
    const P = new Set(parts);
    const out = { years: k.years, crops: {}, hazard: { learned: [] }, places: {} };
    for (const [id, c] of Object.entries(k.crops || {})) {
      const e = { learned: [] };
      if (P.has("cropLimits")) { e.minT = c.minT; e.frostKill = c.frostKill; e.flood = c.flood; e.learned.push(...(c.learned || []).filter((t) => !/yields/.test(t))); }
      if (P.has("cropYields") && c.yieldFactor) { e.yieldFactor = c.yieldFactor; e.learned.push(...(c.learned || []).filter((t) => /yields/.test(t))); }
      if (Object.keys(e).length > 1) out.crops[id] = e;
    }
    for (const key of Object.keys(LESSON_TEXT)) {
      if (P.has(key) && k.hazard && k.hazard[key]) { out.hazard[key] = true; out.hazard.learned.push(...(k.hazard.learned || []).filter((t) => LESSON_TEXT[key].test(t))); }
    }
    if (P.has("place") && k.places && k.places[scenario]) out.places[scenario] = k.places[scenario];
    if (P.has("cropLimits") && k.sunflower) out.sunflower = true;
    if (P.has("cropLimits") && k.vents) out.vents = true;
    return out;
  }
  // What the pre-trained veteran brings to a given place.
  function veteranFor(trained, scenario) {
    if (!trained) return { brain: null, knowledge: null };
    const pp = (trained.perPlace || {})[scenario];
    if (!pp) return { brain: trained.brain || null, knowledge: trained.knowledge || null };
    return { brain: pp.brain || null, knowledge: filterKnowledge(trained.knowledge, pp.parts, scenario), parts: pp.parts };
  }

  const api = { SPACE, PARTS, episodeScore, playYear, gatherKnowledge, trainBrain, compare, summarize, drain, vecToBrain, brainToVec, filterKnowledge, veteranFor };
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
  const evalSeeds = +arg("eval-seeds", 24), valSeeds = +arg("val-seeds", 16), confirmSeeds = +arg("confirm-seeds", 30);
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
    const sgn = (v) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}`;
    // ---- 1. knowledge
    log(`Stage 1: living ${years} simulated years to build knowledge...`);
    const kRun = [];
    const k = drain(gatherKnowledge({ years }), (s) => { kRun.push({ year: s.year, scenario: s.scenario, outcome: s.outcome, score: Math.round(s.score) }); }).knowledge;
    const placeEps = (scenario, n, base) => Array.from({ length: n }, (_, i) => ({ scenario, seed: base + i, hazards: i % 2 ? "frequent" : "normal" }));

    const perPlace = {};
    const validation = {};
    for (const scenario of SCENARIOS) {
      log(`== ${D.SCENARIOS[scenario].name} ==`);
      const val = placeEps(scenario, valSeeds * 2, 70000);
      // ---- 2. which lessons help here? (paired, on validation games)
      const novice = await scoreMany(val);
      const partGain = {};
      for (const part of PARTS) {
        const kn = filterKnowledge(k, [part], scenario);
        if (!kn) continue;
        const r = await scoreMany(val.map((e) => ({ ...e, knowledge: kn })));
        const adv = r.map((v, i) => v - novice[i]);
        partGain[part] = { gain: mean(adv), err: stderr(adv) };
      }
      // keep a lesson only with solid evidence (2 standard errors); a 1-SE bar
      // let a lucky lesson through that then lost on the untouched test
      let parts = Object.entries(partGain).filter(([, g]) => g.gain > 0.5 && g.gain > 2 * g.err).map(([p]) => p);
      let K = filterKnowledge(k, parts, scenario);
      let kVal = 0, kErr = 0;
      if (K) {
        const r = await scoreMany(val.map((e) => ({ ...e, knowledge: K })));
        const adv = r.map((v, i) => v - novice[i]); kVal = mean(adv); kErr = stderr(adv);
        if (kVal <= 0) { parts = []; K = null; } // parts that help alone but not together
      }
      log(`  lessons: ${Object.entries(partGain).map(([p, g]) => `${p} ${sgn(g.gain)}`).join(", ")}`);
      log(`  keep: ${parts.length ? parts.join(", ") : "none"}${K ? ` (together ${sgn(kVal)} ± ${kErr.toFixed(2)})` : ""}`);

      // ---- 3. decision weights for this place (paired CEM)
      const S = makeSampler(null, 11 + scenario.length);
      const baseBrain = vecToBrain(S.mean);
      const hall = [];
      const curve = [];
      for (let g = 0; g < generations; g++) {
        const eps = placeEps(scenario, perScenario * 4, 20000 + g * 997);
        const baseline = await scoreMany(eps.map((e) => ({ ...e, brain: baseBrain, knowledge: K })));
        const scored = [];
        for (const vec of S.sample(pop)) {
          const brain = vecToBrain(vec);
          scored.push({ vec, brain, fitness: mean(await advantage(brain, eps, K, baseline)) });
        }
        const top = S.update(scored, elite);
        hall.push({ brain: top[0].brain, generation: g + 1 });
        curve.push({ generation: g + 1, best: Math.round(top[0].fitness * 10) / 10, mean: Math.round(mean(scored.map((c) => c.fitness)) * 10) / 10 });
      }
      hall.push({ brain: vecToBrain(S.mean), generation: "final" });
      log(`  search: best per generation ${curve.map((c) => sgn(c.best)).join(" ")}`);
      // ---- 4. validation gate for the brain
      const baseVal = await scoreMany(val.map((e) => ({ ...e, brain: baseBrain, knowledge: K })));
      let pick = null;
      for (const h of hall) {
        const adv = await advantage(h.brain, val, K, baseVal);
        h.val = mean(adv); h.valErr = stderr(adv);
        if (!pick || h.val > pick.val) pick = h;
      }
      const accept = pick.val > 0.5 && pick.val > 2 * pick.valErr;
      log(`  brain: best on validation ${sgn(pick.val)} ± ${pick.valErr.toFixed(2)} (gen ${pick.generation}) -> ${accept ? "ACCEPT" : "reject"}`);
      // ---- 5. confirm the chosen bundle ONCE on games that played no part in
      // choosing it. Picking the best of many lessons and generations on the
      // validation games inflates their score there (the winner's curse);
      // without this step, picks kept passing validation and losing on test.
      const brain = accept ? pick.brain : null;
      let confirm = null;
      if (K || brain) {
        const ce = placeEps(scenario, confirmSeeds * 2, 75000);
        const nov = await scoreMany(ce);
        const vet = await scoreMany(ce.map((e) => ({ ...e, knowledge: K, brain })));
        const adv = vet.map((v, i) => v - nov[i]);
        confirm = { gain: mean(adv), err: stderr(adv) };
        confirm.accepted = confirm.gain > 0.5 && confirm.gain > 2 * confirm.err;
        log(`  confirm on ${ce.length} unseen games: ${sgn(confirm.gain)} ± ${confirm.err.toFixed(2)} -> ${confirm.accepted ? "KEEP" : "drop (plays like the novice)"}`);
      }
      const keep = !!(confirm && confirm.accepted);
      perPlace[scenario] = { parts: keep ? parts : [], brain: keep ? brain : null, curve };
      validation[scenario] = { parts: partGain, knowledge: { gain: kVal, err: kErr }, brain: { gain: pick.val, err: pick.valErr, accepted: accept, generation: pick.generation }, confirm };
    }

    // ---- 5. final test on untouched seeds: novice vs veteran, per place
    log(`Final test on ${evalSeeds} fresh seeds per place and disaster level...`);
    async function compareParallel(forScenario) {
      const cells = [];
      for (const scenario of SCENARIOS) for (const hazards of ["normal", "frequent"]) for (let i = 0; i < evalSeeds; i++) cells.push({ scenario, hazards, seed: 90000 + i, ...forScenario(scenario) });
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
    const trainedPayload = { knowledge: k, perPlace };
    const byScenario = {
      novice: await compareParallel(() => ({})),
      allKnowledge: await compareParallel(() => ({ knowledge: k })),
      veteran: await compareParallel((sc) => { const v = veteranFor(trainedPayload, sc); return { knowledge: v.knowledge, brain: v.brain }; }),
    };
    const summary = Object.fromEntries(Object.entries(byScenario).map(([n, r]) => [n, summarize(r)]));
    for (const [name, s] of Object.entries(summary)) log(`  ${name.padEnd(13)} thriving ${(s.thriving * 100).toFixed(0)}%  perished ${(s.perished * 100).toFixed(0)}%  score ${s.score.toFixed(1)}  deaths/yr ${s.deaths.toFixed(2)}`);
    for (const sc of SCENARIOS) {
      const f = (name) => { const r = ["normal", "frequent"].map((h) => byScenario[name][`${sc}/${h}`]); return `${r.reduce((a, x) => a + x.THRIVING, 0)}/${r.reduce((a, x) => a + x.SURVIVED, 0)}/${r.reduce((a, x) => a + x.PERISHED, 0)}`; };
      log(`  ${sc.padEnd(12)} novice ${f("novice")}  all-knowledge ${f("allKnowledge")}  veteran ${f("veteran")}   (thriving/survived/perished)`);
    }

    const payload = {
      meta: { created: new Date().toISOString().slice(0, 10), years, generations, pop, perScenario, evalSeeds, valSeeds, knowledgeRun: kRun, summary, byScenario, validation },
      knowledge: k, perPlace,
    };
    fs.writeFileSync(out, `/* Generated by frontier-train.js. Do not edit by hand. */\n(function (root) {\n  const TRAINED = ${JSON.stringify(payload)};\n  if (typeof module !== "undefined" && module.exports) module.exports = TRAINED; else root.FRONTIER_TRAINED = TRAINED;\n})(typeof window !== "undefined" ? window : globalThis);\n`);
    log(`Wrote ${out}`);
    workers.forEach((w) => w.terminate());
  })();
})(typeof window !== "undefined" ? window : globalThis);
