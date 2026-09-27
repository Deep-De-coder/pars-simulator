"""
Dashboard — Rich-powered terminal visualizer for the PARS 3D simulation.
Renders multi-level ASCII maps, stats panels, and coordinator logs.
"""

from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.layout import Layout
from rich.text import Text
from rich.live import Live
from rich import box

console = Console()

LEVEL_LABELS = {
    -1: "🕳️  UNDERGROUND (Z=-1)",
    0:  "🌍 SURFACE (Z=0)",
    1:  "🏔️  MOUNTAINS (Z=1)",
}

LEVEL_COLORS = {
    -1: "dark_gray",
    0:  "green",
    1:  "cyan",
}

DISASTER_ICONS = {
    "None": "☀️  Calm",
    "Acid Rain": "☣️  ACID RAIN",
    "Blizzard": "❄️  BLIZZARD",
    "Solar Flare": "☢️  SOLAR FLARE",
    "Radon Leak": "💀 RADON LEAK",
    "Cave-In Threat": "⛏️  CAVE-IN RISK",
}


def render_level_map(grid, z, survivors, width, height):
    """Render a single Z-level as an ASCII grid with survivors and resources."""
    lines = []
    header = LEVEL_LABELS.get(z, f"Z={z}")
    color = LEVEL_COLORS.get(z, "white")
    lines.append(f"[bold {color}]{header}[/bold {color}]")

    # Build a grid with resource info and survivors
    for y in range(height):
        row_parts = []
        for x in range(width):
            cell = grid.get_cell(x, y, z)
            if not cell:
                row_parts.append("   ")
                continue
            # Find survivors at this coordinate
            survivors_here = [s for s in survivors if s.x == x and s.y == y and s.z == z and s.health > 0]
            if survivors_here:
                s = survivors_here[0]
                if s.status in ("Starving", "Sick", "Freezing", "Poisoned"):
                    icon = "⚠"
                elif s.health < 40:
                    icon = "⚕"
                else:
                    icon = "◉"
                row_parts.append(f"[bold yellow]{icon}[/bold yellow] ")
            else:
                # Show resource or empty tile
                if cell["biomass"] > 10:
                    row_parts.append("[green]♣ [/green]")
                elif cell["water"] > 10:
                    row_parts.append("[blue]≈ [/blue]")
                elif cell["scrap"] > 10:
                    row_parts.append("[grey50]■ [/grey50]")
                else:
                    row_parts.append("· ")
        lines.append("".join(row_parts))
    return "\n".join(lines)


def render_stats_panel(intel, stockpile, tech_tree, survivors, turn):
    """Build the statistics panel showing colony vitals and resources."""
    table = Table(box=box.SIMPLE_HEAVY, show_header=False, expand=True)
    table.add_column("Metric", style="bold cyan", width=22)
    table.add_column("Value", style="white")

    table.add_row("Turn", str(turn))
    table.add_row("Population", f"{intel['alive_count']} alive / {intel['population']} total")
    table.add_row("Avg Health", f"{intel['avg_health']:.1f}%")
    table.add_row("Avg Hunger", f"{intel['avg_hunger']:.1f}%")
    table.add_row("Avg Radiation", f"{intel['avg_radiation']:.1f}%")
    table.add_row("Avg Energy", f"{intel['avg_energy']:.1f}%")
    table.add_row("─" * 30, "─" * 10)
    table.add_row("Scrap", f"{stockpile['scrap']}")
    table.add_row("Water", f"{stockpile['water']}")
    table.add_row("Biomass", f"{stockpile['biomass']}")
    table.add_row("Research Points", f"{tech_tree.research_points}")
    table.add_row("─" * 30, "─" * 10)
    table.add_row("Surface (Z=0)", f"{intel['surface_pop']} survivors")
    table.add_row("Underground (Z=-1)", f"{intel['underground_pop']} survivors")
    table.add_row("Mountains (Z=1)", f"{intel['mountain_pop']} survivors")
    return Panel(table, title="📊 COLONY STATS", border_style="green")


def render_survivor_table(survivors):
    """Build a compact table of all living survivors and their status."""
    table = Table(box=box.SIMPLE, show_header=True, expand=True)
    table.add_column("Name", style="bold", width=14)
    table.add_column("Z", width=4)
    table.add_column("HP", width=5)
    table.add_column("⚡", width=5)
    table.add_column("🍖", width=5)
    table.add_column("☢", width=5)
    table.add_column("Speed", width=7)
    table.add_column("Forag", width=7)
    table.add_column("Cold", width=7)
    table.add_column("RadR", width=7)
    table.add_column("Int", width=7)
    table.add_column("Role", width=12)
    table.add_column("Status", width=16)

    for s in sorted(survivors, key=lambda x: x.health, reverse=True):
        if s.health <= 0:
            continue
        hp_color = "red" if s.health < 30 else ("yellow" if s.health < 60 else "green")
        rad_color = "red" if s.radiation > 50 else ("yellow" if s.radiation > 25 else "white")
        table.add_row(
            s.name,
            str(s.z),
            f"[{hp_color}]{s.health:.0f}[/{hp_color}]",
            f"{s.energy:.0f}",
            f"{s.hunger:.0f}",
            f"[{rad_color}]{s.radiation:.0f}[/{rad_color}]",
            f"{s.genes['speed']:.2f}",
            f"{s.genes['foraging']:.2f}",
            f"{s.genes['cold_resistance']:.2f}",
            f"{s.genes['rad_resistance']:.2f}",
            f"{s.genes['intelligence']:.2f}",
            s.role,
            s.status,
        )
    return Panel(table, title="🧬 SURVIVORS", border_style="yellow")


