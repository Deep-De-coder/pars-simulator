import random

NAMES_DB = [
    "Alex", "Sam", "Jordan", "Taylor", "Morgan", "Casey", "Riley", "Jamie", "Skyler", "Robin",
    "Logan", "Quinn", "Avery", "Reese", "Rowan", "Finley", "Emery", "Peyton", "Sage", "Drew",
    "Chris", "Pat", "Terry", "Dana", "Kim", "Kelly", "Leslie", "Jan", "Val", "Ren"
]

class Survivor:
    def __init__(self, x=2, y=2, z=0, genes=None, generation=1, name=None):
        self.name = name if name else random.choice(NAMES_DB) + f" v{generation}"
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
        self.role = "Unassigned"
        self.status = "Idle"
        self.has_reproduced_this_turn = False
        
        # Genetics (traits default around 1.0, representing multiplier efficiency)
        if genes:
            self.genes = genes
        else:
            self.genes = {
                "speed": round(random.uniform(0.6, 1.4), 2),
                "foraging": round(random.uniform(0.6, 1.4), 2),
                "rad_resistance": round(random.uniform(0.6, 1.4), 2),
                "cold_resistance": round(random.uniform(0.6, 1.4), 2),
                "intelligence": round(random.uniform(0.6, 1.4), 2)
            }

    def tick(self, grid_cell):
        """Apply basic metabolism and environmental factors based on current cell location."""
        self.age += 1
        self.has_reproduced_this_turn = False
        
        # Standard metabolism
        # Speedier individuals burn energy and hunger faster
        burn_rate = 3.0 + (self.genes["speed"] * 1.5)
        self.hunger = min(100.0, self.hunger + burn_rate)
        self.energy = max(0.0, self.energy - (1.5 + (self.genes["speed"] * 0.5)))
        
        # Process starvation
        if self.hunger >= 80.0:
            starve_dmg = (self.hunger - 80.0) * 0.5
            self.health = max(0.0, self.health - starve_dmg)
            self.status = "Starving"
        else:
            self.status = "Idle"
            
        # Process radiation exposure (adjusted by resistance gene)
        rad_exposure = grid_cell["radiation"]
        if rad_exposure > 0:
            absorbed = max(0.1, rad_exposure - (self.genes["rad_resistance"] * 12.0))
            self.radiation = min(100.0, self.radiation + absorbed * 0.5)
        else:
            # Natural radiation flush when in clean areas
            self.radiation = max(0.0, self.radiation - 2.0)
            
        if self.radiation > 30.0:
            rad_dmg = (self.radiation - 30.0) * 0.3
            self.health = max(0.0, self.health - rad_dmg)
            if self.status == "Idle":
                self.status = "Sick"

        # Process temperature exposure (cold mountain Z=1)
        temp = grid_cell["temperature"]
        if temp < 10.0:
            cold_severity = 10.0 - temp
            absorbed_cold = max(0.0, cold_severity - (self.genes["cold_resistance"] * 10.0))
            if absorbed_cold > 0:
                self.health = max(0.0, self.health - absorbed_cold * 0.4)
                if self.status == "Idle":
                    self.status = "Freezing"
                    
        # Toxicity exposure
        toxicity = grid_cell["toxicity"]
        if toxicity > 20:
            tox_dmg = (toxicity - 20) * 0.2
            self.health = max(0.0, self.health - tox_dmg)
            if self.status == "Idle":
                self.status = "Poisoned"

        # Slow passive healing if healthy, fed, and rested
        if self.hunger < 40.0 and self.radiation < 15.0 and self.energy > 50.0 and temp >= 5.0 and toxicity < 10:
            self.health = min(100.0, self.health + 4.0)

    def perform_action(self, action_type, grid, tech_tree, stockpile):
        """Execute the assigned action based on the coordinator's directive."""
        cell = grid.get_cell(self.x, self.y, self.z)
        if not cell:
            return
        
        # If too weak or starving, forced to rest or look for food locally
        if self.health < 20.0 or self.energy < 15.0:
            action_type = "Rest"
            
        if action_type == "Forage":
            # Decide what resource we need most or gather what's available
            # Gather Scrap, Water, or Biomass depending on Z layer profile
            gathered_any = False
            
            # Surface foraging
            if self.z == 0:
                # Prioritize based on stocks
                if stockpile.get("water", 0) < stockpile.get("food", 0) and cell["water"] > 0:
                    yield_amt = min(cell["water"], int(random.randint(5, 12) * self.genes["foraging"]))
                    cell["water"] -= yield_amt
                    stockpile["water"] += yield_amt
                    self.status = f"Gathered {yield_amt} Water"
                    gathered_any = True
                elif cell["biomass"] > 0:
                    yield_amt = min(cell["biomass"], int(random.randint(6, 14) * self.genes["foraging"]))
                    cell["biomass"] -= yield_amt
                    stockpile["biomass"] += yield_amt
                    self.status = f"Gathered {yield_amt} Biomass"
                    gathered_any = True
                elif cell["scrap"] > 0:
                    yield_amt = min(cell["scrap"], int(random.randint(4, 10) * self.genes["foraging"]))
                    cell["scrap"] -= yield_amt
                    stockpile["scrap"] += yield_amt
                    self.status = f"Gathered {yield_amt} Scrap"
                    gathered_any = True
            
            # Underground foraging
            elif self.z == -1:
                # Water/scrap
                if cell["water"] > 0:
                    yield_amt = min(cell["water"], int(random.randint(8, 15) * self.genes["foraging"]))
                    cell["water"] -= yield_amt
                    stockpile["water"] += yield_amt
                    self.status = f"Gathered {yield_amt} Water"
                    gathered_any = True
                elif cell["scrap"] > 0:
                    yield_amt = min(cell["scrap"], int(random.randint(2, 6) * self.genes["foraging"]))
                    cell["scrap"] -= yield_amt
                    stockpile["scrap"] += yield_amt
                    self.status = f"Gathered {yield_amt} Bunker Scrap"
                    gathered_any = True
            
            # Mountain foraging
            elif self.z == 1:
                if cell["biomass"] > 0:
                    yield_amt = min(cell["biomass"], int(random.randint(3, 8) * self.genes["foraging"]))
                    cell["biomass"] -= yield_amt
                    stockpile["biomass"] += yield_amt
                    self.status = f"Gathered {yield_amt} Alpine Biomass"
                    gathered_any = True
                elif cell["scrap"] > 0:
                    yield_amt = min(cell["scrap"], int(random.randint(3, 8) * self.genes["foraging"]))
                    cell["scrap"] -= yield_amt
                    stockpile["scrap"] += yield_amt
                    self.status = f"Gathered {yield_amt} High Wreckage"
                    gathered_any = True

            if not gathered_any:
                # Nothing left in this cell, auto-move to find some
                self.wander(grid)
                self.status = "Cell Empty, Searching..."

            # Foraging consumes extra energy/hunger
            self.energy = max(0.0, self.energy - 8.0)
            self.hunger = min(100.0, self.hunger + 5.0)

        elif action_type == "Research":
            # Add research points based on Intelligence gene
            research_gain = int(random.randint(2, 6) * self.genes["intelligence"])
            if tech_tree:
                tech_tree["points"] += research_gain
            self.status = f"Researched +{research_gain} Points"
            self.energy = max(0.0, self.energy - 6.0)
            self.hunger = min(100.0, self.hunger + 3.0)

        elif action_type == "Construct":
            # If we are constructing, we consume scrap to advance tech projects
            if tech_tree and tech_tree["current_project"]:
                proj = tech_tree["current_project"]
                needed = tech_tree["projects"][proj]["cost"] - tech_tree["projects"][proj]["progress"]
                if needed > 0 and stockpile["scrap"] > 0:
                    spent = min(stockpile["scrap"], random.randint(3, 8), needed)
                    stockpile["scrap"] -= spent
                    tech_tree["projects"][proj]["progress"] += spent
                    self.status = f"Built {spent} on {proj}"
                else:
                    self.status = "No Construct Project/Scrap"
            else:
                self.status = "Idle Construct"
            self.energy = max(0.0, self.energy - 10.0)
            self.hunger = min(100.0, self.hunger + 6.0)

        elif action_type == "Rest":
            # Restores health and energy, lowers hunger burn slightly
            self.energy = min(100.0, self.energy + 25.0)
            # Resting flushes a little radiation
            self.radiation = max(0.0, self.radiation - 1.0)
            self.status = "Resting"

    def move_towards(self, target_z, grid):
        """Move 1 step vertically or horizontally towards a destination."""
        # 1. Handle vertical movement first (climb up/down)
        if self.z != target_z:
            if target_z > self.z:
                self.z += 1
                self.status = "Climbed Up"
            else:
                self.z -= 1
                self.status = "Descended Down"
            self.energy = max(0.0, self.energy - 10.0)
            return

        # 2. Horizontal movement if already on the correct level
        # Move randomly towards the center or wander on that level
        self.wander(grid)

    def wander(self, grid):
        """Move 1 step horizontally on the current Z level."""
        directions = [(-1, 0), (1, 0), (0, -1), (0, 1)]
        dx, dy = random.choice(directions)
        new_x = max(0, min(grid.width - 1, self.x + dx))
        new_y = max(0, min(grid.height - 1, self.y + dy))
        if new_x != self.x or new_y != self.y:
            self.x = new_x
            self.y = new_y
            self.status = f"Moved to ({new_x},{new_y})"
            self.energy = max(0.0, self.energy - 4.0)

    def feed(self, food_stock, water_stock):
        """Consume food and water from the stockpiles to reduce hunger."""
        if self.hunger > 20:
            # Eat food
            food_needed = int(self.hunger / 10)
            if food_needed > 0:
                eaten = min(food_stock[0], food_needed)
                food_stock[0] -= eaten
                self.hunger = max(0.0, self.hunger - (eaten * 15))
            
            # Drink water
            water_needed = int(self.hunger / 10)
            if water_needed > 0:
                drunk = min(water_stock[0], water_needed)
                water_stock[0] -= drunk
                self.hunger = max(0.0, self.hunger - (drunk * 15))

    def reproduce(self, partner, grid):
        """Cross-over genetics with a partner to create a mutated offspring."""
        # Children are spawned at the parents' location
        child_genes = {}
        for gene_name in self.genes:
            # Mix parents genes with a 10% mutation chance
            mixed_gene = (self.genes[gene_name] + partner.genes[gene_name]) / 2.0
            if random.random() < 0.15:  # Mutated
                mutation = random.uniform(-0.25, 0.25)
                mixed_gene = max(0.1, round(mixed_gene + mutation, 2))
            else:
                mixed_gene = round(mixed_gene, 2)
            child_genes[gene_name] = mixed_gene
            
        child_generation = max(self.generation, partner.generation) + 1
        child = Survivor(x=self.x, y=self.y, z=self.z, genes=child_genes, generation=child_generation)
        
        # Deduct energy from parents for reproduction
        self.energy = max(5.0, self.energy - 35.0)
        partner.energy = max(5.0, partner.energy - 35.0)
        self.has_reproduced_this_turn = True
        partner.has_reproduced_this_turn = True
        
        return child
