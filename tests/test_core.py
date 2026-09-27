import random

import pytest

from pars.coordinator import CoordinatorAgent
from pars.environment import Grid3D
from pars.simulation import Simulation
from pars.survivor import Survivor
from pars.tech import TechTree


def calm_cell(**over):
    cell = {"scrap": 10, "biomass": 10, "water": 10, "radiation": 0,
            "temperature": 20, "toxicity": 0, "cave_in_risk": 0}
    cell.update(over)
    return cell


def test_research_action_credits_tech_tree():
    random.seed(0)
    grid = Grid3D(3, 3)
    tt = TechTree()
    s = Survivor(1, 1, 0)
    s.perform_action("Research", grid, tt, {"scrap": 0, "water": 0, "biomass": 0})
    assert tt.research_points > 0


def test_construct_spends_scrap_on_current_project():
    random.seed(0)
    grid = Grid3D(3, 3)
    tt = TechTree()
    tt.research_points = 100
    name = tt.try_unlock_next()
    tt.current_project = name
    stock = {"scrap": 50, "water": 0, "biomass": 0}
    Survivor(1, 1, 0).perform_action("Construct", grid, tt, stock)
    assert tt.projects[name]["progress"] > 0
    assert stock["scrap"] == 50 - tt.projects[name]["progress"]


def test_surface_forager_collects_water_when_water_is_short():
    random.seed(1)
    grid = Grid3D(3, 3)
    grid.grid[(1, 1, 0)].update(water=30, biomass=30, scrap=30)
    stock = {"scrap": 100, "water": 0, "biomass": 100}
    Survivor(1, 1, 0).perform_action("Forage", grid, None, stock)
    assert stock["water"] > 0


def test_supply_forager_ignores_scrap_even_when_scrap_stock_is_zero():
    random.seed(1)
    grid = Grid3D(3, 3)
    grid.grid[(1, 1, 0)].update(water=30, biomass=30, scrap=30)
    stock = {"scrap": 0, "water": 5, "biomass": 5}
    Survivor(1, 1, 0).perform_action("Forage", grid, None, stock)
    assert stock["scrap"] == 0


def test_feed_consumes_stock_and_reduces_hunger():
    s = Survivor()
    s.hunger = 70
    stock = {"biomass": 10, "water": 10, "scrap": 0}
    s.feed(stock)
    assert s.hunger < 70
    assert stock["biomass"] < 10 and stock["water"] < 10


def test_cause_of_death_is_largest_damage_source():
    s = Survivor(genes={g: 1.0 for g in
                        ("speed", "foraging", "rad_resistance", "cold_resistance", "intelligence")})
    s.health = 5
    s.tick(calm_cell(temperature=-40))
    assert not s.alive
    assert s.cause_of_death == "Hypothermia"


def test_geothermal_protection_prevents_mild_cold_damage():
    genes = {g: 1.0 for g in ("speed", "foraging", "rad_resistance", "cold_resistance", "intelligence")}
    exposed, shielded = Survivor(genes=genes), Survivor(genes=genes)
    exposed.tick(calm_cell(temperature=-8))
    shielded.tick(calm_cell(temperature=-8), {"cold": 12.0})
    assert shielded.health > exposed.health


def test_tech_unlocks_regardless_of_crisis():
    random.seed(0)
    grid = Grid3D(3, 3)
    tt = TechTree()
    tt.research_points = 25
    coord = CoordinatorAgent(grid, tt)
    survivors = [Survivor(1, 1, 0) for _ in range(4)]
    stock = {"scrap": 0, "water": 0, "biomass": 0}  # full resource crisis
    intel = coord.gather_intel(survivors, stock)
    coord.formulate_plan(survivors, intel, stock)
    assert tt.projects["Underground Reinforcement"]["unlocked"]


def test_forecast_is_honoured():
    random.seed(3)
    grid = Grid3D(3, 3)
    grid.current_disaster, grid.disaster_duration = "None", 0
    grid.disaster_forecast = ["Blizzard", "None", "None", "None", "None"]
    grid.tick()
    assert grid.current_disaster == "Blizzard"
    assert len(grid.disaster_forecast) == 5


def test_reproduction_crosses_genes_within_bounds():
    random.seed(0)
    a, b = Survivor(), Survivor()
    child = a.reproduce(b)
    assert child.generation == 2
    for g, v in child.genes.items():
        assert 0.1 <= v <= 3.0


