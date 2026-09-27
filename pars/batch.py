"""
Batch runner: simulate many seeds headlessly and summarise outcomes.

    python -m pars.batch --runs 100 --max-turns 500
"""

import argparse
import json
import statistics
from collections import Counter

from pars.config import DIFFICULTIES, DEFAULT_DIFFICULTY
from pars.simulation import Simulation


def run_one(seed, width=5, height=5, population=6, max_turns=500, difficulty=None):
    sim = Simulation(width=width, height=height, starting_population=population, seed=seed,
                     difficulty=difficulty)
    reason = sim.run(max_turns=max_turns, delay_ms=0)
    return {
        "seed": seed,
        "outcome": reason,
        "turns": sim.turn,
        "tech_completed": sim.tech_tree.completed_count(),
        "final_population": len(sim.alive),
        "peak_population": sim.stats["peak_population"],
        "births": sim.stats["births"],
        "deaths": sim.stats["deaths"],
        "recruits": sim.stats["recruits"],
        "max_generation": sim.stats["max_generation"],
        "causes_of_death": sim.stats["causes_of_death"],
        "tech_completed_turn": sim.stats["tech_completed_turn"],
    }


def summarise(results):
    n = len(results)
    outcomes = Counter(r["outcome"] for r in results)
    causes = Counter()
    for r in results:
        causes.update(r["causes_of_death"])
    wins = [r for r in results if r["outcome"] == "RESTORATION"]
    losses = [r for r in results if r["outcome"] == "EXTINCTION"]
    return {
        "runs": n,
        "outcomes": dict(outcomes),
        "win_rate": outcomes["RESTORATION"] / n if n else 0.0,
        "median_turns_to_win": statistics.median(r["turns"] for r in wins) if wins else None,
        "median_turns_to_extinction": statistics.median(r["turns"] for r in losses) if losses else None,
        "tech_completed_distribution": dict(sorted(Counter(r["tech_completed"] for r in results).items())),
        "causes_of_death": dict(causes.most_common()),
        "mean_peak_population": statistics.mean(r["peak_population"] for r in results) if n else 0,
        "mean_max_generation": statistics.mean(r["max_generation"] for r in results) if n else 0,
    }


def main(argv=None):
    p = argparse.ArgumentParser(description="Run many PARS simulations and summarise outcomes")
    p.add_argument("--runs", type=int, default=50)
    p.add_argument("--start-seed", type=int, default=0)
    p.add_argument("--width", type=int, default=5)
    p.add_argument("--height", type=int, default=5)
    p.add_argument("--population", type=int, default=6)
    p.add_argument("--max-turns", type=int, default=500)
    p.add_argument("--difficulty", choices=list(DIFFICULTIES) + ["all"], default=DEFAULT_DIFFICULTY)
    p.add_argument("--json", metavar="PATH", help="Also write per-run results as JSON lines")
    args = p.parse_args(argv)

    levels = list(DIFFICULTIES) if args.difficulty == "all" else [args.difficulty]
    json_out = open(args.json, "w") if args.json else None
    try:
        for level in levels:
            results = [run_one(seed, args.width, args.height, args.population, args.max_turns, level)
                       for seed in range(args.start_seed, args.start_seed + args.runs)]
            if json_out:
                for r in results:
                    json_out.write(json.dumps(dict(r, difficulty=level)) + "\n")
            if len(levels) > 1:
                print(f"== {level} ==")
            print_summary(summarise(results))
    finally:
        if json_out:
            json_out.close()
    return 0


def print_summary(s):
    print(f"Runs: {s['runs']}   Win rate: {s['win_rate']:.0%}   Outcomes: {s['outcomes']}")
    print(f"Median turns to win: {s['median_turns_to_win']}   "
          f"to extinction: {s['median_turns_to_extinction']}")
    print(f"Tech completed (count -> runs): {s['tech_completed_distribution']}")
    print(f"Causes of death: {s['causes_of_death']}")
    print(f"Mean peak population: {s['mean_peak_population']:.1f}   "
          f"mean max generation: {s['mean_max_generation']:.1f}")


if __name__ == "__main__":
    raise SystemExit(main())
