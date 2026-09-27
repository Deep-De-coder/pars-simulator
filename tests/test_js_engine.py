"""Checks the browser engine (pars/web/static/engine.js) against the Python
reference. RNG streams differ, so the comparison is statistical."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from pars.batch import run_many

ENGINE = Path(__file__).resolve().parent.parent / "pars" / "web" / "static" / "engine.js"
NODE = shutil.which("node")
pytestmark = pytest.mark.skipif(NODE is None, reason="node is not installed")


def run_node(script):
    out = subprocess.run([NODE, "-e", f"const P = require({json.dumps(str(ENGINE))});\n{script}"],
                         capture_output=True, text=True, timeout=120, check=True)
    return json.loads(out.stdout)


def test_js_engine_orders_and_state_shape():
    state = run_node("""
      const g = P.createGame({seed: 3});
      g.step(5);
      g.command({type: 'focus', focus: 'build'});
      g.command({type: 'evacuate', z: 1, turns: 4});
      const id = g.state().survivors[0].id;
      g.command({type: 'pin', id, role: 'Research'});
      let err = null;
      try { g.command({type: 'evacuate', z: 0}); g.command({type: 'evacuate', z: -1}); } catch (e) { err = e.message; }
      const s = g.step(3);
      console.log(JSON.stringify({turn: s.turn, focus: s.focus, cells: s.cells.length,
        forbidden: s.forbidden, err, keys: Object.keys(s).sort()}));
    """)
    assert state["turn"] == 8 and state["focus"] == "build" and state["cells"] == 75
    assert state["err"] == "At least one level must stay open"
    # Same top-level shape as the Python server's serializer.
    from pars.simulation import Simulation
    from pars.web.server import serialize
    assert state["keys"] == sorted(serialize(Simulation(seed=1)).keys())


def test_js_engine_matches_python_win_rate():
    runs = 150
    js = run_node(f"""
      let wins = 0;
      for (let seed = 0; seed < {runs}; seed++) {{
        const sim = new P.Simulation({{seed, difficulty: 'hard'}});
        while (sim.running && sim.turn < 500) sim.tick();
        if (sim.game_over_reason === 'RESTORATION') wins++;
      }}
      console.log(JSON.stringify({{rate: wins / {runs}}}));
    """)["rate"]
    py = [r["outcome"] for r in run_many(range(runs), jobs=2, difficulty="hard")]
    py_rate = py.count("RESTORATION") / runs
    # ~3.5 standard errors of the difference at n=150, p~0.6.
    assert abs(js - py_rate) < 0.2, (js, py_rate)
