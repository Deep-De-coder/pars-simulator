"""
AI Coordinator Agent -- gathers intel, formulates strategic survival plans,
and assigns directives to each survivor based on their genetic traits.

Each turn the coordinator:
  1. unlocks the next tech whenever research points allow,
  2. scores every Z level's hazard *for each survivor* (their genes and the
     colony's tech shielding), including the next forecast disaster, and
     relocates survivors whose level is clearly more dangerous than another,
  3. decides how many foragers / builders / researchers the colony needs
     and fills those roles with the best-suited survivors.
"""

import math

from pars.config import get_doctrine

LOG_LIMIT = 200

# Which levels each disaster makes worse (used for forecast look-ahead).
DISASTER_THREAT = {
    "Acid Rain": {0: 8.0, 1: 3.0},
    "Blizzard": {1: 12.0, 0: 6.0},
    "Solar Flare": {1: 10.0, 0: 7.0},
    "Radon Leak": {-1: 9.0},
    "Cave-In Threat": {-1: 6.0},
}


class CoordinatorAgent:
    def __init__(self, grid, tech_tree, doctrine=None):
        self.doctrine = get_doctrine(doctrine)
        self.grid = grid
        self.tech_tree = tech_tree
        self.thought_log = []
        self.active_plan = "Initializing..."
        self.plan_age = 0
        self.turn = 0
        self._last_plan = None

    def log(self, msg):
        self.thought_log.append(f"T{self.turn:<3} {msg}")
        if len(self.thought_log) > LOG_LIMIT:
            del self.thought_log[:-LOG_LIMIT]

    # ------------------------------------------------------------------ intel
    def gather_intel(self, survivors, stockpile):
        """Collect comprehensive colony intel for decision-making."""
        alive = [s for s in survivors if s.health > 0]
        n = len(alive)
        return {
            "population": len(survivors),
            "alive_count": n,
            "avg_health": sum(s.health for s in alive) / max(1, n),
            "avg_hunger": sum(s.hunger for s in alive) / max(1, n),
            "avg_radiation": sum(s.radiation for s in alive) / max(1, n),
            "avg_energy": sum(s.energy for s in alive) / max(1, n),
            "disaster": self.grid.current_disaster,
            "disaster_turns_left": self.grid.disaster_duration,
            "forecast": list(self.grid.disaster_forecast[:3]),
            "scrap": stockpile.get("scrap", 0),
            "water": stockpile.get("water", 0),
            "biomass": stockpile.get("biomass", 0),
            "research_points": self.tech_tree.research_points,
            "surface_pop": sum(1 for s in alive if s.z == 0),
            "underground_pop": sum(1 for s in alive if s.z == -1),
            "mountain_pop": sum(1 for s in alive if s.z == 1),
        }

    def level_conditions(self):
        """Average hazard readings per Z level."""
        out = {}
        for z in self.grid.z_levels:
            cells = [c for (x, y, cz), c in self.grid.grid.items() if cz == z]
            n = max(1, len(cells))
            out[z] = {k: sum(c[k] for c in cells) / n
                      for k in ("radiation", "temperature", "toxicity", "cave_in_risk",
                                "water", "biomass", "scrap")}
        return out

    def danger_for(self, s, z, levels, protections, lookahead=True):
        """Estimated HP loss per turn for survivor s standing on level z."""
        c = levels[z]
        rad = c["radiation"] * (1 - protections.get("radiation", 0)) - s.genes["rad_resistance"] * 12
        # Radiation accumulates: project the dose over a few turns, and for
        # already-irradiated survivors value levels where it flushes out.
        future_rad = s.radiation + (rad * 0.5 if rad > 0 else -3.0) * 4
        danger = max(0.0, future_rad - 30.0) * 0.3
        if s.radiation > 20 and rad > 0:
            danger += 2.0
        temp = c["temperature"] + protections.get("cold", 0)
        danger += max(0.0, (10 - temp) - s.genes["cold_resistance"] * 10) * 0.4
        tox = c["toxicity"] * ((1 - protections.get("radon", 0)) if z == -1 else 1)
        danger += max(0.0, tox - 20) * 0.2
        if z == -1:
            danger += c["cave_in_risk"] * (1 - protections.get("cave_in", 0)) / 400 * 27
        if lookahead and self.grid.current_disaster == "None" and self.grid.disaster_forecast:
            danger += DISASTER_THREAT.get(self.grid.disaster_forecast[0], {}).get(z, 0.0)
        return danger

    # --------------------------------------------------------------- planning
    def formulate_plan(self, survivors, intel, stockpile):
        """Decide the colony's strategic priority for this turn."""
        self.turn += 1

        unlocked = self.tech_tree.try_unlock_next()
        if unlocked:
            self.log(f"\U0001f513 Tech unlocked: {unlocked}")

        n = max(1, intel["alive_count"])
        food_days = min(intel["water"], intel["biomass"]) / n
        if intel["disaster"] != "None":
            plan = "DISASTER_RESPONSE"
            self.active_plan = (f"EMERGENCY: {intel['disaster']} "
                                f"({intel['disaster_turns_left']}t). Shelter on safest levels.")
        elif intel["alive_count"] <= 2:
            plan = "SURVIVAL"
            self.active_plan = f"CRITICAL: only {intel['alive_count']} alive. Forage and rest."
        elif food_days < 3 or intel["avg_hunger"] > 55:
            plan = "FORAGE_PRIORITY"
            self.active_plan = f"Resource crisis (~{food_days:.1f} turns of supplies). Foraging priority."
        elif intel["avg_radiation"] > 35 or intel["avg_health"] < 45:
            plan = "HEALTH_FOCUS"
            self.active_plan = (f"Health crisis (HP {intel['avg_health']:.0f}, "
                                f"Rad {intel['avg_radiation']:.0f}). Rest and retreat.")
        elif self.tech_tree.get_available_construction():
            plan = "BUILD"
            self.active_plan = f"Build {self.tech_tree.get_available_construction()[0]}."
        elif (intel["alive_count"] < 12 and intel["avg_health"] > 65
              and intel["avg_hunger"] < 35 and food_days > self.doctrine.breed_food_days):
            plan = "EXPAND"
            self.active_plan = "Colony healthy. Encourage reproduction."
        else:
            plan = "BALANCED"
            target = self.tech_tree.next_research_target()
            self.active_plan = (f"Research toward {target}." if target
                                else "Stockpile and maintain.")

        if plan != self._last_plan:
            self.log(f"\U0001f9e0 Plan: {self.active_plan}")
            self.plan_age = 0
        else:
            self.plan_age += 1
        self._last_plan = plan
        return plan

    # ------------------------------------------------------------ directives
    def assign_directives(self, survivors, plan, stockpile):
        """Assign a role to every living survivor based on the plan."""
        alive = [s for s in survivors if s.health > 0]
        if not alive:
            return
        levels = self.level_conditions()
        prot = self.tech_tree.protections()

        construct = self.tech_tree.get_available_construction()
        self.tech_tree.current_project = construct[0] if construct else None

        # 1. Relocation for safety.
        free = []
        moved = 0
        for s in alive:
            s.role = "Unassigned"
            here = self.danger_for(s, s.z, levels, prot)
            best_z = min(levels, key=lambda z: self.danger_for(s, z, levels, prot))
            best = self.danger_for(s, best_z, levels, prot)
            doc = self.doctrine
            if best_z != s.z and here - best >= doc.move_threshold and s.energy > 15:
                s.role = f"Move To Z={best_z}"
                moved += 1
            elif s.health < 30 or s.energy < doc.rest_energy or (plan == "HEALTH_FOCUS" and s.radiation > 30):
                s.role = "Rest"
            else:
                free.append(s)
        if moved:
            self.log(f"⚠️ Relocating {moved} survivor(s) to safer levels.")

        if not free:
            return

        # 2. How many of each job do we need?
        n_alive = len(alive)
        stock = min(stockpile.get("water", 0), stockpile.get("biomass", 0))
        if plan in ("FORAGE_PRIORITY", "SURVIVAL", "DISASTER_RESPONSE"):
            foragers = len(free)
        else:
            # Staff foragers in proportion to how far supplies are below the
            # doctrine's target buffer (a baseline crew always forages).
            target = max(1.0, n_alive * self.doctrine.buffer_days)
            deficit = min(1.0, max(0.0, (target - stock) / target))
            foragers = max(1, math.ceil(len(free) * (0.25 + 0.65 * deficit)))
        foragers = min(foragers, len(free))

        builders = 0
        if self.tech_tree.current_project and stockpile.get("scrap", 0) > 0:
            builders = max(1, min(self.doctrine.max_builders, stockpile["scrap"] // 8))
            if plan in ("FORAGE_PRIORITY", "SURVIVAL"):
                builders = 0
        remaining = len(free) - foragers
        builders = min(builders, remaining)

        # 3. Fill jobs by gene fit.
        pool = list(free)
        pool.sort(key=lambda s: s.genes["foraging"], reverse=True)
        scarce = "biomass" if stockpile.get("biomass", 0) <= stockpile.get("water", 0) else "water"
        imbalanced = stockpile.get(scarce, 0) * 2 < max(stockpile.get("water", 0),
                                                        stockpile.get("biomass", 0))
        relocated = 0
        for s in pool[:foragers]:
            s.role = "Forage"
            s.forage_target = "supplies"
            # Send some foragers to where the scarce supply actually grows,
            # if that level is not meaningfully more dangerous.
            if imbalanced and levels[s.z][scarce] < 6 and relocated < max(1, foragers // 2):
                here = self.danger_for(s, s.z, levels, prot)
                options = [z for z in levels if z != s.z and levels[z][scarce] > 10
                           and self.danger_for(s, z, levels, prot) <= here + 0.5]
                if options and s.energy > 30:
                    target = max(options, key=lambda z: levels[z][scarce])
                    s.role = f"Move To Z={target}"
                    relocated += 1
        if relocated:
            self.log(f"🧭 Sending {relocated} forager(s) toward {scarce}.")
        pool = pool[foragers:]
        pool.sort(key=lambda s: s.genes["intelligence"], reverse=True)
        for s in pool[:builders]:
            s.role = "Construct"
        for s in pool[builders:]:
            # Scrap is the bottleneck for building: send spare hands to salvage
            # if we have a project waiting on it, otherwise research.
            if (self.tech_tree.current_project
                    and stockpile.get("scrap", 0) < self.doctrine.salvage_below):
                s.role = "Forage"
                s.forage_target = "scrap"
            elif self.tech_tree.next_research_target() is None and not self.tech_tree.current_project:
                s.role = "Forage" if s.energy > 60 else "Rest"
                s.forage_target = "supplies"
            else:
                s.role = "Research"

    # ---------------------------------------------------------------- outcome
    def check_win_lose(self, survivors, intel, stockpile):
        """Check for game-ending conditions."""
        if intel["alive_count"] == 0:
            return "EXTINCTION"
        if (self.tech_tree.all_completed() and intel["alive_count"] >= 8
                and intel["avg_health"] > 60):
            return "RESTORATION"
        return None
