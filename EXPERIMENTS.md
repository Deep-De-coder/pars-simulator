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

*Don't retry* mean-objective strategy switching or distilling it (nothing to distill). Next: risk-averse objective (E28), since fair planning raised deaths.

## Open questions worth testing next

1. How much is decision-time planning worth at all? (search with the true engine, fresh randomness = upper bound)
2. If it's worth a lot, how much of it survives when the colony imagines with its *own* beliefs instead of the truth? (the value of a better world model)
3. Procedurally generated worlds with held-out worlds (generalization instead of per-place tuning).
4. LLM proposes candidate features; loop 2 verifies them statistically.
