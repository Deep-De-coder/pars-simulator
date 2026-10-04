// E31: does loop-2 structure learning track the truth when the truth changes?
// Generate worlds where sand forages anywhere from 0.3x to 1.7x grass, and
// compare the colony's learned sand/grass ratio with the world's true one.
// Usage: node experiments/world_shift.js <worlds> <scenario>
const path = require("path");
const F = require(path.join(__dirname, "../pars/web/static/frontier-engine.js"));
const [N = 40, SC = "after_wave"] = process.argv.slice(2);
const rows = [];
for (let i = 0; i < +N; i++) {
  const truth = 0.3 + (1.4 * i) / Math.max(1, +N - 1);
  const f = new F.Frontier({ scenario: SC, seed: 86000 + i, hazards: "normal", world: { sandForage: truth } });
  let sand = 0, tot = 0; const og = f.doGather.bind(f);
  f.doGather = (s, t, res, sk) => { if (res === "forage") { tot++; if (t.type === "sand") sand++; } return og(s, t, res, sk); };
  while (f.running) f.tick();
  const M = f.models.forage, split = M.split.includes("ground");
  const g = Object.fromEntries(M.groups().map((x) => [x.key, x]));
  const key = (k) => Object.keys(g).find((x) => x.split("|")[M.split.indexOf("ground")] === k);
  const pred = (k) => { const ks = Object.keys(g).filter((x) => x.split("|")[M.split.indexOf("ground")] === k); const n = ks.reduce((a, x) => a + g[x].n, 0); return n ? ks.reduce((a, x) => a + g[x].m * g[x].n, 0) / n : null; };
  const learned = split ? (pred("sand") !== null && pred("grass") ? pred("sand") / pred("grass") : null) : 1;
  rows.push({ truth, split, learned, sandShare: tot ? sand / tot : 0 });
}
const ok = rows.filter((r) => r.learned !== null);
const mean = (a) => a.reduce((p, q) => p + q, 0) / a.length;
const mt = mean(ok.map((r) => r.truth)), ml = mean(ok.map((r) => r.learned));
const cov = mean(ok.map((r) => (r.truth - mt) * (r.learned - ml))), sd = (a, m) => Math.sqrt(mean(a.map((x) => (x - m) ** 2)));
const corr = cov / (sd(ok.map((r) => r.truth), mt) * sd(ok.map((r) => r.learned), ml));
console.log(`${SC}: ${rows.length} worlds, ground split adopted in ${rows.filter((r) => r.split).length}; corr(true, learned sand/grass) = ${corr.toFixed(2)}; mean |error| = ${mean(ok.map((r) => Math.abs(r.learned - r.truth))).toFixed(2)} (always-1 baseline: ${mean(ok.map((r) => Math.abs(1 - r.truth))).toFixed(2)})`);
for (const band of [[0.3, 0.7], [0.7, 1.3], [1.3, 1.71]]) {
  const b = rows.filter((r) => r.truth >= band[0] && r.truth < band[1]);
  console.log(`  true ${band[0]}–${band[1]}: split ${b.filter((r) => r.split).length}/${b.length}, learned ≈ ${mean(b.map((r) => r.learned ?? 1)).toFixed(2)} (true ≈ ${mean(b.map((r) => r.truth)).toFixed(2)}), forage trips on sand ${(100 * mean(b.map((r) => r.sandShare))).toFixed(0)}%`);
}
