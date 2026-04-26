// Game data: map, arguments, helpers.
// Real-time mode: car auto-advances each server tick; driver only steers/brakes.

export const TICK_MS = 900;        // ms between auto-forward steps
export const BRAKE_MAX = 3;         // max queued brake ticks
export const COUNTDOWN_MS = 2000;   // grace period before first tick after Start

export const MAP = {
  id: "v3_portrait",
  width: 10,
  height: 14,
  start: { x: 1, y: 0, direction: "south" },
  destination: { x: 8, y: 13 },
  driverSpawnAfterCrash:    { x: 9, y: 0,  label: "Evil Town / Arouca" },
  navigatorSpawnAfterCrash: { x: 0, y: 12, label: "Pretty Cool Girl City / Champs Fleurs" },
  zones: [
    { label: "Arouca",        x: 1, y: 0  },
    { label: "Centre",        x: 5, y: 6  },
    { label: "Champs Fleurs", x: 0, y: 12 },
    { label: "Maracas",       x: 8, y: 13 },
  ],
  tiles: [
    ".S........".split(""),
    "..#.##.#..".split(""),
    "..........".split(""),
    "##.#####..".split(""),
    ".........#".split(""),
    ".####X##.#".split(""),
    "..........".split(""),
    "###.######".split(""),
    "..........".split(""),
    ".####.###.".split(""),
    "..........".split(""),
    ".##X######".split(""),
    "..........".split(""),
    "########D.".split(""),
  ],
};

export const ARGUMENTS = [
  ["You said turn left!", "I said the OTHER left."],
  ["I trusted you.", "That was your first mistake."],
  ["I had it under control.", "You hit a stationary object."],
  ["The map is confusing.", "You are confusing."],
  ["There were three lefts!", "And somehow you chose the fourth."],
  ["Why didn't you warn me?!", "I literally said 'wall'."],
  ["You panicked!", "You accelerated into it."],
  ["That was a corner!", "No, that was a spiritual warning."],
  ["I asked for clear directions!", "I gave you east. You went west spiritually."],
  ["Are you even looking at the map?", "Are you even looking at the road?"],
  ["BRAKE WAS RIGHT THERE.", "I see one tile. ONE."],
  ["My job is to drive.", "My job is to lower my expectations."],
  ["Slow down maybe??", "I am literally going one tile per second."],
  ["You said 'go straight'.", "I said 'go straight INTO THE WALL'??"],
  ["I knew this would happen.", "Then why didn't you stop me?!"],
  ["You weren't listening.", "You weren't speaking words."],
  ["I'm doing my best.", "Your best is concerning."],
  ["This map is rigged.", "The map is fine. You are not."],
  ["I thought you said RIGHT.", "I said RIGHT NOW. Not 'turn right'."],
  ["We need to talk about this.", "We need to talk about a lot."],
];

export function pickArgument() {
  return ARGUMENTS[Math.floor(Math.random() * ARGUMENTS.length)];
}

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

export function classifyDriveTile(map, x, y) {
  const t = tileAt(map, x, y);
  if (t === null) return "crash";
  if (t === "#")  return "crash";
  if (t === "X")  return "crash";
  if (t === "D")  return "win";
  return "move";
}

export function isReunionWalkable(map, x, y) {
  const t = tileAt(map, x, y);
  if (t === null) return false;
  if (t === "#")  return false;
  return true;
}

// Trajectory the navigator sees: project N tiles forward in current direction,
// stopping at the first crash/win tile (inclusive).
export function projectTrajectory(map, car, maxLen = 6) {
  const out = [];
  let x = car.x, y = car.y;
  for (let i = 0; i < maxLen; i++) {
    const next = forwardOf({ x, y }, car.direction);
    out.push({ x: next.x, y: next.y });
    const cls = classifyDriveTile(map, next.x, next.y);
    if (cls === "crash" || cls === "win") break;
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

export function freshRoom(code) {
  return {
    code,
    phase: "waiting",
    players: { driver: null, navigator: null },
    car: { x: MAP.start.x, y: MAP.start.y, direction: MAP.start.direction },
    crashAt: null,
    argument: null,
    driverAvatar: null,
    navigatorAvatar: null,
    outcome: null,
    distance: 0,
    brakeTicks: 0,
    tickInterval: null,
    pendingStartAt: 0,
  };
}

export function resetRound(room) {
  room.phase = "ready";
  room.car = { x: MAP.start.x, y: MAP.start.y, direction: MAP.start.direction };
  room.crashAt = null;
  room.argument = null;
  room.driverAvatar = null;
  room.navigatorAvatar = null;
  room.outcome = null;
  room.distance = 0;
  room.brakeTicks = 0;
  room.pendingStartAt = 0;
}
