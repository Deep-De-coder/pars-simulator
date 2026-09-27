"""
Core simulation loop — ties environment, survivors, coordinator, and tech together.
"""

import random
import time
from pars.environment import Grid3D
from pars.survivor import Survivor, reset_ids
from pars.coordinator import CoordinatorAgent
from pars.tech import TechTree

MAX_POPULATION = 30


class Simulation:
    def __init__(self, width=5, height=5, starting_population=6, seed=None,
                 renderer=None):
        if width < 3 or height < 3:
            raise ValueError("Grid must be at least 3x3")
        if starting_population < 1:
            raise ValueError("Starting population must be at least 1")
        if seed is not None:
            random.seed(seed)
        reset_ids()

        # renderer(sim) is called once per turn; None runs headless.
        self.renderer = renderer
        self.last_intel = None

        self.width = width
        self.height = height
        self.turn = 0
        self.running = True
        self.game_over_reason = None

        self.grid = Grid3D(width=width, height=height, z_levels=[-1, 0, 1])
        self.tech_tree = TechTree()
        self.coordinator = CoordinatorAgent(self.grid, self.tech_tree)

        self.stockpile = {"scrap": 0, "water": 30, "biomass": 30}

        # Lifetime counters for the end-of-run report.
        self.stats = {"births": 0, "deaths": 0, "recruits": 0,
                      "causes_of_death": {}, "peak_population": starting_population,
                      "max_generation": 1, "tech_completed_turn": {}}

        self.survivors = []
        for _ in range(starting_population):
            self.survivors.append(Survivor(
                x=random.randint(1, width - 2),
                y=random.randint(1, height - 2),
                z=random.choice([-1, 0, 0, 1]),
                generation=1,
            ))

    @property
    def alive(self):
        return [s for s in self.survivors if s.alive]

    def tick(self):
        """Advance the simulation by one full turn."""
        self.turn += 1

        self.grid.tick()
        self._apply_tech_income()

        intel = self.coordinator.gather_intel(self.survivors, self.stockpile)
        plan = self.coordinator.formulate_plan(self.survivors, intel, self.stockpile)
        self.coordinator.assign_directives(self.survivors, plan, self.stockpile)

        # Hungriest eat first so scarce food goes where it prevents deaths.
        for s in sorted(self.alive, key=lambda s: -s.hunger):
            if s.hunger > 30:
                s.feed(self.stockpile)

        protections = self.tech_tree.protections()
        for s in self.alive:
            s.tick(self.grid.get_cell(s.x, s.y, s.z), protections)
            if not s.alive:
                continue
            role = s.role
            if role in ("Forage", "Research", "Construct", "Rest"):
                s.perform_action(role, self.grid, self.tech_tree, self.stockpile)
            elif role.startswith("Move To Z="):
                s.move_towards(int(role.split("=")[1]), self.grid)

        self._passive_research()
        self._bury_dead()
        self._handle_reproduction(plan)

        for t in self.tech_tree.update_completion_states():
            self.stats["tech_completed_turn"][t] = self.turn
            self.coordinator.log(f"✅ Tech completed: {t}")

        intel = self.coordinator.gather_intel(self.survivors, self.stockpile)
        self.stats["peak_population"] = max(self.stats["peak_population"], intel["alive_count"])
        self._render(intel)

        result = self.coordinator.check_win_lose(self.survivors, intel, self.stockpile)
        if result:
            self.running = False
            self.game_over_reason = result

        return intel

    def _render(self, intel):
        self.last_intel = intel
        if self.renderer:
            self.renderer(self)

    def _passive_research(self):
        """Idle tinkering: a trickle of RP proportional to colony intellect."""
        total_int = sum(s.genes["intelligence"] for s in self.alive)
        self.tech_tree.research_points += int(total_int * 0.25)

    def _bury_dead(self):
        for d in [s for s in self.survivors if not s.alive]:
            cause = d.cause_of_death or "Unknown"
            self.stats["deaths"] += 1
            self.stats["causes_of_death"][cause] = self.stats["causes_of_death"].get(cause, 0) + 1
            self.coordinator.log(
                f"\U0001f480 {d.name} perished (Gen {d.generation}, age {d.age}, {cause})"
            )
        self.survivors = self.alive

    def _apply_tech_income(self):
        tt = self.tech_tree
        if tt.is_completed("Water Filtration Rig"):
            self.stockpile["water"] += 6
        if tt.is_completed("Automated Hydroponics"):
            self.stockpile["biomass"] += 6
        if (tt.is_completed("Sub-space Radio Beacon") and random.random() < 0.15
                and len(self.alive) < MAX_POPULATION // 2):
            new_s = Survivor(
                x=random.randint(0, self.width - 1),
                y=random.randint(0, self.height - 1),
                z=0,
                generation=1,
            )
            self.survivors.append(new_s)
            self.stats["recruits"] += 1
            self.coordinator.log(f"\U0001f4e1 Radio Beacon attracted {new_s.name}!")

    def _can_breed(self, s):
        return (s.alive and not s.has_reproduced_this_turn
                and s.health >= 60 and s.hunger <= 40 and s.energy >= 40 and s.age >= 5)

    def _handle_reproduction(self, plan):
        """Pairs on the same Z level may have a child if the colony can
        afford it. Births are capped per turn and by carrying capacity so the
        population can't boom past what the stockpile supports."""
        alive = self.alive
        pop = len(alive)
        if pop >= MAX_POPULATION or plan in ("DISASTER_RESPONSE", "SURVIVAL",
                                             "FORAGE_PRIORITY"):
            return
        max_births = 2 if plan == "EXPAND" else 1
        births = 0
        for i, s1 in enumerate(alive):
            if births >= max_births:
                break
            if not self._can_breed(s1):
                continue
            for s2 in alive[i + 1:]:
                if s2.z != s1.z or not self._can_breed(s2):
                    continue
                # Reserve ~3 turns of food and water for the existing colony.
                reserve = 15 + pop * 3
                if self.stockpile["biomass"] < reserve or self.stockpile["water"] < reserve:
                    return
                child = s1.reproduce(s2)
                self.survivors.append(child)
                self.stockpile["biomass"] -= 10
                self.stockpile["water"] -= 10
                self.stats["births"] += 1
                self.stats["max_generation"] = max(self.stats["max_generation"], child.generation)
                self.coordinator.log(
                    f"\U0001f476 New survivor born: {child.name} (Gen {child.generation})"
                )
                births += 1
                pop += 1
                break

    def run(self, max_turns=0, delay_ms=500):
        """Run the simulation loop, rendering each turn."""
        while self.running:
            if max_turns > 0 and self.turn >= max_turns:
                self.running = False
                self.game_over_reason = "MAX_TURNS_REACHED"
                break
            self.tick()
            if delay_ms > 0:
                time.sleep(delay_ms / 1000.0)
        return self.game_over_reason
