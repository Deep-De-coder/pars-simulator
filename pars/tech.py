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
                "description": "Reinforces cave walls, reducing Cave-In risk and radon leak damage at Z = -1.",
                "type": "safety"
            },
            "Geothermal Insulation": {
                "unlocked": False,
                "research_cost": 30,
                "cost": 50,
                "progress": 0,
                "completed": False,
                "description": "Protects survivors from freezing temperatures on Mountains (Z = 1) and Surface (Z = 0).",
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
                "description": "Significantly decreases Radiation exposure across all levels (especially Z = 1).",
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

    def update_completion_states(self):
        """Check progress and mark completed projects."""
        newly_completed = []
        for name, proj in self.projects.items():
            if proj["unlocked"] and not proj["completed"] and proj["progress"] >= proj["cost"]:
                proj["completed"] = True
                newly_completed.append(name)
        return newly_completed
