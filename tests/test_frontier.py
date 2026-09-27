"""Tests for the PARS Frontier engine (pars/web/static/frontier-engine.js),
run through Node. Skipped when node isn't installed."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

STATIC = Path(__file__).resolve().parent.parent / "pars" / "web" / "static"
NODE = shutil.which("node")
pytestmark = pytest.mark.skipif(NODE is None, reason="node is not installed")


def run(script):
    prelude = (f"const F = require({json.dumps(str(STATIC / 'frontier-engine.js'))});\n"
               f"const D = require({json.dumps(str(STATIC / 'frontier-data.js'))});\n")
    out = subprocess.run([NODE, "-e", prelude + script], capture_output=True, text=True,
                         timeout=180, check=True)
    return json.loads(out.stdout)


def test_every_scenario_runs_a_full_year_or_ends():
    res = run("""
      const out = {};
      for (const sc of Object.keys(D.SCENARIOS)) {
        const f = new F.Frontier({scenario: sc, seed: 5});
        while (f.running) f.tick();
        out[sc] = {outcome: f.outcome, day: f.day, neg: Object.entries(f.inv).filter(([k, v]) => v < 0).map(([k]) => k)};
      }
      console.log(JSON.stringify(out));
    """)
    for sc, r in res.items():
        assert r["outcome"] in ("THRIVING", "SURVIVED", "PERISHED"), sc
        assert r["outcome"] == "PERISHED" or r["day"] == 360, sc
        assert r["neg"] == [], f"{sc}: negative inventory {r['neg']}"


def test_seeded_runs_are_deterministic():
    res = run("""
      const go = () => { const f = new F.Frontier({scenario: 'river_flood', seed: 11}); for (let i = 0; i < 120; i++) f.tick();
        return JSON.stringify([f.day, f.inv, f.alive.length, f.stats.harvested]); };
      console.log(JSON.stringify({same: go() === go()}));
    """)
    assert res["same"]


def test_agents_correct_the_handbook():
    # Over a few seeds the colony should learn at least one handbook error
    # (crop limits, well odds or real power output).
    res = run("""
      let learned = 0;
      for (let seed = 0; seed < 6; seed++) {
        const f = new F.Frontier({scenario: 'river_flood', seed});
        while (f.running) f.tick();
        learned += f.log.filter((l) => l.kind === 'learn').length;
      }
      console.log(JSON.stringify({learned}));
    """)
    assert res["learned"] >= 3


def test_water_comes_before_farming_in_a_crisis():
    res = run("""
      const f = new F.Frontier({scenario: 'river_flood', seed: 1});
      f.inv.water = 0; f.inv.wood = 3;
      f.plan();
      console.log(JSON.stringify({first: f.mind.options[0].label, needs: f.mind.needs.slice(0, 2)}));
    """)
    assert "water" in res["first"].lower() or res["needs"][0]["need"] == "water"


def test_player_orders_are_validated_and_obeyed():
    res = run("""
      const g = F.createFrontier({scenario: 'river_flood', seed: 2});
      let err = null;
      try { g.command({type: 'order', kind: 'plant', crop: 'potato', x: 0, y: 0}); } catch (e) { err = e.message; }
      const s = g.state();
      const spot = s.tiles.find((t) => t.type === 'grass' && !t.structure && t.elev >= 2);
      g.command({type: 'order', kind: 'till', x: spot.x, y: spot.y});
      g.command({type: 'priority', priority: 'water'});
      let st = g.state();
      for (let i = 0; i < 6; i++) st = g.step(1);
      const t = st.tiles.find((x) => x.x === spot.x && x.y === spot.y);
      console.log(JSON.stringify({err, field: t.field, priority: st.priority, orders: st.orders.length}));
    """)
    assert res["err"] and "field" in res["err"]
    assert res["field"] is True and res["orders"] == 0
    assert res["priority"] == "water"


def test_red_planet_grows_potatoes():
    res = run("""
      let harvested = 0;
      for (let seed = 0; seed < 3; seed++) {
        const f = new F.Frontier({scenario: 'red_planet', seed});
        while (f.running) f.tick();
        harvested += f.stats.harvested;
      }
      console.log(JSON.stringify({harvested}));
    """)
    assert res["harvested"] > 0


def test_every_disaster_can_be_triggered_and_resolves():
    res = run("""
      const out = {};
      for (const kind of Object.keys(D.DISASTERS)) {
        const sc = kind === 'flood' ? 'river_flood' : kind === 'ashfall' ? 'ash_winter' : 'river_flood';
        const f = new F.Frontier({scenario: sc, seed: 4});
        for (let i = 0; i < 40; i++) f.tick();
        f.triggerDisaster(kind);
        for (let i = 0; i < 40 && f.running; i++) f.tick();
        out[kind] = {over: !f.disaster || f.disaster.type !== kind || f.disaster.forced !== true,
                     neg: Object.entries(f.inv).filter(([, v]) => v < 0).map(([k]) => k),
                     burning: f.tiles.filter((t) => t.burning > 0).length};
      }
      let marsFire = null;
      try { new F.Frontier({scenario: 'red_planet', seed: 1}).triggerDisaster('wildfire'); } catch (e) { marsFire = e.message; }
      console.log(JSON.stringify({out, marsFire}));
    """)
    for kind, r in res["out"].items():
        assert r["over"], f"{kind} never ended"
        assert r["neg"] == [], f"{kind}: negative inventory"
    assert res["out"]["wildfire"]["burning"] == 0
    assert "can't happen" in res["marsFire"]


def test_blight_spreads_along_same_crop_and_teaches_mixing():
    # When nobody pulls the infected plants, blight runs through a block of
    # one crop and the colony draws the lesson.
    res = run("""
      const f = new F.Frontier({scenario: 'river_flood', seed: 0});
      for (let i = 0; i < 70; i++) f.tick();
      const block = f.tiles.filter((t) => f.isLand(t) && t.x >= 2 && t.x <= 6 && t.y >= 1 && t.y <= 3);
      for (const t of block) { t.greenhouse = false; t.field = true; t.crop = {type: 'potato', growth: 0.3, health: 1, age: 10, planted: 0, fertAtPlant: t.fert, contamAtPlant: 0, ripe: false}; }
      block[0].crop.blight = true;
      for (let i = 0; i < 12; i++) f.dailyHazards();
      console.log(JSON.stringify({infected: block.filter((t) => !t.crop || t.crop.blight).length, block: block.length, learned: f.beliefs.hazard.mixCrops}));
    """)
    assert res["infected"] >= 4
    assert res["learned"] is True


def test_knowledge_carries_over_between_games():
    res = run("""
      const a = new F.Frontier({scenario: 'river_flood', seed: 1});
      while (a.running) a.tick();
      const k = a.exportKnowledge();
      const b = new F.Frontier({scenario: 'river_flood', seed: 2, knowledge: k});
      const potato = b.beliefs.crops.potato;
      console.log(JSON.stringify({years: k.years, trained: b.trained, minT: potato.minT, fresh: new F.Frontier({scenario: 'river_flood', seed: 2}).beliefs.crops.potato.minT,
        inherited: potato.learned.length}));
    """)
    assert res["years"] == 1 and res["trained"] is True
    assert res["minT"] >= res["fresh"]


def test_training_improves_or_keeps_the_best_candidate():
    res = run("""
      const T = require(%s);
      let last = null, gens = 0;
      for (const s of T.trainBrain({generations: 2, pop: 3, elite: 2, perScenario: 1, seedBase: 123})) {
        if (s.phase === 'generation') { gens++; last = s; }
      }
      const keys = Object.keys(T.SPACE);
      const inRange = keys.every((k) => last.brain[k] >= T.SPACE[k][0] - 1e-9 && last.brain[k] <= T.SPACE[k][1] + 1e-9);
      const k = T.drain(T.gatherKnowledge({years: 3})).knowledge;
      console.log(JSON.stringify({gens, inRange, best: last.best.fitness, years: k.years}));
    """ % json.dumps(str(STATIC / "frontier-train.js")))
    assert res["gens"] == 2 and res["inRange"] and res["years"] == 3
    assert res["best"] > 0
