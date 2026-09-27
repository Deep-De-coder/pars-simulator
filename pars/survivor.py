import itertools
import random

NAMES_DB = [
    "Alex", "Sam", "Jordan", "Taylor", "Morgan", "Casey", "Riley", "Jamie", "Skyler", "Robin",
    "Logan", "Quinn", "Avery", "Reese", "Rowan", "Finley", "Emery", "Peyton", "Sage", "Drew",
    "Chris", "Pat", "Terry", "Dana", "Kim", "Kelly", "Leslie", "Jan", "Val", "Ren"
]

GENE_NAMES = ("speed", "foraging", "rad_resistance", "cold_resistance", "intelligence")

# What each Z level yields when foraged: (resource, min, max, flavour label),
# in the order they are tried.
FORAGE_TABLE = {
    0: [("water", 5, 12, "Water"), ("biomass", 6, 14, "Biomass"), ("scrap", 4, 10, "Scrap")],
    -1: [("water", 8, 15, "Water"), ("scrap", 3, 8, "Bunker Scrap"), ("biomass", 2, 5, "Fungi")],
    1: [("biomass", 3, 8, "Alpine Biomass"), ("scrap", 3, 8, "High Wreckage"), ("water", 2, 6, "Ice")],
}

HUNGER_PER_BIOMASS = 10.0
HUNGER_PER_WATER = 6.0

_ids = itertools.count(1)


def reset_ids():
    """Restart survivor numbering (called per Simulation for reproducible names)."""
    global _ids
    _ids = itertools.count(1)


