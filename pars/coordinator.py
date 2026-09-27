"""
AI Coordinator Agent -- gathers intel, formulates strategic survival plans,
and assigns directives to each survivor based on their genetic traits.
"""

import random


class CoordinatorAgent:
    def __init__(self, grid, tech_tree):
        self.grid = grid
        self.tech_tree = tech_tree
        self.thought_log = []
        self.active_plan = "Initializing..."
        self.plan_age = 0
        self.turn = 0

    def gather_intel(self, survivors, stockpile):
        """Collect comprehensive colony intel for decision-making."""
        alive = [s for s in survivors if s.health > 0]
        nel = len(alive)
        intel = {
            "population": len(survivors),
            "alive_count": nel,
            "avg_health": sum(s.health for s in alive) / max(1, nel),
            "avg_hunger": sum(s.hunger for s in alive) / max(1, nel),
            "avg_radiation": sum(s.radiation for s in alive) / max(1, nel),
            "avg_energy": sum(s.energy for s in alive) / max(1, nel),
            "disaster": self.grid.current_disaster,
            "disaster_turns_left": self.grid.disaster_duration,
            "forecast": (self.grid.disaster_forecast[:3]
                          if self.grid.disaster_forecast else []),
            "scrap": stockpile.get("scrap", 0),
            "water": stockpile.get("water", 0),
            "biomass": stockpile.get("biomass", 0),
            "research_points": self.tech_tree.research_points,
            "surface_pop": sum(1 for s in alive if s.z == 0),
            "underground_pop": sum(1 for s in alive if s.z == -1),
            "mountain_pop": sum(1 for s in alive if s.z == 1),
        }
        return intel

    def formulate_plan(self, survivors, intel, stockpile):
        """Decide the colony's strategic priority for this turn."""
        self.turn += 1
        self.plan_age += 1
        self.thought_log.append(f"--- Turn {self.turn} ---")

        if intel["disaster"] != "None":
            plan = self._handle_disaster(intel)
            if plan:
                return plan

        if intel["alive_count"] <= 2:
            return self._plan_survival(intel)

        if (intel["water"] < 20 or intel["biomass"] < 20
                or intel["avg_hunger"] > 55):
            return self._plan_forage_crisis(intel)

        if intel["avg_radiation"] > 35 or intel["avg_health"] < 40:
            return self._plan_health_crisis(intel)

        if intel["research_points"] >= 20 and self._has_unlockable_tech():
            return self._plan_research(intel)

        if (intel["alive_count"] < 12 and intel["avg_health"] > 65
                and intel["avg_hunger"] < 35):
            return self._plan_expand(intel)

        return self._plan_balanced(intel)

    def _handle_disaster(self, intel):
        """Deal with active disasters: evacuate survivors to safe zones."""
        d = intel["disaster"]
        if d in ["Acid Rain", "Solar Flare"]:
            self.active_plan = (
                f"EMERGENCY: {d}! Order all survivors underground (Z=-1)."
            )
            self.plan_age = 0
            self.thought_log.append(
                "\u26a0\ufe0f ALERT: " + self.active_plan
            )
            return "EVACUATE_TO_UNDERGROUND"
        elif d == "Blizzard":
            self.active_plan = (
                "Blizzard! Mountain (Z=1) survivors move to surface."
            )
            self.plan_age = 0
            self.thought_log.append(
                "\u26a0\ufe0f ALERT: " + self.active_plan
            )
            return "EVACUATE_FROM_MOUNTAINS"
        elif d in ["Radon Leak", "Cave-In Threat"]:
            self.active_plan = (
                f"{d}! Underground unsafe. Evacuate to surface."
            )
            self.plan_age = 0
            self.thought_log.append(
                "\u26a0\ufe0f ALERT: " + self.active_plan
            )
            return "EVACUATE_FROM_UNDERGROUND"
        return None

    def _plan_survival(self, intel):
        self.active_plan = (
            f"CRITICAL: Only {intel['alive_count']} alive! "
            f"Forage NOW."
        )
        self.plan_age = 0
        return "FORAGE_WATER_BIOMASS"

    def _plan_forage_crisis(self, intel):
        self.active_plan = "Resource crisis. Foraging priority."
        self.plan_age = 0
        return "FORAGE_PRIORITY"

    def _plan_health_crisis(self, intel):
        self.active_plan = (
            f"Health crisis (Rad:{int(intel['avg_radiation'])}"
            f"%). Rest + retreat."
        )
        self.plan_age = 0
        return "HEALTH_FOCUS"

    def _plan_research(self, intel):
        """Attempt to unlock a research project, then return plan."""
        available = self.tech_tree.get_available_research()
        if available:
            target = available[0]
            if self.tech_tree.unlock_project(target):
                self.active_plan = f"Unlocked {target}! Build it."
                self.thought_log.append(
                    "\U0001f513 Tech unlocked: " + target
                )
            else:
                self.active_plan = (
                    f"Need more RP for {target}. Keep researching."
                )
        else:
            self.active_plan = (
                "All tech researched. Build remaining projects."
            )
        self.plan_age = 0
        return "RESEARCH_COMPLETE"

    def _plan_expand(self, intel):
        self.active_plan = "Colony healthy. Encourage reproduction."
        self.plan_age = 0
        return "EXPAND"

    def _plan_balanced(self, intel):
        self.active_plan = "Balanced: research, gather, rest."
        self.plan_age = 0
        return "BALANCED"

    def _has_unlockable_tech(self):
        return len(self.tech_tree.get_available_research()) > 0

    def assign_directives(self, survivors, plan, stockpile):
        """Assign a role to every living survivor based on the plan."""
        for s in survivors:
            if s.health <= 0:
                continue
            s.role = self._pick_action(s, plan)

        construct_projects = self.tech_tree.get_available_construction()
        if construct_projects:
            self.tech_tree.current_project = construct_projects[0]
            best = max(
                (s for s in survivors if s.health > 0),
                key=lambda s: s.genes["intelligence"],
                default=None                       )
            if best and stockpile.get("scrap", 0) > 0:
                best.role = "Construct"

    def _pick_action(self, s, plan):
        """Determine the best role for a single survivor."""
        if plan == "EVACUATE_TO_UNDERGROUND":
            return "Forage" if s.z == -1 else "Move To Z=-1"
        if plan == "EVACUATE_FROM_MOUNTAINS":
            return "Forage" if s.z != 1 else "Move To Z=0"
        if plan == "EVACUATE_FROM_UNDERGROUND":
            return "Rest" if s.z != -1 else "Move To Z=0"
        if plan in ("FORAGE_WATER_BIOMASS", "FORAGE_PRIORITY"):
            return "Forage"
        if plan == "HEALTH_FOCUS":
            return "Rest" if (s.health < 40 or s.radiation > 30) else "Forage"
        if plan == "RESEARCH_COMPLETE":
            return ("Construct"
                    if s.genes["intelligence"] > 1.1
                    else "Forage")
        if plan in ("EXPAND", "BALANCED"):
            roll = random.random()
            if roll < 0.4:
                return "Forage"
            elif roll < 0.8:
                return "Research"
            return "Rest"
        return "Forage"

    def check_win_lose(self, survivors, intel, stockpile):
        """Check for game-ending conditions."""
        if intel["alive_count"] == 0:
            return "EXTINCTION"

        all_done = all(
            v["completed"] for v in self.tech_tree.projects.values()
        )
        if all_done and intel["alive_count"] >= 8 and intel["avg_health"] > 60:
            return "RESTORATION"

        return None
