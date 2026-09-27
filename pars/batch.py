"""
Batch runner: simulate many seeds headlessly and summarise outcomes.

    python -m pars.batch --runs 100 --max-turns 500
"""

import argparse
import json
import os
import statistics
from collections import Counter

from pars.config import DIFFICULTIES, DEFAULT_DIFFICULTY, DOCTRINES, DEFAULT_DOCTRINE
from pars.report import score
from pars.simulation import Simulation


def run_one(seed, width=5, height=5, population=6, max_turns=500, difficulty=None,
            doctrine=None):
    sim = Simulation(width=width, height=height, starting_population=population, seed=seed,
                     difficulty=difficulty, doctrine=doctrine)
    reason = sim.run(max_turns=max_turns, delay_ms=0)
    return {
        "seed": seed,
        "outcome": reason,
        "score": score(sim),
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


def _run_job(job):
    return run_one(**job)


def run_many(seeds, jobs=1, **kwargs):
    """Run one simulation per seed, optionally across processes."""
    work = [dict(kwargs, seed=s) for s in seeds]
    if jobs == 1 or len(work) < 2:
        return [_run_job(w) for w in work]
    from multiprocessing import Pool
    with Pool(jobs) as pool:
        return pool.map(_run_job, work, chunksize=max(1, len(work) // (jobs * 4)))


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
        "mean_score": statistics.mean(r["score"] for r in results) if n else 0,
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
    p.add_argument("--doctrine", choices=list(DOCTRINES) + ["all"], default=DEFAULT_DOCTRINE)
    p.add_argument("--jobs", type=int, default=os.cpu_count() or 1,
                   help="Worker processes")
    p.add_argument("--json", metavar="PATH", help="Also write per-run results as JSON lines")
    args = p.parse_args(argv)

    levels = list(DIFFICULTIES) if args.difficulty == "all" else [args.difficulty]
    doctrines = list(DOCTRINES) if args.doctrine == "all" else [args.doctrine]
    json_out = open(args.json, "w") if args.json else None
    try:
        for level in levels:
            for doc in doctrines:
                results = run_many(range(args.start_seed, args.start_seed + args.runs),
                                   jobs=args.jobs, width=args.width, height=args.height,
                                   population=args.population, max_turns=args.max_turns,
                                   difficulty=level, doctrine=doc)
                if json_out:
                    for r in results:
                        json_out.write(json.dumps(dict(r, difficulty=level, doctrine=doc)) + "\n")
                if len(levels) * len(doctrines) > 1:
                    print(f"== difficulty={level} doctrine={doc} ==")
                print_summary(summarise(results))
    finally:
        if json_out:
            json_out.close()
    return 0


def print_summary(s):
    print(f"Runs: {s['runs']}   Win rate: {s['win_rate']:.0%}   Mean score: {s['mean_score']:.0f}   "
          f"Outcomes: {s['outcomes']}")
    print(f"Median turns to win: {s['median_turns_to_win']}   "
          f"to extinction: {s['median_turns_to_extinction']}")
    print(f"Tech completed (count -> runs): {s['tech_completed_distribution']}")
    print(f"Causes of death: {s['causes_of_death']}")
    print(f"Mean peak population: {s['mean_peak_population']:.1f}   "
          f"mean max generation: {s['mean_max_generation']:.1f}")


if __name__ == "__main__":
    raise SystemExit(main())
