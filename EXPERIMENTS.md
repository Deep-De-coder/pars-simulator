# Experiment log

Every idea tried on the Frontier agent, with what was measured and what was decided, so the next attempt starts from here instead of repeating it. Newest at the bottom. Add an entry for every experiment, including failures.

**Conventions.** "A/B" means paired games: identical seeds with and without the change, so the difference is the change's effect. Numbers are points per colony-year (mean ± standard error) unless noted; outcomes are thriving / perished counts. A change is kept only if it isn't harmful; a claim needs 2+ standard errors. Mars (Red Planet) is very noisy (SE ≈ 6 at 60 games): use 200+ games there before believing anything.

**Verdicts:** `KEPT` (shipped) · `OPTION` (available, off by default) · `REVERTED` (tried, harmful or useless) · `NOTE` (finding, no code change).

## Index

| ID | Idea | Verdict | Headline |
|---|---|---|---|
| E01 | Learned yields shape priorities | KEPT (fixed) | first version −6.6 ± 2.2; within-need scaling +1.0 |
| E02 | Lesson announced only past 2.5 SE | KEPT | false lessons 95 → 3 |
| E03 | Exact "rounding-free" yield observations | REVERTED | River Rose 35 → 31 thriving |
| E04 | Learn from flood damage, not only death | KEPT | neutral outcome, fixes a wrong belief in 7/12 games |
| E05 | Greenhouse patch/brace (round 1) | KEPT (gated) | Mars perished 12 → 3 of 40; Ash Winter −2 until gated |
| E06 | Power: lights off over empty beds, crops before drill | KEPT | neutral; part of round 1 |
| E07 | Greenhouses from hypothetical crop advice (round 2) | KEPT | +4.1 ± 1.4; Dry Country thriving 52 → 72 of 80 |
| E08 | Power planning on bad days where a cut is lethal (round 3) | KEPT | +3.1 ± 1.5; Mars thriving 19 → 50 of 80 |
| E09 | Fixed 10th-percentile power everywhere | REVERTED | Ash Winter −7.6 |
| E10 | Learned-only power caution | REVERTED | too late for a first life on Mars |
| E11 | Watering to each crop's need | OPTION (`waterCare`, off) | −1 to −8 on Earth; Mars gain was noise |
| E12 | Bigger farms (fieldsMult) | NOTE / not done | hurts Ash/Dry (labour-bound) and Mars (delays first harvest) |
| E13 | Learned greenhouse venting (round 4) | KEPT | neutral (+0.3 ± 0.7), realism |
| E14 | Radio only when food covers a newcomer | REVERTED | −8.0 ± 0.9 |
| E15 | Frost covers when frost forecast (round 5) | KEPT | crop losses 10.7 → 6.7; outcomes neutral |
| E16 | Food-lull foresight (gather more before a gap) | REVERTED | River Rose thriving 69 → 48 / 41 |
| E17 | Battery banks + wire from scrap | KEPT | Mars +8.0 ± 3.1; perished 42 → 26 of 200 |
| E18 | Reserve materials at job start (compost) | REVERTED | −8.6 ± 3.4 on 200 Mars games |
| E19 | Soil-before-fertilizer rule | REVERTED | more thriving and more deaths on Mars |
| E20 | Training without a confirmation step | FIXED (E21) | 3 picks passed validation and lost on test |
| E21 | Confirmation on unseen games before shipping | KEPT | caught 6 inflated picks since |
| E22 | Bigger training budget | KEPT | first reliable Mars veteran (+9.7 ± 3.6) |
| E23 | Loop 2 structure learning (BIC + held-out) | KEPT | found "sand forages half" alone; outcomes +1.4 ± 1.4 |
| E24 | Loop 3: train how the colony learns | NOTE | pick didn't beat shipped veteran (−2.8 ± 3.5) |
| E25 | Skeptical knowledge transfer | OPTION (`transfer`) | +0.6 ± 0.7 vs naive, not significant |
| E26 | Curiosity siting for turbines | KEPT | Mars +6.9 ± 2.5 / 300 games, but via fewer turbines, not learning |
| E27 | Planning by imagination (switch strategy after imagining futures) | NOTE (no ship) | oracle + true score: Mars +28.8 ± 4.7; fair (no foresight): +1.0 ± 3.4 over 200 games |
| E28 | Risk-averse (CVaR) planning | REVERTED (never shipped) | 200 games +6.2 ± 3.3, then fresh 200: +1.9 ± 3.0, deaths 23 → 31 |
| E29 | Event-triggered planning (use the real 3-day forecast) | NOTE | 60 games +10.3 ± 5.5 |
| E30 | Event-triggered + risk-averse | QUEUED | |
| E31 | Loop 2 in generated worlds (sand 0.3×–1.7× grass) | NOTE (validates E23) | learned ratio tracks truth: corr 0.88 / 0.82; sand trips 10% → 79% as sand gets richer |
| E32 | LLM proposes features, statistics verify | BLOCKED | no model API access inside the container |
| E33 | Why loop 2 can't learn Mars turbine height | KEPT | shared daily wind; compare turbines **within a day** → height found 16/16 (was 1/16); outcomes Mars +4.1 ± 3.8, Ash +2.8 ± 2.2 |
| E30 | (event + risk-averse planning) | ABORTED | run loaded a mid-edit engine; rerun only on a committed engine |

