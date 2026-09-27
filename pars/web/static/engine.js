/*
 * PARS browser engine: a JavaScript port of the Python simulation
 * (pars/environment.py, survivor.py, tech.py, coordinator.py,
 * simulation.py, report.py). It lets the 3D page run with no server, for
 * example as a hosted page. The Python package stays the reference
 * implementation; keep rule changes in sync (tests/test_js_engine.py
 * compares the two statistically).
 *
 * Exposes a global `PARS` (and module.exports under Node) with
 * createGame(opts) -> { state(), step(n), command(cmd), new(opts) }
 * returning the same JSON shape as pars/web/server.py.
 */
(function (root) {
  "use strict";

  // ------------------------------------------------------------ random
  // Seeded PRNG (mulberry32). Sequences differ from CPython's, so a given
  // seed plays out differently than in the Python engine.
  function makeRng(seed) {
    let a = (seed === null || seed === undefined) ? (Math.random() * 2 ** 32) >>> 0 : (seed >>> 0) ^ 0x9e3779b9;
    const random = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return {
      random,
      randint: (lo, hi) => lo + Math.floor(random() * (hi - lo + 1)),
      uniform: (lo, hi) => lo + random() * (hi - lo),
      choice: (arr) => arr[Math.floor(random() * arr.length)],
      shuffle(arr) {
        for (let i = arr.length - 1; i > 0; i--) {
          const j = Math.floor(random() * (i + 1));
          [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
      },
    };
  }
  let R = makeRng(1);

  const round2 = (v) => Math.round(v * 100) / 100;
  const argmax = (items, key) => items.reduce((best, it) => (key(it) > key(best) ? it : best), items[0]);
  const argmin = (items, key) => items.reduce((best, it) => (key(it) < key(best) ? it : best), items[0]);

  // ------------------------------------------------------------ config
  const mkDiff = (name, calm_weight, intensity, regen, tech_cost, starting_stock, duration, escalation) =>
    ({ name, calm_weight, intensity, regen, tech_cost, starting_stock, duration, escalation });
  const DIFFICULTIES = {
    easy: mkDiff("easy", 0.82, 0.9, 1.15, 0.9, 40, [2, 3], 0.2),
    normal: mkDiff("normal", 0.74, 1.15, 0.9, 1.1, 25, [2, 4], 0.5),
    hard: mkDiff("hard", 0.7, 1.25, 0.8, 1.2, 20, [2, 5], 0.6),
    nightmare: mkDiff("nightmare", 0.65, 1.4, 0.65, 1.35, 15, [3, 6], 0.7),
  };
  const mkDoc = (name, description, move_threshold, buffer_days, max_builders, breed_food_days, max_births, rest_energy, salvage_below) =>
    ({ name, description, move_threshold, buffer_days, max_builders, breed_food_days, max_births, rest_energy, salvage_below });
  const DOCTRINES = {
    balanced: mkDoc("balanced", "Even-handed: react to danger early, keep a healthy buffer, build steadily.", 1.2, 10.0, 3, 5.0, 2, 30.0, 10),
    cautious: mkDoc("cautious", "Safety first: flee any hint of danger, hoard supplies. Safest, slowest.", 0.8, 13.0, 2, 10.0, 1, 35.0, 8),
    industrious: mkDoc("industrious", "Tech rush: salvage hard, many builders, lean supplies. Fastest, riskier.", 1.5, 7.0, 5, 6.0, 1, 25.0, 40),
    expansionist: mkDoc("expansionist", "Breed early and often; numbers over tech. Big colonies, slower builds.", 1.2, 10.0, 3, 3.0, 3, 30.0, 10),
  };
  const FOCUSES = {
    auto: "Coordinator decides",
    forage: "Everyone free gathers food and water",
    build: "Max builders; spare hands salvage scrap",
    research: "Minimal foraging; everyone else researches",
    shelter: "Move to the safest level and rest",
  };
  const PINNABLE_ROLES = ["Forage", "Research", "Construct", "Rest"];
  const MAX_POPULATION = 30;
  const LOG_LIMIT = 200;
  const FORBIDDEN_PENALTY = 50.0;
  const LEVELS = [-1, 0, 1];

  // ------------------------------------------------------------ environment
  const DISASTERS = ["Acid Rain", "Blizzard", "Solar Flare", "Radon Leak", "Cave-In Threat"];
  const RAD_FLOOR = { "-1": 12, "0": 5, "1": 10 };
  const BASE_TEMP = { "-1": 12, "0": 20, "1": -5 };

  function scaled(lo, hi, mult) {
    const v = R.randint(lo, hi) * mult;
    const base = Math.floor(v);
    return base + (R.random() < v - base ? 1 : 0);
  }
  function decay(value, floor, rate = 0.85) {
    if (value <= floor) return value;
    return Math.max(floor, Math.trunc(floor + (value - floor) * rate) - R.randint(1, 3));
  }

  class Grid3D {
    constructor(width, height, difficulty) {
      this.difficulty = difficulty;
      this.width = width; this.height = height;
      this.z_levels = LEVELS.slice();
      this.cells = []; // ordered like the Python dict: z, then y, then x
      this.index = new Map();
      for (const z of this.z_levels) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const cell = { x, y, z, scrap: 0, biomass: 0, water: 0, radiation: 0, temperature: 15, toxicity: 0, cave_in_risk: z !== -1 ? 0 : 10 };
        this.cells.push(cell);
        this.index.set(`${x},${y},${z}`, cell);
      }
      this.seedResources();
      this.current_disaster = "None";
      this.disaster_duration = 0;
      this.turn = 0;
      this.disaster_forecast = [];
      this.generateForecast();
    }
    seedResources() {
      for (const c of this.cells) {
        if (c.z === 0) {
          c.scrap = R.randint(10, 30); c.biomass = R.randint(15, 40); c.water = R.randint(10, 30);
          c.radiation = R.randint(0, 15); c.temperature = 20; c.toxicity = R.randint(0, 10);
        } else if (c.z === -1) {
          c.scrap = R.randint(5, 15); c.biomass = R.randint(0, 5); c.water = R.randint(15, 40);
          c.radiation = R.randint(5, 25); c.temperature = 12; c.toxicity = R.randint(0, 5);
        } else {
          c.scrap = R.randint(0, 10); c.biomass = R.randint(5, 15); c.water = R.randint(0, 10);
          c.radiation = R.randint(20, 40); c.temperature = -5; c.toxicity = R.randint(0, 5);
        }
      }
    }
    get escalation() { return 1.0 + this.difficulty.escalation * (this.turn / 50.0); }
    rollWeather() {
      const calm = 1.0 - (1.0 - this.difficulty.calm_weight) * this.escalation;
      if (R.random() < Math.max(0.3, calm)) return "None";
      return R.choice(DISASTERS);
    }
    generateForecast(length = 5) {
      while (this.disaster_forecast.length < length) this.disaster_forecast.push(this.rollWeather());
    }
    getCell(x, y, z) { return this.index.get(`${x},${y},${z}`); }
    tick() {
      this.turn += 1;
      if (this.disaster_duration > 0) {
        this.disaster_duration -= 1;
        if (this.disaster_duration === 0) this.current_disaster = "None";
      } else if (this.current_disaster === "None") {
        const upcoming = this.disaster_forecast.shift();
        this.generateForecast();
        if (upcoming !== "None") {
          this.current_disaster = upcoming;
          this.disaster_duration = R.randint(this.difficulty.duration[0], this.difficulty.duration[1]);
        }
      }
      const regen = this.difficulty.regen;
      const hit = this.difficulty.intensity * this.escalation;
      const d = this.current_disaster;
      for (const cell of this.cells) {
        const z = cell.z;
        if (z === 0 && cell.biomass < 60 && d !== "Acid Rain") cell.biomass += scaled(0, 2, regen);
        else if (z === 1 && cell.biomass < 40) cell.biomass += scaled(0, 1, regen);
        else if (z === -1 && cell.biomass < 10) cell.biomass += scaled(0, 1, regen * 0.5);

        if (z === -1 && cell.water < 40) cell.water += scaled(0, 2, regen);
        else if (z === 0 && cell.water < 30 && (d === "None" || d === "Blizzard")) cell.water += scaled(0, 2, regen);
        else if (z === 1 && cell.water < 20) cell.water += d === "Blizzard" ? scaled(1, 3, regen) : scaled(0, 1, regen);

        if (cell.scrap < 30 && R.random() < 0.08 * regen) cell.scrap += R.randint(1, 3);

        if (d === "Acid Rain") {
          if (z === 0) {
            cell.toxicity = Math.min(100, cell.toxicity + scaled(15, 30, hit));
            cell.biomass = Math.max(0, cell.biomass - R.randint(5, 15));
          } else if (z === 1) cell.toxicity = Math.min(100, cell.toxicity + scaled(5, 15, hit));
        } else if (d === "Blizzard") {
          if (z === 1) cell.temperature = Math.max(-40, cell.temperature - scaled(15, 25, hit));
          else if (z === 0) cell.temperature = Math.max(-20, cell.temperature - scaled(10, 18, hit));
          else cell.temperature = Math.max(5, cell.temperature - scaled(1, 2, hit));
        } else if (d === "Solar Flare") {
          if (z === 1) cell.radiation = Math.min(100, cell.radiation + scaled(20, 40, hit));
          else if (z === 0) cell.radiation = Math.min(100, cell.radiation + scaled(15, 30, hit));
        } else if (d === "Radon Leak") {
          if (z === -1) cell.toxicity = Math.min(100, cell.toxicity + scaled(25, 50, hit));
        } else if (d === "Cave-In Threat") {
          if (z === -1) cell.cave_in_risk = Math.min(100, cell.cave_in_risk + scaled(20, 40, hit));
        }

        const toxHit = (d === "Acid Rain" && z >= 0) || (d === "Radon Leak" && z === -1);
        if (!toxHit) cell.toxicity = decay(cell.toxicity, z === -1 ? 0 : 5);
        if (!(d === "Solar Flare" && z >= 0)) cell.radiation = decay(cell.radiation, RAD_FLOOR[z]);
        if (!(d === "Blizzard" && z >= 0)) {
          const target = BASE_TEMP[z];
          if (cell.temperature < target) cell.temperature = Math.min(target, cell.temperature + R.randint(2, 4));
          else if (cell.temperature > target) cell.temperature = Math.max(target, cell.temperature - R.randint(1, 3));
        }
        if (d !== "Cave-In Threat" && z === -1) cell.cave_in_risk = decay(cell.cave_in_risk, 5);
      }
    }
  }

  // ------------------------------------------------------------ survivors
  const NAMES_DB = ["Alex", "Sam", "Jordan", "Taylor", "Morgan", "Casey", "Riley", "Jamie", "Skyler", "Robin",
    "Logan", "Quinn", "Avery", "Reese", "Rowan", "Finley", "Emery", "Peyton", "Sage", "Drew",
    "Chris", "Pat", "Terry", "Dana", "Kim", "Kelly", "Leslie", "Jan", "Val", "Ren"];
  const GENE_NAMES = ["speed", "foraging", "rad_resistance", "cold_resistance", "intelligence"];
  const FORAGE_TABLE = {
    "0": [["water", 5, 12, "Water"], ["biomass", 6, 14, "Biomass"], ["scrap", 4, 10, "Scrap"]],
    "-1": [["water", 8, 15, "Water"], ["scrap", 3, 8, "Bunker Scrap"], ["biomass", 2, 5, "Fungi"]],
    "1": [["biomass", 3, 8, "Alpine Biomass"], ["scrap", 3, 8, "High Wreckage"], ["water", 2, 6, "Ice"]],
  };
  const HUNGER_PER_BIOMASS = 10.0, HUNGER_PER_WATER = 6.0;
  let nextId = 1;

  class Survivor {
    constructor(x, y, z, genes = null, generation = 1) {
      this.id = nextId++;
      this.name = `${R.choice(NAMES_DB)}-${this.id}`;
      this.x = x; this.y = y; this.z = z;
      this.generation = generation;
      this.health = 100.0; this.energy = 100.0; this.hunger = 0.0; this.radiation = 0.0;
      this.age = 0;
      this.lifespan = R.randint(90, 140);
      this.role = "Unassigned";
      this.forage_target = "supplies";
      this.status = "Idle";
      this.cause_of_death = null;
      this.has_reproduced_this_turn = false;
      this._damage = {};
      if (genes) this.genes = { ...genes };
      else { this.genes = {}; for (const g of GENE_NAMES) this.genes[g] = round2(R.uniform(0.6, 1.4)); }
    }
    get alive() { return this.health > 0; }
    hurt(amount, cause) {
      if (amount <= 0) return;
      this.health = Math.max(0, this.health - amount);
      this._damage[cause] = (this._damage[cause] || 0) + amount;
      if (this.health <= 0 && this.cause_of_death === null) {
        this.cause_of_death = argmax(Object.keys(this._damage), (k) => this._damage[k]);
      }
    }
    tick(cell, prot) {
      prot = prot || {};
      this.age += 1;
      this.has_reproduced_this_turn = false;
      this._damage = {};
      this.status = "Idle";
      this.hunger = Math.min(100, this.hunger + 3.0 + this.genes.speed * 1.5);
      this.energy = Math.max(0, this.energy - (1.5 + this.genes.speed * 0.5));
      if (this.hunger >= 80) { this.hurt((this.hunger - 80) * 0.5, "Starvation"); this.status = "Starving"; }

      const radExposure = cell.radiation * (1 - (prot.radiation || 0));
      const absorbed = radExposure - this.genes.rad_resistance * 12.0;
      if (absorbed > 0) this.radiation = Math.min(100, this.radiation + absorbed * 0.5);
      else this.radiation = Math.max(0, this.radiation - 3.0);
      if (this.radiation > 30) {
        this.hurt((this.radiation - 30) * 0.3, "Radiation");
        if (this.status === "Idle") this.status = "Sick";
      }

      const temp = cell.temperature + (prot.cold || 0);
      if (temp < 10) {
        const absorbedCold = (10 - temp) - this.genes.cold_resistance * 10;
        if (absorbedCold > 0) {
          this.hurt(absorbedCold * 0.4, "Hypothermia");
          if (this.status === "Idle") this.status = "Freezing";
        }
      }

      let toxicity = cell.toxicity;
      if (this.z === -1) toxicity *= 1 - (prot.radon || 0);
      if (toxicity > 20) {
        this.hurt((toxicity - 20) * 0.2, "Toxic exposure");
        if (this.status === "Idle") this.status = "Poisoned";
      }

      const risk = (cell.cave_in_risk || 0) * (1 - (prot.cave_in || 0));
      if (this.z === -1 && risk > 0 && R.random() < risk / 400) {
        this.hurt(R.uniform(15, 40), "Cave-in");
        this.status = "Crushed";
      }

      const frailFrom = this.lifespan * 0.75;
      if (this.age > frailFrom) {
        this.hurt((this.age - frailFrom) / (this.lifespan * 0.25) * 6.0, "Old age");
        if (this.status === "Idle") this.status = "Frail";
      }

      if (this.hunger < 40 && this.radiation < 15 && this.energy > 50 && temp >= 5 && toxicity < 10
          && Object.keys(this._damage).length === 0) {
        this.health = Math.min(100, this.health + 4.0);
      }
    }
    forage(cell, stock) {
      const options = FORAGE_TABLE[this.z].filter((o) => cell[o[0]] > 0);
      if (!options.length) return false;
      const wantScrap = this.forage_target === "scrap";
      options.sort((a, b) => {
        const pa = wantScrap ? (a[0] !== "scrap") : (a[0] === "scrap");
        const pb = wantScrap ? (b[0] !== "scrap") : (b[0] === "scrap");
        if (pa !== pb) return pa ? 1 : -1;
        return (stock[a[0]] || 0) - (stock[b[0]] || 0);
      });
      const [res, lo, hi, label] = options[0];
      const amount = Math.min(cell[res], Math.max(1, Math.trunc(R.randint(lo, hi) * this.genes.foraging)));
      cell[res] -= amount;
      stock[res] = (stock[res] || 0) + amount;
      this.status = `Gathered ${amount} ${label}`;
      return true;
    }
    performAction(action, grid, tech, stock) {
      const cell = grid.getCell(this.x, this.y, this.z);
      if (!cell) return;
      if (this.health < 20 || this.energy < 15) action = "Rest";
      if (action === "Forage") {
        if (!this.forage(cell, stock)) { this.moveToRichestNeighbor(grid); this.status = "Cell Empty, Searching..."; }
        this.energy = Math.max(0, this.energy - 8); this.hunger = Math.min(100, this.hunger + 3);
      } else if (action === "Research") {
        const gain = Math.trunc(R.randint(2, 6) * this.genes.intelligence);
        tech.research_points += gain;
        this.status = `Researched +${gain} RP`;
        this.energy = Math.max(0, this.energy - 6); this.hunger = Math.min(100, this.hunger + 2);
      } else if (action === "Construct") {
        const name = tech.current_project;
        if (name) {
          const p = tech.projects[name];
          const needed = p.cost - p.progress;
          if (needed > 0 && stock.scrap > 0) {
            const rate = R.randint(4, 9) * (0.5 + this.genes.intelligence / 2);
            const spent = Math.min(stock.scrap, Math.max(1, Math.trunc(rate)), needed);
            stock.scrap -= spent; p.progress += spent;
            this.status = `Built ${spent} on ${name}`;
          } else this.status = "No Scrap to Build";
        } else this.status = "Nothing to Build";
        this.energy = Math.max(0, this.energy - 10); this.hunger = Math.min(100, this.hunger + 4);
      } else if (action === "Rest") {
        this.energy = Math.min(100, this.energy + 25);
        this.radiation = Math.max(0, this.radiation - 2);
        if (this.status === "Idle") this.status = "Resting";
      }
    }
    moveTowards(targetZ, grid) {
      if (this.z !== targetZ) {
        if (targetZ > this.z) { this.z += 1; this.status = "Climbed Up"; }
        else { this.z -= 1; this.status = "Descended"; }
        this.energy = Math.max(0, this.energy - 10 / Math.max(0.5, this.genes.speed));
        return;
      }
      this.moveToRichestNeighbor(grid);
    }
    neighbors(grid) {
      const out = [];
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nx = this.x + dx, ny = this.y + dy;
        if (nx >= 0 && nx < grid.width && ny >= 0 && ny < grid.height) out.push([nx, ny]);
      }
      return out;
    }
    moveToRichestNeighbor(grid) {
      const opts = this.neighbors(grid);
      if (!opts.length) return;
      R.shuffle(opts);
      const rich = (p) => {
        const c = grid.getCell(p[0], p[1], this.z);
        return c.water + c.biomass + c.scrap - c.toxicity - c.radiation * 0.5;
      };
      const [nx, ny] = argmax(opts, rich);
      this.x = nx; this.y = ny;
      this.status = `Moved to (${nx},${ny})`;
      this.energy = Math.max(0, this.energy - 4);
    }
    feed(stock) {
      if (this.hunger <= 20) return;
      const want = this.hunger - 10;
      const food = Math.min(stock.biomass, Math.trunc(want * 0.6 / HUNGER_PER_BIOMASS + 0.999));
      stock.biomass -= food;
      const water = Math.min(stock.water, Math.trunc(want * 0.4 / HUNGER_PER_WATER + 0.999));
      stock.water -= water;
      let relief = food * HUNGER_PER_BIOMASS + water * HUNGER_PER_WATER;
      if (water === 0) relief *= 0.5;
      this.hunger = Math.max(0, this.hunger - relief);
    }
    reproduce(partner) {
      const genes = {};
      for (const g of Object.keys(this.genes)) {
        const parentVal = R.choice([this.genes[g], partner.genes[g]]);
        let mixed = (parentVal + (this.genes[g] + partner.genes[g]) / 2) / 2;
        if (R.random() < 0.15) mixed += R.uniform(-0.25, 0.25);
        genes[g] = round2(Math.max(0.1, Math.min(3.0, mixed)));
      }
      const child = new Survivor(this.x, this.y, this.z, genes, Math.max(this.generation, partner.generation) + 1);
      child.hunger = 30;
      this.energy = Math.max(5, this.energy - 35);
      partner.energy = Math.max(5, partner.energy - 35);
      this.has_reproduced_this_turn = partner.has_reproduced_this_turn = true;
      return child;
    }
  }

  // ------------------------------------------------------------ tech
  const TECH_BASE = [
    ["Underground Reinforcement", 20, 40, "Reinforces cave walls: -75% cave-in chance and -50% radon toxicity at Z = -1."],
    ["Geothermal Insulation", 30, 50, "Heated shelters: survivors feel +12 C warmer everywhere."],
    ["Water Filtration Rig", 40, 60, "Enables passive clean water generation (adds +5 water to stockpile per tick)."],
    ["Automated Hydroponics", 50, 80, "Allows farming food in bunkers, generating +5 biomass/food per tick."],
    ["Cosmic Ray Deflector", 60, 100, "Halves radiation exposure on every level."],
    ["Sub-space Radio Beacon", 80, 150, "Pings the wasteland to attract new survivors, stabilizing the population."],
  ];
  // Python's round() rounds halves to even.
  function pyRound(v) {
    const f = Math.floor(v), diff = v - f;
    if (Math.abs(diff - 0.5) < 1e-9) return f % 2 === 0 ? f : f + 1;
    return Math.round(v);
  }
  class TechTree {
    constructor(costMult) {
      this.research_points = 0;
      this.current_project = null;
      this.projects = {};
      for (const [name, rc, c, desc] of TECH_BASE) {
        this.projects[name] = { unlocked: false, research_cost: pyRound(rc * costMult), cost: pyRound(c * costMult), progress: 0, completed: false, description: desc };
      }
    }
    names() { return Object.keys(this.projects); }
    availableResearch() { return this.names().filter((k) => !this.projects[k].unlocked); }
    availableConstruction() { return this.names().filter((k) => this.projects[k].unlocked && !this.projects[k].completed); }
    nextResearchTarget() {
      const locked = this.availableResearch();
      return locked.length ? argmin(locked, (k) => this.projects[k].research_cost) : null;
    }
    tryUnlockNext() {
      const t = this.nextResearchTarget();
      if (t && this.research_points >= this.projects[t].research_cost) {
        this.research_points -= this.projects[t].research_cost;
        this.projects[t].unlocked = true;
        return t;
      }
      return null;
    }
    isCompleted(n) { return this.projects[n].completed; }
    allCompleted() { return this.names().every((k) => this.projects[k].completed); }
    completedCount() { return this.names().filter((k) => this.projects[k].completed).length; }
    protections() {
      const p = {};
      if (this.isCompleted("Underground Reinforcement")) { p.cave_in = 0.75; p.radon = 0.5; }
      if (this.isCompleted("Geothermal Insulation")) p.cold = 12.0;
      if (this.isCompleted("Cosmic Ray Deflector")) p.radiation = 0.5;
      return p;
    }
    updateCompletion() {
      const done = [];
      for (const k of this.names()) {
        const p = this.projects[k];
        if (p.unlocked && !p.completed && p.progress >= p.cost) { p.completed = true; done.push(k); }
      }
      return done;
    }
  }

  // ------------------------------------------------------------ coordinator
  const DISASTER_THREAT = {
    "Acid Rain": { "0": 8.0, "1": 3.0 },
    "Blizzard": { "1": 12.0, "0": 6.0 },
    "Solar Flare": { "1": 10.0, "0": 7.0 },
    "Radon Leak": { "-1": 9.0 },
    "Cave-In Threat": { "-1": 6.0 },
  };

  class Coordinator {
    constructor(grid, tech, doctrine) {
      this.doctrine = doctrine; this.grid = grid; this.tech = tech;
      this.thought_log = []; this.active_plan = "Initializing..."; this.turn = 0; this._lastPlan = null;
      this.focus = "auto"; this.forbidden = {}; this.pins = {};
    }
    log(msg) {
      this.thought_log.push(`T${String(this.turn).padEnd(3)} ${msg}`);
      if (this.thought_log.length > LOG_LIMIT) this.thought_log.splice(0, this.thought_log.length - LOG_LIMIT);
    }
    intel(survivors, stock) {
      const alive = survivors.filter((s) => s.alive);
      const n = alive.length, avg = (k) => alive.reduce((a, s) => a + s[k], 0) / Math.max(1, n);
      return {
        alive_count: n, avg_health: avg("health"), avg_hunger: avg("hunger"),
        avg_radiation: avg("radiation"), avg_energy: avg("energy"),
        disaster: this.grid.current_disaster, disaster_turns_left: this.grid.disaster_duration,
        water: stock.water, biomass: stock.biomass, scrap: stock.scrap,
        surface_pop: alive.filter((s) => s.z === 0).length,
        underground_pop: alive.filter((s) => s.z === -1).length,
        mountain_pop: alive.filter((s) => s.z === 1).length,
      };
    }
    levelConditions() {
      const out = {};
      for (const z of this.grid.z_levels) {
        const cells = this.grid.cells.filter((c) => c.z === z), n = Math.max(1, cells.length);
        const o = {};
        for (const k of ["radiation", "temperature", "toxicity", "cave_in_risk", "water", "biomass", "scrap"]) {
          o[k] = cells.reduce((a, c) => a + c[k], 0) / n;
        }
        out[z] = o;
      }
      return out;
    }
    dangerFor(s, z, levels, prot) {
      const c = levels[z];
      const rad = c.radiation * (1 - (prot.radiation || 0)) - s.genes.rad_resistance * 12;
      const futureRad = s.radiation + (rad > 0 ? rad * 0.5 : -3.0) * 4;
      let danger = Math.max(0, futureRad - 30) * 0.3;
      if (s.radiation > 20 && rad > 0) danger += 2.0;
      const temp = c.temperature + (prot.cold || 0);
      danger += Math.max(0, (10 - temp) - s.genes.cold_resistance * 10) * 0.4;
      const tox = c.toxicity * (z === -1 ? (1 - (prot.radon || 0)) : 1);
      danger += Math.max(0, tox - 20) * 0.2;
      if (z === -1) danger += c.cave_in_risk * (1 - (prot.cave_in || 0)) / 400 * 27;
      if (this.grid.current_disaster === "None" && this.grid.disaster_forecast.length) {
        danger += (DISASTER_THREAT[this.grid.disaster_forecast[0]] || {})[z] || 0;
      }
      if (z in this.forbidden) danger += FORBIDDEN_PENALTY;
      return danger;
    }
    formulatePlan(intel) {
      this.turn += 1;
      for (const z of Object.keys(this.forbidden)) {
        this.forbidden[z] -= 1;
        if (this.forbidden[z] <= 0) { delete this.forbidden[z]; this.log(`\u{1F7E2} Evacuation order for Z=${z} expired.`); }
      }
      const unlocked = this.tech.tryUnlockNext();
      if (unlocked) this.log(`\u{1F513} Tech unlocked: ${unlocked}`);
      const n = Math.max(1, intel.alive_count);
      const foodDays = Math.min(intel.water, intel.biomass) / n;
      let plan;
      if (intel.disaster !== "None") {
        plan = "DISASTER_RESPONSE";
        this.active_plan = `EMERGENCY: ${intel.disaster} (${intel.disaster_turns_left}t). Shelter on safest levels.`;
      } else if (intel.alive_count <= 2) {
        plan = "SURVIVAL"; this.active_plan = `CRITICAL: only ${intel.alive_count} alive. Forage and rest.`;
      } else if (foodDays < 3 || intel.avg_hunger > 55) {
        plan = "FORAGE_PRIORITY"; this.active_plan = `Resource crisis (~${foodDays.toFixed(1)} turns of supplies). Foraging priority.`;
      } else if (intel.avg_radiation > 35 || intel.avg_health < 45) {
        plan = "HEALTH_FOCUS"; this.active_plan = `Health crisis (HP ${intel.avg_health.toFixed(0)}, Rad ${intel.avg_radiation.toFixed(0)}). Rest and retreat.`;
      } else if (this.tech.availableConstruction().length) {
        plan = "BUILD"; this.active_plan = `Build ${this.tech.availableConstruction()[0]}.`;
      } else if (intel.alive_count < 12 && intel.avg_health > 65 && intel.avg_hunger < 35 && foodDays > this.doctrine.breed_food_days) {
        plan = "EXPAND"; this.active_plan = "Colony healthy. Encourage reproduction.";
      } else {
        plan = "BALANCED";
        const t = this.tech.nextResearchTarget();
        this.active_plan = t ? `Research toward ${t}.` : "Stockpile and maintain.";
      }
      if (this.focus === "shelter") { plan = "SHELTER"; this.active_plan = "ORDER: shelter on the safest level and rest."; }
      else if (this.focus !== "auto") this.active_plan += ` [Order: ${this.focus}]`;
      if (plan !== this._lastPlan) this.log(`\u{1F9E0} Plan: ${this.active_plan}`);
      this._lastPlan = plan;
      return plan;
    }
    assignDirectives(survivors, plan, stock) {
      const alive = survivors.filter((s) => s.alive);
      if (!alive.length) return;
      const levels = this.levelConditions();
      const prot = this.tech.protections();
      const construct = this.tech.availableConstruction();
      this.tech.current_project = construct.length ? construct[0] : null;
      const doc = this.doctrine;
      const zs = this.grid.z_levels;

      const free = [];
      let moved = 0;
      for (const s of alive) {
        s.role = "Unassigned";
        const here = this.dangerFor(s, s.z, levels, prot);
        const bestZ = argmin(zs, (z) => this.dangerFor(s, z, levels, prot));
        const best = this.dangerFor(s, bestZ, levels, prot);
        const threshold = plan === "SHELTER" ? 0.3 : doc.move_threshold;
        const mustLeave = (s.z in this.forbidden) && !(bestZ in this.forbidden);
        if (bestZ !== s.z && here - best >= threshold && (s.energy > 15 || mustLeave)) {
          s.role = `Move To Z=${bestZ}`; moved++;
        } else if (s.id in this.pins) {
          s.role = this.pins[s.id]; s.forage_target = "supplies";
        } else if (plan === "SHELTER" || s.health < 30 || s.energy < doc.rest_energy || (plan === "HEALTH_FOCUS" && s.radiation > 30)) {
          s.role = "Rest";
        } else free.push(s);
      }
      if (moved) this.log(`⚠️ Relocating ${moved} survivor(s) to safer levels.`);
      if (!free.length) return;

      const nAlive = alive.length;
      const stockMin = Math.min(stock.water, stock.biomass);
      let foragers;
      if (["FORAGE_PRIORITY", "SURVIVAL", "DISASTER_RESPONSE"].includes(plan) || this.focus === "forage") foragers = free.length;
      else if (this.focus === "research") foragers = stockMin > nAlive * 2 ? 1 : Math.max(1, Math.floor(free.length / 3));
      else {
        const target = Math.max(1, nAlive * doc.buffer_days);
        const deficit = Math.min(1, Math.max(0, (target - stockMin) / target));
        foragers = Math.max(1, Math.ceil(free.length * (0.25 + 0.65 * deficit)));
      }
      foragers = Math.min(foragers, free.length);

      let builders = 0;
      if (this.tech.current_project && stock.scrap > 0) {
        builders = Math.max(1, Math.min(doc.max_builders, Math.floor(stock.scrap / 8)));
        if (plan === "FORAGE_PRIORITY" || plan === "SURVIVAL") builders = 0;
        if (this.focus === "build") {
          builders = doc.max_builders + 2;
          foragers = Math.min(foragers, Math.max(1, Math.floor(free.length / 4)));
        } else if (this.focus === "research") builders = 0;
      }
      builders = Math.min(builders, free.length - foragers);

      let pool = free.slice().sort((a, b) => b.genes.foraging - a.genes.foraging);
      const scarce = stock.biomass <= stock.water ? "biomass" : "water";
      const imbalanced = stock[scarce] * 2 < Math.max(stock.water, stock.biomass);
      let relocated = 0;
      for (const s of pool.slice(0, foragers)) {
        s.role = "Forage"; s.forage_target = "supplies";
        if (imbalanced && levels[s.z][scarce] < 6 && relocated < Math.max(1, Math.floor(foragers / 2))) {
          const here = this.dangerFor(s, s.z, levels, prot);
          const options = zs.filter((z) => z !== s.z && levels[z][scarce] > 10 && this.dangerFor(s, z, levels, prot) <= here + 0.5);
          if (options.length && s.energy > 30) {
            s.role = `Move To Z=${argmax(options, (z) => levels[z][scarce])}`;
            relocated++;
          }
        }
      }
      if (relocated) this.log(`\u{1F9ED} Sending ${relocated} forager(s) toward ${scarce}.`);
      pool = pool.slice(foragers).sort((a, b) => b.genes.intelligence - a.genes.intelligence);
      for (const s of pool.slice(0, builders)) s.role = "Construct";
      for (const s of pool.slice(builders)) {
        if (this.focus === "research" && this.tech.nextResearchTarget()) s.role = "Research";
        else if (this.tech.current_project && (this.focus === "build" || stock.scrap < doc.salvage_below)) {
          s.role = "Forage"; s.forage_target = "scrap";
        } else if (this.tech.nextResearchTarget() === null && !this.tech.current_project) {
          s.role = s.energy > 60 ? "Forage" : "Rest"; s.forage_target = "supplies";
        } else s.role = "Research";
      }
    }
    checkWinLose(intel) {
      if (intel.alive_count === 0) return "EXTINCTION";
      if (this.tech.allCompleted() && intel.alive_count >= 8 && intel.avg_health > 60) return "RESTORATION";
      return null;
    }
  }

  // ------------------------------------------------------------ simulation
  function geneAverages(alive) {
    if (!alive.length) return {};
    const out = {};
    for (const g of GENE_NAMES) out[g] = alive.reduce((a, s) => a + s.genes[g], 0) / alive.length;
    return out;
  }

  class Simulation {
    constructor({ width = 5, height = 5, population = 6, seed = null, difficulty = "normal", doctrine = "balanced" } = {}) {
      width = +width; height = +height; population = +population;
      if (!(width >= 3 && height >= 3)) throw new Error("Grid must be at least 3x3");
      if (width > 12 || height > 12) throw new Error("Grid can be at most 12x12");
      if (!(population >= 1)) throw new Error("Starting population must be at least 1");
      if (!DIFFICULTIES[difficulty]) throw new Error(`Unknown difficulty ${difficulty}`);
      if (!DOCTRINES[doctrine]) throw new Error(`Unknown doctrine ${doctrine}`);
      this.seed = (seed === null || seed === undefined || seed === "") ? Math.floor(Math.random() * 1e6) : parseInt(seed, 10);
      if (Number.isNaN(this.seed)) throw new Error("Seed must be a whole number");
      R = makeRng(this.seed);
      this.rng = R;
      nextId = 1;
      this.difficulty = DIFFICULTIES[difficulty];
      this.doctrine = DOCTRINES[doctrine];
      this.width = width; this.height = height;
      this.turn = 0; this.running = true; this.game_over_reason = null;
      this.grid = new Grid3D(width, height, this.difficulty);
      this.tech = new TechTree(this.difficulty.tech_cost);
      this.coordinator = new Coordinator(this.grid, this.tech, this.doctrine);
      const st = this.difficulty.starting_stock;
      this.stockpile = { scrap: 0, water: st, biomass: st };
      this.stats = { births: 0, deaths: 0, recruits: 0, causes_of_death: {}, peak_population: population, max_generation: 1, tech_completed_turn: {} };
      this.survivors = [];
      for (let i = 0; i < population; i++) {
        this.survivors.push(new Survivor(R.randint(1, width - 2), R.randint(1, height - 2), R.choice([-1, 0, 0, 1]), null, 1));
      }
      this.initial_genes = geneAverages(this.survivors);
      this.history = [];
    }
    get alive() { return this.survivors.filter((s) => s.alive); }
    tick() {
      R = this.rng; // several games may coexist; use this one's stream
      this.turn += 1;
      this.grid.tick();
      this.applyTechIncome();
      let intel = this.coordinator.intel(this.survivors, this.stockpile);
      const plan = this.coordinator.formulatePlan(intel);
      this.coordinator.assignDirectives(this.survivors, plan, this.stockpile);
      for (const s of this.alive.sort((a, b) => b.hunger - a.hunger)) if (s.hunger > 30) s.feed(this.stockpile);
      const prot = this.tech.protections();
      for (const s of this.alive) {
        s.tick(this.grid.getCell(s.x, s.y, s.z), prot);
        if (!s.alive) continue;
        if (PINNABLE_ROLES.includes(s.role)) s.performAction(s.role, this.grid, this.tech, this.stockpile);
        else if (s.role.startsWith("Move To Z=")) s.moveTowards(parseInt(s.role.split("=")[1], 10), this.grid);
      }
      this.tech.research_points += Math.trunc(this.alive.reduce((a, s) => a + s.genes.intelligence, 0) * 0.25);
      this.buryDead();
      this.handleReproduction(plan);
      for (const t of this.tech.updateCompletion()) {
        this.stats.tech_completed_turn[t] = this.turn;
        this.coordinator.log(`✅ Tech completed: ${t}`);
      }
      intel = this.coordinator.intel(this.survivors, this.stockpile);
      this.stats.peak_population = Math.max(this.stats.peak_population, intel.alive_count);
      this.history.push({ turn: this.turn, alive: intel.alive_count, tech: this.tech.completedCount() });
      const result = this.coordinator.checkWinLose(intel);
      if (result) { this.running = false; this.game_over_reason = result; }
    }
    buryDead() {
      for (const d of this.survivors.filter((s) => !s.alive)) {
        delete this.coordinator.pins[d.id];
        const cause = d.cause_of_death || "Unknown";
        this.stats.deaths += 1;
        this.stats.causes_of_death[cause] = (this.stats.causes_of_death[cause] || 0) + 1;
        this.coordinator.log(`\u{1F480} ${d.name} perished (Gen ${d.generation}, age ${d.age}, ${cause})`);
      }
      this.survivors = this.alive;
    }
    applyTechIncome() {
      if (this.tech.isCompleted("Water Filtration Rig")) this.stockpile.water += 6;
      if (this.tech.isCompleted("Automated Hydroponics")) this.stockpile.biomass += 6;
      if (this.tech.isCompleted("Sub-space Radio Beacon") && R.random() < 0.15 && this.alive.length < MAX_POPULATION / 2) {
        const s = new Survivor(R.randint(0, this.width - 1), R.randint(0, this.height - 1), 0, null, 1);
        this.survivors.push(s);
        this.stats.recruits += 1;
        this.coordinator.log(`\u{1F4E1} Radio Beacon attracted ${s.name}!`);
      }
    }
    canBreed(s) {
      return s.alive && !s.has_reproduced_this_turn && s.health >= 60 && s.hunger <= 40 && s.energy >= 40 && s.age >= 5;
    }
    handleReproduction(plan) {
      const alive = this.alive;
      let pop = alive.length;
      if (pop >= MAX_POPULATION || ["DISASTER_RESPONSE", "SURVIVAL", "FORAGE_PRIORITY", "SHELTER"].includes(plan)) return;
      const maxBirths = plan === "EXPAND" ? this.doctrine.max_births : 1;
      let births = 0;
      for (let i = 0; i < alive.length; i++) {
        if (births >= maxBirths) break;
        const s1 = alive[i];
        if (!this.canBreed(s1)) continue;
        for (const s2 of alive.slice(i + 1)) {
          if (s2.z !== s1.z || !this.canBreed(s2)) continue;
          const reserve = 15 + pop * 3;
          if (this.stockpile.biomass < reserve || this.stockpile.water < reserve) return;
          const child = s1.reproduce(s2);
          this.survivors.push(child);
          this.stockpile.biomass -= 10; this.stockpile.water -= 10;
          this.stats.births += 1;
          this.stats.max_generation = Math.max(this.stats.max_generation, child.generation);
          this.coordinator.log(`\u{1F476} New survivor born: ${child.name} (Gen ${child.generation})`);
          births++; pop++;
          break;
        }
      }
    }
    // ---- player orders
    order(msg) { this.coordinator.log(`\u{1F4E3} ORDER: ${msg}`); }
    setFocus(f) {
      if (!FOCUSES[f]) throw new Error(`Unknown focus ${f}`);
      this.coordinator.focus = f;
      this.order(`colony focus -> ${f} (${FOCUSES[f]})`);
    }
    evacuate(z, turns = 6) {
      if (!this.grid.z_levels.includes(z)) throw new Error(`Unknown level ${z}`);
      const f = this.coordinator.forbidden;
      if (turns <= 0) { delete f[z]; this.order(`evacuation of Z=${z} lifted`); return; }
      const closed = new Set([...Object.keys(f).map(Number), z]);
      if (closed.size >= this.grid.z_levels.length) throw new Error("At least one level must stay open");
      f[z] = turns;
      this.order(`evacuate Z=${z} for ${turns} turns`);
    }
    pinRole(id, role) {
      const s = this.alive.find((v) => v.id === id);
      if (!s) throw new Error(`No living survivor with id ${id}`);
      if (!role) { delete this.coordinator.pins[id]; this.order(`${s.name} released to coordinator`); return; }
      if (!PINNABLE_ROLES.includes(role)) throw new Error(`Role must be one of ${PINNABLE_ROLES.join(", ")}`);
      this.coordinator.pins[id] = role;
      this.order(`${s.name} pinned to ${role}`);
    }
    setDoctrine(name) {
      if (!DOCTRINES[name]) throw new Error(`Unknown doctrine ${name}`);
      this.doctrine = this.coordinator.doctrine = DOCTRINES[name];
      this.order(`doctrine -> ${name}`);
    }
    score() {
      const alive = this.alive.length;
      if (this.game_over_reason === "RESTORATION") return 1000 + 10 * alive + Math.max(0, 300 - this.turn) * 2;
      return this.tech.completedCount() * 60 + Math.floor(Math.min(this.turn, 300) / 2) + 5 * alive;
    }
    report() {
      const st = this.stats;
      const lines = [
        `Outcome:        ${this.game_over_reason || "IN PROGRESS"} after ${this.turn} turns`,
        `Settings:       ${this.width}x${this.height} grid, difficulty=${this.difficulty.name}, doctrine=${this.doctrine.name}, seed=${this.seed}`,
        `Population:     ${this.alive.length} alive (peak ${st.peak_population}), ${st.births} births, ${st.recruits} recruits, ${st.deaths} deaths`,
        `Generations:    up to Gen ${st.max_generation}`,
        `Tech:           ${this.tech.completedCount()}/6 completed`,
        `Score:          ${this.score()}`,
      ];
      for (const [name, turn] of Object.entries(st.tech_completed_turn).sort((a, b) => a[1] - b[1])) lines.push(`                - ${name} (turn ${turn})`);
      const causes = Object.entries(st.causes_of_death).sort((a, b) => b[1] - a[1]);
      if (causes.length) lines.push(`Deaths by cause: ${causes.map(([k, v]) => `${k} ${v}`).join(", ")}`);
      const fin = geneAverages(this.alive);
      if (Object.keys(fin).length) {
        lines.push("Gene averages (living colony, change since turn 0):");
        for (const g of GENE_NAMES) {
          const dlt = fin[g] - this.initial_genes[g];
          lines.push(`                ${g.padEnd(16)} ${fin[g].toFixed(2)}  (${dlt >= 0 ? "+" : ""}${dlt.toFixed(2)})`);
        }
      }
      return lines.join("\n");
    }
  }

  // ------------------------------------------------------------ serialize (same shape as server.py)
  const r1 = (v) => (Number.isInteger(v) ? v : Math.round(v * 10) / 10);
  function serialize(sim) {
    const c = sim.coordinator;
    return {
      turn: sim.turn,
      running: sim.running,
      outcome: sim.game_over_reason,
      score: sim.score(),
      report: sim.running ? null : sim.report(),
      settings: { width: sim.width, height: sim.height, seed: sim.seed, difficulty: sim.difficulty.name, doctrine: sim.doctrine.name },
      levels: sim.grid.z_levels,
      disaster: sim.grid.current_disaster,
      disaster_turns_left: sim.grid.disaster_duration,
      forecast: sim.grid.disaster_forecast.slice(0, 3),
      escalation: Math.round(sim.grid.escalation * 100) / 100,
      stockpile: { ...sim.stockpile },
      research_points: sim.tech.research_points,
      current_project: sim.tech.current_project,
      tech: sim.tech.names().map((k) => ({ name: k, ...sim.tech.projects[k] })),
      cells: sim.grid.cells.map((cell) => ({ ...cell })),
      survivors: sim.alive.map((s) => ({
        id: s.id, name: s.name, x: s.x, y: s.y, z: s.z,
        health: r1(s.health), energy: r1(s.energy), hunger: r1(s.hunger), radiation: r1(s.radiation),
        age: s.age, lifespan: s.lifespan, generation: s.generation, role: s.role, status: s.status,
        genes: { ...s.genes }, pinned: c.pins[s.id] || null,
      })),
      plan: c.active_plan,
      focus: c.focus,
      forbidden: Object.fromEntries(Object.entries(c.forbidden).map(([z, t]) => [String(z), t])),
      log: c.thought_log.slice(-40),
      history: sim.history.slice(),
      stats: sim.stats,
      options: { difficulties: Object.keys(DIFFICULTIES), doctrines: Object.keys(DOCTRINES), focuses: FOCUSES, roles: PINNABLE_ROLES },
    };
  }

  function createGame(opts) {
    let sim = new Simulation(opts || {});
    return {
      get sim() { return sim; },
      state: () => serialize(sim),
      new(o) { sim = new Simulation(o || {}); return serialize(sim); },
      step(n = 1) {
        n = Math.max(1, Math.min(50, parseInt(n, 10) || 1));
        for (let i = 0; i < n && sim.running; i++) sim.tick();
        return serialize(sim);
      },
      command(cmd) {
        switch (cmd.type) {
          case "focus": sim.setFocus(cmd.focus); break;
          case "evacuate": sim.evacuate(parseInt(cmd.z, 10), cmd.turns === undefined ? 6 : parseInt(cmd.turns, 10)); break;
          case "pin": sim.pinRole(parseInt(cmd.id, 10), cmd.role || null); break;
          case "doctrine": sim.setDoctrine(cmd.doctrine); break;
          default: throw new Error(`Unknown command type ${cmd.type}`);
        }
        return serialize(sim);
      },
    };
  }

  const api = { createGame, Simulation, DIFFICULTIES, DOCTRINES, FOCUSES };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PARS = api;
})(typeof window !== "undefined" ? window : globalThis);
