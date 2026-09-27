"""End-of-run summary, as plain text (no rich dependency)."""

from pars.survivor import GENE_NAMES


def gene_averages(survivors):
    alive = [s for s in survivors if s.alive]
    if not alive:
        return {}
    return {g: sum(s.genes[g] for s in alive) / len(alive) for g in GENE_NAMES}


def score(sim):
    """Single-number run score: a win is worth far more than any loss, and
    among wins faster restorations with larger colonies score higher."""
    alive = len(sim.alive)
    tech = sim.tech_tree.completed_count()
    if sim.game_over_reason == "RESTORATION":
        return 1000 + 10 * alive + max(0, 300 - sim.turn) * 2
    return tech * 60 + min(sim.turn, 300) // 2 + 5 * alive


def build_report(sim, initial_genes=None):
    """Return a multi-line summary of a finished (or interrupted) run."""
    st = sim.stats
    lines = [
        f"Outcome:        {sim.game_over_reason or 'IN PROGRESS'} after {sim.turn} turns",
        f"Settings:       {sim.width}x{sim.height} grid, difficulty={sim.difficulty.name}, "
        f"doctrine={sim.doctrine.name}, seed={sim.seed if sim.seed is not None else 'random'}",
        f"Population:     {len(sim.alive)} alive (peak {st['peak_population']}), "
        f"{st['births']} births, {st['recruits']} recruits, {st['deaths']} deaths",
        f"Generations:    up to Gen {st['max_generation']}",
        f"Tech:           {sim.tech_tree.completed_count()}/{len(sim.tech_tree.projects)} completed",
        f"Score:          {score(sim)}",
    ]
    for name, turn in sorted(st["tech_completed_turn"].items(), key=lambda kv: kv[1]):
        lines.append(f"                - {name} (turn {turn})")
    if st["causes_of_death"]:
        causes = ", ".join(f"{k} {v}" for k, v in
                           sorted(st["causes_of_death"].items(), key=lambda kv: -kv[1]))
        lines.append(f"Deaths by cause: {causes}")

    final = gene_averages(sim.survivors)
    if final:
        lines.append("Gene averages (living colony" + (", change since turn 0):" if initial_genes else "):"))
        for g in GENE_NAMES:
            if initial_genes and g in initial_genes:
                delta = final[g] - initial_genes[g]
                lines.append(f"                {g:<16} {final[g]:.2f}  ({delta:+.2f})")
            else:
                lines.append(f"                {g:<16} {final[g]:.2f}")
    return "\n".join(lines)
