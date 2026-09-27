# Project PARS

**Post-disaster Evolutionary Survival Coordinator**

A 3D evolutionary survival simulator with genetic survivor agents, a strategic AI Coordinator, and a Rich-powered CLI dashboard.

## Lore

The world as you knew it is gone. A catastrophic event  radiant, seismic, biochemical  shattered civilization. Small bands of survivors emerge from the rubble, clinging to life across three elevation zones:

- **Z=-1: Underground**  Dark caves with bunker debris, underground aquifers, but also radon leaks and cave-in risks.
- **Z=0: Surface**  The scorched but habitable surface, with scattered scrap, biomass, and water.
- **Z=1: Mountains**  Cold high-altitude refuges, exposed to cosmic radiation but offering alpine resources.

Survivors evolve to survive: each offspring inherits and mutates genetic traits (speed, foraging, cold resistance, radiation resistance, intelligence). An AI Coordinator agent monitors the colony, formulates strategic plans, and assigns roles to every survivor.

Can you guide your colony from the brink of extinction to RESTORATION? Or will the wasteland claim them all?

## Features

- **3D Grid Environment**: X/Y/Z with unique resource profiles, temperatures, and hazards per elevation
- **Genetic Evolution**: 5 inheritable traits with mutation during reproduction
- **Dynamic Disasters**: Acid Rain, Blizzard, Solar Flare, Radon Leak, Cave-In Threat
- **Tech Tree**: 6 researchable projects (Underground Reinforcement, Geothermal Insulation, Water Filtration Rig, Automated Hydroponics, Cosmic Ray Deflector, Sub-space Radio Beacon)
- **AI Coordinator**: Priority-based strategic planning (disaster response > survival > resources > health > research > expansion
- **Rich Dashboard**: Real-time 3-layer ASCII maps, colony stats, survivor table, tech tree panel, coordinator logs

## Installation

```bash
# Clone the repository
git clone https://github.com/Deep-De-coder/pars-simulator.git
cd pars-simulator

# Install dependency
pip install rich

# Run
python main.py
```

## Usage

```bash
# Quick demo with defaults
python main.py

# Custom grid and population
python main.py --width 8 --height 8 --population 10 --seed 42

# Fast simulation with 50 turns and 100ms delay
python main.py --max-turns 50 --delay 100

# Reproducible run with fixed seed
python main.py --seed 12345

# Full options
python main.py --width 6 --height 6 --population 8  seed 42 -delay 200 --max-turns 100
```

### Command-Line Options

| Option | Type | Default | Description |
|-|---|---|---|
| `--width` | int | 5 | Grid width (X axis) |
| `--height` | int | 5 | Grid height ( axis) |
| `--population` | int | 6 | Starting survivors |
| `--seed` | int | random | Random seed for reproducibility |
| `--delay` | int | 500 | Turn delay in milliseconds |
| `--max-turns` | int | 0 | Maximum turns (0 = unlimited) |

## Screenshots Description

When running, the terminal displays:

1. **Header Banner**: PARS title with current disaster status and 3-turn forecast
2. **3D Environment Layers**: Three column of ASCII maps (Underground, Surface, Mountains) showing survivors ( ) and resources ( , , )
3. **Colony Stats Panel**: Turn, population, average health/hunger/radiation/energy, stockpile levels, research points, population per Z level
4. **Tech Tree Panel*: 6 reseach projects with progress bars (Locked  Unlocked Building  Completed)
5. **Survivor Table**: A per-survivor view with name, position, health, genetics, assigned role, and status
6. **Coordinator Log**: Last 8 AI coordinator thought entries
7. **Footer**: Active strategic plan

## Win/Lose Conditions

- **EXTINCTION**: All survivors die (heath reaches 0)
- **RESTORATION**: All 6 tech projects completed, 8+ survivors aliv, average health above 60%

## Project Structure

```
pars-simulator/
   main.py              # CLI entry point
     pars/                  # Core package
       __init__.py          # Package init
       environment.py       # 3D grid, disasters, resources
       survivor.py         # Survivor agents with genes and actions
       coordinator.py        AI Coordinator Agent
       tech.py             # Tech tree
       dashboard.py          Rich-powered CLI disply
   README.md               # This file
    .gitignore             # Git ignore rules
```

## License

MIT