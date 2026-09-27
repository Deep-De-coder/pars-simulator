#!/usr/bin/env python3
"""
PARS - Post-disaster Evolutionary Survival Coordinator
"""

import argparse
import sys

from pars.config import DIFFICULTIES, DEFAULT_DIFFICULTY
from pars.simulation import Simulation


def parse_args(argv=None):
    p = argparse.ArgumentParser(
        description="PARS - Post-disaster Evolutionary Survival Coordinator",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--width", type=int, default=5, help="Grid width (>=3)")
    p.add_argument("--height", type=int, default=5, help="Grid height (>=3)")
    p.add_argument("--population", type=int, default=6, help="Starting survivors")
    p.add_argument("--seed", type=int, default=None, help="Random seed")
    p.add_argument("--delay", type=int, default=500, help="Turn delay in ms")
    p.add_argument("--max-turns", type=int, default=0, help="Max turns (0=unlimited)")
    p.add_argument("--difficulty", choices=list(DIFFICULTIES), default=DEFAULT_DIFFICULTY,
                   help="Disaster frequency/intensity, regrowth and tech cost preset")
    p.add_argument("--headless", action="store_true",
                   help="Skip the dashboard; print a status line every --report-every turns")
    p.add_argument("--report-every", type=int, default=10,
                   help="Headless status line interval in turns (0=final summary only)")
    args = p.parse_args(argv)
    if args.width < 3 or args.height < 3:
        p.error("--width and --height must be at least 3")
    if args.population < 1:
        p.error("--population must be at least 1")
    if args.delay < 0 or args.max_turns < 0:
        p.error("--delay and --max-turns must be non-negative")
    return args


def headless_reporter(every):
    def report(sim):
        if every <= 0 or sim.turn % every:
            return
        i = sim.last_intel
        done = sum(p["completed"] for p in sim.tech_tree.projects.values())
        print(f"turn {sim.turn:4d} | pop {i['alive_count']:3d} | "
              f"hp {i['avg_health']:5.1f} | hunger {i['avg_hunger']:5.1f} | "
              f"scrap {sim.stockpile['scrap']:4d} water {sim.stockpile['water']:4d} "
              f"biomass {sim.stockpile['biomass']:4d} | RP {sim.tech_tree.research_points:4d} | "
              f"tech {done}/6 | {sim.grid.current_disaster}")
    return report


def main(argv=None):
    args = parse_args(argv)
    seed_str = args.seed if args.seed is not None else "random"
    turns_str = args.max_turns if args.max_turns > 0 else "unlimited"

    print("=" * 60)
    print("PARS - Post-disaster Evolutionary Survival Coordinator")
    print("=" * 60)
    print(f"Grid: {args.width}x{args.height}")
    print(f"Survivors: {args.population}")
    print(f"Seed: {seed_str}")
    print(f"Max turns: {turns_str}")
    print(f"Difficulty: {args.difficulty}")
    print("=" * 60)
    print()

    sim_kwargs = dict(width=args.width, height=args.height,
                      starting_population=args.population, seed=args.seed,
                      difficulty=args.difficulty)

    if args.headless:
        sim = Simulation(renderer=headless_reporter(args.report_every), **sim_kwargs)
        reason = sim.run(max_turns=args.max_turns, delay_ms=0)
    else:
        from pars.dashboard import Dashboard
        with Dashboard() as dash:
            sim = Simulation(renderer=dash, **sim_kwargs)
            try:
                reason = sim.run(max_turns=args.max_turns, delay_ms=args.delay)
            except KeyboardInterrupt:
                reason = "INTERRUPTED"

    print()
    print("=" * 60)
    print(f"SIMULATION ENDED: {reason} after {sim.turn} turns")
    print("=" * 60)
    return 0 if reason in ("RESTORATION", "MAX_TURNS_REACHED") else 1


if __name__ == "__main__":
    sys.exit(main())
