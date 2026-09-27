/*
 * PARS Frontier: world knowledge.
 *
 * TRUTH is how the world actually behaves (the simulation uses it).
 * HANDBOOK is what the survivors start out believing (the planner uses it).
 * They differ on purpose in a few places, so agents have things to learn by
 * trying: see `handbookErrors` below and the learning code in
 * frontier-engine.js.
 */
(function (root) {
  "use strict";

  // Survival priorities taught in wilderness courses ("rule of threes").
  const RULE_OF_THREES = [
    { need: "safety", label: "Safety", rule: "3 minutes without air, and get away from immediate danger (floodwater, fire, collapse) first." },
    { need: "warmth", label: "Shelter & warmth", rule: "About 3 hours exposed in harsh cold or wet before hypothermia sets in." },
    { need: "water", label: "Water", rule: "About 3 days without drinkable water." },
    { need: "food", label: "Food", rule: "About 3 weeks without food; plant early because crops take months." },
    { need: "power", label: "Power", rule: "Not needed to survive, but it pumps water, lights greenhouses and heats shelters." },
  ];

  // ---------------------------------------------------------------- crops
  // Real-world ranges, simplified. Temperatures in °C. days = days to harvest.
  // yield = person-days of food from one plot under good conditions.
  // water: 0 (drought tolerant) .. 1 (paddy). flood: survives standing water.
  const CROPS = {
    potato: { name: "Potato", minT: 7, optLo: 15, optHi: 20, maxT: 27, frostKill: -2, days: 90, yield: 60, water: 0.5, flood: false, saltTol: 0.2, feed: 0.08, fact: "Grows from cut seed tubers. Mark Watney's crop in The Martian." },
    beans: { name: "Bush beans", minT: 12, optLo: 21, optHi: 27, maxT: 32, frostKill: 1, days: 60, yield: 30, water: 0.5, flood: false, saltTol: 0.1, feed: -0.1, fact: "Legumes fix nitrogen, so the soil is richer after them." },
    kale: { name: "Kale", minT: 3, optLo: 13, optHi: 20, maxT: 27, frostKill: -10, days: 55, yield: 22, water: 0.5, flood: false, saltTol: 0.5, feed: 0.05, fact: "Frost-hardy; frost even sweetens the leaves." },
    wheat: { name: "Winter wheat", minT: 3, optLo: 12, optHi: 24, maxT: 32, frostKill: -18, days: 120, yield: 45, water: 0.35, flood: false, saltTol: 0.4, feed: 0.08, fact: "Survives deep cold; grain stores for years." },
    corn: { name: "Corn", minT: 12, optLo: 24, optHi: 30, maxT: 36, frostKill: 0, days: 90, yield: 55, water: 0.75, flood: false, saltTol: 0.2, feed: 0.14, fact: "High yield but a heavy feeder that needs warmth and water." },
    rice: { name: "Rice", minT: 18, optLo: 24, optHi: 32, maxT: 38, frostKill: 4, days: 120, yield: 55, water: 1.0, flood: true, saltTol: 0.3, feed: 0.06, fact: "Grows in standing water, so floods help it." },
    squash: { name: "Squash", minT: 15, optLo: 21, optHi: 30, maxT: 35, frostKill: 1, days: 90, yield: 40, water: 0.65, flood: false, saltTol: 0.2, feed: 0.1, fact: "Keeps for months after harvest." },
    amaranth: { name: "Amaranth", minT: 16, optLo: 24, optHi: 34, maxT: 40, frostKill: 2, days: 60, yield: 26, water: 0.2, flood: false, saltTol: 0.4, feed: 0.06, fact: "Drought and heat tolerant; eat both leaves and seed." },
    sweetpotato: { name: "Sweet potato", minT: 16, optLo: 24, optHi: 32, maxT: 38, frostKill: 2, days: 110, yield: 55, water: 0.35, flood: false, saltTol: 0.3, feed: 0.07, fact: "Thrives in heat and poor sandy soil." },
    sunflower: { name: "Sunflower", minT: 10, optLo: 20, optHi: 28, maxT: 35, frostKill: 0, days: 80, yield: 14, water: 0.3, flood: false, saltTol: 0.4, feed: 0.06, remediates: true, fact: "Pulls heavy metals and radioactive caesium out of soil (used after Chernobyl)." },
    radish: { name: "Radish", minT: 5, optLo: 10, optHi: 20, maxT: 27, frostKill: -4, days: 25, yield: 9, water: 0.5, flood: false, saltTol: 0.3, feed: 0.03, fact: "Ready in under a month: an emergency crop." },
  };

  // What the survivors initially believe. Mostly right; a few entries are
  // wrong so the agents can discover the truth by planting.
  const HANDBOOK_CROPS = JSON.parse(JSON.stringify(CROPS));
  const handbookErrors = [
    ["corn", { minT: 7, frostKill: -3 }, "Old almanac claims corn shrugs off light frost."],
    ["beans", { flood: true }, "A note says beans \"don't mind wet feet\"."],
    ["sweetpotato", { yield: 75 }, "Seed packet promises a bumper crop."],
    ["potato", { frostKill: -5 }, "Believed to survive a hard frost."],
  ];
  for (const [crop, wrong, why] of handbookErrors) {
    Object.assign(HANDBOOK_CROPS[crop], wrong);
    HANDBOOK_CROPS[crop].rumor = why;
  }

  // ---------------------------------------------------------------- techniques
  // requires: materials consumed. tools: tool count needed (not consumed).
  // site: where it can be built (checked in the engine). days: work days.
  // skill: which survivor skill speeds it up. need: which need it serves.
  const TECHNIQUES = {
    // water
    rain_catcher: { name: "Rain catcher", need: "water", site: "land", requires: { scrap: 2, plastic: 1 }, days: 1, skill: "building", effect: "Collects about 6 water per rainy day.", why: "Rain is clean water from the sky; tarps and barrels collect it." },
    well: { name: "Dug well", need: "water", site: "land", requires: { stone: 4 }, tools: 1, days: 3, skill: "building", effect: "About 6 water a day if it strikes groundwater.", why: "Groundwater sits closer to the surface in low ground near rivers.", uncertain: true },
    solar_still: { name: "Solar still", need: "water", site: "land", requires: { plastic: 1 }, days: 1, skill: "engineering", effect: "About 2 clean water a day in sun, even from salty or dirty water.", why: "Sunlight evaporates water under plastic; it condenses clean." },
    ice_drill: { name: "Ice drill", need: "water", site: "ice", requires: { scrap: 3, wire: 1 }, tools: 1, days: 2, skill: "engineering", power: 2, effect: "Melts subsurface ice into about 7 water a day using 2 power.", why: "Mars has water ice under the regolith." },
    // shelter & warmth
    shelter: { name: "Shelter", need: "warmth", site: "land", requires: { wood: 6 }, alt: { scrap: 6 }, days: 3, skill: "building", effect: "Houses 4 people out of the wind and wet.", why: "Staying dry and out of wind matters more than anything else in the cold." },
    heater: { name: "Electric heater", need: "warmth", site: "shelter", requires: { scrap: 2, wire: 1 }, days: 1, skill: "engineering", power: 2, effect: "Heats one shelter using 2 power, saving firewood.", why: "Firewood runs out; power can replace it." },
    // food
    greenhouse: { name: "Greenhouse", need: "food", site: "field", requires: { wood: 3, plastic: 3 }, alt: { scrap: 3, plastic: 3 }, days: 2, skill: "building", effect: "Plot is +12 °C warmer and sheltered from frost, ash and storms.", why: "A plastic cover traps heat, which stretches the growing season." },
    grow_lights: { name: "Grow lights", need: "food", site: "greenhouse", requires: { wire: 1, scrap: 1 }, days: 1, skill: "engineering", power: 2, effect: "With 2 power a day, crops get light and stay at least 18 °C, whatever the weather.", why: "LEDs and a heater turn a greenhouse into a grow room, like Watney's Hab." },
    raised_bed: { name: "Raised bed", need: "safety", site: "field", requires: { wood: 3 }, days: 1, skill: "building", effect: "Plot survives shallow floods and drains well.", why: "Raising soil above the flood line keeps roots out of water." },
    irrigation: { name: "Irrigation channel", need: "food", site: "field_near_water", requires: { wood: 2 }, tools: 1, days: 2, skill: "building", effect: "Plot never dries out.", why: "A channel from the river keeps soil moist through droughts." },
    // power
    water_wheel: { name: "Water wheel", need: "power", site: "riverbank", requires: { wood: 4, scrap: 4, wire: 1 }, tools: 1, days: 3, skill: "engineering", effect: "About 6 power a day from flowing water (more in floods, less in droughts).", why: "Moving water turns a wheel, and a salvaged alternator turns that into electricity." },
    wind_turbine: { name: "Wind turbine", need: "power", site: "high", requires: { scrap: 6, wire: 2 }, tools: 1, days: 3, skill: "engineering", effect: "Up to 6 power a day in strong wind; best on high ground.", why: "A car alternator on a pole with blades from scrap.", uncertain: true },
    solar_array: { name: "Solar array", need: "power", site: "land", requires: { panels: 1, wire: 1 }, days: 1, skill: "engineering", effect: "About 5 power a day in full sun per panel.", why: "Salvaged panels still work if they are clean and in the sun.", uncertain: true },
    biogas: { name: "Biogas digester", need: "power", site: "land", requires: { scrap: 3, plastic: 1 }, days: 2, skill: "engineering", effect: "Turns 1 compost a day into 2 power.", why: "Rotting waste in a sealed drum gives off methane you can burn." },
    // safety & growth
    levee: { name: "Sandbag levee", need: "safety", site: "floodable", requires: { stone: 2 }, days: 1, skill: "building", effect: "Tile stays dry in floods up to 2 deep.", why: "Sandbags and rubble block rising water." },
    radio: { name: "Radio beacon", need: "growth", site: "land", requires: { scrap: 4, wire: 2 }, days: 2, skill: "engineering", power: 1, effect: "Other survivors may hear it and join (uses 1 power).", why: "Other survivors are out there listening." },
  };

  const MATERIALS = ["food", "water", "wood", "stone", "scrap", "wire", "plastic", "panels", "compost", "tools"];

  // ---------------------------------------------------------------- scenarios
  // climate: mean temp, seasonal amplitude, daily noise, rain chance, sun
  // (0..1, cloud/ash), wind (0..1). startDay 0 = start of spring.
  const SCENARIOS = {
    river_flood: {
      name: "The River Rose",
      blurb: "Spring in a temperate valley. The river burst its banks and the grid is gone. Get to high ground, find clean water, and use the flowing water before it recedes.",
      needs: "Higher ground, clean water (the floodwater is dirty), shelter from the rain, then fields on the rich flood-plain soil.",
      climate: { mean: 12, amp: 11, noise: 3, rain: 0.35, sun: 0.65, wind: 0.35 },
      terrain: { river: true, forest: 0.22, rock: 0.08, ruins: 0.06, marsh: 0.12, sand: 0.02 },
      survivors: 5,
      inventory: { food: 50, water: 8, wood: 6, stone: 2, scrap: 6, wire: 1, plastic: 2, panels: 0, compost: 0, tools: 2 },
      seeds: { potato: 6, beans: 6, kale: 6, corn: 4, rice: 3, radish: 6 },
      opening: { type: "flood", days: 6, level: 2 },
      disasters: { flood: 0.006, storm: 0.006, frost: 0.004, drought: 0.003, heatwave: 0.002 },
    },
    ash_winter: {
      name: "Ash Winter",
      blurb: "Autumn after the bombs. Ash dims the sun and the soil near the ruins is contaminated. Winter is coming fast.",
      needs: "Shelter and firewood before the cold, then crops that tolerate cold and low light. Sunflowers can clean contaminated soil.",
      climate: { mean: 4, amp: 12, noise: 3, rain: 0.3, sun: 0.4, wind: 0.5 },
      terrain: { river: true, forest: 0.25, rock: 0.12, ruins: 0.1, marsh: 0.04, sand: 0.02, contam: 0.35 },
      survivors: 5,
      startDay: 180,
      inventory: { food: 35, water: 12, wood: 8, stone: 4, scrap: 14, wire: 3, plastic: 4, panels: 1, compost: 0, tools: 3 },
      seeds: { potato: 6, kale: 8, wheat: 6, radish: 8, sunflower: 5, beans: 4 },
      opening: { type: "ashfall", days: 12 },
      disasters: { frost: 0.02, storm: 0.006, ashfall: 0.008, flood: 0.002 },
    },
    dry_country: {
      name: "Dry Country",
      blurb: "Early spring on the edge of a desert. There is almost no rain, the water table is deep, and summer will be brutal. It is also the best solar power you will ever get.",
      needs: "Water above all: wells on low ground, solar stills, rain catchers for the rare storm. Shade and drought-tolerant crops.",
      climate: { mean: 22, amp: 9, noise: 3, rain: 0.06, sun: 0.95, wind: 0.45 },
      terrain: { river: false, forest: 0.03, rock: 0.16, ruins: 0.07, marsh: 0, sand: 0.5, oasis: 3 },
      survivors: 5,
      startDay: 20,
      inventory: { food: 70, water: 25, wood: 4, stone: 4, scrap: 10, wire: 2, plastic: 3, panels: 2, compost: 0, tools: 2 },
      seeds: { amaranth: 8, sweetpotato: 5, beans: 5, squash: 4, corn: 3 },
      opening: { type: "heatwave", days: 5 },
      disasters: { heatwave: 0.012, drought: 0.01, storm: 0.004 },
    },
    after_wave: {
      name: "After the Wave",
      blurb: "A tsunami swept the coast. The fields are salted, the forest is flattened, and storms keep coming off the sea.",
      needs: "Clean water (everything is salty), salt-tolerant crops, and shelter from storms. Rain slowly washes the salt away.",
      climate: { mean: 18, amp: 6, noise: 2, rain: 0.28, sun: 0.7, wind: 0.65 },
      terrain: { river: true, forest: 0.1, rock: 0.06, ruins: 0.12, marsh: 0.1, sand: 0.2, salt: 0.6 },
      survivors: 6,
      startDay: 30,
      inventory: { food: 30, water: 6, wood: 10, stone: 2, scrap: 8, wire: 1, plastic: 3, panels: 0, compost: 0, tools: 2 },
      seeds: { kale: 6, sweetpotato: 4, squash: 4, beans: 4, rice: 4, radish: 6 },
      opening: { type: "storm", days: 3 },
      disasters: { storm: 0.016, flood: 0.006, heatwave: 0.003 },
    },
    red_planet: {
      name: "Red Planet",
      blurb: "A tribute to The Martian. The regolith is sterile, it never rains, and outside it is far below freezing. You have a damaged hab, some solar panels, and a sack of potatoes.",
      needs: "Warmth first (the hab), water from buried ice, soil made from regolith plus compost, and potatoes grown under cover and grow lights.",
      climate: { mean: -35, amp: 10, noise: 4, rain: 0, sun: 0.55, wind: 0.2 },
      terrain: { river: false, forest: 0, rock: 0.2, ruins: 0.05, marsh: 0, sand: 0.7, ice: 0.06, sterile: true },
      survivors: 4,
      startDay: 60,
      inventory: { food: 600, water: 20, wood: 0, stone: 6, scrap: 20, wire: 5, plastic: 10, panels: 1, compost: 10, tools: 3 },
      seeds: { potato: 12 },
      opening: null,
      disasters: { storm: 0.008 },
      noWildFood: true,
      noRadio: true,
      startShelter: true,
      startPower: { panels: 2, battery: 20 },
    },
  };

  const DISASTERS = {
    flood: { name: "Flood", icon: "flood", days: [4, 8], desc: "The river rises and swamps low ground." },
    storm: { name: "Storm", icon: "storm", days: [2, 3], desc: "High wind and rain; damages exposed structures and crops." },
    frost: { name: "Cold snap", icon: "frost", days: [3, 6], desc: "Temperatures plunge well below normal." },
    drought: { name: "Drought", icon: "drought", days: [10, 20], desc: "No rain; soil dries out and rivers run low." },
    heatwave: { name: "Heatwave", icon: "heat", days: [4, 7], desc: "Scorching heat; people and crops need extra water." },
    ashfall: { name: "Ashfall", icon: "ash", days: [6, 12], desc: "Ash blots out the sun, so solar and crops suffer." },
  };

  const api = { RULE_OF_THREES, CROPS, HANDBOOK_CROPS, TECHNIQUES, MATERIALS, SCENARIOS, DISASTERS, handbookErrors };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.FRONTIER_DATA = api;
})(typeof window !== "undefined" ? window : globalThis);
