import random

from pars.config import get_difficulty


def _scaled(lo, hi, mult):
    """randint(lo, hi) scaled by mult, with stochastic rounding so small
    multipliers still average out correctly."""
    v = random.randint(lo, hi) * mult
    base = int(v)
    return base + (1 if random.random() < v - base else 0)


class Grid3D:
    def __init__(self, width=5, height=5, z_levels=(-1, 0, 1), difficulty=None):
        self.difficulty = get_difficulty(difficulty)
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
        self.turn = 0
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
    @property
    def escalation(self):
        """Multiplier >= 1 that grows as the world deteriorates over time."""
        return 1.0 + self.difficulty.escalation * (self.turn / 50.0)

    def _roll_weather(self):
        # Escalation eats into the calm probability as well as intensity.
        calm = 1.0 - (1.0 - self.difficulty.calm_weight) * self.escalation
        if random.random() < max(0.3, calm):
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
        self.turn += 1
        if self.disaster_duration > 0:
            self.disaster_duration -= 1
            if self.disaster_duration == 0:
                self.current_disaster = "None"
        elif self.current_disaster == "None":
            upcoming = self.disaster_forecast.pop(0)
            self.generate_forecast()
            if upcoming != "None":
                self.current_disaster = upcoming
                self.disaster_duration = random.randint(*self.difficulty.duration)

        regen = self.difficulty.regen
        hit = self.difficulty.intensity * self.escalation

        # Apply disaster impacts across layers
        for (x, y, z), cell in self.grid.items():
            # Slowly regenerate natural biomass on surface/mountains if not hit by acid rain
            if z == 0 and cell["biomass"] < 60 and self.current_disaster != "Acid Rain":
                cell["biomass"] += _scaled(0, 2, regen)
            elif z == 1 and cell["biomass"] < 40:
                cell["biomass"] += _scaled(0, 1, regen)
            elif z == -1 and cell["biomass"] < 10:
                cell["biomass"] += _scaled(0, 1, regen * 0.5)  # fungi

            # Water: aquifers recharge underground, rain refills the
            # surface, snowmelt feeds the mountains (more during blizzards).
            if z == -1 and cell["water"] < 40:
                cell["water"] += _scaled(0, 2, regen)
            elif z == 0 and cell["water"] < 30 and self.current_disaster in ("None", "Blizzard"):
                cell["water"] += _scaled(0, 2, regen)
            elif z == 1 and cell["water"] < 20:
                cell["water"] += _scaled(1, 3, regen) if self.current_disaster == "Blizzard" else _scaled(0, 1, regen)

            # Scrap: shifting ruins slowly expose more salvage.
            if cell["scrap"] < 30 and random.random() < 0.08 * regen:
                cell["scrap"] += random.randint(1, 3)

            # Apply disaster consequences
            if self.current_disaster == "Acid Rain":
                if z == 0:  # Surface directly hit
                    cell["toxicity"] = min(100, cell["toxicity"] + _scaled(15, 30, hit))
                    cell["biomass"] = max(0, cell["biomass"] - random.randint(5, 15))
                elif z == 1:  # Runoff affects mountains moderately
                    cell["toxicity"] = min(100, cell["toxicity"] + _scaled(5, 15, hit))
                # Z = -1 is protected underground

            elif self.current_disaster == "Blizzard":
                if z == 1:  # Mountains hit hardest
                    cell["temperature"] = max(-40, cell["temperature"] - _scaled(15, 25, hit))
                elif z == 0:  # Surface hit hard
                    cell["temperature"] = max(-20, cell["temperature"] - _scaled(10, 18, hit))
                elif z == -1:  # Underground temperature remains insulated
                    cell["temperature"] = max(5, cell["temperature"] - _scaled(1, 2, hit))

            elif self.current_disaster == "Solar Flare":
                if z == 1:  # High elevation exposed to severe cosmic rays
                    cell["radiation"] = min(100, cell["radiation"] + _scaled(20, 40, hit))
                elif z == 0:  # Surface heavily irradiated
                    cell["radiation"] = min(100, cell["radiation"] + _scaled(15, 30, hit))
                # Z = -1 is shielded underground

            elif self.current_disaster == "Radon Leak":
                if z == -1:  # Heavy toxic gas leaks in the caves
                    cell["toxicity"] = min(100, cell["toxicity"] + _scaled(25, 50, hit))
                # Z = 0 and Z = 1 are unaffected

            elif self.current_disaster == "Cave-In Threat":
                if z == -1:
                    cell["cave_in_risk"] = min(100, cell["cave_in_risk"] + _scaled(20, 40, hit))

            # Environmental recovery: hazards decay toward each level's
            # baseline (proportional, so spikes fade with a ~4 turn
            # half-life), except on levels the active disaster is hitting.
            d = self.current_disaster
            tox_hit = (d == "Acid Rain" and z >= 0) or (d == "Radon Leak" and z == -1)
            if not tox_hit:
                cell["toxicity"] = self._decay(cell["toxicity"], 0 if z == -1 else 5)
            if not (d == "Solar Flare" and z >= 0):
                cell["radiation"] = self._decay(cell["radiation"], self.RAD_FLOOR[z])
            if not (d == "Blizzard" and z >= 0):
                target_temp = self.BASE_TEMP[z]
                if cell["temperature"] < target_temp:
                    cell["temperature"] = min(target_temp, cell["temperature"] + random.randint(2, 4))
                elif cell["temperature"] > target_temp:
                    cell["temperature"] = max(target_temp, cell["temperature"] - random.randint(1, 3))
            if d != "Cave-In Threat" and z == -1:
                cell["cave_in_risk"] = self._decay(cell["cave_in_risk"], 5)

    RAD_FLOOR = {-1: 12, 0: 5, 1: 10}
    BASE_TEMP = {-1: 12, 0: 20, 1: -5}

    @staticmethod
    def _decay(value, floor, rate=0.85):
        if value <= floor:
            return value
        return max(floor, int(floor + (value - floor) * rate) - random.randint(1, 3))

    def get_cell(self, x, y, z):
        return self.grid.get((x, y, z))
