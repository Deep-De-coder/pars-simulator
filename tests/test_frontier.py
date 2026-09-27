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