def render_tech_panel(tech_tree):
    """Build a panel showing tech progress."""
    table = Table(box=box.SIMPLE, show_header=True, expand=True)
    table.add_column("Tech", style="bold", width=28)
    table.add_column("Progress", width=14)
    table.add_column("Status", width=12)

    for name, proj in tech_tree.projects.items():
        if proj["completed"]:
            status = "[green]✓ Complete[/green]"
            progr = "──"
        elif proj["unlocked"]:
            pct = int((proj["progress"] / max(1, proj["cost"])) * 100)
            status = f"[yellow]Building {pct}%[/yellow]"
            progr = f"{proj['progress']}/{proj['cost']}"
        else:
            status = f"[grey50]Research: {proj['research_cost']} RP[/grey50]"
            progr = "──"
        table.add_row(name, progr, status)
    return Panel(table, title="🔬 TECH TREE", border_style="magenta")


def build_layout(grid, survivors, intel, stockpile, tech_tree, coordinator, turn):
    """Assemble the full Rich dashboard layout."""
    layout = Layout()
    layout.split_column(
        Layout(name="header", size=3),
        Layout(name="body"),
        Layout(name="footer", size=3),
    )
    layout["body"].split_row(
        Layout(name="left", ratio=2),
        Layout(name="right", ratio=3),
    )
    layout["left"].split_column(
        Layout(name="maps"),
        Layout(name="logs"),
    )
    layout["right"].split_column(
        Layout(name="stats"),
        Layout(name="tech"),
        Layout(name="survivors"),
    )

    # Header
    disaster_str = DISASTER_ICONS.get(grid.current_disaster, grid.current_disaster)
    disaster_info = f" | {disaster_str}"
    if grid.disaster_duration > 0:
        disaster_info += f" ({grid.disaster_duration}t left)"
    forecast = " → ".join(DISASTER_ICONS.get(d, d) for d in grid.disaster_forecast[:3])
    header_text = Text()
    header_text.append("🔨 PARS — Post-disaster Evolutionary Survival Coordinator", style="bold white on dark_red")
    header_text.append(f"\nActive: {disaster_info}  |  Forecast: {forecast}")
    layout["header"].update(Panel(header_text, border_style="red"))

    # Maps: render 3 level slices
    map_panels = []
    for z in grid.z_levels:
        map_str = render_level_map(grid, z, survivors, grid.width, grid.height)
        map_panels.append(map_str)
    layout["maps"].update(Panel("\n\n".join(map_panels), title="🗺  3D ENVIRONMENT LAYERS", border_style="blue"))

    # Coordinator logs (last 6 entries)
    log_lines = coordinator.thought_log[-8:]
    log_text = "\n".join(log_lines) if log_lines else "No logs yet..."
    layout["logs"].update(Panel(log_text, title="🧠 COORDINATOR LOG", border_style="yellow"))

    # Stats
    layout["stats"].update(render_stats_panel(intel, stockpile, tech_tree, survivors, turn))
    layout["tech"].update(render_tech_panel(tech_tree))
    layout["survivors"].update(render_survivor_table(survivors))

    # Footer
    footer_text = Text()
    footer_text.append(f"Plan: {coordinator.active_plan}", style="bold cyan")
    layout["footer"].update(Panel(footer_text, border_style="cyan"))

    return layout


def render_frame(grid, survivors, intel, stockpile, tech_tree, coordinator, turn):
    """Render one complete frame to the terminal (non-live fallback)."""
    layout = build_layout(grid, survivors, intel, stockpile, tech_tree, coordinator, turn)
    console.clear()
    console.print(layout)


class Dashboard:
    """Flicker-free live dashboard; use as a context manager and pass as the
    simulation renderer."""

    def __init__(self):
        self._live = Live(console=console, screen=True, auto_refresh=False)

    def __enter__(self):
        self._live.__enter__()
        return self

    def __exit__(self, *exc):
        return self._live.__exit__(*exc)

    def __call__(self, sim):
        layout = build_layout(sim.grid, sim.survivors, sim.last_intel,
                              sim.stockpile, sim.tech_tree, sim.coordinator,
                              sim.turn)
        self._live.update(layout, refresh=True)
