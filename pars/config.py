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
    "normal": Difficulty("normal", 0.74, 1.15, 0.9, 1.1, 25, (2, 4), 0.5),
    "hard": Difficulty("hard", 0.7, 1.25, 0.8, 1.2, 20, (2, 5), 0.6),
    "nightmare": Difficulty("nightmare", 0.65, 1.4, 0.65, 1.35, 15, (3, 6), 0.7),
}

DEFAULT_DIFFICULTY = "normal"


def get_difficulty(name_or_obj=None):
    if isinstance(name_or_obj, Difficulty):
        return name_or_obj
    return DIFFICULTIES[name_or_obj or DEFAULT_DIFFICULTY]


@dataclass(frozen=True)
class Doctrine:
    """The player's strategic lever: how the AI Coordinator weighs risk,
    supplies, construction and growth."""
    name: str
    description: str
    move_threshold: float     # HP/turn improvement needed to relocate
    buffer_days: float        # supply stock (turns per survivor) foragers aim for
    max_builders: int         # cap on simultaneous builders
    breed_food_days: float    # supply buffer (turns) required to EXPAND
    max_births: int           # births per turn while expanding
    rest_energy: float        # below this energy a survivor rests
    salvage_below: int        # spare hands salvage scrap while stock is under this


DOCTRINES = {
    "balanced": Doctrine("balanced", "Even-handed: react to danger early, keep a healthy buffer, build steadily.",
                         1.2, 10.0, 3, 5.0, 2, 30.0, 10),
    "cautious": Doctrine("cautious", "Safety first: flee any hint of danger, hoard supplies. Safest, slowest.",
                         0.8, 13.0, 2, 10.0, 1, 35.0, 8),
    "industrious": Doctrine("industrious", "Tech rush: salvage hard, many builders, lean supplies. Fastest, riskier.",
                            1.5, 7.0, 5, 6.0, 1, 25.0, 40),
    "expansionist": Doctrine("expansionist", "Breed early and often; numbers over tech. Big colonies, slower builds.",
                             1.2, 10.0, 3, 3.0, 3, 30.0, 10),
}

DEFAULT_DOCTRINE = "balanced"


def get_doctrine(name_or_obj=None):
    if isinstance(name_or_obj, Doctrine):
        return name_or_obj
    return DOCTRINES[name_or_obj or DEFAULT_DOCTRINE]
