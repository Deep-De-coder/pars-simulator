"""Difficulty presets. Every tunable that changes how hard a run is lives here."""

from dataclasses import dataclass


@dataclass(frozen=True)
class Difficulty:
    name: str
    calm_weight: float        # chance a calm turn stays calm
    intensity: float          # multiplier on disaster hazard increments
    regen: float              # multiplier on natural resource regeneration
    tech_cost: float          # multiplier on research and build costs
    starting_stock: int       # initial water and biomass
    duration: tuple           # (min, max) disaster length in turns
    escalation: float         # extra disaster intensity/frequency per 50 turns


DIFFICULTIES = {
    "easy": Difficulty("easy", 0.82, 0.9, 1.15, 0.9, 40, (2, 3), 0.2),
    "normal": Difficulty("normal", 0.75, 1.1, 0.9, 1.1, 25, (2, 4), 0.4),
    "hard": Difficulty("hard", 0.72, 1.2, 0.8, 1.2, 20, (2, 5), 0.4),
    "nightmare": Difficulty("nightmare", 0.65, 1.4, 0.6, 1.4, 15, (3, 6), 0.5),
}

DEFAULT_DIFFICULTY = "normal"


def get_difficulty(name_or_obj=None):
    if isinstance(name_or_obj, Difficulty):
        return name_or_obj
    return DIFFICULTIES[name_or_obj or DEFAULT_DIFFICULTY]