def test_population_is_capped():
    from pars.simulation import MAX_POPULATION
    sim = Simulation(seed=5, starting_population=10)
    sim.stockpile.update(water=10_000, biomass=10_000)
    for _ in range(150):
        if not sim.running:
            break
        sim.tick()
        sim.stockpile.update(water=10_000, biomass=10_000)
        assert len(sim.alive) <= MAX_POPULATION + 1  # +1 for a beacon recruit


def test_small_grid_rejected():
    with pytest.raises(ValueError):
        Simulation(width=2, height=5)


def test_seeded_runs_are_deterministic():
    def run(seed):
        sim = Simulation(seed=seed)
        sim.run(max_turns=60, delay_ms=0)
        return sim.turn, sim.game_over_reason, dict(sim.stockpile), len(sim.alive)
    assert run(11) == run(11)


def test_full_run_terminates():
    sim = Simulation(seed=2)
    reason = sim.run(max_turns=500, delay_ms=0)
    assert reason in ("EXTINCTION", "RESTORATION", "MAX_TURNS_REACHED")


def test_dashboard_renders_without_error():
    import io
    from rich.console import Console
    from pars import dashboard
    sim = Simulation(seed=4)
    sim.tick()
    layout = dashboard.build_layout(sim.grid, sim.survivors, sim.last_intel, sim.stockpile,
                                    sim.tech_tree, sim.coordinator, sim.turn)
    buf = io.StringIO()
    Console(file=buf, width=160, height=60).print(layout)
    assert "PARS" in buf.getvalue()


def test_names_reproducible_across_runs():
    a = [s.name for s in Simulation(seed=9).survivors]
    b = [s.name for s in Simulation(seed=9).survivors]
    assert a == b


def test_difficulty_presets_change_costs_and_stock():
    easy = Simulation(seed=1, difficulty="easy")
    hard = Simulation(seed=1, difficulty="hard")
    name = "Sub-space Radio Beacon"
    assert easy.tech_tree.projects[name]["cost"] < hard.tech_tree.projects[name]["cost"]
    assert easy.stockpile["water"] > hard.stockpile["water"]


def test_escalation_grows_over_time():
    grid = Grid3D(3, 3)
    start = grid.escalation
    for _ in range(100):
        grid.tick()
    assert grid.escalation > start


def test_old_age_eventually_kills():
    s = Survivor()
    s.lifespan = 20
    for _ in range(60):
        if not s.alive:
            break
        s.hunger = 0
        s.tick(calm_cell())
    assert s.cause_of_death == "Old age"


def test_batch_summary():
    from pars.batch import run_one, summarise
    results = [run_one(seed, max_turns=40) for seed in range(3)]
    s = summarise(results)
    assert s["runs"] == 3 and sum(s["outcomes"].values()) == 3


def test_doctrine_changes_coordinator_behaviour():
    a = Simulation(seed=3, doctrine="cautious")
    b = Simulation(seed=3, doctrine="industrious")
    assert a.coordinator.doctrine.move_threshold < b.coordinator.doctrine.move_threshold
    a.run(max_turns=80, delay_ms=0)
    b.run(max_turns=80, delay_ms=0)
    assert a.history != b.history


def test_export_and_report():
    import json
    from pars.report import build_report, score
    sim = Simulation(seed=6)
    sim.run(max_turns=30, delay_ms=0)
    data = json.loads(json.dumps(sim.to_dict()))
    assert data["turns"] == 30 and len(data["history"]) == 30
    assert "Score:" in build_report(sim, sim.initial_genes)
    assert score(sim) >= 0


def test_restoration_outscores_any_loss():
    from pars.report import score
    win = Simulation(seed=1)
    win.game_over_reason, win.turn = "RESTORATION", 299
    loss = Simulation(seed=1)
    for p in loss.tech_tree.projects.values():
        p["completed"] = True
    loss.game_over_reason, loss.turn = "EXTINCTION", 300
    assert score(win) > score(loss)


def test_main_headless_exports(tmp_path):
    import json
    import main
    out = tmp_path / "run.json"
    code = main.main(["--headless", "--seed", "2", "--max-turns", "25",
                      "--report-every", "0", "--export", str(out)])
    assert code == 0
    assert json.loads(out.read_text())["turns"] == 25