## Details and "don't retry unless"

**E01 Learned yields.** Accurate low yields lowered whole needs' priority (−6.56 ± 2.15). Fixed by scaling within a need and using handbook effort for salvage priority (+1.03). *Lesson:* accurate numbers can still break a planner whose scale they feed.

**E02 Significance-gated lessons.** Every observation was a test, so 2 SE leaked false lessons; 2.5 SE: 39 true / 3 false (was 118 / 95). 3 SE: precision 94% but slow. *Don't retry* threshold tuning below 2.5 SE.

**E03 Rounding-free observations.** Rounding isn't bias: a skill-1 forager really gets round(2.5) = 3 food. Observing the unrounded value undervalued foraging. *Don't retry.*

**E05/E06 Greenhouse care.** Patching hurt Ash Winter until gated on "would the crop freeze uncovered, by its own beliefs". Replaceability rule (patch only if few seeds) made Mars trade growth for survival. *Lesson:* make advice consequence-aware, not place-specific.

**E07 Greenhouse reasoning.** First version only looked one step ahead and killed every Mars colony (a cover alone is useless at −30 °C); needs cover + lights lookahead.

**E08–E10 Power caution.** The right caution depends on whether a cut kills the hardiest crop (judge with min frost limit, not max: one bean seed flagged Ash Winter as lethal). Crop advice must reserve power per lit planting or several plantings share the same spare power.

**E12 Farm size.** Mars: 12 fields → thriving 2 → 13 but perished 7 → 10 (pre-battery); later fieldsMult 1.3 → perished 5 → 19 of 60. *Don't retry* fixed multipliers; the ramp speed in the first 60 days decides Mars.

**E14, E16 Food heuristics.** Recruitment isn't what fails the food goal; foresight-driven gathering starves the farms. *Don't retry* without a new mechanism.

**E18/E19 Compost.** ~Half of early Mars soil-making jobs are wasted (several people start compost jobs with compost for one), but naive reservation shifts compost from soil to fertilizer and harvests collapse (220–390 vs 820–940). *Retry only* with a value comparison "one more field vs a richer field".

**E20/E21 Winner's curse.** Screening 8 lessons and picking the best of 9 weight sets on the same validation games, then judging the pick there, inflates it. Confirmation on 100 unseen games fixed it. Even confirmed picks can lose head-to-head (E24): always compare against what's shipped.

