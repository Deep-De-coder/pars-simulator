class TechTree:
    def __init__(self):
        self.research_points = 0
        self.projects = {
            "Underground Reinforcement": {
                "unlocked": False,
                "research_cost": 20,
                "cost": 40,
                "progress": 0,
                "completed": False,
                "description": "Reinforces cave walls: -75% cave-in chance and -50% radon toxicity at Z = -1.",
                "type": "safety"
            },
            "Geothermal Insulation": {
                "unlocked": False,
                "research_cost": 30,
                "cost": 50,
                "progress": 0,
                "completed": False,
                "description": "Heated shelters: survivors feel +12 C warmer everywhere.",
                "type": "survival"
            },
            "Water Filtration Rig": {
                "unlocked": False,
                "research_cost": 40,
                "cost": 60,
                "progress": 0,
                "completed": False,
                "description": "Enables passive clean water generation (adds +5 water to stockpile per tick).",
                "type": "resource"
            },
            "Automated Hydroponics": {
                "unlocked": False,
                "research_cost": 50,
                "cost": 80,
                "progress": 0,
                "completed": False,
                "description": "Allows farming food in bunkers, generating +5 biomass/food per tick.",
                "type": "resource"
            },
            "Cosmic Ray Deflector": {
                "unlocked": False,
                "research_cost": 60,
                "cost": 100,
                "progress": 0,
                "completed": False,
                "description": "Halves radiation exposure on every level.",
                "type": "safety"
            },
            "Sub-space Radio Beacon": {
                "unlocked": False,
                "research_cost": 80,
                "cost": 150,
                "progress": 0,
                "completed": False,
                "description": "Pings the wasteland to attract new survivors, stabilizing the population.",
                "type": "repopulation"
            }
        }
        self.current_project = None

    def unlock_project(self, name):
        """Unlock a project for construction using accumulated research points."""
        if name in self.projects and not self.projects[name]["unlocked"]:
            cost = self.projects[name]["research_cost"]
            if self.research_points >= cost:
                self.research_points -= cost
                self.projects[name]["unlocked"] = True
                return True
        return False

    def get_available_research(self):
        """Return names of projects that can be researched/unlocked."""
        return [k for k, v in self.projects.items() if not v["unlocked"]]

    def get_available_construction(self):
        """Return names of projects that are unlocked but not completed."""
        return [k for k, v in self.projects.items() if v["unlocked"] and not v["completed"]]

    def next_research_target(self):
        """The cheapest project still locked, or None."""
        locked = self.get_available_research()
        if not locked:
            return None
        return min(locked, key=lambda k: self.projects[k]["research_cost"])

    def try_unlock_next(self):
        """Unlock the cheapest locked project if affordable; return its name."""
        target = self.next_research_target()
        if target and self.unlock_project(target):
            return target
        return None

    def is_completed(self, name):
        return self.projects[name]["completed"]

    def all_completed(self):
        return all(p["completed"] for p in self.projects.values())

    def completed_count(self):
        return sum(p["completed"] for p in self.projects.values())

    def protections(self):
        """Per-survivor hazard mitigation granted by completed tech."""
        prot = {}
        if self.is_completed("Underground Reinforcement"):
            prot["cave_in"] = 0.75
            prot["radon"] = 0.5
        if self.is_completed("Geothermal Insulation"):
            prot["cold"] = 12.0
        if self.is_completed("Cosmic Ray Deflector"):
            prot["radiation"] = 0.5
        return prot

    def update_completion_states(self):
        """Check progress and mark completed projects."""
        newly_completed = []
        for name, proj in self.projects.items():
            if proj["unlocked"] and not proj["completed"] and proj["progress"] >= proj["cost"]:
                proj["completed"] = True
                newly_completed.append(name)
        return newly_completed
