// Game data: map, errand pool, helpers.
// Errand-date mode: random errand list per round, score/combo/patience.

export const TICK_MS_BASE = 1000;
export const TICK_MS_FLOOR = 400;
export const TICK_MS_PER_COMBO = 40;     // tick gets faster by this many ms per combo level
export const COMBO_MULT_PER_LEVEL = 0.2; // score multiplier increment per combo level
export const PATIENCE_START = 150;
export const PATIENCE_PER_TICK = 1;
export const PATIENCE_PER_CRASH = 30;
export const POST_CRASH_FREEZE_MS = 1500;
export const COUNTDOWN_MS = 2500;
export const ERRAND_COUNT_MIN = 4;
export const ERRAND_COUNT_MAX = 5;
export const ERRAND_BASE_SCORE = 100;
export const PERFECT_SATURDAY_BONUS = 500;
export const PATIENCE_BONUS_PER_POINT = 5;

export const MAP = {
  id: "errand_date_v1",
  width: 12,
  height: 18,
  start: { x: 0, y: 0, direction: "south" },
  home: { x: 0, y: 0 },
  zones: [
    { label: "Arouca",        x: 1,  y: 0  },
    { label: "Champs Fleurs", x: 5,  y: 4  },
    { label: "Centre",        x: 5,  y: 8  },
    { label: "Coast",         x: 5,  y: 12 },
    { label: "Maracas",       x: 5,  y: 17 },
  ],
  // 12 cols × 18 rows. Mostly grid-pattern streets (every other row is a clear E-W avenue),
  // with a few X hazards on N-S streets to force route choices.
  // Start tile S is at (0,0); col 0 is a clean N-S corridor so south is always safe.
  tiles: [
    "S...........".split(""),
    ".#.##.#.##..".split(""),
    "............".split(""),
    ".#.##.#.##..".split(""),
    "............".split(""),
    ".#.##X#.##..".split(""),
    "............".split(""),
    ".#.##.#X##..".split(""),
    "............".split(""),
    ".#.##.#.##..".split(""),
    "............".split(""),
    ".#X##.#.##..".split(""),
    "............".split(""),
    ".#.##.#.##X.".split(""),
    "............".split(""),
    ".#.##.#.##..".split(""),
    "............".split(""),
    "............".split(""),
  ],
};

// All possible errand locations. Each round picks a random subset.
// `tile` is the location on the map (must be a road tile '.' or S).
export const ERRAND_POOL = [
  { type: "pharmacy",   label: "Pharmacy",        icon: "💊", flavor: "Picked up the meds.",                    tile: { x: 5,  y: 2  } },
  { type: "doubles",    label: "Doubles",         icon: "🥟", flavor: "Got the doubles. Worth the trip.",       tile: { x: 7,  y: 0  } },
  { type: "rituals",    label: "Coffee",          icon: "☕", flavor: "Coffee acquired. Saturday saved.",       tile: { x: 10, y: 2  } },
  { type: "roti",       label: "Roti",            icon: "🫓", flavor: "Roti for later.",                        tile: { x: 5,  y: 4  } },
  { type: "icecream",   label: "Ice cream",       icon: "🍦", flavor: "Soft serve. Heaven.",                    tile: { x: 11, y: 4  } },
  { type: "carwash",    label: "Drive-thru wash", icon: "🧼", flavor: "Car is clean. For 4 minutes.",           tile: { x: 5,  y: 6  } },
  { type: "kfc",        label: "KFC drive-thru",  icon: "🍗", flavor: "KFC. The plan was salad. Whatever.",     tile: { x: 10, y: 6  } },
  { type: "ramen",      label: "Ramen",           icon: "🍜", flavor: "Ramen unlocked.",                        tile: { x: 5,  y: 8  } },
  { type: "cousin",     label: "Drop off cousin", icon: "🚪", flavor: "Cousin delivered. Wave goodbye.",        tile: { x: 10, y: 8  } },
  { type: "atm",        label: "ATM",             icon: "🏧", flavor: "Cash secured.",                          tile: { x: 5,  y: 10 } },
  { type: "bugspray",   label: "Bug spray",       icon: "🦟", flavor: "Bug spray: this is the beach plan.",    tile: { x: 10, y: 10 } },
  { type: "gas",        label: "Put gas",         icon: "⛽", flavor: "Tank full. Now a real adventure.",       tile: { x: 5,  y: 12 } },
  { type: "topup",      label: "Phone top-up",    icon: "📱", flavor: "Phone has minutes again.",               tile: { x: 10, y: 12 } },
  { type: "mango",      label: "Mango stand",     icon: "🥭", flavor: "Mangoes. The good ones.",                tile: { x: 5,  y: 14 } },
  { type: "lascuevas",  label: "Las Cuevas",      icon: "🏖️", flavor: "Las Cuevas. The quiet beach.",           tile: { x: 1,  y: 17 } },
  { type: "maracas",    label: "Maracas Bay",     icon: "🌊", flavor: "Maracas. Bake-and-shark calling.",      tile: { x: 5,  y: 17 } },
  { type: "lookout",    label: "Maracas lookout", icon: "🏞️", flavor: "Lookout view. One photo. Done.",         tile: { x: 10, y: 17 } },
];