**E23 Loop 2 pitfalls.** (a) Logging every turbine daily made a two-week memory; changing turbine mix looked seasonal (false "season" in 16/16 Mars games; sample one turbine every other day → 3/16). (b) Coarse height bands let season act as proxy; use exact height. (c) Mars turbine output is too noisy (storms) for one year of data: height detectable in ~1/10 games even with log-scaled tests and high/low bands. *Don't retry* those fixes for Mars turbines.

**E25 Transfer.** Naive transfer of all knowledge: −2.9 ± 1.7 overall; Mars effect swung −13.5 ↔ −2.4 between seed sets: attribution impossible at 60 games.

**E26 Curiosity.** Mechanism check showed 21 vs 25 turbines at similar heights; less power (50.5 vs 53.6), same lit-crop timing. Gain is resource freeing.

**E27 Planning by imagination.** `Frontier.imagine(seed, oracle)` deep-copies the colony with a fresh random generator (same state, beliefs and rules; unknown future). `experiments/plan_search.js`: every K days, imagine each of 5 strategies (asIs, food-first, power-first, expand, cautious; brain multipliers) R times, follow the best for K days. Mars, 60 paired games (seeds 82000–82029 × 2 hazard levels):

| Variant | Result | Read |
|---|---|---|
| fair, 45-day horizon, value = hand-made proxy, R=2 | +0.81 ± 6.03 | nothing |
| oracle (knows the future), 45 days, proxy | +8.03 ± 6.31 | small even with foresight |
| oracle, 90 days, proxy | −3.52 ± 6.56, perished 10 → 17 | **longer horizon hurt: the proxy value is misaligned** |
| oracle, to year end, true episode score, K=30 | **+28.76 ± 4.68, thriving 34 → 60, perished 10 → 0** | the lever exists; picks mostly asIs with rare, well-timed switches |
| fair, to year end, true score, R=2 | +6.89 ± 6.18 | ~+7, not significant at 60 games |
| fair, to year end, true score, R=4 | +7.15 ± 5.89 | more imagined futures didn't help |
| fair, to year end, true score, R=2, **200 games** (seeds 83000+) | **+1.02 ± 3.35**, thriving 125 → 139, perished 33 → 42 | the +7 at 60 games was noise; planning without foresight ≈ 0 net and gambles (more thriving, more deaths) |

*Lessons:* (1) never trust a short-horizon hand-made value; it actively misled the oracle. (2) Of the oracle's +28.8, essentially all is foresight (knowing which disaster strikes when): planning with the true rules but an unknown future is worth ≈ +1 ± 3. A better forecaster, not a better planner, is where most of the value is. (3) Cost: to-year-end rollouts are ~30 colony-years of compute per game.

Earth places (fair, to year end, R=2, 16 games each): River Rose −5.50 ± 4.50, Ash Winter +5.94 ± 6.14, Dry Country −0.53 ± 4.89, After the Wave 0.00: nothing.

*Don't retry* mean-objective strategy switching or distilling it (nothing to distill).

