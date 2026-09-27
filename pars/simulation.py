"""
Core simulation loop — ties environment, survivors, coordinator, and tech together.
"""

import random
import time
from pars.environment import Grid3D
from pars.survivor import Survivor
from pars.coordinator import CoordinatorAgent
from pars.tech import TechTree


class Simulation:
    def __init__(self, width=5, height=5, starting_population=6, seed=None,
                 renderer=None):
        if width < 3 or height < 3:
            raise ValueError("Grid must be at least 3x3")
        if starting_population < 1:
            raise ValueError("Starting population must be at least 1")
        if seed is not None:
            random.seed(seed)

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

        self.stockpile = {"scrap": 0, "water": 10, "biomass": 10}

        self.survivors = []
        for i in range(starting_population):
            z = random.choice([-1, 0, 0, 1])
            s = Survivor(
                x=random.randint(1, width - 2),
                y=random.randint(1, height - 2),
                z=z,
                generation=1,
            )
            self.survivors.append(s)

    def tick(self):
        """Advance the simulation by one full turn."""
        self.turn += 1

        self.grid.tick()
        self._apply_tech_bonuses()

        intel = self.coordinator.gather_intel(self.survivors, self.stockpile)

        result = self.coordinator.check_win_lose(self.survivors, intel, self.stockpile)
        if result:
            self.running = False
            self.game_over_reason = result
            self._render(intel)
            return intel

        plan = self.coordinator.formulate_plan(self.survivors, intel, self.stockpile)
        self.coordinator.assign_directives(self.survivors, plan, self.stockpile)

        food_stock = [self.stockpile["biomass"]]
        water_stock = [self.stockpile["water"]]
        for s in self.survivors:
            if s.health > 0 and s.hunger > 30:
                s.feed(food_stock, water_stock)
        self.stockpile["biomass"] = food_stock[0]
        self.stockpile["water"] = water_stock[0]

        for s in self.survivors:
            if s.health <= 0:
                continue
            cell = self.grid.get_cell(s.x, s.y, s.z)
            s.tick(cell)

            role = s.role
            if role == "Forage":
                s.perform_action("Forage", self.grid, {}, self.stockpile)
            elif role in ("Research", "Construct"):
                s.perform_action(
                    role,
                    self.grid,
                    {"points": self.tech_tree.research_points,
                     "current_project": self.tech_tree.current_project,
                     "projects": self.tech_tree.projects},
                    self.stockpile,
                )
            elif role == "Rest":
                s.perform_action("Rest", self.grid, {}, self.stockpile)
            elif role == "Move To Z=-1":
                s.move_towards(-1, self.grid)
            elif role == "Move To Z=0":
                s.move_towards(0, self.grid)
            elif role == "Move To Z=1":
                s.move_towards(1, self.grid)

        self._sync_research_points()

        deaths = [s for s in self.survivors if s.health <= 0]
        for d in deaths:
            self.coordinator.thought_log.append(
                f"\U0001f480 {d.name} has perished (Gen {d.generation}, cause: {d.status})"
            )
        self.survivors = [s for s in self.survivors if s.health > 0]

        self._handle_reproduction()

        completed = self.tech_tree.update_completion_states()
        for t in completed:
            self.coordinator.thought_log.append(f"\u2705 Tech completed: {t}")

        intel = self.coordinator.gather_intel(self.survivors, self.stockpile)
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

    def _sync_research_points(self):
        total_intelligence = sum(s.genes["intelligence"] for s in self.survivors if s.health > 0)
        self.tech_tree.research_points += int(total_intelligence * 0.5)

    def _apply_tech_bonuses(self):
        for name, proj in self.tech_tree.projects.items():
            if not proj["completed"]:
                continue
            if name == "Water Filtration Rig":
                self.stockpile["water"] += 5
            elif name == "Automated Hydroponics":
                self.stockpile["biomass"] += 5
            elif name == "Underground Reinforcement":
                for (x, y, z), cell in self.grid.grid.items():
                    if z == -1:
                        cell["cave_in_risk"] = max(0, cell["cave_in_risk"] - 15)
            elif name == "Geothermal Insulation":
                for (x, y, z), cell in self.grid.grid.items():
                    if cell["temperature"] < 5:
                        cell["temperature"] += 10
            elif name == "Cosmic Ray Deflector":
                for (x, y, z), cell in self.grid.grid.items():
                    cell["radiation"] = max(5, cell["radiation"] - 15)
            elif name == "Sub-space Radio Beacon":
                if random.random() < 0.15 and len([s for s in self.survivors if s.health > 0]) < 15:
                    new_s = Survivor(
                        x=random.randint(0, self.width - 1),
                        y=random.randint(0, self.height - 1),
                        z=0,
                        generation=1,
                    )
                    self.survivors.append(new_s)
                    self.coordinator.thought_log.append(
                        f"\U0001f4e1 Radio Beacon attracted {new_s.name}!"
                    )

    def _handle_reproduction(self):
        for i, s1 in enumerate(self.survivors):
            if s1.health <= 0:
                continue
            if s1.has_reproduced_this_turn or s1.health < 55 or s1.hunger > 40:
                continue
            for s2 in self.survivors[i + 1:]:
                if s2.health <= 0:
                    continue
                if s2.has_reproduced_this_turn or s2.health < 55 or s2.hunger > 40:
                    continue
                if self.stockpile["biomass"] >= 15 and self.stockpile["water"] >= 15:
                    child = s1.reproduce(s2, self.grid)
                    self.survivors.append(child)
                    self.stockpile["biomass"] -= 10
                    self.stockpile["water"] -= 10
                    self.coordinator.thought_log.append(
                        f"\U0001f476 New survivor born: {child.name} (Gen {child.generation})"
                    )
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