const DIRS = {
  north: { dx: 0,  dy: -1 },
  east:  { dx: 1,  dy:  0 },
  south: { dx: 0,  dy:  1 },
  west:  { dx: -1, dy:  0 },
};
const ORDER = ["north", "east", "south", "west"];

export function turnLeft(dir)  { return ORDER[(ORDER.indexOf(dir) + 3) % 4]; }
export function turnRight(dir) { return ORDER[(ORDER.indexOf(dir) + 1) % 4]; }

export function forwardOf(pos, dir) {
  const d = DIRS[dir];
  return { x: pos.x + d.dx, y: pos.y + d.dy };
}

export function tileAt(map, x, y) {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return null;
  return map.tiles[y][x];
}

export function isInBounds(map, x, y) {
  return x >= 0 && y >= 0 && x < map.width && y < map.height;
}

// Drive tile classification: walls/X/off-map = crash; everything else = move.
// (No special "win" tile — round end is decided by errand list + home.)
export function classifyDriveTile(map, x, y) {
  const t = tileAt(map, x, y);
  if (t === null) return "crash";
  if (t === "#")  return "crash";
  if (t === "X")  return "crash";
  return "move";
}

// Trajectory the navigator sees: project N tiles forward in current direction.
export function projectTrajectory(map, car, maxLen = 6) {
  const out = [];
  let x = car.x, y = car.y;
  for (let i = 0; i < maxLen; i++) {
    const next = forwardOf({ x, y }, car.direction);
    out.push({ x: next.x, y: next.y });
    const cls = classifyDriveTile(map, next.x, next.y);
    if (cls === "crash") break;
    x = next.x; y = next.y;
  }
  return out;
}

export function makeRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

// Pick N random errands from the pool.
export function rollErrandList(count = 4) {
  const pool = [...ERRAND_POOL];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const n = Math.min(count, pool.length);
  return pool.slice(0, n).map((e) => ({
    type: e.type,
    label: e.label,
    icon: e.icon,
    flavor: e.flavor,
    x: e.tile.x,
    y: e.tile.y,
    done: false,
  }));
}

export function tickMsForCombo(combo) {
  const ms = TICK_MS_BASE - combo * TICK_MS_PER_COMBO;
  return Math.max(TICK_MS_FLOOR, Math.floor(ms));
}

export function comboMultiplier(combo) {
  return 1 + combo * COMBO_MULT_PER_LEVEL;
}

export function freshRoom(code) {
  return {
    code,
    phase: "waiting",
    players: { driver: null, navigator: null },
    car: { x: MAP.start.x, y: MAP.start.y, direction: MAP.start.direction },
    crashAt: null,
    argument: null,
    distance: 0,
    brakeTicks: 0,
    tickInterval: null,
    pendingStartAt: 0,
    // Errand mode state
    errands: [],
    score: 0,
    combo: 0,
    bestCombo: 0,
    patience: PATIENCE_START,
    crashes: 0,
    outcome: null,           // "perfect" | "tired" | null
    bestScoreThisSession: 0, // session-only personal best per room
  };
}

export function resetRound(room, errandCount) {
  const count = errandCount ?? (ERRAND_COUNT_MIN + Math.floor(Math.random() * (ERRAND_COUNT_MAX - ERRAND_COUNT_MIN + 1)));
  room.phase = "ready";
  room.car = { x: MAP.start.x, y: MAP.start.y, direction: MAP.start.direction };
  room.crashAt = null;
  room.argument = null;
  room.distance = 0;
  room.brakeTicks = 0;
  room.pendingStartAt = 0;
  room.errands = rollErrandList(count);
  room.score = 0;
  room.combo = 0;
  room.bestCombo = 0;
  room.patience = PATIENCE_START;
  room.crashes = 0;
  room.outcome = null;
}

// Funny lines played briefly on a crash (no longer ends the round).
export const CRASH_BARKS = [
  ["You said turn left!", "I said the OTHER left."],
  ["BRAKE was right there.", "I see one tile. ONE."],
  ["I trusted you.", "That was your first mistake."],
  ["You panicked!", "You accelerated into it."],
  ["The map is confusing.", "You are confusing."],
  ["I knew this would happen.", "Then why didn't you stop me?!"],
  ["You weren't listening.", "You weren't speaking words."],
  ["Slow down maybe??", "I am literally going one tile."],
  ["My job is to drive.", "My job is to lower my expectations."],
  ["Why didn't you warn me?!", "I literally said 'wall'."],
];

// Game-end taglines based on outcome.
export const ENDING_LINES = {
  perfect: [
    ["Perfect Saturday.", "Trust restored."],
    ["Got everything.", "We're a team."],
    ["Errand list cleared.", "Vibes intact."],
    ["You drove like a legend.", "I navigated like one."],
  ],
  tired: [
    ["Forget it. Let's go home.", "Wine and pizza tonight."],
    ["Patience: 0%.", "We tried."],
    ["This is why we don't run errands together.", "And yet, here we are again."],
    ["The errand list won today.", "Tomorrow is a new Saturday."],
  ],
};

export function pickEndingLine(outcome) {
  const pool = ENDING_LINES[outcome] ?? ENDING_LINES.tired;
  return pool[Math.floor(Math.random() * pool.length)];
}

export function pickCrashBark() {
  return CRASH_BARKS[Math.floor(Math.random() * CRASH_BARKS.length)];
}
