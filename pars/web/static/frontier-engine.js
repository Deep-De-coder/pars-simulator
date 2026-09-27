/*
 * PARS Frontier engine: survivors start a new life somewhere hostile and
 * work out, day by day, what they need and how to get it.
 *
 * One tick is one day. Each day:
 *   1. weather arrives (the 3-day forecast is honest),
 *   2. the land responds (floods, soil moisture, salt, regrowth),
 *   3. structures produce water and power, and consumers draw power,
 *   4. the colony mind assesses needs (safety > warmth > water > food >
 *      power), lists every action the handbook says is possible *right now*,
 *      works backwards to gather missing materials, and assigns people by
 *      skill (the reasoning is kept for the UI),
 *   5. people work, crops grow, everyone eats, drinks and keeps warm,
 *   6. outcomes feed back into beliefs: the handbook gets corrected and new
 *      facts get discovered.
 *
 * Requires frontier-data.js (FRONTIER_DATA global, or require() in Node).
 */
(function (root) {
  "use strict";
  const D = (typeof module !== "undefined" && module.exports) ? require("./frontier-data.js") : root.FRONTIER_DATA;
  const { CROPS, HANDBOOK_CROPS, TECHNIQUES, SCENARIOS, DISASTERS, RULE_OF_THREES, HAZARD_GUIDE, HAZARD_LEVELS } = D;

  // The colony's decision weights. Hand-set defaults; frontier-train.js
  // evolves better ones by playing many simulated years.
  // What the handbook claims a day of each gathering job brings (food per day,
  // or chance per dig for salvage finds). Some are optimistic on purpose.
  const HANDBOOK_YIELDS = {
    forage_Spring: 3, forage_Summer: 3, forage_Autumn: 4.2, forage_Winter: 1.2,
    fish_river: 3.5, fish_lake: 2.2, hunt: 3.2,
    wire: 0.35, plastic: 0.3, tools: 0.2, panels: 0.12,
  };
  const YIELD_LABEL = {
    forage_Spring: "Foraging in spring", forage_Summer: "Foraging in summer", forage_Autumn: "Foraging in autumn", forage_Winter: "Foraging in winter",
    fish_river: "Fishing the river", fish_lake: "Fishing the pond", hunt: "Hunting", wire: "Finding wire in ruins", plastic: "Finding plastic in ruins",
    tools: "Finding tools in ruins", panels: "Finding solar panels in ruins",
  };

  const DEFAULT_BRAIN = {
    safety: 1, warmth: 1, fuel: 1, water: 1, waterSource: 1, food: 1, farming: 1, power: 1, growth: 1,
    crisisDamp: 0.65, fieldsMult: 0.9, woodStock: 6, scrapStock: 6, fireResponse: 1, repair: 1, boilBias: 1,
  };

  const YEAR = 360;
  const SEASONS = ["Spring", "Summer", "Autumn", "Winter"];
  const SKILLS = ["farming", "building", "engineering", "scavenging"];
  const NAMES = ["Ada", "Bram", "Cleo", "Dev", "Esme", "Faro", "Gia", "Hugo", "Iris", "Jonas", "Kira", "Lev",
    "Mina", "Nico", "Oona", "Pax", "Quin", "Rhea", "Sol", "Tariq", "Uma", "Vik", "Wren", "Yara", "Zeke"];
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const r1 = (v) => Math.round(v * 10) / 10;

  function makeRng(seed) {
    let a = (seed >>> 0) ^ 0x2f6b1c3d;
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
      chance: (p) => random() < p,
    };
  }

  // ================================================================ world
  class Frontier {
    constructor({ scenario = "river_flood", seed = null, width = 16, height = 12, hazards = "normal", brain = null, knowledge = null, learnYields = true, learnPower = true } = {}) {
      this.learnYields = learnYields;
      this.learnPower = learnPower;
      if (!(hazards in HAZARD_LEVELS)) throw new Error(`Unknown hazard level ${hazards}`);
      this.hazards = hazards;
      this.hazardMult = HAZARD_LEVELS[hazards];
      this.brain = { ...DEFAULT_BRAIN, ...(brain || {}) };
      this.trained = !!(brain || knowledge);
      if (!SCENARIOS[scenario]) throw new Error(`Unknown scenario ${scenario}`);
      width = +width; height = +height;
      if (!(width >= 8 && width <= 24 && height >= 8 && height <= 20)) throw new Error("Map must be 8-24 wide and 8-20 tall");
      this.seed = (seed === null || seed === undefined || seed === "") ? Math.floor(Math.random() * 1e6) : parseInt(seed, 10);
      if (Number.isNaN(this.seed)) throw new Error("Seed must be a whole number");
      this.R = makeRng(this.seed);
      this.scenarioId = scenario;
      this.sc = SCENARIOS[scenario];
      this.W = width; this.H = height;
      this.day = 0;
      this.dayOfYear = this.sc.startDay || 0;
      this.running = true;
      this.outcome = null;
      this.log = [];
      this.nextId = 1;
      this.inv = { ...this.sc.inventory };
      this.seeds = { ...this.sc.seeds };
      this.priority = "auto";
      this.orders = [];
      this.stats = { harvested: 0, harvests: 0, deaths: 0, joined: 0, cropsLost: 0, built: {}, causes: {}, foodEaten: 0 };
      this.recentHarvest = []; // [day, food]
      this.plotStats = { food: 0, plotDays: 0 }; // observed food per plot per day in this place
      this.power = { produced: 0, used: 0, stored: 0, capacity: 10, shortfall: [] };
      this.water = { produced: 0 };
      this.discoveries = {};
      this.initBeliefs();
      if (knowledge) this.applyKnowledge(knowledge);
      this.startKnowledge = true;
      this.genMap();
      this.initWeather();
      this.survivors = [];
      for (let i = 0; i < this.sc.survivors; i++) this.addSurvivor(this.home.x, this.home.y);
      this.mind = null;
      this.note("event", `Day 1. ${this.sc.blurb}`);
      this.note("think", `What we need here: ${this.sc.needs}`);
      this.startAccuracy = Math.round(this.knowledgeAccuracy().pct * 1000) / 10;
    }

    // ------------------------------------------------------------ helpers
    tile(x, y) { return (x >= 0 && y >= 0 && x < this.W && y < this.H) ? this.tiles[y * this.W + x] : null; }
    neighbors(t) {
      const out = [];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const n = this.tile(t.x + dx, t.y + dy); if (n) out.push(n); }
      return out;
    }
    dist(a, b) { return Math.abs(a.x - b.x) + Math.abs(a.y - b.y); }
    isWater(t) { return t.type === "river" || t.type === "lake"; }
    isLand(t) { return !this.isWater(t); }
    note(kind, text) {
      this.log.push({ day: this.day + 1, kind, text });
      if (this.log.length > 400) this.log.splice(0, this.log.length - 400);
    }
    get season() { return SEASONS[Math.floor(((this.dayOfYear % YEAR) + YEAR) % YEAR / 90)]; }
    get alive() { return this.survivors.filter((s) => s.health > 0); }

    // ------------------------------------------------------------ setup
    initBeliefs() {
      this.beliefs = { crops: {}, tech: {} };
      for (const [id, c] of Object.entries(HANDBOOK_CROPS)) {
        this.beliefs.crops[id] = { ...c, yieldFactor: 1, planted: 0, harvested: 0, lost: 0, learned: [], coldDays: 0 };
      }
      // yield book: running mean per job, starting from the handbook (n = pseudo-count)
      this.beliefs.yields = Object.fromEntries(Object.entries(HANDBOOK_YIELDS).map(([k, v]) => [k, { m: v, n: k.length > 8 && !k.startsWith("fish") && !k.startsWith("forage") ? 6 : 3, told: false }]));
      this.beliefs.hazard = { fireAware: false, quakeWait: false, mixCrops: false, boilWater: false, ashFertile: false, learned: [] };
      this.beliefs.tech = {
        well: { byElev: [0, 1, 2, 3, 4].map(() => ({ ok: 4, fail: 1 })), learned: [] }, // prior ~0.8 everywhere
        wind_turbine: { output: 5, samples: 0, learned: [] },
        solar_array: { output: 5, samples: 0, learned: [] },
      };
    }

    genMap() {
      const { W, H, R, sc } = this;
      const T = sc.terrain;
      this.tiles = [];
      // river path
      const riverY = [];
      let y0 = Math.floor(H * (0.35 + R.random() * 0.3));
      for (let x = 0; x < W; x++) {
        riverY.push(y0);
        if (R.chance(0.35)) y0 = clamp(y0 + R.choice([-1, 1]), 2, H - 3);
      }
      // smooth random elevation field
      const bumps = Array.from({ length: 5 }, () => ({ x: R.uniform(0, W), y: R.uniform(0, H), h: R.uniform(1, 3), r: R.uniform(2.5, 5) }));
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        let elev;
        if (T.river) {
          const d = Math.abs(y - riverY[x]);
          elev = d === 0 ? 0 : clamp(Math.round(d / 2.3 + R.uniform(-0.4, 0.6)), 0, 4);
        } else {
          let h = 1;
          for (const b of bumps) h += b.h * Math.exp(-((x - b.x) ** 2 + (y - b.y) ** 2) / (b.r * b.r));
          elev = clamp(Math.round(h - 0.5 + R.uniform(-0.4, 0.4)), 0, 4);
        }
        const t = {
          x, y, elev, type: "grass", fert: sc.terrain.sterile ? 0 : clamp(0.45 + R.uniform(-0.15, 0.15), 0, 1),
          moist: 0.5, flood: 0, contam: 0, salt: 0, wood: 0, stone: 0, salvage: 0, silt: false,
          field: false, crop: null, structure: null, greenhouse: false, lights: false, raised: false, irrigated: false, levee: false,
        };
        if (T.river && y === riverY[x]) { t.type = "river"; t.elev = 0; }
        this.tiles.push(t);
      }
      // features, placed as clusters
      const place = (type, share, pick) => {
        const target = Math.round(share * W * H);
        let placed = 0, guard = 0;
        while (placed < target && guard++ < 2000) {
          const cx = R.randint(0, W - 1), cy = R.randint(0, H - 1);
          const size = R.randint(2, 6);
          for (let k = 0; k < size && placed < target; k++) {
            const t = this.tile(cx + R.randint(-1, 1), cy + R.randint(-1, 1));
            if (t && t.type === "grass" && pick(t)) { this.setType(t, type); placed++; }
          }
        }
      };
      place("ruins", T.ruins || 0, (t) => t.elev >= 1);
      place("rock", T.rock || 0, (t) => t.elev >= 2);
      place("forest", T.forest || 0, () => true);
      place("marsh", T.marsh || 0, (t) => t.elev <= 1);
      place("sand", T.sand || 0, () => true);
      place("ice", T.ice || 0, () => true);
      // soil hazards
      for (const t of this.tiles) {
        if (T.contam && this.tiles.some((r) => r.type === "ruins" && this.dist(r, t) <= 3)) t.contam = clamp(R.uniform(0.2, 0.7) * T.contam * 2, 0, 0.9);
        if (T.salt && t.elev <= 2) t.salt = clamp(T.salt * (1 - t.elev * 0.3) + R.uniform(-0.1, 0.1), 0, 1);
      }
      // home: a dry, fairly central tile at elevation >= 2 if possible
      const cands = this.tiles.filter((t) => this.isLand(t) && t.type !== "rock" && t.type !== "ice");
      this.home = cands.reduce((best, t) => {
        const score = (t.elev >= 2 ? 3 : t.elev) - this.dist(t, { x: W / 2, y: H / 2 }) * 0.25;
        return score > best.s ? { t, s: score } : best;
      }, { t: cands[0], s: -1e9 }).t;
      if (this.home.type !== "grass" && this.home.type !== "sand") this.setType(this.home, sc.terrain.sterile ? "sand" : "grass");
      if (sc.startShelter) {
        this.home.structure = { type: "shelter", hp: 100, hab: true, heater: true, built: 0 };
        this.note("event", "The hab still holds pressure: shelter for 4, but it needs 2 power a day for heat.");
      }
      if (sc.startPower) {
        const spot = this.neighbors(this.home).find((t) => this.isLand(t) && !t.structure && t.type !== "ice");
        if (spot) spot.structure = { type: "solar_array", hp: 100, panels: sc.startPower.panels, built: 0 };
        this.power.capacity = sc.startPower.battery;
        this.power.stored = sc.startPower.battery;
      }
      // desert oases: small ponds in the lowest ground
      if (T.oasis) {
        const low = this.tiles.filter((t) => t !== this.home && this.isLand(t)).sort((a, b) => a.elev - b.elev || R.random() - 0.5);
        for (const t of low.slice(0, T.oasis)) { t.type = "lake"; t.elev = 0; this.neighbors(t).forEach((n) => { if (n.type === "sand") this.setType(n, "grass"); }); }
      }
    }
    setType(t, type) {
      t.type = type;
      if (type === "forest") t.wood = this.R.randint(12, 20);
      if (type === "rock") t.stone = this.R.randint(10, 18);
      if (type === "ruins") t.salvage = this.R.randint(10, 18);
      if (type === "sand") t.fert = this.sc.terrain.sterile ? 0 : 0.15;
      if (type === "marsh") { t.fert = 0.6; t.moist = 0.9; }
      if (type === "ice") t.stone = 6;
    }

    // ------------------------------------------------------------ weather
    initWeather() {
      this.disaster = null;
      this.riverLevel = 0;
      this.forecast = [];
      this.pendingDisasters = [];
      if (this.sc.opening) {
        const o = this.sc.opening;
        this.disaster = { type: o.type, daysLeft: o.days, level: o.level || 2 };
        this.lived = { [o.type]: true };
        this.note("event", `${DISASTERS[o.type].name}: ${DISASTERS[o.type].desc}`);
      }
      this.dirtyWaterDay = -99;
      for (let i = 0; i < 4; i++) this.forecast.push(this.rollWeather(this.dayOfYear + i));
      this.weather = this.forecast.shift();
    }
    climateTemp(doy) {
      const c = this.sc.climate;
      // coldest around day 315 (mid-winter), warmest around day 135
      return c.mean + c.amp * Math.sin(((doy - 45) / YEAR) * 2 * Math.PI);
    }
    rollWeather(doy) {
      const c = this.sc.climate, R = this.R;
      // disasters are decided when the day enters the forecast, so the
      // forecast is honest
      let event = null;
      if (!this.disaster && !this.forecast.some((f) => f.event)) {
        const season = Math.sin(((doy - 45) / YEAR) * 2 * Math.PI); // +1 midsummer, -1 midwinter
        const types = Object.entries(this.sc.disasters);
        // shuffle so earlier table entries don't always win ties
        for (let i = types.length - 1; i > 0; i--) { const j = R.randint(0, i); [types[i], types[j]] = [types[j], types[i]]; }
        for (const [type, p] of types) {
          if (!this.canHappen(type)) continue;
          let seasonal = 1;
          if (type === "frost") seasonal = season < -0.3 ? 2.5 : 0.3;
          if (type === "heatwave" || type === "drought") seasonal = season > 0.3 ? 2 : 0.3;
          if (type === "wildfire") seasonal = season > 0.2 ? 2.2 : season < -0.4 ? 0.1 : 0.6;
          if (type === "outbreak" && this.day - (this.dirtyWaterDay ?? -99) < 5) seasonal = 4; // truth: dirty water spreads disease
          if (R.chance(p * seasonal * this.hazardMult)) { event = type; break; }
        }
      }
      const temp = this.climateTemp(doy) + R.uniform(-c.noise, c.noise);
      return {
        doy, temp, event,
        rain: R.chance(c.rain) ? R.uniform(0.3, 1) : 0,
        sun: clamp(c.sun + R.uniform(-0.25, 0.2), 0.05, 1),
        wind: clamp(c.wind + R.uniform(-0.25, 0.3), 0, 1),
      };
    }
    advanceWeather() {
      this.weather = this.forecast.shift();
      this.forecast.push(this.rollWeather(this.dayOfYear + 3));
      const w = this.weather;
      if (w.event && !this.disaster) this.startDisaster(w.event);
      const dz = this.disaster && this.disaster.type;
      if (dz === "storm") { w.wind = 1; w.rain = Math.max(w.rain, 0.9); w.sun *= 0.4; }
      if (dz === "flood") { w.rain = Math.max(w.rain, 0.6); w.sun *= 0.6; }
      if (dz === "frost") w.temp -= 12;
      if (dz === "heatwave") { w.temp += 10; w.rain = 0; }
      if (dz === "drought") w.rain = 0;
      if (dz === "ashfall") { w.sun *= 0.25; w.temp -= 3; }
      if (this.sc.climate.rain === 0) w.rain = 0;
    }

    // ------------------------------------------------------------ land
    updateLand() {
      const w = this.weather, dz = this.disaster && this.disaster.type;
      // river level
      const target = dz === "flood" ? this.disaster.level : dz === "drought" ? -1 : 0;
      this.riverLevel += clamp(target - this.riverLevel, -1, 1);
      this.flow = this.sc.terrain.river ? (this.riverLevel >= 1 ? 1.6 : this.riverLevel < 0 ? 0.3 : 1) : 0;
      for (const t of this.tiles) {
        if (this.isWater(t)) continue;
        // flooding
        const protect = (t.levee ? 2 : 0) + (t.raised ? 1 : 0);
        // a river at level L floods land lower than L; normal level is 0
        const depth = this.sc.terrain.river ? Math.max(0, this.riverLevel - t.elev - protect) : 0;
        if (t.flood > 0 && depth === 0) {
          t.silt = true; // truth: floodwater leaves fertile silt behind
          t.fert = clamp(t.fert + 0.15, 0, 1);
        }
        t.flood = depth;
        // moisture
        if (t.flood) t.moist = 1;
        else if (t.irrigated) t.moist = Math.max(t.moist, 0.75);
        else {
          const dry = 0.04 + 0.05 * w.sun + (w.temp > 28 ? 0.05 : 0) + (t.type === "sand" ? 0.04 : 0);
          t.moist = clamp(t.moist + w.rain * 0.35 - dry, 0, 1);
        }
        // rain washes salt out; forests regrow
        if (t.salt > 0 && w.rain > 0) t.salt = Math.max(0, t.salt - w.rain * 0.012);
        if (t.type === "forest" && t.wood < 20 && this.R.chance(0.08)) t.wood += 1;
        // storms damage exposed structures
        if (dz === "storm" && t.structure && ["wind_turbine", "rain_catcher", "solar_array"].includes(t.structure.type) && this.R.chance(0.15)) {
          t.structure.hp -= this.R.randint(15, 40);
          if (t.structure.hp <= 0) { this.note("event", `The storm wrecked the ${TECHNIQUES[t.structure.type].name.toLowerCase()} at (${t.x},${t.y}).`); t.structure = null; }
        }
        if (dz === "storm" && t.greenhouse && this.R.chance((t.bracedUntil || 0) >= this.day ? 0.02 : 0.08)) { this.loseCover(t); this.note("event", `Wind tore the greenhouse cover off (${t.x},${t.y}).`); }
        if (t.flood >= 2 && t.structure && !["well", "water_wheel"].includes(t.structure.type) && this.R.chance(0.3)) {
          t.structure.hp -= 30;
          if (t.structure.hp <= 0) { this.note("event", `Floodwater destroyed the ${TECHNIQUES[t.structure.type].name.toLowerCase()} at (${t.x},${t.y}).`); t.structure = null; }
        }
        if (t.charred > 0) t.charred--;
      }
      this.dailyHazards();
    }

    // ------------------------------------------------------------ hazards
    canHappen(type) {
      const T = this.sc.terrain;
      if (type === "flood") return !!T.river;
      if (type === "wildfire") return !T.sterile && this.tiles.filter((t) => this.burnable(t)).length > 8;
      if (type === "outbreak") return !T.sterile; // sealed hab: no fevers on Mars
      return true;
    }
    startDisaster(type, forced = false) {
      const d = DISASTERS[type];
      this.disaster = { type, daysLeft: this.R.randint(d.days[0], d.days[1]), level: this.R.randint(1, 3), forced, startDay: this.day };
      (this.lived = this.lived || {})[type] = true;
      this.note("event", `${d.name} begins: ${d.desc}`);
      if (type === "earthquake") this.quake(1);
      if (type === "wildfire") {
        const cands = this.tiles.filter((t) => this.burnable(t) && this.dist(t, this.home) >= 4);
        const pool = cands.filter((t) => t.type === "forest").length ? cands.filter((t) => t.type === "forest") : cands;
        const n = Math.min(pool.length, this.R.randint(1, 2));
        for (let i = 0; i < n; i++) { const t = this.R.choice(pool); t.burning = t.type === "forest" ? 3 : 2; }
        if (!n) { this.note("event", "A grass fire flared up and burned itself out."); this.disaster.daysLeft = 0; }
      }
      if (type === "blight") {
        const crops = this.tiles.filter((t) => t.crop && !t.greenhouse);
        const byType = {};
        for (const t of crops) byType[t.crop.type] = (byType[t.crop.type] || 0) + 1;
        const worst = Object.entries(byType).sort((a, b) => b[1] - a[1])[0];
        if (worst) {
          const victims = crops.filter((t) => t.crop.type === worst[0]);
          for (let i = 0; i < Math.min(2, victims.length); i++) this.R.choice(victims).crop.blight = true;
          this.note("event", `Blight showed up on the ${CROPS[worst[0]].name.toLowerCase()}.`);
        } else this.note("event", "Blight spores are in the air: anything planted in the next days is at risk.");
      }
      if (type === "outbreak") {
        const healthy = this.alive.filter((s) => !s.sick);
        const n = Math.min(healthy.length, this.R.randint(1, 2));
        for (let i = 0; i < n; i++) { const s = healthy.splice(this.R.randint(0, healthy.length - 1), 1)[0]; s.sick = this.R.randint(5, 9); }
        if (n && this.day - this.dirtyWaterDay < 5 && !this.beliefs.hazard.boilWater) {
          this.hazardLesson("boilWater", "People fell sick days after we drank unboiled water. From now on we always boil it, even if it means chopping wood first.");
        }
      }
    }
    hazardLesson(key, msg) {
      const h = this.beliefs.hazard;
      if (h[key]) return;
      h[key] = true;
      h.learned.push(`Day ${this.day + 1}: ${msg}`);
      this.note("learn", msg);
    }
    burnable(t) {
      if (this.isWater(t) || t.flood > 0 || t.firebreak || t.burning) return false;
      if (["rock", "ice", "sand", "ruins"].includes(t.type) && !t.structure) return false;
      if (t.structure && t.structure.hab) return false;
      return ["forest", "grass", "field", "marsh"].includes(t.type) || !!t.structure;
    }
    quake(mag) {
      let damaged = 0;
      for (const t of this.tiles) {
        const s = t.structure;
        if (t.greenhouse && this.R.chance((this.sc.terrain.sterile ? 0.08 : 0.25) * mag)) { this.loseCover(t); damaged++; this.note("event", `The greenhouse at (${t.x},${t.y}) shattered.`); }
        if (!s) continue;
        const dmg = this.R.randint(10, 60) * mag * (s.hab ? 0.4 : 1);
        s.hp -= dmg;
        if (dmg > 5) damaged++;
        if (s.repairedDay !== undefined && this.day - s.repairedDay <= 4 && dmg > 15) {
          this.hazardLesson("quakeWait", "An aftershock wrecked what we had just repaired. After a big quake we'll wait for the shaking to stop before rebuilding.");
        }
        if (s.type === "well") {
          if (s.ok && dmg > 30 && this.R.chance(0.5)) { s.ok = false; this.note("event", `The well at (${t.x},${t.y}) collapsed.`); }
          else if (!s.ok && this.R.chance(0.08 * mag)) { s.ok = true; this.note("learn", `The quake opened a spring: the dry well at (${t.x},${t.y}) now has water.`); }
        }
        if (s.hp <= 0) {
          this.note("event", `The ${TECHNIQUES[s.type].name.toLowerCase()} at (${t.x},${t.y}) collapsed.`);
          if (s.type === "shelter") for (const p of this.alive) if (p.x === t.x && p.y === t.y) { p.health -= this.R.randint(10, 25); p.cause = "Crushed"; }
          t.structure = null;
        }
      }
      if (mag < 1 && damaged) this.note("event", `Aftershock: ${damaged} structures took damage.`);
    }
    dailyHazards() {
      const w = this.weather, dz = this.disaster && this.disaster.type, R = this.R;
      // --- fire
      const burning = this.tiles.filter((t) => t.burning > 0);
      if (burning.length) {
        const dry = (dz === "drought" || dz === "heatwave") ? 1.3 : 1;
        for (const t of burning) {
          if (w.rain > 0.3 && R.chance(w.rain * 0.6)) { t.burning = 0; continue; }
          for (const n of this.neighbors(t)) {
            if (!this.burnable(n)) continue;
            const fuel = n.type === "forest" ? 1.4 : n.type === "marsh" ? 0.3 : n.type === "field" && !n.crop ? 0.4 : 1;
            const p = 0.22 * (0.6 + w.wind) * (1.2 - n.moist) * fuel * dry * (w.rain > 0 ? 0.3 : 1);
            if (R.chance(p)) n.burning = n.type === "forest" ? 3 : 2;
          }
          t.burning--;
          if (t.burning <= 0) this.burnOut(t);
        }
        for (const p of this.alive) { const t = this.tile(p.x, p.y); if (t.burning > 0 && !(p.task && p.task.kind === "fight_fire")) { p.health -= 12; p.cause = "Burns"; } }
        if (this.disaster && this.disaster.type === "wildfire") this.disaster.daysLeft = Math.max(this.disaster.daysLeft, 2);
      }
      if (dz === "wildfire" && !burning.length && this.disaster.daysLeft > 1) this.disaster.daysLeft = 1;
      // --- aftershocks
      if (dz === "earthquake" && this.day > this.disaster.startDay && R.chance(0.6)) this.quake(0.45);
      // --- blight
      let sameSpread = 0;
      for (const t of this.tiles) {
        if (!t.crop || !t.crop.blight) continue;
        t.crop.health -= 0.07;
        for (const n of this.neighbors(t)) {
          if (!n.crop || n.crop.blight || n.greenhouse) continue;
          const same = n.crop.type === t.crop.type;
          if (R.chance(same ? 0.3 : 0.03)) { n.crop.blight = true; if (same) sameSpread++; }
        }
        if (t.crop.health <= 0) this.cropDies(t, "blight");
      }
      this.blightSameSpread = (this.blightSameSpread || 0) + sameSpread;
      if (this.blightSameSpread >= 3) this.hazardLesson("mixCrops", "Blight jumps between neighbouring plots of the same crop and mostly skips different ones. We'll mix crops from now on.");
      // --- outbreak persists while anyone is sick
      if (dz === "outbreak" && this.alive.some((s) => s.sick)) this.disaster.daysLeft = Math.max(this.disaster.daysLeft, 2);
    }
    burnOut(t) {
      t.burning = 0; t.charred = 25; t.ashDay = this.day;
      const lost = [];
      if (t.type === "forest") { t.type = "grass"; t.wood = 0; lost.push("forest"); }
      if (t.crop) { lost.push(CROPS[t.crop.type].name.toLowerCase()); this.stats.cropsLost++; this.beliefs.crops[t.crop.type].lost++; t.crop = null; }
      if (t.greenhouse) { t.greenhouse = false; t.lights = false; lost.push("greenhouse"); }
      if (t.structure && !t.structure.hab && t.structure.type !== "well") { lost.push(TECHNIQUES[t.structure.type].name.toLowerCase()); t.structure = null; }
      t.fert = clamp(t.fert + 0.2, 0, 1); // truth: ash is fertiliser
      t.ash = true;
      if (lost.some((x) => x !== "forest")) {
        this.note("event", `Fire destroyed the ${lost.filter((x) => x !== "forest").join(", ")} at (${t.x},${t.y}).`);
        this.hazardLesson("fireAware", "Fire races through dry grass and forest, faster in wind. We'll keep a cleared firebreak around the settlement in dry weather.");
      }
    }

    // ------------------------------------------------------------ production
    windAt(t) { return this.weather.wind * (0.45 + 0.2 * t.elev); } // truth: valleys are sheltered
    produce() {
      const w = this.weather, dz = this.disaster && this.disaster.type;
      let power = 0, water = 0;
      const outputs = [];
      for (const t of this.tiles) {
        const s = t.structure;
        if (!s || t.flood >= 2) continue;
        if (s.type === "rain_catcher") water += w.rain * 6;
        if (s.type === "well" && s.ok) water += dz === "drought" ? 3 : 6;
        if (s.type === "solar_still") water += 2 * w.sun;
        if (s.type === "water_wheel") { const p = 6 * (this.flow || 0); power += p; outputs.push(["water_wheel", p]); }
        if (s.type === "wind_turbine") { const p = 6 * this.windAt(t); power += p; outputs.push(["wind_turbine", p]); }
        if (s.type === "solar_array") { const p = 5 * w.sun * (s.panels || 1); power += p; outputs.push(["solar_array", p / (s.panels || 1)]); }
        if (s.type === "biogas" && this.inv.compost >= 1) { this.inv.compost -= 1; power += 2; }
      }
      // learn real outputs of uncertain power sources
      for (const [type, out] of outputs) {
        const b = this.beliefs.tech[type];
        if (!b) continue;
        b.samples++;
        b.output += (out - b.output) * 0.1;
        if (b.samples === 20) {
          const hand = 5;
          if (Math.abs(b.output - hand) > 1.2) {
            const msg = `${TECHNIQUES[type].name} really averages ${b.output.toFixed(1)} power/day here (handbook said ~${hand}).`;
            b.learned.push(msg); this.note("learn", msg);
          }
        }
      }
      // spend power: heaters when cold, grow lights over growing crops, ice
      // drills, radio. Handbook: lights over empty beds are switched off, and
      // living crops come before topping up a water tank that isn't low.
      let avail = power + this.power.stored;
      const consumers = [];
      const waterLow = this.inv.water < this.alive.length * 4;
      for (const t of this.tiles) {
        const s = t.structure;
        if (s && s.type === "shelter" && s.heater && this.coldTonight()) consumers.push({ t, kind: "heat", cost: 2 });
        if (s && s.type === "ice_drill" && this.inv.water < this.alive.length * 20) consumers.push({ t, kind: waterLow ? "drillUrgent" : "drill", cost: 2 });
        if (t.lights) { if (t.crop) consumers.push({ t, kind: "lights", cost: 2 }); else t.powered = false; }
        if (s && s.type === "radio") consumers.push({ t, kind: "radio", cost: 1 });
      }
      const order = { heat: 0, drillUrgent: 1, lights: 2, drill: 3, radio: 4 };
      consumers.sort((a, b) => order[a.kind] - order[b.kind]);
      let used = 0;
      const short = [];
      for (const c of consumers) {
        c.t.powered = avail >= c.cost;
        if (c.t.powered) { avail -= c.cost; used += c.cost; if (c.kind === "drill" || c.kind === "drillUrgent") water += 7; }
        else short.push(c.kind);
      }
      this.power.produced = r1(power);
      this.power.used = used;
      this.power.stored = Math.min(this.power.capacity, avail);
      this.power.shortfall = [...new Set(short)];
      this.water.produced = r1(water);
      this.inv.water += water;
    }
    coldTonight() { return this.weather.temp < 10; }

    // ------------------------------------------------------------ crops
    cropTemp(t, temp) {
      const warmed = temp + (t.greenhouse ? 12 : 0);
      return t.lights && t.powered ? Math.max(warmed, 18) : warmed;
    }
    growthRate(c, temp) { // c: crop params (truth or belief)
      if (temp <= c.minT || temp >= c.maxT) return 0;
      if (temp < c.optLo) return (temp - c.minT) / (c.optLo - c.minT);
      if (temp > c.optHi) return (c.maxT - temp) / (c.maxT - c.optHi);
      return 1;
    }
    growCrops() {
      const w = this.weather;
      for (const t of this.tiles) {
        const crop = t.crop;
        if (!crop) continue;
        const truth = CROPS[crop.type], belief = this.beliefs.crops[crop.type];
        // a crop planted today under lights draws from the battery tonight
        if (t.lights && !t.powered && this.power.stored >= 2) { this.power.stored -= 2; this.power.used += 2; t.powered = true; }
        const temp = this.cropTemp(t, w.temp);
        crop.age++;
        // what this crop has been exposed to (to tell "untested" from "wrong")
        belief.lowT = Math.min(belief.lowT ?? 99, temp);
        if (t.flood > 0) belief.wet = true;
        // frost kill
        if (temp <= truth.frostKill) { this.cropDies(t, "frost", temp); continue; }
        // drowning
        if (t.flood > 0 && !truth.flood) {
          crop.health -= 0.25 * t.flood;
          if (crop.health <= 0) { this.cropDies(t, "flood"); continue; }
          // it doesn't have to die for us to see it suffering
          if (belief.flood && crop.health < 0.6) { belief.flood = false; this.learn(crop.type, `${truth.name} wilts in standing floodwater (the handbook was wrong).`); }
        }
        if (t.flood > 0 && truth.flood && belief.flood !== true) { belief.flood = true; this.learn(crop.type, `${truth.name} survived standing floodwater.`); }
        const light = (t.lights && t.powered) ? 1 : (t.greenhouse ? 0.9 : 1) * clamp(w.sun * 1.3, 0.15, 1);
        const want = truth.water;
        const moist = t.flood ? 1 : t.moist;
        const water = truth.flood ? clamp(moist / Math.max(0.3, want), 0.2, 1) : clamp(1 - Math.max(0, want - moist) * 1.6, 0, 1);
        const soil = 0.7 + 0.3 * t.fert; // poor soil mostly shrinks the yield (see harvest), and slows growth a little
        const rate = this.growthRate(truth, temp) * light * water * soil;
        crop.growth += rate / truth.days;
        if (rate < 0.15) crop.health -= 0.012;
        if (water < 0.4) crop.health -= 0.02;
        if (this.disaster && this.disaster.type === "storm" && !t.greenhouse) crop.health -= 0.05;
        crop.health = clamp(crop.health, 0, 1);
        if (crop.health <= 0) { this.cropDies(t, water < 0.4 ? "drought" : "stress"); continue; }
        // learning: crop stalled by cold that the handbook said was fine
        if (temp < truth.minT + 0.5 && temp > belief.minT) {
          belief.coldDays++;
          if (belief.coldDays >= 4) {
            const old = belief.minT;
            belief.minT = Math.max(old, Math.round(temp)); // the stall temperature is the estimate; no safety margin that compounds over years
            belief.coldDays = 0;
            if (belief.minT !== old) this.learn(crop.type, `${truth.name} stops growing below about ${belief.minT} °C (we thought ${old} °C).`);
          }
        }
        if (crop.growth >= 1) crop.ripe = true;
        if (truth.remediates && t.contam > 0) {
          t.contam = Math.max(0, t.contam - 0.004);
          if (!this.discoveries.sunflower && t.contam < crop.contamAtPlant - 0.08) {
            this.discoveries.sunflower = true;
            this.note("learn", "Confirmed: sunflowers are pulling contamination out of the soil.");
          }
        }
      }
    }
    loseCover(t) {
      if (t.crop) { t.coverLost = this.day; t.hadLights = !!t.lights; }
      t.greenhouse = false; t.lights = false;
    }
    cropDies(t, cause, temp) {
      const crop = t.crop, truth = CROPS[crop.type], b = this.beliefs.crops[crop.type];
      // a greenhouse that froze because its lights lost power teaches us to
      // keep spare power, not that the crop is tender
      if (cause === "frost" && t.lights && !t.powered && this.learnPower) {
        const m = this.beliefs.powerMargin || 0;
        this.beliefs.powerMargin = Math.min(8, m + 2);
        if (!m) this.note("learn", `A power cut let the greenhouse at (${t.x},${t.y}) freeze. From now on we keep spare power before lighting more plots.`);
      }
      b.lost++;
      this.stats.cropsLost++;
      this.plotStats.plotDays += crop.age;
      t.crop = null;
      this.note("event", `${truth.name} at (${t.x},${t.y}) died (${cause}).`);
      if (cause === "frost" && temp > b.frostKill) {
        const old = b.frostKill;
        b.frostKill = Math.ceil(temp); // it died at this temperature, so it can't take this much cold
        this.learn(crop.type, `${truth.name} is killed by frost at ${temp.toFixed(0)} °C (we thought it survives to ${old} °C).`);
      }
      if (cause === "flood" && b.flood) {
        b.flood = false;
        this.learn(crop.type, `${truth.name} drowns in floodwater (the handbook was wrong).`);
      }
    }
    learn(crop, msg) {
      this.beliefs.crops[crop].learned.push(`Day ${this.day + 1}: ${msg}`);
      this.note("learn", msg);
    }
    harvest(t, s) {
      const crop = t.crop, truth = CROPS[crop.type], b = this.beliefs.crops[crop.type];
      const food = Math.round(truth.yield * crop.health * (0.5 + 0.5 * t.fert) * (1 - t.contam * 0.8) * (1 - Math.max(0, t.salt - truth.saltTol) * 0.9) * (0.9 + 0.2 * s.skills.farming / 1.5));
      // expect what the handbook says after local salt and contamination, so
      // the correction learns about the crop, not about this particular field
      const expected = b.yield * crop.health * (0.5 + 0.5 * crop.fertAtPlant) * b.yieldFactor
        * (1 - t.contam * 0.8) * (1 - Math.max(0, t.salt - truth.saltTol) * 0.9);
      const ratio = food / Math.max(1, expected);
      b.yieldFactor = clamp(b.yieldFactor + (ratio - 1) * 0.35 * b.yieldFactor, 0.2, 2);
      if (b.harvested === 1 && Math.abs(b.yieldFactor - 1) > 0.2) {
        this.learn(crop.type, `${truth.name} yields about ${Math.round(b.yieldFactor * 100)}% of what the handbook promised here.`);
      }
      if (t.ash && !this.beliefs.hazard.ashFertile && ratio > 1.05) {
        this.hazardLesson("ashFertile", "Burnt ground grows more than expected: the ash is fertiliser. Old fire scars make good fields.");
      }
      // discovery: flood silt
      if (t.silt && !this.discoveries.silt) {
        this.siltWins = (this.siltWins || 0) + (t.fert > crop.fertAtPlant - 0.01 && ratio > 1.05 ? 1 : 0);
        if (this.siltWins >= 1 && crop.fertAtPlant > 0.55) {
          this.discoveries.silt = true;
          this.note("learn", "Discovered: fields that flooded are more fertile afterwards. River silt! We'll plant on old flood ground first.");
        }
      }
      b.harvested++;
      this.plotStats.food += food; this.plotStats.plotDays += crop.age;
      this.inv.food += food;
      this.inv.compost += 2;
      const seedBack = this.R.randint(2, 4);
      this.seeds[crop.type] = (this.seeds[crop.type] || 0) + seedBack;
      t.fert = clamp(t.fert - truth.feed, 0, 1);
      this.stats.harvested += food; this.stats.harvests++;
      this.recentHarvest.push([this.day, food]);
      this.gainFood(food);
      t.crop = null;
      return food;
    }

    gainFood(n) {
      this.recentFood = this.recentFood || [];
      this.recentFood.push([this.day, n]);
      if (this.recentFood.length > 600) this.recentFood.splice(0, 200);
    }

    // ------------------------------------------------------------ people
    addSurvivor(x, y) {
      const R = this.R;
      const skills = {};
      for (const k of SKILLS) skills[k] = Math.round(R.uniform(0.6, 1.4) * 100) / 100;
      // everybody is good at something
      skills[R.choice(SKILLS)] = Math.round(R.uniform(1.3, 1.7) * 100) / 100;
      const s = { id: this.nextId++, name: R.choice(NAMES), x, y, health: 100, task: null, status: "Getting bearings", skills, xp: {} };
      this.survivors.push(s);
      return s;
    }

    // ================================================================ the colony mind
    assess() {
      const pop = Math.max(1, this.alive.length);
      const heat = this.disaster && this.disaster.type === "heatwave" ? 1.5 : 1;
      const temps = [this.weather.temp, ...this.forecast.map((f) => f.temp - (f.event === "frost" ? 12 : 0))];
      const minT = Math.min(...temps);
      const waterProdEst = this.estimateWaterProduction();
      const waterNet = waterProdEst - pop * heat;
      const waterDays = this.inv.water / (pop * heat);
      const growing = this.tiles.filter((t) => t.crop);
      const prodRate = growing.reduce((a, t) => {
        const b = this.beliefs.crops[t.crop.type];
        return a + (b.yield * b.yieldFactor * t.crop.health) / b.days;
      }, 0);
      const foodDays = this.inv.food / pop;
      const shelterCap = this.tiles.reduce((a, t) => a + (t.structure && t.structure.type === "shelter" && t.flood < 2 ? 4 : 0), 0);
      const cold = minT < 10;
      const occupied = Math.min(Math.ceil(pop / 4), Math.ceil(shelterCap / 4));
      const heated = this.tiles.filter((t) => t.structure && t.structure.type === "shelter" && t.structure.heater).length;
      const fireNeed = cold ? Math.max(0, occupied - heated) : 0;
      const floodSoon = (this.disaster && this.disaster.type === "flood") || this.forecast.some((f) => f.event === "flood");
      const stormSoon = (this.disaster && this.disaster.type === "storm") || this.forecast.some((f) => f.event === "storm");
      const fields = this.tiles.filter((t) => t.field).length;
      const powerNeed = this.powerDemand();

      const u = {};
      u.safety = (floodSoon && this.floodExposed().length) ? 0.9 : stormSoon ? 0.3 : 0;
      const unsheltered = Math.max(0, pop - shelterCap);
      const harsh = minT < -10 ? 1 : minT < 5 ? 0.85 : minT < 12 ? 0.55 : 0.15;
      u.warmth = unsheltered > 0 ? harsh : 0;
      const woodDays = fireNeed ? this.inv.wood / fireNeed : 99;
      u.fuel = cold && woodDays < 6 ? clamp((6 - woodDays) / 6, 0.2, 0.9) : 0;
      u.water = waterNet >= 0 ? (waterDays < 2 ? 0.4 : 0.05) : clamp((8 - waterDays) / 8, 0.15, 1);
      u.waterSource = waterNet < 0 ? clamp(0.45 + (-waterNet / pop) * 0.4, 0.45, 0.9) : 0;
      u.food = clamp((21 - foodDays) / 18, 0, 1);
      u.farming = clamp(1 - prodRate / pop, 0, 1) * (foodDays < 60 ? 1 : 0.5);
      const margin = this.beliefs.powerMargin || 0;
      u.power = powerNeed + margin > this.power.produced + 0.5 ? clamp(0.35 + (powerNeed + margin - this.power.produced) * 0.08, 0.35, 0.85) : (this.power.produced === 0 ? 0.2 : 0.05);
      u.growth = this.sc.noRadio ? 0 : pop < 8 && foodDays > 20 && waterNet >= 0 ? 0.25 : 0.05;
      // player priority boosts one need
      const map = { water: ["water", "waterSource"], food: ["food", "farming"], warmth: ["warmth", "fuel"], power: ["power"], safety: ["safety"] };
      for (const k of Object.keys(u)) u[k] = Math.min(1, u[k] * (this.brain[k] ?? 1));
      for (const k of map[this.priority] || []) u[k] = Math.min(1, (u[k] || 0) + 0.45);

      return { pop, heat, minT, waterNet, waterDays, waterProdEst, foodDays, prodRate, shelterCap, fireNeed, woodDays, floodSoon, stormSoon, fields, powerNeed, cold, u };
    }
    estimateWaterProduction() {
      let w = 0;
      for (const t of this.tiles) {
        const s = t.structure;
        if (!s) continue;
        if (s.type === "rain_catcher") w += 6 * this.sc.climate.rain * 0.65;
        if (s.type === "well" && s.ok) w += 6;
        if (s.type === "solar_still") w += 2 * this.sc.climate.sun;
        if (s.type === "ice_drill") w += 7;
      }
      return w;
    }
    powerDemand() {
      let d = 0;
      for (const t of this.tiles) {
        const s = t.structure;
        if (s && s.type === "shelter" && s.heater) d += this.sc.climate.mean < 10 ? 2 : 0.5;
        if (s && s.type === "ice_drill") d += 2;
        if (s && s.type === "radio") d += 1;
        if (t.lights) d += 2;
      }
      if (this.sc.terrain.sterile && !this.tiles.some((t) => t.structure && t.structure.type === "ice_drill")) d += 2;
      return d;
    }
    floodExposed() {
      if (!this.sc.terrain.river) return [];
      const lvl = Math.max(this.disaster && this.disaster.type === "flood" ? this.disaster.level : 0,
        this.forecast.some((f) => f.event === "flood") ? 2 : 0);
      return this.tiles.filter((t) => this.isLand(t) && (t.crop || t.structure) && !t.levee
        && t.elev + (t.raised ? 1 : 0) < lvl && !(t.crop && this.beliefs.crops[t.crop.type].flood));
    }

    // what can we build, and what's missing?
    missingFor(req) {
      const miss = {};
      for (const [k, v] of Object.entries(req || {})) if ((this.inv[k] || 0) < v) miss[k] = v - (this.inv[k] || 0);
      return miss;
    }
    techCost(id) {
      const tech = TECHNIQUES[id];
      const m = this.missingFor(tech.requires);
      if (Object.keys(m).length && tech.alt && !Object.keys(this.missingFor(tech.alt)).length) return { req: tech.alt, missing: {} };
      return { req: tech.requires, missing: m };
    }
    reserved(t) { return this.alive.some((s) => s.task && s.task.x === t.x && s.task.y === t.y); }
    freeLand(t) {
      return this.isLand(t) && !t.structure && !t.field && t.flood === 0 && !["rock", "ice"].includes(t.type) && !this.reserved(t);
    }
    siteFor(id) {
      const home = this.home, T = this.tiles;
      const near = (list, extra = () => 0) => list.length ? list.reduce((a, t) => {
        const s = -this.dist(t, home) + extra(t);
        return s > a.s ? { t, s } : a;
      }, { t: null, s: -1e9 }).t : null;
      const safeElev = (t) => (this.sc.terrain.river ? (t.elev >= 2 ? 3 : t.elev * 1.2) : 0);
      switch (TECHNIQUES[id].site) {
        case "land": return near(T.filter((t) => this.freeLand(t) && t.type !== "forest"), safeElev);
        case "high": return near(T.filter((t) => this.freeLand(t)), (t) => t.elev * 2.5);
        case "riverbank": return near(T.filter((t) => this.freeLand(t) && this.neighbors(t).some((n) => n.type === "river")));
        case "ice": return near(T.filter((t) => t.type === "ice" && !t.structure && !this.reserved(t)));
        case "shelter": return near(T.filter((t) => t.structure && t.structure.type === "shelter" && !t.structure.heater && !this.reserved(t)));
        case "field": return null; // chosen per field by the farm planner
        case "greenhouse": return near(T.filter((t) => t.greenhouse && !t.lights && !this.reserved(t)));
        case "field_near_water": return near(T.filter((t) => t.field && !t.irrigated && !this.reserved(t)
          && this.neighbors(t).some((n) => n.type === "river" || n.type === "lake" || (n.structure && n.structure.type === "well" && n.structure.ok))));
        case "floodable": return near(this.floodExposed().filter((t) => !this.reserved(t)), (t) => (t.crop ? 3 : 0));
        default: return null;
      }
    }
    wellChance(t) { // belief
      const b = this.beliefs.tech.well.byElev[t.elev];
      return b.ok / (b.ok + b.fail);
    }

    // crop advisor: expected food from planting crop on tile t today (beliefs only)
    cropAdvice(t) {
      const out = [];
      for (const [id, n] of Object.entries(this.seeds)) {
        if (n <= 0) continue;
        const b = this.beliefs.crops[id];
        let growth = 0, risk = null, days = 0;
        const horizon = Math.min(b.days * 2, 200);
        for (let d = 0; d < horizon && growth < 1; d++) {
          const raw = this.climateTemp(this.dayOfYear + d) + (t.greenhouse ? 12 : 0);
          const temp = t.lights ? Math.max(raw, 18) : raw;
          if (temp <= b.frostKill + 1) { risk = `frost around day ${d}`; break; }
          const light = (t.lights ? 1 : clamp(this.sc.climate.sun * 1.3, 0.15, 1));
          const canWater = this.inv.water > this.alive.length * 6 ? 0.55 : 0;
          const moist = t.irrigated ? 0.75 : Math.max(t.moist, this.sc.climate.rain * 1.4, canWater);
          const water = b.flood ? 1 : clamp(1 - Math.max(0, b.water - moist) * 1.6, 0, 1);
          growth += this.growthRate(b, temp) * light * water * (0.7 + 0.3 * t.fert) / b.days;
          days = d + 1;
        }
        const fertMult = 0.5 + 0.5 * t.fert;
        const saltMult = 1 - Math.max(0, t.salt - b.saltTol) * 0.9;
        const contamMult = 1 - t.contam * 0.8;
        let expected = growth >= 1 ? b.yield * b.yieldFactor * fertMult * saltMult * contamMult : 0;
        if (!risk && growth < 1) risk = "won't ripen in time";
        if (b.remediates && t.contam > 0.2) expected += 15 * t.contam; // value of cleaning soil
        const floodRisk = this.sc.terrain.river && t.elev <= 1 && !t.raised && !b.flood;
        if (floodRisk) expected *= 0.75;
        const sameNext = this.beliefs.hazard.mixCrops && this.neighbors(t).some((nb) => nb.crop && nb.crop.type === id);
        if (sameNext) expected *= 0.8;
        out.push({ crop: id, name: b.name, expected: Math.round(expected), days, risk: risk || (floodRisk ? "flood-prone plot" : sameNext ? "same crop next door (blight)" : null), seeds: n });
      }
      return out.sort((a, b) => b.expected - a.expected);
    }
    siteForIrrigation(t) {
      return t.field && !t.irrigated && !this.reserved(t) && this.neighbors(t).some((n) => this.isWater(n) || (n.structure && n.structure.type === "well" && n.structure.ok));
    }
    fieldScore(t) {
      let s = t.fert * 3 + (t.moist > 0.3 ? 0.5 : 0) - this.dist(t, this.home) * 0.2 - t.salt * 2 - t.contam * 2;
      if (t.type === "marsh") s += 0.3;
      // in dry country, fields must sit next to water so they can be irrigated
      if (this.sc.climate.rain < 0.2 && this.neighbors(t).some((n) => this.isWater(n))) s += 2.5;
      if (this.discoveries.silt && t.silt) s += 1.5;
      if (this.sc.terrain.river && t.elev <= 1) s -= this.beliefsFloodWary() ? 1.2 : 0.2;
      return s;
    }
    beliefsFloodWary() { return this.stats.cropsLost > 0 || this.day > 20; }

    // Enumerate candidate actions with a value. Units are roughly
    // "person-days of need covered", divided by the work-days it takes.
    candidates(A) {
      const C = [];
      const u = A.u, pop = A.pop;
      const add = (o) => { if (o.value > 0.01) C.push(o); };
      const gatherFor = (missing, parentValue, parentLabel, parentNeed) => {
        for (const [res, amt] of Object.entries(missing)) {
          const g = this.gatherOption(res, amt);
          // materials inherit the priority of what they're for
          if (g) add({ ...g, value: parentValue * 0.55 / Math.max(1, g.daysNeeded), why: `to get ${amt} ${res} for ${parentLabel}${g.expectDays && g.expectDays !== g.daysNeeded ? ` (from experience: ~${g.expectDays} days of digging)` : ""}`, need: parentNeed || "materials" });
        }
      };
      const buildOption = (id, value, why, site = null) => {
        const tech = TECHNIQUES[id];
        site = site || this.siteFor(id);
        if (!site) return;
        const { req, missing } = this.techCost(id);
        const lacksTools = (tech.tools || 0) > this.inv.tools;
        if (lacksTools) missing.tools = tech.tools - this.inv.tools;
        const label = `Build ${tech.name.toLowerCase()} at (${site.x},${site.y})`;
        if (Object.keys(missing).length) {
          C.push({ label, need: tech.need, value: value / tech.days, missing, blocked: true, why });
          gatherFor(missing, value, tech.name.toLowerCase(), tech.need);
        } else {
          add({ label, need: tech.need, value: value / tech.days, why, task: { kind: "build", tech: id, x: site.x, y: site.y, work: tech.days, req }, skill: tech.skill });
        }
      };

      // --- safety: floods
      if (u.safety > 0 && A.floodSoon) {
        for (const t of this.floodExposed().slice(0, 3)) {
          const val = u.safety * (t.crop ? 25 : 18);
          if (t.crop && t.crop.growth > 0.7) add({ label: `Harvest ${CROPS[t.crop.type].name.toLowerCase()} early before the flood (${t.x},${t.y})`, need: "safety", value: val, why: "flood forecast", task: { kind: "harvest", x: t.x, y: t.y, work: 1, early: true }, skill: "farming" });
          else buildOption("levee", val, "flood forecast: protect this plot", t);
        }
      }
      // --- warmth
      if (u.warmth > 0) buildOption("shelter", u.warmth * 4 * Math.min(4, pop - A.shelterCap) * 3, `${pop - A.shelterCap} people have no shelter and it drops to ${A.minT.toFixed(0)} °C`);
      if (u.fuel > 0) {
        const g = this.gatherOption("wood", 8);
        if (g) add({ ...g, value: u.fuel * 8 / g.daysNeeded, need: "warmth", why: `firewood lasts ${A.woodDays.toFixed(1)} more cold nights` });
        if (this.power.produced > 2) buildOption("heater", u.fuel * 10, "power can replace firewood");
      }
      // --- water
      if (u.water > 0.1) {
        const src = this.tiles.filter((t) => (this.isWater(t) || t.type === "marsh" || t.flood) && !this.reserved(t));
        if (src.length && !this.sc.terrain.sterile) {
          const t = src.reduce((a, b) => (this.dist(b, this.home) < this.dist(a, this.home) ? b : a));
          const boil = this.inv.wood >= 1;
          const amt = boil ? 5 : 3; // boiled, or strained through sand and cloth
          let value = u.water * amt * 4.5;
          // once burned by dirty water, only drink it unboiled in a real emergency
          if (!boil && this.beliefs.hazard.boilWater && A.waterDays > 1) value *= 0.15 / this.brain.boilBias;
          add({ label: `${boil ? "Fetch and boil" : "Fetch and strain"} water at (${t.x},${t.y})`, need: "water", value, why: `${A.waterDays.toFixed(1)} days of water left${boil ? "" : ", no firewood to boil it"}`, task: { kind: "gather", res: "water", x: t.x, y: t.y, work: 1 }, skill: "scavenging" });
          if (!boil && this.beliefs.hazard.boilWater) { const g = this.gatherOption("wood", 2); if (g) add({ ...g, value: u.water * 10 * this.brain.boilBias, need: "water", why: "firewood to boil drinking water" }); }
        }
      }
      if (u.waterSource > 0) {
        const horizon = 25;
        if (this.sc.terrain.sterile) buildOption("ice_drill", u.waterSource * 7 * horizon * 0.3, "no rain and no rivers: water must come from ice");
        else {
          const wsite = this.tiles.filter((t) => this.freeLand(t)).reduce((a, t) => {
            const s = this.wellChance(t) * 6 - this.dist(t, this.home) * 0.15;
            return s > a.s ? { t, s } : a;
          }, { t: null, s: -1e9 }).t;
          if (wsite) buildOption("well", u.waterSource * 6 * horizon * 0.3 * this.wellChance(wsite), `we use more water than we collect; groundwater odds here ~${Math.round(this.wellChance(wsite) * 100)}%`, wsite);
          if (this.sc.climate.rain > 0.1) buildOption("rain_catcher", u.waterSource * 6 * this.sc.climate.rain * 0.65 * horizon * 0.3, "it rains often enough to collect it");
          if (this.sc.climate.sun > 0.6 || this.tiles.some((t) => t.salt > 0.3)) buildOption("solar_still", u.waterSource * 2 * this.sc.climate.sun * horizon * 0.3, "sunny, and it cleans salty water");
        }
      }
      // --- food now
      if (u.food > 0 && !this.sc.noWildFood) {
        const season = this.season;
        const wild = season === "Winter" ? 0.4 : season === "Autumn" ? 1.4 : 1;
        // Learned yields choose between food jobs; how much the colony works on
        // food at all stays driven by how urgent food is (u.food). Using learned
        // yields for both made the colony give up on food when it learned the
        // handbook was optimistic (tested: -6.6 points/year).
        const hasFish = this.inv.tools > 0 && this.tiles.some((t) => this.isWater(t));
        const hasLake = this.tiles.some((t) => t.type === "lake"), hasRiver = !!this.sc.terrain.river;
        const foodYields = [this.yieldEst(`forage_${season}`, 3 * wild)];
        if (hasFish && hasRiver) foodYields.push(this.yieldEst("fish_river", 3.5));
        if (hasFish && hasLake) foodYields.push(this.yieldEst("fish_lake", 2.2));
        if (this.sc.game && this.inv.tools > 0) foodYields.push(this.yieldEst("hunt", 3.2));
        const bestYield = Math.max(0.1, ...foodYields);
        const foodScale = (y) => 3.5 * y / bestYield; // the best food job gets full weight
        const spots = this.tiles.filter((t) => ["forest", "marsh", "grass", "sand"].includes(t.type) && !t.field && t.flood === 0 && !this.reserved(t));
        if (spots.length) {
          const t = spots.reduce((a, b) => (this.dist(b, this.home) < this.dist(a, this.home) ? b : a));
          const fy = this.yieldEst(`forage_${season}`, 3 * wild);
          add({ label: `Forage wild food near (${t.x},${t.y})`, need: "food", value: u.food * foodScale(fy), why: `${A.foodDays.toFixed(0)} days of food left; expect ~${fy.toFixed(1)} a day`, task: { kind: "gather", res: "forage", x: t.x, y: t.y, work: 1 }, skill: "scavenging" });
        }
        const game = this.sc.game;
        if (game && this.inv.tools > 0) {
          const t = spots.length ? spots[spots.length - 1] : null;
          const hy = this.yieldEst("hunt", 3.2);
          if (t) add({ label: `${game.name} near (${t.x},${t.y})`, need: "food", value: u.food * foodScale(hy), why: `small game lives in the scrub; expect ~${hy.toFixed(1)} a day`, task: { kind: "gather", res: "hunt", x: t.x, y: t.y, work: 1 }, skill: "scavenging" });
        }
        const fishing = this.tiles.filter((t) => this.isWater(t) && !this.reserved(t));
        if (fishing.length && this.inv.tools > 0) {
          const t = fishing.reduce((a, b) => (this.dist(b, this.home) < this.dist(a, this.home) ? b : a));
          const fk = t.type === "lake" ? "fish_lake" : "fish_river";
          const fy = this.yieldEst(fk, t.type === "lake" ? 2.2 : 3.5);
          add({ label: `Fish at (${t.x},${t.y})`, need: "food", value: u.food * foodScale(fy), why: `${t.type === "lake" ? "the pond" : "the river"} has fish; expect ~${fy.toFixed(1)} a day`, task: { kind: "gather", res: "fish", x: t.x, y: t.y, work: 1 }, skill: "scavenging" });
        }
      }
      // --- farming
      const foodValue = 0.4 + u.farming * 1.4 + u.food * 0.6;
      for (const t of this.tiles) {
        if (!t.field || this.reserved(t)) continue;
        if (t.crop && t.crop.ripe) add({ label: `Harvest ${CROPS[t.crop.type].name.toLowerCase()} (${t.x},${t.y})`, need: "food", value: 12 + CROPS[t.crop.type].yield * 0.4, why: "ripe", task: { kind: "harvest", x: t.x, y: t.y, work: 1 }, skill: "farming" });
        if (!t.crop && t.flood === 0) {
          const adv = this.cropAdvice(t);
          const best = adv[0];
          if (best && best.expected >= 8) add({ label: `Plant ${best.name.toLowerCase()} at (${t.x},${t.y})`, need: "food", value: best.expected * foodValue * 0.35, why: `best choice here: expect ~${best.expected} food in ${best.days} days`, task: { kind: "plant", crop: best.crop, x: t.x, y: t.y, work: 1 }, skill: "farming", advice: adv.slice(0, 4) });
          else if (this.sc.climate.mean < 12 && !t.greenhouse && this.seeds && Object.values(this.seeds).some((n) => n > 0)) {
            buildOption("greenhouse", 30 * foodValue * 0.35, "too cold to grow anything uncovered right now", t);
          }
        }
        if (!t.crop && t.fert < 0.6 && this.inv.compost >= 2 && !this.sc.terrain.sterile || (!t.crop && t.fert < 0.7 && this.inv.compost >= 2 && this.sc.terrain.sterile)) {
          add({ label: `Spread compost on the field at (${t.x},${t.y})`, need: "food", value: 5 + (0.6 - t.fert) * 20 * foodValue, why: `soil fertility is ${Math.round(t.fert * 100)}%`, task: { kind: "fertilize", x: t.x, y: t.y, work: 1 }, skill: "farming" });
        }
        if (t.crop && !t.irrigated && t.moist < 0.25 && CROPS[t.crop.type] && this.inv.water > A.pop * 2) {
          add({ label: `Water crops at (${t.x},${t.y})`, need: "food", value: 4 + t.crop.growth * 6, why: "soil is drying out", task: { kind: "water_crop", x: t.x, y: t.y, work: 1 }, skill: "farming" });
        }
        if (!t.irrigated && (this.sc.climate.rain < 0.2 || t.crop && t.moist < 0.3) && this.siteForIrrigation(t)) {
          buildOption("irrigation", 18 * foodValue * (this.sc.climate.rain < 0.2 ? 1.6 : 1), "a channel from the water saves watering by hand every few days", t);
        }
        if (t.greenhouse && !t.lights && (this.sc.climate.sun < 0.6 || this.sc.climate.mean + 12 < 10)) {
          if (this.power.produced - A.powerNeed > 1.5 + (this.beliefs.powerMargin || 0)) buildOption("grow_lights", 25 * foodValue, "the greenhouse alone is too dark or too cold", t);
          else if (u.power < 0.6) u.power = 0.6; // we need more power before lights make sense
        }
      }
      // new fields
      const plantable = Object.values(this.seeds).some((n) => n > 0);
      // how many plots does it take to feed everyone, by our own beliefs?
      // Farm size comes from the handbook's yields on purpose. Sizing it from
      // learned yields (or observed harvests) was tried: accurate numbers made
      // the colony plan more fields than it had hands to work, or fewer than
      // power-limited places like Mars need. Learned yields still pick the crop.
      const perPlot = Math.max(0.15, ...Object.entries(this.seeds).filter(([, n]) => n > 0)
        .map(([id]) => { const cb = this.beliefs.crops[id]; return cb.yield * 0.7 / cb.days; }), 0.15);
      const fieldsWanted = clamp(Math.ceil(pop / perPlot * this.brain.fieldsMult), pop, pop * 3);
      if (plantable && A.fields < fieldsWanted) {
        const sterile = this.sc.terrain.sterile;
        const opts = this.tiles.filter((t) => this.freeLand(t) && (sterile ? t.type === "sand" : ["grass", "marsh", "sand"].includes(t.type)));
        if (opts.length) {
          const t = opts.reduce((a, b) => (this.fieldScore(b) > this.fieldScore(a) ? b : a));
          const val = (0.5 + u.farming) * 14 * (A.fields < pop * 0.5 ? 1.6 : 1);
          if (sterile) {
            if (this.inv.compost >= 3) add({ label: `Make soil from regolith + compost at (${t.x},${t.y})`, need: "food", value: val / 2, why: "sterile ground: mix in compost like Watney", task: { kind: "make_soil", x: t.x, y: t.y, work: 2 }, skill: "farming" });
            else C.push({ label: "Make soil from regolith + compost", need: "food", value: val / 2, missing: { compost: 3 - Math.floor(this.inv.compost) }, blocked: true, why: "compost builds up from our own waste" });
          } else if (this.inv.tools > 0) add({ label: `Clear and till a field at (${t.x},${t.y})`, need: "food", value: val, why: `${A.fields}/${fieldsWanted} fields; best plot by soil${this.discoveries.silt && t.silt ? " (flood silt)" : ""}`, task: { kind: "till", x: t.x, y: t.y, work: 1 }, skill: "farming" });
        }
      }
      // --- power
      if (u.power > 0.1) {
        const horizon = 30;
        const b = this.beliefs.tech;
        // While power is genuinely short, a weak source is still worth building:
        // value it by the shortage it helps cover, with efficiency as a tiebreak.
        const unmet = A.powerNeed + (this.beliefs.powerMargin || 0) - this.power.produced;
        const worth = (out) => (unmet > 1 ? Math.max(out, Math.min(unmet, 4)) + out * 0.15 : out);
        if (this.sc.terrain.river) buildOption("water_wheel", u.power * worth(6 * this.flowBelief()) * horizon * 0.25, "the river keeps flowing day and night");
        if (this.inv.panels > 0 || this.tiles.some((t) => t.type === "ruins" && t.salvage > 0)) buildOption("solar_array", u.power * worth(b.solar_array.output) * horizon * 0.25, `panels give ~${b.solar_array.output.toFixed(1)}/day here${unmet > 1 ? `; we're ${unmet.toFixed(0)} short` : ""}`);
        buildOption("wind_turbine", u.power * worth(b.wind_turbine.output) * horizon * 0.25, `turbines give ~${b.wind_turbine.output.toFixed(1)}/day here${unmet > 1 ? `; we're ${unmet.toFixed(0)} short` : ""}`);
        if (this.inv.compost > 8) buildOption("biogas", u.power * 2 * horizon * 0.2, "spare compost can make methane");
      }
      // --- growth
      if (u.growth > 0.1 && !this.sc.noRadio && A.shelterCap >= pop + 2 && this.power.produced > 3 && !this.tiles.some((t) => t.structure && t.structure.type === "radio")) buildOption("radio", u.growth * 40, "we have spare beds, and a radio might reach other survivors");
      // --- keep a small stock of common materials
      if (this.inv.wood < this.brain.woodStock && !this.sc.terrain.sterile) { const g = this.gatherOption("wood", 6); if (g) add({ ...g, value: 1.2, why: "wood stock is low" }); }
      if (this.inv.scrap < this.brain.scrapStock) { const g = this.gatherOption("scrap", 6); if (g) add({ ...g, value: 1.0, why: "scrap stock is low" }); }
      this.hazardOptions(A, add, buildOption);

      // --- player orders get a big boost
      for (const o of this.orders) {
        const t = this.tile(o.x, o.y);
        if (!t) continue;
        if (o.kind === "build") buildOption(o.tech, 60, "ordered by you", t);
        if (o.kind === "plant" && t.field && !t.crop && (this.seeds[o.crop] || 0) > 0) add({ label: `Plant ${CROPS[o.crop].name.toLowerCase()} at (${t.x},${t.y})`, need: "food", value: 60, why: "ordered by you", task: { kind: "plant", crop: o.crop, x: t.x, y: t.y, work: 1, order: o }, skill: "farming" });
        if (o.kind === "till" && this.freeLand(t) && this.inv.tools > 0) add({ label: `Till a field at (${t.x},${t.y})`, need: "food", value: 60, why: "ordered by you", task: { kind: "till", x: t.x, y: t.y, work: 1, order: o }, skill: "farming" });
      }
      // Rule of threes: while safety, warmth or water is urgent, long-term
      // work (farming, power, growth, stockpiling) waits.
      // Food joins the survival tier once supplies are down to about a week.
      const hungry = u.food > 0.5;
      const crisis = Math.max(u.safety, u.warmth, u.water > 0.55 ? u.water : 0, hungry ? u.food * 0.9 : 0);
      if (crisis > 0) {
        for (const c of C) {
          // food you get today counts; fields planted today feed no one for months
          const foodNow = /^(Forage|Fish|Harvest|Hunt)/.test(c.label);
          const survival = ["safety", "warmth", "water"].includes(c.need) || foodNow && (hungry || c.label.startsWith("Harvest"));
          if (!survival && !(c.why || "").includes("ordered by you")) c.value *= 1 - this.brain.crisisDamp * crisis;
        }
      }
      this.crisis = crisis;
      return C.sort((a, b) => b.value - a.value);
    }
    hazardOptions(A, add) {
      const b = this.brain, H = this.beliefs.hazard;
      // --- greenhouses (handbook: brace covers before a storm; patch a torn
      // cover the same day, or the crop under it freezes tonight)
      for (const t of this.tiles) {
        if (t.crop && !t.greenhouse && t.coverLost !== undefined && this.day - t.coverLost <= 1 && !this.reserved(t)) {
          const cb = this.beliefs.crops[t.crop.type];
          if (this.weather.temp <= cb.frostKill + 4 || this.sc.terrain.sterile) {
            const mat = this.inv.plastic >= 2 ? "plastic" : this.inv.scrap >= 3 ? "scrap" : null;
            if (mat) add({ label: `Patch the torn greenhouse at (${t.x},${t.y})`, need: "food", value: 20 + t.crop.growth * 30, why: `the ${cb.name.toLowerCase()} under it freezes tonight without cover`, task: { kind: "patch", x: t.x, y: t.y, work: 0.6, mat }, skill: "building" });
          }
        }
        if (A.stormSoon && t.greenhouse && t.crop && (t.bracedUntil || 0) < this.day && !this.reserved(t)) {
          add({ label: `Brace the greenhouse at (${t.x},${t.y})`, need: "safety", value: 4 + t.crop.growth * 8 + (this.sc.terrain.sterile ? 6 : 0), why: "a storm is coming; weighted, braced covers rarely tear", task: { kind: "brace", x: t.x, y: t.y, work: 0.5 }, skill: "building" });
        }
      }
      const isHome = (t) => t.x === this.home.x && t.y === this.home.y;
      const valuable = (t) => !!(t.structure || t.crop || t.field || t.greenhouse || isHome(t));
      // --- wildfire response
      const burning = this.tiles.filter((t) => t.burning > 0);
      for (const t of burning) {
        const threat = this.tiles.filter((v) => valuable(v) && this.dist(v, t) <= 2).length + (this.dist(t, this.home) <= 3 ? 3 : 0);
        if (!threat) continue;
        if (this.inv.water >= 3 + A.pop && !this.reserved(t)) {
          add({ label: `Fight the fire at (${t.x},${t.y})`, need: "safety", value: (8 + threat * 4) * b.fireResponse, why: `${threat} homes, fields or structures within reach`, task: { kind: "fight_fire", x: t.x, y: t.y, work: 1 }, skill: "building" });
        }
        for (const n of this.neighbors(t)) {
          if (!this.burnable(n) || valuable(n) || this.reserved(n) || this.inv.tools < 1) continue;
          const guards = this.neighbors(n).filter(valuable).length;
          if (guards) add({ label: `Cut a firebreak at (${n.x},${n.y})`, need: "safety", value: (6 + guards * 4) * b.fireResponse, why: "clear the fuel so the fire can't reach what's beside it", task: { kind: "firebreak", x: n.x, y: n.y, work: 1 }, skill: "building" });
        }
      }
      // --- learned prevention: a firebreak ring before the dry season
      if (H.fireAware && !burning.length && this.inv.tools > 0) {
        const avgMoist = this.tiles.reduce((a, t) => a + t.moist, 0) / this.tiles.length;
        const dz = this.disaster && this.disaster.type;
        const dryish = dz === "drought" || dz === "heatwave" || this.forecast.some((f) => ["wildfire", "heatwave", "drought"].includes(f.event))
          || (this.season === "Summer" && avgMoist < 0.4);
        if (dryish) {
          const ring = this.tiles.filter((t) => { const d = this.dist(t, this.home); return d >= 1 && d <= 2 && this.burnable(t) && !valuable(t) && !this.reserved(t); });
          if (ring.length) {
            const t = ring.reduce((a, c) => (c.type === "forest" ? c : a));
            add({ label: `Cut a firebreak at (${t.x},${t.y})`, need: "safety", value: 3 * b.fireResponse, why: "dry season: keep a cleared ring around home (learned the hard way)", task: { kind: "firebreak", x: t.x, y: t.y, work: 1 }, skill: "building" });
          }
        }
      }
      // --- repairs (storm, flood, quake damage)
      const quaking = this.disaster && this.disaster.type === "earthquake";
      for (const t of this.tiles) {
        const s = t.structure;
        if (!s || s.hp >= 70 || this.reserved(t)) continue;
        const tech = TECHNIQUES[s.type];
        const costs = [tech.requires, tech.alt].filter(Boolean).map((r) => { const k = Object.keys(r)[0]; return { [k]: Math.max(1, Math.ceil(r[k] / 3)) }; });
        const cost = costs.find((c) => !Object.keys(this.missingFor(c)).length);
        if (!cost) continue;
        let value = (100 - s.hp) / 10 * b.repair * (["shelter", "well", "water_wheel", "ice_drill"].includes(s.type) ? 2 : 1);
        let why = `${Math.max(0, Math.round(s.hp))}% intact`;
        const critical = s.hab || ["shelter", "ice_drill", "well", "water_wheel"].includes(s.type) && s.hp < 40;
        if (quaking && H.quakeWait && !critical) { value *= 0.15; why += "; waiting for the aftershocks to pass"; }
        add({ label: `Repair the ${tech.name.toLowerCase()} at (${t.x},${t.y})`, need: tech.need === "materials" ? "safety" : tech.need, value, why, task: { kind: "repair", x: t.x, y: t.y, work: 1, req: cost }, skill: "building" });
      }
      // --- blight
      for (const t of this.tiles) {
        if (!t.crop || !t.crop.blight || this.reserved(t)) continue;
        const same = this.neighbors(t).filter((n) => n.crop && !n.crop.blight && n.crop.type === t.crop.type).length;
        add({ label: `Pull blighted ${CROPS[t.crop.type].name.toLowerCase()} at (${t.x},${t.y})`, need: "food", value: 6 + same * 5, why: same ? `${same} healthy plots of the same crop next to it` : "stop it spreading", task: { kind: "pull_blight", x: t.x, y: t.y, work: 1 }, skill: "farming" });
      }
    }
    flowBelief() { return this.riverLevel < 0 ? 0.3 : 1; }
    // ---- learning from experience: the yield book
    yieldEst(key, fallback) {
      if (!this.learnYields) return fallback;
      const b = this.beliefs.yields[key];
      return b ? b.m : fallback;
    }
    observeYield(key, value) {
      const b = this.beliefs.yields[key];
      if (!b) return;
      b.n++;
      b.m += (value - b.m) / b.n;
      b.seen = (b.seen || 0) + 1;
      // running mean/variance of what was actually seen (no handbook prior)
      const d0 = value - (b.om || 0);
      b.om = (b.om || 0) + d0 / b.seen;
      b.M2 = (b.M2 || 0) + d0 * (value - b.om);
      const hand = HANDBOOK_YIELDS[key];
      // only call it a lesson when the gap is bigger than luck explains:
      // two standard errors under "the handbook was right"
      const se = hand < 1 ? Math.sqrt(hand * (1 - hand) / b.seen) : Math.max(0.05 * hand, Math.sqrt(b.M2 / Math.max(1, b.seen - 1) / b.seen));
      const gap = Math.abs(b.om - hand);
      if (this.learnYields && !b.told && b.seen >= 8 && gap / hand > 0.3 && gap > 2.5 * se) {
        b.told = true;
        const msg = hand < 1
          ? `${YIELD_LABEL[key]}: it happens in about ${Math.round(b.m * 100)}% of digs here, not ${Math.round(hand * 100)}% as the handbook says.`
          : `${YIELD_LABEL[key]} here brings about ${b.m.toFixed(1)} food a day, not ${hand.toFixed(1)} as the handbook says.`;
        this.beliefs.yieldLearned = this.beliefs.yieldLearned || [];
        this.beliefs.yieldLearned.push(`Day ${this.day + 1}: ${msg}`);
        this.note("learn", msg);
      }
    }
    // Learn a rule, not just a table: water lies deeper under high ground, so
    // fit "chance = base x ratio^height" to every well actually dug, and use
    // it for heights we haven't tried (blended with what each height showed).
    generalizeWells() {
      const T = this.beliefs.tech.well;
      const real = T.real;
      if (!real) return;
      const dug = real.reduce((a, r) => a + r.ok + r.fail, 0);
      if (dug < 2) return;
      let best = null;
      for (let b = 0.05; b <= 0.99; b += 0.02) for (let r = 0.2; r <= 1.0001; r += 0.02) {
        // log-likelihood of what we saw, with a gentle pull toward the handbook's "works anywhere"
        let ll = -((b - 0.8) ** 2 + (r - 1) ** 2) * 2;
        real.forEach((c, h) => { const p = Math.min(0.99, Math.max(0.01, b * r ** h)); ll += c.ok * Math.log(p) + c.fail * Math.log(1 - p); });
        if (!best || ll > best.ll) best = { ll, b, r };
      }
      T.model = { base: best.b, ratio: best.r, dug };
      const K = 3; // how much the fitted rule counts, in wells
      T.byElev = real.map((c, h) => { const p = best.b * best.r ** h; return { ok: c.ok + K * p, fail: c.fail + K * (1 - p) }; });
      if (dug >= 3 && best.r < 0.8 && !this.wellsGeneralized) {
        this.wellsGeneralized = true;
        this.note("learn", `Water lies deeper under high ground: each step uphill cuts a well's chance to about ${Math.round(best.r * 100)}% of the step below. Applying that to heights we haven't dug.`);
      }
    }
    // ---- how much of what the colony believes is actually true?
    trueWellChance(elev) {
      return [0.95, 0.8, 0.5, 0.25, 0.1][elev] * (this.scenarioId === "dry_country" ? 0.55 : 1) * (this.sc.terrain.sterile ? 0 : 1);
    }
    knowledgeAccuracy() {
      const facts = [];
      // "tested": the colony has had some experience that bears on the fact
      // (planted the crop, dug at that height, lived through the disaster);
      // an untested fact can only be right if the handbook happened to be
      const fact = (group, name, ok, belief, truth, tested) => facts.push({ group, name, ok: !!ok, belief, truth, tested: !!tested });
      const lived = this.lived || {};
      // crops the colony has or has grown
      for (const [id, b] of Object.entries(this.beliefs.crops)) {
        if (!((this.seeds[id] || 0) > 0 || b.planted)) continue;
        const t = CROPS[id];
        fact("crops", `${t.name}: grows above`, Math.abs(b.minT - t.minT) <= 1, `${b.minT} °C`, `${t.minT} °C`, (b.lowT ?? 99) < t.minT);
        fact("crops", `${t.name}: frost kills at`, Math.abs(b.frostKill - t.frostKill) <= 1.5, `${b.frostKill} °C`, `${t.frostKill} °C`, (b.lowT ?? 99) <= Math.max(t.frostKill, b.frostKill));
        fact("crops", `${t.name}: survives floods`, b.flood === t.flood, b.flood ? "yes" : "no", t.flood ? "yes" : "no", b.wet);
      }
      // wells at the heights that exist here
      if (!this.sc.terrain.sterile) {
        const elevs = [...new Set(this.tiles.filter((t) => this.isLand(t)).map((t) => t.elev))].sort();
        for (const e of elevs) {
          const w = this.beliefs.tech.well.byElev[e], bel = w.ok / (w.ok + w.fail), tru = this.trueWellChance(e);
          const r = this.beliefs.tech.well.real;
          fact("wells", `Well at height ${e} strikes water`, Math.abs(bel - tru) <= 0.15, `${Math.round(bel * 100)}%`, `${Math.round(tru * 100)}%`, r && r[e].ok + r[e].fail >= 4);
        }
      }
      // gathering yields that apply here
      const Y = this.beliefs.yields;
      // enough tries that an honest average would land within the tolerance
      const enough = (key, truth, tol) => { const y = Y[key], n = y.seen || 0; if (n < 2) return false;
        const v = truth < 1 ? truth * (1 - truth) : (y.M2 || 0) / (n - 1); return 2 * Math.sqrt(v / n) <= tol; };
      const yf = (key, truth, tol) => fact("yields", YIELD_LABEL[key], Math.abs(Y[key].m - truth) <= tol, Y[key].m.toFixed(2), truth.toFixed(2), enough(key, truth, tol));
      if (!this.sc.noWildFood) {
        // where there's sand the nearest spot may be sand (half yield) or grass
        const lo = this.tiles.some((t) => t.type === "sand") ? 0.5 : 1;
        // what a day's foraging actually brings in (whole portions) at skill 1
        for (const [sea, raw] of [["Spring", 2.5], ["Summer", 2.5], ["Autumn", 4], ["Winter", 1]]) {
          const hi = Math.round(raw), low = lo < 1 ? Math.round(raw * lo) : hi;
          const m = Y[`forage_${sea}`].m, tol = Math.max(0.5, hi * 0.25);
          fact("yields", YIELD_LABEL[`forage_${sea}`], m >= low - tol && m <= hi + tol, m.toFixed(2), low < hi ? `${low.toFixed(2)}–${hi.toFixed(2)}` : hi.toFixed(2), enough(`forage_${sea}`, hi, tol));
        }
      }
      if (this.sc.terrain.river) yf("fish_river", 2, 0.5);
      if (this.tiles.some((t) => t.type === "lake")) yf("fish_lake", 1.2, 0.4);
      if (this.sc.game) yf("hunt", (this.sc.game.yield[0] + this.sc.game.yield[1]) / 2, 0.5);
      if (this.tiles.some((t) => t.type === "ruins") || this.stats.harvests >= 0) {
        for (const [k, p] of [["wire", 0.35], ["plastic", 0.3], ["tools", 0.08], ["panels", 0.07]]) if (this.sc.terrain.ruins) yf(k, p, Math.max(0.04, p * 0.3));
      }
      // disaster lessons for disasters that can strike here
      const LES = { boilWater: "outbreak", fireAware: "wildfire", quakeWait: "earthquake", mixCrops: "blight", ashFertile: "wildfire" };
      const LNAME = { boilWater: "Unboiled water spreads fever", fireAware: "Firebreaks before dry season", quakeWait: "Wait out aftershocks", mixCrops: "Mix crops against blight", ashFertile: "Ash makes soil fertile" };
      for (const [k, d] of Object.entries(LES)) if (d in this.sc.disasters && this.canHappen(d)) fact("lessons", LNAME[k], this.beliefs.hazard[k], this.beliefs.hazard[k] ? "known" : "not yet", "true", this.beliefs.hazard[k]);
      if (this.sc.terrain.river) fact("lessons", "Flood silt is fertile", this.discoveries.silt, this.discoveries.silt ? "known" : "not yet", "true", this.discoveries.silt);
      const ok = facts.filter((f) => f.ok).length;
      const T = facts.filter((f) => f.tested), tok = T.filter((f) => f.ok).length;
      return { pct: facts.length ? ok / facts.length : 1, ok, total: facts.length, facts, tested: T.length, testedOk: tok, testedPct: T.length ? tok / T.length : 1 };
    }
    gatherOption(res, amt) {
      const T = this.tiles.filter((t) => !this.reserved(t) && t.flood === 0);
      const nearest = (f) => { const l = T.filter(f); return l.length ? l.reduce((a, b) => (this.dist(b, this.home) < this.dist(a, this.home) ? b : a)) : null; };
      let t, rate, kind, label, learned = null;
      if (res === "wood") { t = nearest((x) => x.type === "forest" && x.wood > 0); rate = 4; kind = "wood"; label = "Chop wood"; }
      else if (res === "stone") { t = nearest((x) => (x.type === "rock" || x.type === "ice") && x.stone > 0); rate = 3; kind = "stone"; label = "Quarry stone"; }
      else if (["scrap", "wire", "plastic", "panels", "tools"].includes(res)) {
        t = nearest((x) => x.type === "ruins" && x.salvage > 0);
        // priority uses the handbook's effort so a rarer part doesn't make the
        // thing it's for less important; the learned odds give the honest estimate
        rate = res === "scrap" ? 3 : { wire: 0.35, plastic: 0.3, tools: 0.12, panels: 0.08 }[res];
        learned = res === "scrap" ? 3 : Math.max(0.03, this.yieldEst(res, HANDBOOK_YIELDS[res]));
        kind = "salvage"; label = `Salvage ruins for ${res}`;
      } else return null;
      if (!t) return null;
      return { label: `${label} at (${t.x},${t.y})`, daysNeeded: Math.max(1, Math.ceil(amt / rate)), expectDays: learned ? Math.max(1, Math.ceil(amt / learned)) : null, task: { kind: "gather", res: kind, x: t.x, y: t.y, work: 1 }, skill: kind === "salvage" ? "scavenging" : "building", need: "materials" };
    }

    plan() {
      const A = this.assess();
      const C = this.candidates(A);
      const people = this.alive.filter((s) => !s.task);
      const assignments = [];
      const taken = new Set();
      for (const s of this.alive) if (s.task) taken.add(`${s.task.x},${s.task.y}`);
      // each person takes the best remaining option, weighted by their skill
      for (const s of people) {
        // resting heals nothing if there's no food: the starving must keep foraging
        const starving = this.inv.food < this.alive.length;
        if ((s.health < 25 && !starving) || s.sick) { s.task = { kind: "rest", x: this.home.x, y: this.home.y, work: 1 }; s.status = s.sick ? "Sick with fever" : "Resting to recover"; assignments.push({ name: s.name, label: s.sick ? "Rest (fever)" : "Rest (injured)" }); continue; }
        let best = null, bestScore = 0;
        for (const c of C) {
          if (!c.task || c.blocked) continue;
          if (c.task.req && Object.keys(this.missingFor(c.task.req)).length) continue; // someone else took the materials
          if (c.task.kind === "build" && (TECHNIQUES[c.task.tech].tools || 0) > this.inv.tools) continue;
          if (c.task.kind === "plant" && !(this.seeds[c.task.crop] > 0)) continue;
          const key = `${c.task.x},${c.task.y}`;
          if (taken.has(key) && c.task.kind !== "gather") continue;
          const score = c.value * (0.6 + 0.4 * (s.skills[c.skill] || 1));
          if (score > bestScore) { best = c; bestScore = score; }
        }
        if (!best) { s.status = "Idle"; continue; }
        if (best.task.kind !== "gather") taken.add(`${best.task.x},${best.task.y}`);
        if (best.task.kind === "plant") this.seeds[best.task.crop]--; // reserve the seed now
        // materials are committed when the job starts
        if (best.task.req) for (const [k, v] of Object.entries(best.task.req)) this.inv[k] -= v;
        s.task = { ...best.task, progress: 0, label: best.label, skill: best.skill };
        if (best.task.kind !== "gather") best.value = 0; // one person per site job
        // Crowding: wood, stone and ruins run out, so piling on has diminishing
        // returns. Fish, wild food and game don't deplete in this world, so the
        // best food job keeps nearly full value for each extra person.
        else best.value *= ["forage", "fish", "hunt"].includes(best.task.res) ? 0.95 : 0.7;
        assignments.push({ name: s.name, label: best.label, why: best.why });
      }
      const needs = Object.entries(A.u).sort((a, b) => b[1] - a[1]);
      this.mind = {
        day: this.day + 1,
        summary: {
          water: `${A.waterDays.toFixed(1)} days (net ${A.waterNet >= 0 ? "+" : ""}${A.waterNet.toFixed(1)}/day)`,
          food: `${A.foodDays.toFixed(0)} days (crops ~${A.prodRate.toFixed(1)}/day)`,
          shelter: `${A.shelterCap}/${A.pop} sheltered, coldest ahead ${A.minT.toFixed(0)} °C`,
          power: `${this.power.produced}/day made, ${A.powerNeed} wanted`,
        },
        needs: needs.map(([k, v]) => ({ need: k, urgency: Math.round(v * 100) / 100 })),
        options: C.slice(0, 8).map((c) => ({ label: c.label, need: c.need, score: Math.round(c.value * 10) / 10, why: c.why, missing: c.missing || null, blocked: !!c.blocked })),
        assignments,
        advice: (C.find((c) => c.advice) || {}).advice || null,
      };
      const top = needs[0];
      if (top && top[1] >= 0.5 && (!this.lastTopNeed || this.lastTopNeed !== top[0])) {
        this.note("think", `Top priority now: ${top[0]} (urgency ${top[1].toFixed(2)}).`);
      }
      this.lastTopNeed = top ? top[0] : null;
    }

    // ------------------------------------------------------------ doing the work
    work() {
      for (const s of this.alive) {
        const task = s.task;
        if (!task) continue;
        const t = this.tile(task.x, task.y);
        s.x = task.x; s.y = task.y;
        if (t.flood >= 1 && task.kind !== "gather") { s.status = "Waiting for floodwater to drop"; continue; }
        const skill = s.skills[task.skill] || 1;
        task.progress += 0.6 + 0.4 * skill;
        s.xp[task.skill] = (s.xp[task.skill] || 0) + 1;
        if (task.skill && s.xp[task.skill] % 12 === 0 && s.skills[task.skill] < 2) {
          s.skills[task.skill] = Math.round((s.skills[task.skill] + 0.05) * 100) / 100;
        }
        s.status = task.label || task.kind;
        if (task.kind === "gather") { this.doGather(s, t, task.res, skill); s.task = null; continue; }
        if (task.kind === "rest") { s.resting = true; s.task = null; continue; }
        if (task.progress < task.work) continue;
        s.task = null;
        if (task.order) this.orders = this.orders.filter((o) => o !== task.order);
        this.finishTask(s, t, task);
      }
    }
    doGather(s, t, res, skill) {
      const R = this.R;
      if (res === "wood" && t.wood > 0) { const n = Math.min(t.wood, Math.round(4 * skill)); t.wood -= n; this.inv.wood += n; if (t.wood <= 0) { t.type = "grass"; this.note("event", `Forest at (${t.x},${t.y}) cleared.`); } }
      if (res === "stone" && t.stone > 0) { const n = Math.min(t.stone, Math.round(3 * skill)); t.stone -= n; this.inv.stone += n; }
      if (res === "salvage" && t.salvage > 0) {
        t.salvage -= 1;
        this.inv.scrap += Math.round(2 + skill * 1.5);
        const finds = [["wire", 0.35], ["plastic", 0.3], ["tools", 0.08], ["panels", 0.07]];
        for (const [k, p] of finds) {
          const got = R.chance(p * skill);
          if (got) { this.inv[k] += 1; if (k === "panels" || k === "tools") this.note("event", `${s.name} found ${k === "panels" ? "a working solar panel" : "a toolkit"} in the ruins.`); }
          this.observeYield(k, (got ? 1 : 0) / skill);
        }
        if (R.chance(0.18)) {
          const n = R.randint(2, 5);
          this.inv.food += n; this.gainFood(n);
          s.status = `Found ${n} cans of food`;
        }
        if (R.chance(0.05)) {
          const pool = Object.keys(CROPS).filter((c) => c !== "rice");
          const c = R.choice(pool);
          const n = R.randint(3, 6);
          this.seeds[c] = (this.seeds[c] || 0) + n;
          this.note("event", `${s.name} found a packet of ${n} ${CROPS[c].name.toLowerCase()} seeds.`);
        }
        if (t.salvage <= 0) { t.type = "grass"; this.note("event", `Ruins at (${t.x},${t.y}) picked clean.`); }
      }
      if (res === "water") {
        const boil = this.inv.wood >= 1;
        if (boil) this.inv.wood -= 1; else this.dirtyWaterDay = this.day;
        this.inv.water += boil ? 5 : 3;
      }
      if (res === "forage") {
        const base = this.season === "Winter" ? 1 : this.season === "Autumn" ? 4 : 2.5;
        const n = Math.round(base * skill * (t.type === "sand" ? 0.5 : 1)); // desert plants are sparse
        this.inv.food += n; this.gainFood(n);
        this.observeYield(`forage_${this.season}`, n / skill);
      }
      if (res === "hunt") { const [lo, hi] = this.sc.game.yield; const n = Math.round(this.R.randint(lo, hi) * skill); this.inv.food += n; this.gainFood(n); this.observeYield("hunt", n / skill); }
      if (res === "fish") { const n = Math.round(this.R.randint(0, 4) * skill * (t.type === "lake" ? 0.6 : 1)); this.inv.food += n; this.gainFood(n); this.observeYield(t.type === "lake" ? "fish_lake" : "fish_river", n / skill); }
    }
    finishTask(s, t, task) {
      const R = this.R;
      if (task.kind === "build") {
        const id = task.tech, tech = TECHNIQUES[id];
        this.stats.built[id] = (this.stats.built[id] || 0) + 1;
        if (id === "well") {
          const truth = [0.95, 0.8, 0.5, 0.25, 0.1][t.elev] * (this.scenarioId === "dry_country" ? 0.55 : 1) * (this.sc.terrain.sterile ? 0 : 1);
          const ok = R.chance(truth);
          const b = this.beliefs.tech.well.byElev[t.elev];
          if (ok) b.ok++; else b.fail++;
          const real = this.beliefs.tech.well.real || (this.beliefs.tech.well.real = [0, 1, 2, 3, 4].map(() => ({ ok: 0, fail: 0 })));
          if (ok) real[t.elev].ok++; else real[t.elev].fail++;
          this.generalizeWells(t.elev);
          t.structure = { type: "well", ok, hp: 100, built: this.day };
          this.note(ok ? "build" : "event", ok ? `${s.name} struck water with a well at (${t.x},${t.y}).` : `The well at (${t.x},${t.y}) came up dry.`);
          if (!ok) {
            const rate = b.ok / (b.ok + b.fail);
            if (b.fail >= 2) { const msg = `Wells at elevation ${t.elev} succeed only about ${Math.round(rate * 100)}% of the time. Dig lower, nearer the river.`; this.beliefs.tech.well.learned.push(msg); this.note("learn", msg); }
          }
          return;
        }
        if (id === "greenhouse") { t.greenhouse = true; this.note("build", `${s.name} covered (${t.x},${t.y}) with a greenhouse.`); return; }
        if (id === "grow_lights") { t.lights = true; this.note("build", `Grow lights installed at (${t.x},${t.y}).`); return; }
        if (id === "raised_bed") { t.raised = true; return; }
        if (id === "irrigation") { t.irrigated = true; this.note("build", `Irrigation channel dug to (${t.x},${t.y}).`); return; }
        if (id === "levee") { t.levee = true; this.note("build", `Sandbags stacked around (${t.x},${t.y}).`); return; }
        if (id === "heater") { t.structure.heater = true; this.note("build", "Electric heater wired into a shelter."); return; }
        if (id === "solar_array") {
          const existing = this.tiles.find((x) => x.structure && x.structure.type === "solar_array" && this.dist(x, t) <= 1);
          if (existing && existing !== t) { existing.structure.panels = (existing.structure.panels || 1) + 1; this.note("build", "Another panel added to the solar array."); return; }
        }
        t.structure = { type: id, hp: 100, built: this.day, panels: id === "solar_array" ? 1 : undefined };
        if (t.type === "forest") { this.inv.wood += Math.floor(t.wood / 2); t.type = "grass"; t.wood = 0; }
        this.note("build", `${s.name} finished a ${tech.name.toLowerCase()} at (${t.x},${t.y}).`);
        if (id === "water_wheel" && !this.discoveries.wheel) { this.discoveries.wheel = true; this.note("learn", "Power from the river! The wheel turns faster when the water is high."); }
        return;
      }
      if (task.kind === "till") {
        if (t.type === "forest") { this.inv.wood += Math.floor(t.wood / 2); t.wood = 0; }
        t.type = "field"; t.field = true;
        this.note("build", `${s.name} tilled a new field at (${t.x},${t.y}).`);
        return;
      }
      if (task.kind === "make_soil") {
        if (this.inv.compost < 3) return;
        this.inv.compost -= 3;
        t.fert = 0.35; t.type = "field"; t.field = true;
        this.note("build", `${s.name} mixed compost into the regolith at (${t.x},${t.y}). It's soil now.`);
        return;
      }
      if (task.kind === "plant") {
        if (!t.field || t.crop) { this.seeds[task.crop]++; return; } // seed was reserved at assignment
        t.crop = { type: task.crop, growth: 0, health: 1, age: 0, planted: this.day, fertAtPlant: t.fert, contamAtPlant: t.contam, ripe: false };
        if (this.disaster && this.disaster.type === "blight" && !t.greenhouse && this.R.chance(0.25)) t.crop.blight = true;
        this.beliefs.crops[task.crop].planted++;
        return;
      }
      if (task.kind === "harvest") {
        if (!t.crop) return;
        if (task.early && t.crop.growth < 1) t.crop.health *= t.crop.growth;
        const food = this.harvest(t, s);
        this.note("build", `${s.name} harvested ${food} food${task.early ? " early" : ""} at (${t.x},${t.y}).`);
        return;
      }
      if (task.kind === "fight_fire") {
        s.x = this.home.x; s.y = this.home.y; // step back out of the flames
        if (!t.burning) return;
        this.inv.water = Math.max(0, this.inv.water - 3);
        if (this.R.chance(0.55 + 0.2 * (s.skills.building || 1))) { t.burning = 0; this.note("build", `${s.name} put out the fire at (${t.x},${t.y}).`); }
        return;
      }
      if (task.kind === "firebreak") {
        if (t.burning) return;
        if (t.type === "forest") { this.inv.wood += Math.floor(t.wood / 2); t.type = "grass"; t.wood = 0; }
        t.firebreak = true;
        return;
      }
      if (task.kind === "repair") {
        if (!t.structure) return;
        t.structure.hp = Math.min(100, t.structure.hp + 60);
        t.structure.repairedDay = this.day;
        this.note("build", `${s.name} repaired the ${TECHNIQUES[t.structure.type].name.toLowerCase()} at (${t.x},${t.y}).`);
        return;
      }
      if (task.kind === "pull_blight") {
        if (!t.crop) return;
        this.note("event", `${s.name} pulled the blighted ${CROPS[t.crop.type].name.toLowerCase()} at (${t.x},${t.y}).`);
        this.inv.compost += 1; t.crop = null;
        return;
      }
      if (task.kind === "patch") {
        if (!t.crop || t.greenhouse) return;
        if (task.mat === "plastic" && this.inv.plastic >= 2) this.inv.plastic -= 2;
        else if (this.inv.scrap >= 3) this.inv.scrap -= 3;
        else return;
        t.greenhouse = true; t.lights = !!t.hadLights; t.coverLost = undefined;
        this.note("build", `${s.name} patched the greenhouse at (${t.x},${t.y}) before nightfall.`);
        return;
      }
      if (task.kind === "brace") { t.bracedUntil = this.day + 6; return; }
      if (task.kind === "fertilize") {
        if (this.inv.compost < 2) return;
        this.inv.compost -= 2; t.fert = clamp(t.fert + 0.15, 0, 1);
        return;
      }
      if (task.kind === "water_crop") {
        if (this.inv.water < 1) return;
        this.inv.water -= 1; t.moist = Math.min(1, t.moist + 0.45);
      }
    }

    // ------------------------------------------------------------ living
    live() {
      const alive = this.alive;
      const pop = alive.length;
      const heat = this.disaster && this.disaster.type === "heatwave" ? 1.5 : this.weather.temp > 30 ? 1.25 : 1;
      // survivors on flooded tiles move home
      for (const s of alive) { const t = this.tile(s.x, s.y); if (t.flood > 0 && !s.task) { s.x = this.home.x; s.y = this.home.y; } }
      // food and water, shared equally
      const waterNeed = pop * heat;
      const waterShare = Math.min(1, this.inv.water / Math.max(0.01, waterNeed));
      this.inv.water = Math.max(0, this.inv.water - waterNeed);
      const foodShare = Math.min(1, this.inv.food / Math.max(0.01, pop));
      this.inv.food = Math.max(0, this.inv.food - pop);
      this.stats.foodEaten += pop * foodShare;
      // warmth
      const temp = this.weather.temp;
      const shelters = this.tiles.filter((t) => t.structure && t.structure.type === "shelter" && t.flood < 2);
      let beds = shelters.length * 4;
      let fires = 0;
      if (temp < 10) {
        for (const sh of shelters) {
          if (sh.structure.heater && sh.powered) continue;
          if (this.inv.wood >= 1) { this.inv.wood -= 1; fires++; }
          else sh.cold = true;
        }
      }
      const unheated = shelters.filter((sh) => temp < 10 && !(sh.structure.heater && sh.powered) && sh.cold).length;
      for (const sh of shelters) sh.cold = false;
      let coldBeds = unheated * 4;
      // compost from human waste and scraps (Watney's trick)
      this.inv.compost += pop * 0.25;
      // fever: spreads between people sharing shelters, and from dirty water
      const sick = alive.filter((s) => s.sick);
      if (!this.sc.terrain.sterile) {
        for (const s of alive) {
          if (s.sick) continue;
          const p = sick.length * 0.03 + (this.day - this.dirtyWaterDay <= 2 ? 0.015 : 0);
          if (this.R.chance(p)) {
            s.sick = this.R.randint(4, 8);
            if (!sick.length && this.day - this.dirtyWaterDay <= 2 && !this.beliefs.hazard.boilWater) {
              this.hazardLesson("boilWater", `${s.name} got a fever right after we drank unboiled water. From now on we always boil it, even if it means chopping wood first.`);
            }
          }
        }
      }
      for (const s of alive) {
        if (s.health <= 0) { s.health = 0; s.cause = s.cause || "Injuries"; continue; }
        let dmg = 0, cause = null;
        const hit = (v, c) => { if (v > dmg) cause = c; dmg += v; };
        if (s.sick) {
          hit(foodShare >= 1 && waterShare >= 1 ? 1.2 : 3.5, "Fever"); // well-fed, watered patients mostly pull through
          s.sick--;
          if (s.sick <= 0) { s.sick = 0; this.note("event", `${s.name} recovered from the fever.`); }
        }
        if (waterShare < 1) hit((1 - waterShare) * 22, "Thirst");
        if (foodShare < 1) hit((1 - foodShare) * 6, "Starvation");
        const sheltered = beds > 0;
        if (sheltered) beds--;
        const fireless = sheltered && coldBeds > 0;
        if (fireless) coldBeds--;
        const feels = sheltered ? (fireless ? temp + 10 : Math.max(temp + 22, 16)) : temp - (this.weather.rain > 0 ? 4 : 0) - this.weather.wind * 4;
        if (feels < 8) hit((8 - feels) * (feels < -20 ? 1.4 : 0.7), "Hypothermia");
        if (temp > 36 && waterShare < 1.0) hit((temp - 36) * 1.2, "Heatstroke");
        const t = this.tile(s.x, s.y);
        if (t.flood >= 2) hit(10, "Drowning");
        if (t.contam > 0.3 && s.task && s.task.kind !== "rest") hit(t.contam * 2, "Radiation sickness");
        if (dmg > 0) {
          s.health -= dmg;
          if (s.health <= 0) { s.health = 0; s.cause = cause; }
        } else s.health = Math.min(100, s.health + (s.resting ? 8 : 3));
        s.resting = false;
      }
      for (const d of this.survivors.filter((s) => s.health <= 0)) {
        this.stats.deaths++;
        this.stats.causes[d.cause] = (this.stats.causes[d.cause] || 0) + 1;
        this.note("death", `${d.name} died (${d.cause.toLowerCase()}).`);
      }
      this.survivors = this.alive;
      // radio brings newcomers
      if (this.tiles.some((t) => t.structure && t.structure.type === "radio" && t.powered) && this.R.chance(0.04) && this.alive.length < 14) {
        const s = this.addSurvivor(this.home.x, this.home.y);
        this.stats.joined++;
        this.note("event", `${s.name} heard the radio and walked in.`);
      }
    }

    // ------------------------------------------------------------ day loop
    tick() {
      if (!this.running) return;
      this.advanceWeather();
      this.updateLand();
      this.produce();
      this.plan();
      this.work();
      this.growCrops();
      this.live();
      if (this.disaster) {
        this.disaster.daysLeft--;
        if (this.disaster.daysLeft <= 0) { this.note("event", `${DISASTERS[this.disaster.type].name} is over.`); this.disaster = null; }
      }
      this.day++;
      this.dayOfYear++;
      if (this.day % 5 === 0 || this.day === 1) {
        this.accuracyLog = this.accuracyLog || [];
        this.accuracyLog.push([this.day, Math.round(this.knowledgeAccuracy().pct * 1000) / 10]);
      }
      if (!this.alive.length) { this.running = false; this.outcome = "PERISHED"; this.note("death", "No one is left."); }
      else if (this.day >= YEAR) {
        this.running = false;
        const c = this.checklist();
        const core = ["water", "food", "warmth"].every((n) => c.find((x) => x.need === n).ok);
        this.outcome = core && c.filter((x) => x.ok).length >= 4 ? "THRIVING" : "SURVIVED";
        this.note("event", `One year on: ${this.outcome === "THRIVING" ? "the colony is self-sufficient" : "the colony survived, but it is not self-sufficient yet"}.`);
      }
    }
    checklist() {
      const pop = Math.max(1, this.alive.length);
      const cut = this.day - 90;
      const harvested = this.recentHarvest.filter(([d]) => d >= cut).reduce((a, [, f]) => a + f, 0);
      const gained = (this.recentFood || []).filter(([d]) => d >= cut).reduce((a, [, f]) => a + f, 0);
      const shelterCap = this.tiles.reduce((a, t) => a + (t.structure && t.structure.type === "shelter" ? 4 : 0), 0);
      return [
        { need: "water", label: "Reliable water source", ok: this.estimateWaterProduction() >= pop, detail: `${this.estimateWaterProduction().toFixed(1)} a day for ${pop} people` },
        { need: "food", label: "Producing enough food", ok: gained >= pop * 90 * 0.9 || (this.inv.food >= pop * 60 && gained >= pop * 90 * 0.5), detail: `${gained} grown, foraged or fished in the last 90 days (${harvested} from crops); ${pop} people eat ${pop * 90}` },
        { need: "warmth", label: "Shelter for everyone", ok: shelterCap >= pop, detail: `${shelterCap} beds for ${pop}` },
        { need: "power", label: "Power", ok: this.power.produced >= 2, detail: `${this.power.produced} a day` },
        { need: "safety", label: "Nobody lost recently", ok: !this.log.some((l) => l.kind === "death" && l.day > this.day - 60), detail: "no deaths in the last 60 days" },
      ];
    }

    // ------------------------------------------------------------ player
    triggerDisaster(kind) {
      if (!DISASTERS[kind]) throw new Error(`Unknown disaster ${kind}`);
      if (!this.canHappen(kind)) throw new Error(`A ${DISASTERS[kind].name.toLowerCase()} can't happen here.`);
      if (this.disaster) { this.note("event", `${DISASTERS[this.disaster.type].name} is over.`); this.disaster = null; }
      const nm = DISASTERS[kind].name.toLowerCase();
      this.note("order", `You unleashed ${/^[aeiou]/.test(nm) ? "an" : "a"} ${nm}.`);
      this.startDisaster(kind, true);
    }
    setHazards(level) {
      if (!(level in HAZARD_LEVELS)) throw new Error(`Unknown hazard level ${level}`);
      this.hazards = level; this.hazardMult = HAZARD_LEVELS[level];
      this.note("order", `Disaster frequency set to ${level}.`);
    }
    // Knowledge that carries over between games (see frontier-train.js).
    exportKnowledge(prev = null) {
      const k = prev ? JSON.parse(JSON.stringify(prev)) : { years: 0, crops: {}, hazard: {}, places: {} };
      k.years = (k.years || 0) + 1;
      for (const [id, b] of Object.entries(this.beliefs.crops)) {
        const c = k.crops[id] || { learned: [] };
        c.minT = b.minT; c.frostKill = b.frostKill; c.flood = b.flood;
        if (b.harvested) c.yieldFactor = c.yieldFactor ? (c.yieldFactor + b.yieldFactor) / 2 : b.yieldFactor;
        for (const l of b.learned) { const txt = l.replace(/^Day \d+: /, ""); if (!c.learned.includes(txt)) c.learned.push(txt); }
        k.crops[id] = c;
      }
      for (const key of ["fireAware", "quakeWait", "mixCrops", "boilWater", "ashFertile"]) if (this.beliefs.hazard[key]) k.hazard[key] = true;
      k.hazard.learned = [...new Set([...(k.hazard.learned || []), ...this.beliefs.hazard.learned.map((l) => l.replace(/^Day \d+: /, ""))])];
      const place = k.places[this.scenarioId] || {};
      place.wells = this.beliefs.tech.well.byElev.map((b) => ({ ok: b.ok, fail: b.fail }));
      if (this.beliefs.tech.well.real) place.wellsReal = this.beliefs.tech.well.real.map((c) => ({ ...c }));
      place.power = { wind_turbine: this.beliefs.tech.wind_turbine.output, solar_array: this.beliefs.tech.solar_array.output };
      if (this.beliefs.powerMargin) place.powerMargin = this.beliefs.powerMargin;
      place.yields = Object.fromEntries(Object.entries(this.beliefs.yields).map(([k, b]) => [k, { m: b.m, n: Math.min(30, b.n), told: b.told }]));

      if (this.discoveries.silt) place.silt = true;
      k.places[this.scenarioId] = place;
      if (this.discoveries.sunflower) k.sunflower = true;
      return k;
    }
    applyKnowledge(k) {
      this.knowledgeYears = k.years || 0;
      for (const [id, c] of Object.entries(k.crops || {})) {
        const b = this.beliefs.crops[id];
        if (!b) continue;
        if (c.minT !== undefined) b.minT = c.minT;
        if (c.frostKill !== undefined) b.frostKill = c.frostKill;
        if (c.flood !== undefined) b.flood = c.flood;
        if (c.yieldFactor) b.yieldFactor = c.yieldFactor;
        b.learned = (c.learned || []).map((t) => `Inherited: ${t}`);
      }
      for (const [key, v] of Object.entries(k.hazard || {})) if (key !== "learned" && v) this.beliefs.hazard[key] = true;
      this.beliefs.hazard.learned = (k.hazard && k.hazard.learned || []).map((t) => `Inherited: ${t}`);
      const place = (k.places || {})[this.scenarioId];
      if (place) {
        if (place.wells) this.beliefs.tech.well.byElev = place.wells.map((w) => ({ ...w }));
        if (place.wellsReal) { this.beliefs.tech.well.real = place.wellsReal.map((c) => ({ ...c })); this.generalizeWells(); this.wellsGeneralized = true; }
        if (place.power) { this.beliefs.tech.wind_turbine.output = place.power.wind_turbine; this.beliefs.tech.solar_array.output = place.power.solar_array; this.beliefs.tech.wind_turbine.samples = this.beliefs.tech.solar_array.samples = 25; }
        if (place.silt) this.discoveries.silt = true;
        if (place.powerMargin) this.beliefs.powerMargin = place.powerMargin;
        if (place.yields) for (const [k, y] of Object.entries(place.yields)) if (this.beliefs.yields[k]) Object.assign(this.beliefs.yields[k], y, { seen: y.told ? 99 : 0 });

      }
      if (k.sunflower) this.discoveries.sunflower = true;
    }
    setPriority(p) {
      if (!["auto", "water", "food", "warmth", "power", "safety"].includes(p)) throw new Error(`Unknown priority ${p}`);
      this.priority = p;
      this.note("order", p === "auto" ? "You let the colony decide its own priorities." : `You told the colony to prioritise ${p}.`);
    }
    order(o) {
      const t = this.tile(+o.x, +o.y);
      if (!t) throw new Error("That tile is off the map");
      if (o.kind === "build") {
        const tech = TECHNIQUES[o.tech];
        if (!tech) throw new Error(`Unknown technique ${o.tech}`);
        const why = this.whyNot(o.tech, t);
        if (why) throw new Error(why);
      } else if (o.kind === "plant") {
        if (!CROPS[o.crop]) throw new Error(`Unknown crop ${o.crop}`);
        if (!t.field) throw new Error("That tile isn't a field yet. Order it tilled first.");
        if (t.crop) throw new Error("Something is already growing there.");
        if (!(this.seeds[o.crop] > 0)) throw new Error(`We have no ${CROPS[o.crop].name.toLowerCase()} seeds.`);
      } else if (o.kind === "till") {
        if (!this.freeLand(t)) throw new Error("That tile can't be farmed (water, rock, a building, or already a field).");
        if (this.sc.terrain.sterile) throw new Error("Regolith needs compost mixed in; the colony does that itself when compost is available.");
      } else throw new Error(`Unknown order ${o.kind}`);
      const entry = { kind: o.kind, tech: o.tech, crop: o.crop, x: t.x, y: t.y };
      this.orders.push(entry);
      this.note("order", `You ordered: ${o.kind === "build" ? TECHNIQUES[o.tech].name : o.kind === "plant" ? `plant ${CROPS[o.crop].name.toLowerCase()}` : "till a field"} at (${t.x},${t.y}).`);
    }
    whyNot(id, t) {
      const site = TECHNIQUES[id].site;
      const ok = {
        land: () => this.freeLand(t) && t.type !== "forest",
        high: () => this.freeLand(t),
        riverbank: () => this.freeLand(t) && this.neighbors(t).some((n) => n.type === "river"),
        ice: () => t.type === "ice" && !t.structure,
        shelter: () => t.structure && t.structure.type === "shelter" && !t.structure.heater,
        field: () => t.field && !(id === "greenhouse" ? t.greenhouse : id === "raised_bed" ? t.raised : false),
        greenhouse: () => t.greenhouse && !t.lights,
        field_near_water: () => t.field && !t.irrigated && this.neighbors(t).some((n) => this.isWater(n) || (n.structure && n.structure.type === "well" && n.structure.ok)),
        floodable: () => this.sc.terrain.river && this.isLand(t) && !t.levee,
      }[site];
      const where = { land: "open dry land", high: "open land", riverbank: "land next to the river", ice: "an ice deposit", shelter: "a shelter without a heater", field: "a field", greenhouse: "a greenhouse without lights", field_near_water: "a field next to water", floodable: "land without a levee" }[site];
      return ok && ok() ? null : `A ${TECHNIQUES[id].name.toLowerCase()} needs ${where}.`;
    }
  }

  // ================================================================ serialize for the UI
  function serialize(f) {
    return {
      mode: "frontier",
      day: f.day, dayOfYear: f.dayOfYear, season: f.season, year: YEAR,
      running: f.running, outcome: f.outcome,
      scenario: { id: f.scenarioId, name: f.sc.name, blurb: f.sc.blurb, needs: f.sc.needs, sterile: !!f.sc.terrain.sterile },
      seed: f.seed, W: f.W, H: f.H, home: { x: f.home.x, y: f.home.y },
      weather: { ...f.weather, temp: r1(f.weather.temp) },
      forecast: f.forecast.map((w) => ({ temp: r1(w.temp + (w.event === "frost" ? -12 : w.event === "heatwave" ? 10 : 0)), rain: w.rain > 0, event: w.event })),
      disaster: f.disaster ? { ...f.disaster, name: DISASTERS[f.disaster.type].name } : null,
      riverLevel: f.riverLevel,
      inv: Object.fromEntries(Object.entries(f.inv).map(([k, v]) => [k, Math.floor(v)])),
      seeds: { ...f.seeds },
      power: { ...f.power }, water: { ...f.water },
      tiles: f.tiles.map((t) => ({
        x: t.x, y: t.y, type: t.type, elev: t.elev, fert: r1(t.fert), moist: r1(t.moist), flood: t.flood, contam: r1(t.contam), salt: r1(t.salt), silt: t.silt,
        burning: t.burning || 0, firebreak: !!t.firebreak, charred: t.charred || 0, ash: !!t.ash,
        field: t.field, greenhouse: t.greenhouse, lights: t.lights, raised: t.raised, irrigated: t.irrigated, levee: t.levee,
        wood: t.wood, stone: t.stone, salvage: t.salvage,
        structure: t.structure ? { type: t.structure.type, hp: Math.round(t.structure.hp), ok: t.structure.ok, heater: t.structure.heater, hab: t.structure.hab, panels: t.structure.panels, powered: t.powered } : null,
        crop: t.crop ? { type: t.crop.type, growth: r1(t.crop.growth * 100) / 100, health: r1(t.crop.health), ripe: t.crop.ripe, blight: !!t.crop.blight } : null,
      })),
      survivors: f.alive.map((s) => ({ id: s.id, name: s.name, x: s.x, y: s.y, health: Math.round(s.health), status: s.status, sick: s.sick || 0, skills: s.skills, task: s.task ? s.task.label || s.task.kind : null })),
      mind: f.mind,
      log: f.log.slice(-80),
      beliefs: {
        crops: Object.fromEntries(Object.entries(f.beliefs.crops).map(([k, b]) => [k, {
          name: b.name, minT: b.minT, frostKill: b.frostKill, flood: b.flood, yieldFactor: Math.round(b.yieldFactor * 100) / 100,
          planted: b.planted, harvested: b.harvested, lost: b.lost, learned: b.learned, rumor: b.rumor || null, fact: CROPS[k].fact,
          days: CROPS[k].days, water: b.water, handbook: { minT: HANDBOOK_CROPS[k].minT, frostKill: HANDBOOK_CROPS[k].frostKill, flood: HANDBOOK_CROPS[k].flood },
        }])),
        wells: f.beliefs.tech.well.byElev.map((b, i) => ({ elev: i, chance: Math.round(b.ok / (b.ok + b.fail) * 100), tries: b.ok + b.fail - 5 })),
        wellLearned: f.beliefs.tech.well.learned,
        power: { wind_turbine: r1(f.beliefs.tech.wind_turbine.output), solar_array: r1(f.beliefs.tech.solar_array.output) },
        powerLearned: [...f.beliefs.tech.wind_turbine.learned, ...f.beliefs.tech.solar_array.learned],
      },
      discoveries: { ...f.discoveries },
      hazardBeliefs: { ...f.beliefs.hazard },
      accuracy: (() => { const a = f.knowledgeAccuracy(); return a; })(),
      accuracyLog: (f.accuracyLog || []).slice(),
      startAccuracy: f.startAccuracy,
      yieldBook: Object.fromEntries(Object.entries(f.beliefs.yields).map(([k, b]) => [k, { label: YIELD_LABEL[k], belief: Math.round(b.m * 100) / 100, handbook: HANDBOOK_YIELDS[k], seen: b.seen || 0 }])),
      yieldLearned: f.beliefs.yieldLearned || [],
      wellModel: f.beliefs.tech.well.model || null,
      hazardGuide: HAZARD_GUIDE,
      hazards: f.hazards,
      hazardLevels: Object.keys(HAZARD_LEVELS),
      disasterTypes: Object.keys(DISASTERS).map((k) => ({ id: k, name: DISASTERS[k].name, possible: f.canHappen(k), inScenario: k in f.sc.disasters })),
      trained: f.trained, knowledgeYears: f.knowledgeYears || 0, brain: { ...f.brain },
      techniques: TECHNIQUES,
      ruleOfThrees: RULE_OF_THREES,
      checklist: f.checklist(),
      priority: f.priority,
      orders: f.orders.slice(),
      stats: f.stats,
      scenarios: Object.fromEntries(Object.entries(SCENARIOS).map(([k, v]) => [k, { name: v.name, blurb: v.blurb }])),
    };
  }

  function createFrontier(opts) {
    let f = new Frontier(opts || {});
    return {
      get sim() { return f; },
      state: () => serialize(f),
      new(o) { f = new Frontier(o || {}); return serialize(f); },
      step(n = 1) {
        n = Math.max(1, Math.min(60, parseInt(n, 10) || 1));
        for (let i = 0; i < n && f.running; i++) f.tick();
        return serialize(f);
      },
      command(cmd) {
        if (cmd.type === "priority") f.setPriority(cmd.priority);
        else if (cmd.type === "order") f.order(cmd);
        else if (cmd.type === "cancel_orders") { f.orders = []; f.note("order", "You cancelled your orders."); }
        else if (cmd.type === "disaster") f.triggerDisaster(cmd.kind);
        else if (cmd.type === "hazards") f.setHazards(cmd.level);
        else throw new Error(`Unknown command ${cmd.type}`);
        return serialize(f);
      },
    };
  }

  const api = { Frontier, createFrontier, serialize, YEAR, DEFAULT_BRAIN };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.FRONTIER = api;
})(typeof window !== "undefined" ? window : globalThis);
