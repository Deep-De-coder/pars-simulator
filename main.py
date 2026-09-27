#!/usr/bin/env python3
"""
PARS - Post-disaster Evolutionary Survival Coordinator
"""

import argparse
import sys

from pars.simulation import Simulation


def parse_args():
    p = argparse.ArgumentParser(
        description="PARS - Post-disaster Evolutionary Survival Coordinator",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--width", type=int, default=5, help="Grid width")
    p.add_argument("--height", type=int, default=5, help="Grid height")
    p.add_argument("--population", type=int, default=6, help="Starting survivors")
    p.add_argument("--seed", type=int, default=None, help="Random seed")
    p.add_argument("--delay", type=int, default=500, help="Turn delay in ms")
    p.add_argument("--max-turns", type=int, default=0, help="Max turns (0=unlimited)")
    return p.parse_args()


def main():
    args = parse_args()

    print("=" * 60)
    print("PARS - Post-disaster Evolutionary Survival Coordinator")
    print("=" * 60)
    print(f"Grid: {args.width}x{args.height}")
    print(f"Survivors: {args.population}")
    print(f"Seed: {args.seed if args.seed is not None else chr(39)+chr(114)+chr(97)+chr(110)+chr(100)+chr(111)+chr(109)+chr(39)}")
    print(f"Max turns: {args.max_turns if args.max_turns > 0 else chr(39)+chr(117)+chr(110)+chr(108)+chr(105)+chr(109)+chr(105)+chr(116)+chr(101)+chr(100)+chr(39)}")
    print("=" * 60)
    print()

    sim = Simulation(
        width=args.width,
        height=args.height,
        starting_population=args.population,
        seed=args.seed,
    )

    reason = sim.run(max_turns=args.max_turns, delay_ms=args.delay)

    print()
    print("=" * 60)
    print(f"SIMULATION ENDED: {reason}")
    print("=" * 60)
    return 0 if reason in ("RESTORATION", "MAX_TURNS_REACHED") else 1


if __name__ == "__main__":
    sys.exit(main())