class Survivor:
    def __init__(self, x=2, y=2, z=0, genes=None, generation=1, name=None):
        self.id = next(_ids)
        self.name = name if name else f"{random.choice(NAMES_DB)}-{self.id}"
        self.x = x
        self.y = y
        self.z = z
        self.generation = generation

        # Core attributes (0-100 scale)
        self.health = 100.0
        self.energy = 100.0
        self.hunger = 0.0      # 0 is full, 100 is starving
        self.radiation = 0.0   # 0 is clean, 100 is lethal

        # State
        self.age = 0
        self.lifespan = random.randint(90, 140)
        self.role = "Unassigned"
        self.forage_target = "supplies"  # "supplies" (water/biomass) or "scrap"
        self.status = "Idle"
        self.cause_of_death = None
        self.has_reproduced_this_turn = False
        self._damage = {}

        # Genetics (traits default around 1.0, representing multiplier efficiency)
        if genes:
            self.genes = dict(genes)
        else:
            self.genes = {g: round(random.uniform(0.6, 1.4), 2) for g in GENE_NAMES}

    @property
    def alive(self):
        return self.health > 0

    def _hurt(self, amount, cause):
        """Apply damage and remember what is hurting us, so deaths are
        attributed to the largest damage source rather than the last status."""
        if amount <= 0:
            return
        self.health = max(0.0, self.health - amount)
        self._damage[cause] = self._damage.get(cause, 0.0) + amount
        if self.health <= 0 and self.cause_of_death is None:
            self.cause_of_death = max(self._damage, key=self._damage.get)

    def tick(self, grid_cell, protections=None):
        """Apply metabolism and environmental factors for the current cell.

        protections: optional dict of tech mitigations, e.g.
        {"cold": 10, "radiation": 0.5, "cave_in": 0.3}.
        """
        protections = protections or {}
        self.age += 1
        self.has_reproduced_this_turn = False
        self._damage = {}
        self.status = "Idle"

        # Standard metabolism: speedier individuals burn faster.
        self.hunger = min(100.0, self.hunger + 3.0 + self.genes["speed"] * 1.5)
        self.energy = max(0.0, self.energy - (1.5 + self.genes["speed"] * 0.5))

        if self.hunger >= 80.0:
            self._hurt((self.hunger - 80.0) * 0.5, "Starvation")
            self.status = "Starving"

        # Radiation exposure, reduced by gene and tech shielding.
        rad_exposure = grid_cell["radiation"] * (1.0 - protections.get("radiation", 0.0))
        absorbed = rad_exposure - self.genes["rad_resistance"] * 12.0
        if absorbed > 0:
            self.radiation = min(100.0, self.radiation + absorbed * 0.5)
        else:
            self.radiation = max(0.0, self.radiation - 3.0)

        if self.radiation > 30.0:
            self._hurt((self.radiation - 30.0) * 0.3, "Radiation")
            if self.status == "Idle":
                self.status = "Sick"

        # Cold exposure.
        temp = grid_cell["temperature"] + protections.get("cold", 0.0)
        if temp < 10.0:
            absorbed_cold = (10.0 - temp) - self.genes["cold_resistance"] * 10.0
            if absorbed_cold > 0:
                self._hurt(absorbed_cold * 0.4, "Hypothermia")
                if self.status == "Idle":
                    self.status = "Freezing"

        # Toxicity exposure.
        toxicity = grid_cell["toxicity"]
        if self.z == -1:
            toxicity *= 1.0 - protections.get("radon", 0.0)
        if toxicity > 20:
            self._hurt((toxicity - 20) * 0.2, "Toxic exposure")
            if self.status == "Idle":
                self.status = "Poisoned"

        # Cave-ins: underground only, chance scales with local risk.
        risk = grid_cell.get("cave_in_risk", 0) * (1.0 - protections.get("cave_in", 0.0))
        if self.z == -1 and risk > 0 and random.random() < risk / 400.0:
            self._hurt(random.uniform(15, 40), "Cave-in")
            self.status = "Crushed"

        # Old age: frailty sets in over the last quarter of the lifespan.
        frail_from = self.lifespan * 0.75
        if self.age > frail_from:
            self._hurt((self.age - frail_from) / (self.lifespan * 0.25) * 6.0, "Old age")
            if self.status == "Idle":
                self.status = "Frail"

        # Slow passive healing if healthy, fed, and rested.
        if (self.hunger < 40.0 and self.radiation < 15.0 and self.energy > 50.0
                and temp >= 5.0 and toxicity < 10 and not self._damage):
            self.health = min(100.0, self.health + 4.0)

    def _forage(self, cell, stockpile):
        options = [o for o in FORAGE_TABLE.get(self.z, []) if cell[o[0]] > 0]
        # Prefer our assigned target; among supplies, take whichever the
        # colony is shortest on. Fall back to anything available here.
        if self.forage_target == "scrap":
            key = lambda o: (o[0] != "scrap", stockpile.get(o[0], 0))
        else:
            key = lambda o: (o[0] == "scrap", stockpile.get(o[0], 0))
        ranked = sorted(options, key=key)
        if not ranked:
            return False
        res, lo, hi, label = ranked[0]
        amount = min(cell[res], max(1, int(random.randint(lo, hi) * self.genes["foraging"])))
        cell[res] -= amount
        stockpile[res] = stockpile.get(res, 0) + amount
        self.status = f"Gathered {amount} {label}"
        return True

    def perform_action(self, action_type, grid, tech_tree, stockpile):
        """Execute the assigned action based on the coordinator's directive.

        tech_tree is a pars.tech.TechTree (or None for actions that don't
        need it).
        """
        cell = grid.get_cell(self.x, self.y, self.z)
        if not cell:
            return

        # If too weak or exhausted, forced to rest.
        if self.health < 20.0 or self.energy < 15.0:
            action_type = "Rest"

        if action_type == "Forage":
            if not self._forage(cell, stockpile):
                self.move_to_richest_neighbor(grid)
                self.status = "Cell Empty, Searching..."
            self.energy = max(0.0, self.energy - 8.0)
            self.hunger = min(100.0, self.hunger + 3.0)

        elif action_type == "Research":
            gain = int(random.randint(2, 6) * self.genes["intelligence"])
            if tech_tree is not None:
                tech_tree.research_points += gain
            self.status = f"Researched +{gain} RP"
            self.energy = max(0.0, self.energy - 6.0)
            self.hunger = min(100.0, self.hunger + 2.0)

        elif action_type == "Construct":
            proj_name = tech_tree.current_project if tech_tree else None
            if proj_name:
                proj = tech_tree.projects[proj_name]
                needed = proj["cost"] - proj["progress"]
                if needed > 0 and stockpile["scrap"] > 0:
                    rate = random.randint(4, 9) * (0.5 + self.genes["intelligence"] / 2)
                    spent = min(stockpile["scrap"], max(1, int(rate)), needed)
                    stockpile["scrap"] -= spent
                    proj["progress"] += spent
                    self.status = f"Built {spent} on {proj_name}"
                else:
                    self.status = "No Scrap to Build"
            else:
                self.status = "Nothing to Build"
            self.energy = max(0.0, self.energy - 10.0)
            self.hunger = min(100.0, self.hunger + 4.0)

        elif action_type == "Rest":
            self.energy = min(100.0, self.energy + 25.0)
            self.radiation = max(0.0, self.radiation - 2.0)
            if self.status == "Idle":
                self.status = "Resting"

    def move_towards(self, target_z, grid):
        """Move 1 step vertically, or horizontally once on the right level."""
        if self.z != target_z:
            if target_z > self.z:
                self.z += 1
                self.status = "Climbed Up"
            else:
                self.z -= 1
                self.status = "Descended"
            self.energy = max(0.0, self.energy - 10.0 / max(0.5, self.genes["speed"]))
            return
        self.move_to_richest_neighbor(grid)

    def _neighbors(self, grid):
        for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            nx, ny = self.x + dx, self.y + dy
            if 0 <= nx < grid.width and 0 <= ny < grid.height:
                yield nx, ny

    def _step_to(self, nx, ny):
        self.x, self.y = nx, ny
        self.status = f"Moved to ({nx},{ny})"
        self.energy = max(0.0, self.energy - 4.0)

    def wander(self, grid):
        """Move 1 random step horizontally on the current Z level."""
        options = list(self._neighbors(grid))
        if options:
            self._step_to(*random.choice(options))

    def move_to_richest_neighbor(self, grid):
        """Step to the adjacent cell with the most resources, ties random."""
        options = list(self._neighbors(grid))
        if not options:
            return
        random.shuffle(options)

        def richness(pos):
            c = grid.get_cell(pos[0], pos[1], self.z)
            return c["water"] + c["biomass"] + c["scrap"] - c["toxicity"] - c["radiation"] * 0.5

        self._step_to(*max(options, key=richness))

    def feed(self, stockpile):
        """Eat biomass and drink water from the colony stockpile."""
        if self.hunger <= 20:
            return
        want = self.hunger - 10.0
        # Split roughly 60/40 between food and water.
        food = min(stockpile["biomass"], int(want * 0.6 / HUNGER_PER_BIOMASS + 0.999))
        stockpile["biomass"] -= food
        water = min(stockpile["water"], int(want * 0.4 / HUNGER_PER_WATER + 0.999))
        stockpile["water"] -= water
        relief = food * HUNGER_PER_BIOMASS + water * HUNGER_PER_WATER
        # Without water, food alone only half-satisfies (dehydration).
        if water == 0:
            relief *= 0.5
        self.hunger = max(0.0, self.hunger - relief)

    def reproduce(self, partner, grid=None):
        """Cross-over genetics with a partner to create a mutated offspring."""
        child_genes = {}
        for gene_name in self.genes:
            # Uniform crossover plus blending, with a 15% mutation chance.
            parent_val = random.choice((self.genes[gene_name], partner.genes[gene_name]))
            mixed = (parent_val + (self.genes[gene_name] + partner.genes[gene_name]) / 2.0) / 2.0
            if random.random() < 0.15:
                mixed += random.uniform(-0.25, 0.25)
            child_genes[gene_name] = round(max(0.1, min(3.0, mixed)), 2)

        child_generation = max(self.generation, partner.generation) + 1
        child = Survivor(x=self.x, y=self.y, z=self.z, genes=child_genes,
                         generation=child_generation)
        child.hunger = 30.0

        self.energy = max(5.0, self.energy - 35.0)
        partner.energy = max(5.0, partner.energy - 35.0)
        self.has_reproduced_this_turn = True
        partner.has_reproduced_this_turn = True
        return child
