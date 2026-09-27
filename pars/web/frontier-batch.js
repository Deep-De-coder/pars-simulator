#!/usr/bin/env node
// Headless balance check for PARS Frontier:
//   node pars/web/frontier-batch.js [runs=30] [scenario,...]
const path = require("path");
const F = require(path.join(__dirname, "static", "frontier-engine.js"));
const D = require(path.join(__dirname, "static", "frontier-data.js"));
const runs = +process.argv[2] || 30;
const scenarios = process.argv[3] ? process.argv[3].split(",") : Object.keys(D.SCENARIOS);
for (const sc of scenarios) {
  const out = { THRIVING: 0, SURVIVED: 0, PERISHED: 0 }, causes = {}, learned = {}, built = {};
  let days = 0, harvested = 0, pop = 0, lost = 0;
  const t0 = Date.now();
  for (let seed = 0; seed < runs; seed++) {
    const f = new F.Frontier({ scenario: sc, seed });
    while (f.running) f.tick();
    out[f.outcome]++;
    days += f.day; harvested += f.stats.harvested; pop += f.alive.length; lost += f.stats.cropsLost;
    for (const [k, v] of Object.entries(f.stats.causes)) causes[k] = (causes[k] || 0) + v;
    for (const [k, v] of Object.entries(f.stats.built)) built[k] = (built[k] || 0) + v;
    for (const l of f.log) if (l.kind === "learn") { const key = l.text.slice(0, 38); learned[key] = (learned[key] || 0) + 1; }
  }
  console.log(`\n== ${sc}: ${JSON.stringify(out)}  avg days ${(days / runs).toFixed(0)}  final pop ${(pop / runs).toFixed(1)}  harvest ${(harvested / runs).toFixed(0)}  crops lost ${(lost / runs).toFixed(1)}  (${((Date.now() - t0) / runs).toFixed(0)} ms/run)`);
  console.log("deaths:", JSON.stringify(causes));
  console.log("built/run:", Object.entries(built).map(([k, v]) => `${k} ${(v / runs).toFixed(1)}`).join(", "));
  console.log("learned:", Object.entries(learned).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${v}x "${k}…"`).join(" | "));
}