**E28 Risk-averse planning (CVaR-50).** Same planner, but a strategy is judged by the mean of its worst half of R=4 imagined futures. Mars, 60 games: +7.41 ± 6.20, perished 10 → 11, about the same as the mean objective at 60 games (+7.15), which fell to +1 at 200. 200-game test (seeds 83000+, the same seeds as E27's +1.0): **+6.24 ± 3.29, thriving 125 → 151, perished 33 → 33**: risk-aversion removed the gambling (mean objective: perished 33 → 42). Fresh-seed confirmation (84000+): **+1.87 ± 3.01, thriving 137 → 152, perished 23 → 31: not confirmed.** *Lesson:* even a clean-looking 200-game result at 1.9 SE can be luck; planning without foresight is consistently worth about +1 to +2 and trades deaths for thriving. *Don't retry* CVaR-50 strategy switching.

**E29 Event-triggered planning.** Re-plan when a disaster appears in the 3-day forecast or starts (imagined copies inherit that forecast, which is foresight the colony really has), plus a 60-day clock. Mars, 60 games, mean objective, R=2: +10.26 ± 5.51, thriving 34 → 48, perished 10 → 11 (the clock planner on the same seeds: +6.89). Promising but 60 games has misled before.

**E30 Event-triggered + risk-averse (E28 + E29 merged).** R=4, CVaR-50, 200 fresh games (85000+). *Queued.*

**E31 Generated worlds.** `world: { sandForage: x }` overrides the hidden truth. `experiments/world_shift.js`: 40 worlds with x from 0.3 to 1.7 (seeds 86000+), normal disasters.

| Place | ground split adopted | corr(true, learned) | mean abs error (always-1 baseline) | sand trips: poor / even / rich |
|---|---|---|---|---|
| After the Wave | 30/40 | 0.88 | 0.12 (0.36) | 10% / 40% / 79% |
| Dry Country | 29/40 | 0.82 | 0.14 (0.36) | 12% / 54% / 90% |

Caveats: learned ratios are shrunk toward 1 at the extremes (0.62 for a true 0.50; 1.36–1.40 for 1.50), as the small-group shrinkage intends; in worlds where ground truly doesn't matter (0.7–1.3) a ground split is still adopted ~12/16 times, harmless (learned ≈ 1.00) but unnecessary structure. *Next:* vary more truths at once (crop limits, well curve, wind–height effect) and hold out whole worlds.

**E32 LLM-proposed features.** Blocked here: no API key or SDK in the container. Needs an environment with model access.

**E33 Mars turbine height.** Step by step, each hypothesis tested before the next:
1. *Signal too weak?* `world: { windHeight }` (default 0.2). With 5× the effect, Mars still found height in only 2/16 games (Ash Winter 11–14/16): **not signal strength**. The E23 note "too noisy" was incomplete.
2. *A rare height group vetoes the split?* (any group < 4 observations rejected the candidate). Pooled rare values: Mars 3/16, Ash Winter *worse* (12 → 6/15). **Reverted.**
3. *Heavy-tailed storm outliers?* Log-scale tests: Mars 0–1/16. **Not it alone.**
4. **Shared weather.** Output = daily wind × site factor, and every turbine shares the day's wind. Observing each turbine's output **relative to that day's average across turbines** (a paired comparison inside the agent's own learning, the same trick as our identical-seed A/B tests) → **height found 16/16 on Mars at the default effect**, Ash Winter 12/16.
5. That made near-perfect fits, and BIC (log of residual variance) saw "evidence" in microscopic differences (ground split adopted with gain 31.5 while grass and sand at height 4 had identical values, 1.3013). A **noise floor** (outcomes never treated as measured better than 3%) cut false second splits 7 → 5 of 16; the rest look like a real confound (the day's average shifts as the turbine mix changes over the year). Forage world-shift test unaffected or better (corr 0.91).

Outcomes vs. previous commit: Red Planet +4.07 ± 3.78 over 200 games (thriving 131 → 143, perished 37 → 30); Ash Winter +2.76 ± 2.15 over 100 (thriving 82 → 87). Both positive, neither significant alone (pooled ≈ +3 ± 2): kept as not harmful, with a large learning gain.

*Lesson:* when observations share a common cause, compare within the shared condition before testing structure. *Process lesson (E30):* never edit the engine while an experiment is running; workers load the file at start.

## Open questions worth testing next

1. How much is decision-time planning worth at all? (search with the true engine, fresh randomness = upper bound)
2. If it's worth a lot, how much of it survives when the colony imagines with its *own* beliefs instead of the truth? (the value of a better world model)
3. Procedurally generated worlds with held-out worlds (generalization instead of per-place tuning).
4. LLM proposes candidate features; loop 2 verifies them statistically.
