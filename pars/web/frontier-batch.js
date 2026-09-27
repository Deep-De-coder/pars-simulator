#!/usr/bin/env node
// Headless balance check for PARS Frontier:
//   node pars/web/frontier-batch.js [runs=30] [scenario,...] [hazards=normal] [brain.json]
const fs = require("fs");
const path = require("path");
const F = require(path.join(__dirname, "static", "frontier-engine.js"));
const D = require(path.join(__dirname, "static", "frontier-data.js"));
const runs = +process.argv[2] || 30;
const scenarios = process.argv[3] && process.argv[3] !== "all" ? process.argv[3].split(",") : Object.keys(D.SCENARIOS);
const hazards = process.argv[4] || "normal";
const trained = process.argv[5] ? JSON.parse(fs.readFileSync(process.argv[5], "utf8")) : null;
for (const sc of scenarios) {
  const out = { THRIVING: 0, SURVIVED: 0, PERISHED: 0 }, causes = {}, learned = {}, events = {};
  let days = 0, harvested = 0, pop = 0;
  const t0 = Date.now();
  for (let seed = 0; seed < runs; seed++) {
    const f = new F.Frontier({ scenario: sc, seed, hazards, brain: trained && trained.brain, knowledge: trained && trained.knowledge });
    while (f.running) f.tick();
    out[f.outcome]++;
    days += f.day; harvested += f.stats.harvested; pop += f.alive.length;
    for (const [k, v] of Object.entries(f.stats.causes)) causes[k] = (causes[k] || 0) + v;
    for (const l of f.log) {
      if (l.kind === "learn") { const key = l.text.slice(0, 34); learned[key] = (learned[key] || 0) + 1; }
      const m = /^(.*) begins:/.exec(l.text); if (m) events[m[1]] = (events[m[1]] || 0) + 1;
    }
  }
  console.log(`\n== ${sc} [${hazards}${trained ? ", trained" : ""}]: ${JSON.stringify(out)}  avg days ${(days / runs).toFixed(0)}  final pop ${(pop / runs).toFixed(1)}  harvest ${(harvested / runs).toFixed(0)}  (${((Date.now() - t0) / runs).toFixed(0)} ms/run)`);
  console.log("disasters/run:", Object.entries(events).map(([k, v]) => `${k} ${(v / runs).toFixed(1)}`).join(", "));
  console.log("deaths:", JSON.stringify(causes));
  console.log("learned:", Object.entries(learned).sort((a, b) => b[1] - a[1]).slice(0, 7).map(([k, v]) => `${v}x "${k}…"`).join(" | "));
}
