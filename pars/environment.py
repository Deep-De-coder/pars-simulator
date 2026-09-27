import random

class Grid3D:
    def __init__(self, width=5, height=5, z_levels=(-1, 0, 1)):
        self.width = width
        self.height = height
        self.z_levels = list(z_levels)  # -1: Underground, 0: Surface, 1: Mountains
        self.grid = {}
        
        # Initialize nodes
        for z in self.z_levels:
            for y in range(self.height):
                for x in range(self.width):
                    self.grid[(x, y, z)] = {
                        "scrap": 0,
                        "biomass": 0,
                        "water": 0,
                        "radiation": 0,
                        "temperature": 15,  # degrees C
                        "toxicity": 0,
                        "cave_in_risk": 0 if z != -1 else 10,
                    }
        
        # Initial resource seeding
        self.seed_resources()
        
        # Dynamic weather/hazard state
        self.current_disaster = "None"
        self.disaster_duration = 0
        self.disaster_forecast = []
        self.generate_forecast()

    def seed_resources(self):
        """Seed resources differently per elevation level (Z)."""
        for (x, y, z), cell in self.grid.items():
            if z == 0:  # Surface
                cell["scrap"] = random.randint(10, 30)
                cell["biomass"] = random.randint(15, 40)
                cell["water"] = random.randint(10, 30)
                cell["radiation"] = random.randint(0, 15)
                cell["temperature"] = 20
                cell["toxicity"] = random.randint(0, 10)
            elif z == -1:  # Underground Caves
                cell["scrap"] = random.randint(5, 15)       # Old bunker debris
                cell["biomass"] = random.randint(0, 5)        # Mushrooms/fungi only
                cell["water"] = random.randint(15, 40)       # Underground aquifers
                cell["radiation"] = random.randint(5, 25)     # Radon/minerals
                cell["temperature"] = 12                     # Insulated/stable
                cell["toxicity"] = random.randint(0, 5)
            elif z == 1:  # Mountains/Cliffs
                cell["scrap"] = random.randint(0, 10)        # Wind-blown wreckage
                cell["biomass"] = random.randint(5, 15)       # Pine/lichens
                cell["water"] = random.randint(0, 10)        # Frost/ice
                cell["radiation"] = random.randint(20, 40)    # Cosmic radiation (less atmosphere protection)
                cell["temperature"] = -5                     # Cold
                cell["toxicity"] = random.randint(0, 5)

    DISASTERS = ("Acid Rain", "Blizzard", "Solar Flare", "Radon Leak", "Cave-In Threat")
    CALM_WEIGHT = 0.8  # chance a calm turn stays calm

    def _roll_weather(self):
        if random.random() < self.CALM_WEIGHT:
            return "None"
        return random.choice(self.DISASTERS)

    def generate_forecast(self, length=5):
        """Fill the forecast queue. Entry i is what happens on the (i+1)-th
        calm turn from now, so the forecast is accurate: it only advances
        while no disaster is active."""
        while len(self.disaster_forecast) < length:
            self.disaster_forecast.append(self._roll_weather())

    def tick(self):
        """Advance environment state, applying natural decay and active disaster hazards."""
        if self.disaster_duration > 0:
            self.disaster_duration -= 1
            if self.disaster_duration == 0:
                self.current_disaster = "None"
        elif self.current_disaster == "None":
            upcoming = self.disaster_forecast.pop(0)
            self.generate_forecast()
            if upcoming != "None":
                self.current_disaster = upcoming
                self.disaster_duration = random.randint(2, 4)

        # Apply disaster impacts across layers
        for (x, y, z), cell in self.grid.items():
            # Slowly regenerate natural biomass on surface/mountains if not hit by acid rain
            if z == 0 and cell["biomass"] < 100 and self.current_disaster != "Acid Rain":
                cell["biomass"] += random.randint(1, 3)
            elif z == 1 and cell["biomass"] < 40:
                cell["biomass"] += random.choice([0, 1])
            elif z == -1 and cell["biomass"] < 10:
                cell["biomass"] += random.choice([0, 0, 1])  # fungi

            # Water: aquifers recharge underground, rain refills the
            # surface, snowmelt feeds the mountains (more during blizzards).
            if z == -1 and cell["water"] < 40:
                cell["water"] += random.randint(0, 2)
            elif z == 0 and cell["water"] < 30 and self.current_disaster in ("None", "Blizzard"):
                cell["water"] += random.randint(0, 2)
            elif z == 1 and cell["water"] < 20:
                cell["water"] += random.randint(1, 3) if self.current_disaster == "Blizzard" else random.choice([0, 1])

            # Scrap: shifting ruins slowly expose more salvage.
            if cell["scrap"] < 30 and random.random() < 0.08:
                cell["scrap"] += random.randint(1, 3)

            # Apply disaster consequences
            if self.current_disaster == "Acid Rain":
                if z == 0:  # Surface directly hit
                    cell["toxicity"] = min(100, cell["toxicity"] + random.randint(15, 30))
                    cell["biomass"] = max(0, cell["biomass"] - random.randint(5, 15))
                elif z == 1:  # Runoff affects mountains moderately
                    cell["toxicity"] = min(100, cell["toxicity"] + random.randint(5, 15))
                # Z = -1 is protected underground

            elif self.current_disaster == "Blizzard":
                if z == 1:  # Mountains hit hardest
                    cell["temperature"] = max(-40, cell["temperature"] - random.randint(15, 25))
                elif z == 0:  # Surface hit hard
                    cell["temperature"] = max(-20, cell["temperature"] - random.randint(10, 18))
                elif z == -1:  # Underground temperature remains insulated
                    cell["temperature"] = max(5, cell["temperature"] - random.randint(1, 2))

            elif self.current_disaster == "Solar Flare":
                if z == 1:  # High elevation exposed to severe cosmic rays
                    cell["radiation"] = min(100, cell["radiation"] + random.randint(20, 40))
                elif z == 0:  # Surface heavily irradiated
                    cell["radiation"] = min(100, cell["radiation"] + random.randint(15, 30))
                # Z = -1 is shielded underground

            elif self.current_disaster == "Radon Leak":
                if z == -1:  # Heavy toxic gas leaks in the caves
                    cell["toxicity"] = min(100, cell["toxicity"] + random.randint(25, 50))
                # Z = 0 and Z = 1 are unaffected

            elif self.current_disaster == "Cave-In Threat":
                if z == -1:
                    cell["cave_in_risk"] = min(100, cell["cave_in_risk"] + random.randint(20, 40))

            # Environmental recovery / dissipation over time
            if self.current_disaster != "Acid Rain":
                cell["toxicity"] = max(0 if z == -1 else 5, cell["toxicity"] - random.randint(2, 5))
            if self.current_disaster != "Solar Flare":
                cell["radiation"] = max(10 if z == 1 else (5 if z == 0 else 15), cell["radiation"] - random.randint(1, 4))
            if self.current_disaster != "Blizzard":
                # Temperature slowly reverts to normal levels
                target_temp = 20 if z == 0 else (12 if z == -1 else -5)
                if cell["temperature"] < target_temp:
                    cell["temperature"] = min(target_temp, cell["temperature"] + random.randint(1, 3))
                elif cell["temperature"] > target_temp:
                    cell["temperature"] = max(target_temp, cell["temperature"] - random.randint(1, 3))
            if self.current_disaster != "Cave-In Threat" and z == -1:
                cell["cave_in_risk"] = max(5, cell["cave_in_risk"] - random.randint(3, 7))

    def get_cell(self, x, y, z):
        return self.grid.get((x, y, z))
