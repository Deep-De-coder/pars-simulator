"""
Local web server for the interactive 3D view.

    python -m pars.web            # http://127.0.0.1:8765
    python -m pars.web --port 9000 --no-browser

Standard library only. One simulation lives in the server; the browser
polls /api/state and sends orders to /api/command.
"""

import argparse
import json
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from pars.config import DIFFICULTIES, DOCTRINES
from pars.coordinator import FOCUSES, PINNABLE_ROLES
from pars.report import build_report, score
from pars.simulation import Simulation

STATIC = Path(__file__).parent / "static"
MAX_STEP = 50


def serialize(sim):
    """Everything the front end needs to draw one frame."""
    coord = sim.coordinator
    cells = [
        {"x": x, "y": y, "z": z, **{k: round(v, 1) if isinstance(v, float) else v
                                    for k, v in c.items()}}
        for (x, y, z), c in sim.grid.grid.items()
    ]
    survivors = [
        {
            "id": s.id, "name": s.name, "x": s.x, "y": s.y, "z": s.z,
            "health": round(s.health, 1), "energy": round(s.energy, 1),
            "hunger": round(s.hunger, 1), "radiation": round(s.radiation, 1),
            "age": s.age, "lifespan": s.lifespan, "generation": s.generation,
            "role": s.role, "status": s.status, "genes": s.genes,
            "pinned": coord.pins.get(s.id),
        }
        for s in sim.alive
    ]
    tech = [
        {"name": k, "unlocked": v["unlocked"], "completed": v["completed"],
         "progress": v["progress"], "cost": v["cost"], "research_cost": v["research_cost"],
         "description": v["description"]}
        for k, v in sim.tech_tree.projects.items()
    ]
    return {
        "turn": sim.turn,
        "running": sim.running,
        "outcome": sim.game_over_reason,
        "score": score(sim),
        "report": build_report(sim, sim.initial_genes) if not sim.running else None,
        "settings": {"width": sim.width, "height": sim.height, "seed": sim.seed,
                     "difficulty": sim.difficulty.name, "doctrine": sim.doctrine.name},
        "levels": sim.grid.z_levels,
        "disaster": sim.grid.current_disaster,
        "disaster_turns_left": sim.grid.disaster_duration,
        "forecast": sim.grid.disaster_forecast[:3],
        "escalation": round(sim.grid.escalation, 2),
        "stockpile": dict(sim.stockpile),
        "research_points": sim.tech_tree.research_points,
        "current_project": sim.tech_tree.current_project,
        "tech": tech,
        "cells": cells,
        "survivors": survivors,
        "plan": coord.active_plan,
        "focus": coord.focus,
        "forbidden": {str(z): t for z, t in coord.forbidden.items()},
        "log": coord.thought_log[-40:],
        "history": [{"turn": h["turn"], "alive": h["alive"], "tech": h["tech_completed"]}
                    for h in sim.history],
        "stats": sim.stats,
        "options": {"difficulties": list(DIFFICULTIES), "doctrines": list(DOCTRINES),
                    "focuses": FOCUSES, "roles": list(PINNABLE_ROLES)},
    }


class Game:
    """Thread-safe holder for the current simulation."""

    def __init__(self, **kwargs):
        self.lock = threading.Lock()
        self.new(**kwargs)

    def new(self, seed=None, difficulty="normal", doctrine="balanced",
            width=5, height=5, population=6):
        with self.lock:
            self.sim = Simulation(width=int(width), height=int(height),
                                  starting_population=int(population),
                                  seed=None if seed in (None, "") else int(seed),
                                  difficulty=difficulty, doctrine=doctrine)
            return serialize(self.sim)

    def state(self):
        with self.lock:
            return serialize(self.sim)

    def step(self, n=1):
        with self.lock:
            for _ in range(max(1, min(MAX_STEP, int(n)))):
                if not self.sim.running:
                    break
                self.sim.tick()
            return serialize(self.sim)

    def command(self, cmd):
        kind = cmd.get("type")
        with self.lock:
            sim = self.sim
            if kind == "focus":
                sim.set_focus(cmd["focus"])
            elif kind == "evacuate":
                sim.evacuate(int(cmd["z"]), int(cmd.get("turns", 6)))
            elif kind == "pin":
                sim.pin_role(int(cmd["id"]), cmd.get("role") or None)
            elif kind == "doctrine":
                sim.set_doctrine(cmd["doctrine"])
            else:
                raise ValueError(f"Unknown command type {kind!r}")
            return serialize(sim)


def make_handler(game):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):  # keep the console quiet
            pass

        def _send(self, code, body, ctype="application/json"):
            data = body if isinstance(body, bytes) else json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path in ("/", "/index.html"):
                self._send(200, (STATIC / "index.html").read_bytes(), "text/html; charset=utf-8")
            elif self.path == "/vendor/three.min.js":
                self._send(200, (STATIC / "vendor" / "three.min.js").read_bytes(),
                           "application/javascript; charset=utf-8")
            elif self.path in ("/frontier", "/frontier.html"):
                self._send(200, (STATIC / "frontier.html").read_bytes(), "text/html; charset=utf-8")
            elif self.path in ("/frontier-data.js", "/frontier-engine.js", "/frontier-train.js",
                               "/frontier-brain.js", "/engine.js"):
                f = STATIC / self.path.lstrip("/")
                if f.exists():
                    self._send(200, f.read_bytes(), "application/javascript; charset=utf-8")
                else:
                    self._send(404, {"error": "Not found"})
            elif self.path == "/favicon.ico":
                self._send(204, b"", "image/x-icon")
            elif self.path == "/api/state":
                self._send(200, game.state())
            else:
                self._send(404, {"error": "Not found"})

        def do_POST(self):
            try:
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length) or b"{}")
                if self.path == "/api/new":
                    self._send(200, game.new(**body))
                elif self.path == "/api/step":
                    self._send(200, game.step(body.get("n", 1)))
                elif self.path == "/api/command":
                    self._send(200, game.command(body))
                else:
                    self._send(404, {"error": "Not found"})
            except (ValueError, KeyError, TypeError) as e:
                self._send(400, {"error": str(e)})

    return Handler


def main(argv=None):
    p = argparse.ArgumentParser(description="Interactive 3D PARS in your browser")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--seed", type=int, default=None)
    p.add_argument("--difficulty", choices=list(DIFFICULTIES), default="normal")
    p.add_argument("--doctrine", choices=list(DOCTRINES), default="balanced")
    p.add_argument("--no-browser", action="store_true", help="Don't open a browser tab")
    args = p.parse_args(argv)

    game = Game(seed=args.seed, difficulty=args.difficulty, doctrine=args.doctrine)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(game))
    url = f"http://{args.host}:{args.port}/"
    print(f"PARS 3D running at {url}  (Ctrl+C to stop)")
    print(f"PARS Frontier (survival mode) at {url}frontier")
    if not args.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0
