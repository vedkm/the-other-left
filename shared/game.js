// Game data: procedural road graph + errand pool + helpers.
// Errand-date mode: drive a generated Trinidad-style road map.
//
// World model: continuous (px-equivalent units), road graph of nodes + edges.
// - Each edge: polyline geometry, lane count, hazards along it.
// - Car state: { edgeId, t (0..1 along edge), lane, laneTween, dir (1 forward) }.
// - Junctions (nodes): when car reaches t=1 on an edge, look up successor by
//   the (incomingEdgeId, lane) it arrives in.
// - Procedural every round so players can't memorize.
//
// Reunion phase keeps a separate small grid map (it's a different mini-game,
// no need to walk the road graph on foot).

// ────────────────────────────────────────────────────────────────────────────
// Tunables

export const TICK_MS = 100;                  // server fixed tick (10 Hz)
export const BASE_SPEED = 110;               // px/sec at combo 0
export const SPEED_PER_COMBO = 14;           // px/sec added per combo level
export const SPEED_MAX = 260;                // hard ceiling
export const BRAKE_FACTOR = 0.35;            // speed multiplier while braking

export const COMBO_MULT_PER_LEVEL = 0.2;     // score multiplier per combo level
export const PATIENCE_START = 150;
export const PATIENCE_PER_SECOND = 1;        // drains continuously
export const PATIENCE_PER_CRASH = 30;
export const PATIENCE_PER_POTHOLE = 10;
export const POST_CRASH_FREEZE_MS = 1500;
export const COUNTDOWN_MS = 2500;
export const ERRAND_COUNT_MIN = 4;
export const ERRAND_COUNT_MAX = 5;
export const ERRAND_BASE_SCORE = 100;
export const PERFECT_SATURDAY_BONUS = 500;
export const PATIENCE_BONUS_PER_POINT = 5;
export const LANE_CHANGE_COOLDOWN_MS = 280;
export const ERRAND_RADIUS = 18;             // px to count as touching an errand
export const POTHOLE_RADIUS = 14;            // px to count as hitting a pothole

// Reunion phase
export const REUNION_DECAY_PER_SEC = 8;
export const REUNION_BASE_BONUS    = 500;
export const REUNION_MIN_BONUS     = 50;
export const REUNION_BONUS_DECAY_PER_SEC = 12;
export const REUNION_TIMEOUT_MS    = 60_000;
export const REUNION_VIS_RADIUS    = 2;
export const REUNION_GRID_SIZE     = 12;

// World layout
export const WORLD_W = 960;
export const WORLD_H = 1600;
export const ROAD_LANE_WIDTH = 22;           // px per lane (visual + collision)

// Driver fog: world-distance window along the path ahead of the car.
export const FOG_AHEAD = 280;                // px visible in front
export const FOG_BEHIND = 90;                // px visible behind
export const FOG_RADIUS = 130;               // px visible to the sides at the car

// ────────────────────────────────────────────────────────────────────────────
// Errand pool — Trinidad-flavored errands. Each round picks N at random and
// places them along random edges in the generated map.

export const ERRAND_POOL = [
  { type: "pharmacy",   label: "Pharmacy",        icon: "💊", flavor: "Picked up the meds." },
  { type: "doubles",    label: "Doubles",         icon: "🥟", flavor: "Got the doubles. Worth the trip." },
  { type: "rituals",    label: "Coffee",          icon: "☕", flavor: "Coffee acquired. Saturday saved." },
  { type: "roti",       label: "Roti",            icon: "🫓", flavor: "Roti for later." },
  { type: "icecream",   label: "Ice cream",       icon: "🍦", flavor: "Soft serve. Heaven." },
  { type: "carwash",    label: "Drive-thru wash", icon: "🧼", flavor: "Car is clean. For 4 minutes." },
  { type: "kfc",        label: "KFC drive-thru",  icon: "🍗", flavor: "KFC. The plan was salad. Whatever." },
  { type: "ramen",      label: "Ramen",           icon: "🍜", flavor: "Ramen unlocked." },
  { type: "cousin",     label: "Drop off cousin", icon: "🚪", flavor: "Cousin delivered. Wave goodbye." },
  { type: "atm",        label: "ATM",             icon: "🏧", flavor: "Cash secured." },
  { type: "bugspray",   label: "Bug spray",       icon: "🦟", flavor: "Bug spray: this is the beach plan." },
  { type: "gas",        label: "Put gas",         icon: "⛽", flavor: "Tank full. Now a real adventure." },
  { type: "topup",      label: "Phone top-up",    icon: "📱", flavor: "Phone has minutes again." },
  { type: "mango",      label: "Mango stand",     icon: "🥭", flavor: "Mangoes. The good ones." },
  { type: "lascuevas",  label: "Las Cuevas",      icon: "🏖️", flavor: "Las Cuevas. The quiet beach." },
  { type: "maracas",    label: "Maracas Bay",     icon: "🌊", flavor: "Maracas. Bake-and-shark calling." },
  { type: "lookout",    label: "Maracas lookout", icon: "🏞️", flavor: "Lookout view. One photo. Done." },
  { type: "caroni",     label: "Caroni Swamp",    icon: "🦩", flavor: "Scarlet ibis sighted." },
  { type: "pelau",      label: "Pelau pot",       icon: "🍲", flavor: "Auntie's pelau. No leftovers." },
];

// ────────────────────────────────────────────────────────────────────────────
// Geometry helpers

function dist(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }

function lerp(a, b, t) { return a + (b - a) * t; }

function lerpPt(a, b, t) { return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) }; }

// Sample a cubic Bézier into a polyline of points.
function bezierSample(p0, p1, p2, p3, samples = 22) {
  const out = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const u = 1 - t;
    const x = u*u*u*p0.x + 3*u*u*t*p1.x + 3*u*t*t*p2.x + t*t*t*p3.x;
    const y = u*u*u*p0.y + 3*u*u*t*p1.y + 3*u*t*t*p2.y + t*t*t*p3.y;
    out.push({ x, y });
  }
  return out;
}

// Cumulative arc-length table for a polyline. Used to map t (0..1 of length)
// to a position + tangent.
function buildArcTable(points) {
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i-1] + dist(points[i-1], points[i]));
  }
  return { points, cum, length: cum[cum.length - 1] };
}

// Given an arc table and t in [0,1], return { x, y, tangent: {dx,dy} }.
export function pointAt(edge, t) {
  const tbl = edge._arc;
  const target = Math.max(0, Math.min(1, t)) * tbl.length;
  let i = 1;
  while (i < tbl.cum.length && tbl.cum[i] < target) i++;
  if (i >= tbl.cum.length) i = tbl.cum.length - 1;
  const segStart = tbl.cum[i-1];
  const segLen = (tbl.cum[i] - segStart) || 1;
  const localT = (target - segStart) / segLen;
  const a = tbl.points[i-1];
  const b = tbl.points[i];
  const x = lerp(a.x, b.x, localT);
  const y = lerp(a.y, b.y, localT);
  const tangent = normalize({ dx: b.x - a.x, dy: b.y - a.y });
  return { x, y, tangent };
}

function normalize(v) {
  const m = Math.hypot(v.dx, v.dy) || 1;
  return { dx: v.dx / m, dy: v.dy / m };
}

// Perpendicular (right-hand) of tangent.
function perp(tangent) {
  return { dx: -tangent.dy, dy: tangent.dx };
}

// World position of car given (edgeId, t, lane) using the edge's lane offset.
export function carWorldPos(graph, edgeId, t, laneFloat) {
  const e = graph.edgesById[edgeId];
  if (!e) return { x: 0, y: 0, angle: 0 };
  const p = pointAt(e, t);
  const off = laneOffset(e, laneFloat);
  const n = perp(p.tangent);
  return {
    x: p.x + n.dx * off,
    y: p.y + n.dy * off,
    angle: Math.atan2(p.tangent.dy, p.tangent.dx),
  };
}

// Convert lane index (0..lanes-1) to a perpendicular offset in px.
// Lane 0 is the leftmost (driver's left when going forward), lanes-1 the right.
export function laneOffset(edge, laneFloat) {
  const lanes = edge.lanes;
  // Center the lane bundle on the edge polyline. lane 0 is offset to the
  // "left" perp (negative), last lane to the "right" perp (positive).
  const half = (lanes - 1) / 2;
  return (laneFloat - half) * ROAD_LANE_WIDTH;
}

// ────────────────────────────────────────────────────────────────────────────
// RNG — seeded PRNG so we can regenerate identical maps for tests if needed.

function mulberry32(seed) {
  let a = seed >>> 0;
  return function() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickRandom(arr, rng) { return arr[Math.floor(rng() * arr.length)]; }

// ────────────────────────────────────────────────────────────────────────────
// Chunk authors. Each returns a subgraph in LOCAL coords (origin 0,0, flowing
// generally +Y from entry to exit). The stitcher translates and rotates them
// into world space.
//
// Each chunk must produce:
//   { nodes: [{lid, x, y}], edges: [{lid, fromLid, toLid, ctrl1, ctrl2,
//             lanes, hazards, kind}], entryLid, exitLid, height }
//   - lid = local ID (string). Stitcher renames to global IDs.
//   - ctrl1, ctrl2 are bezier control points relative to the chunk origin.
//   - kind classifies the edge for visuals: "straight", "hairpin", "round",
//     "filter", "potholed".
//   - height = the chunk's vertical extent so the stitcher knows how to stack.

function chunkStraight(rng, w) {
  const h = 220 + Math.floor(rng() * 80);
  const a = { lid: "n0", x: w/2, y: 0 };
  const b = { lid: "n1", x: w/2, y: h };
  const wob = (rng() - 0.5) * 60;
  const c1 = { x: w/2 + wob, y: h * 0.33 };
  const c2 = { x: w/2 - wob, y: h * 0.66 };
  const hazards = [];
  const potCount = Math.floor(rng() * 3);
  const lanes = 2;
  for (let i = 0; i < potCount; i++) {
    hazards.push({ t: 0.18 + rng() * 0.7, lane: Math.floor(rng() * lanes), kind: "pothole" });
  }
  return {
    nodes: [a, b],
    edges: [{ lid: "e0", fromLid: "n0", toLid: "n1", ctrl1: c1, ctrl2: c2, lanes, hazards, kind: "straight" }],
    entryLid: "n0",
    exitLid: "n1",
    height: h,
  };
}

function chunkHairpin(rng, w) {
  // 3 sharp S-curves stacked vertically. Each segment swings dramatically
  // left↔right. Driving fast through this without braking is the challenge.
  const segH = 110;
  const segs = 3;
  const h = segH * segs;
  const nodes = [];
  const edges = [];
  for (let i = 0; i <= segs; i++) {
    nodes.push({ lid: `n${i}`, x: w/2, y: i * segH });
  }
  for (let i = 0; i < segs; i++) {
    // Alternate the curve direction each segment for an S-shape.
    const dir = (i % 2 === 0) ? 1 : -1;
    const swing = (w * 0.42) * dir;
    const c1 = { x: w/2 + swing, y: i * segH + segH * 0.2 };
    const c2 = { x: w/2 + swing, y: i * segH + segH * 0.8 };
    const hazards = [];
    if (rng() < 0.6) {
      hazards.push({ t: 0.5, lane: Math.floor(rng() * 2), kind: "pothole" });
    }
    edges.push({
      lid: `e${i}`,
      fromLid: `n${i}`, toLid: `n${i+1}`,
      ctrl1: c1, ctrl2: c2,
      lanes: 2, hazards, kind: "hairpin",
    });
  }
  return {
    nodes, edges,
    entryLid: "n0",
    exitLid: `n${segs}`,
    height: h,
  };
}

function chunkRoundabout(rng, w) {
  // Big roundabout: car enters from the south (top of chunk), goes around
  // 3/4 of the circle, exits south (bottom of chunk). Two visual "exits"
  // pass by while you're on the roundabout but they're pure decoration —
  // gameplay-wise it auto-routes. The challenge is the curving edges.
  const cx = w/2;
  const r  = 110 + rng() * 25;        // radius
  const cy = r + 10;                  // center y, inside the chunk
  const h  = cy + r + 10;             // chunk height
  const entry = { lid: "in",  x: cx, y: 0 };
  const exit  = { lid: "out", x: cx, y: h };
  const top   = { lid: "rt",  x: cx, y: cy - r }; // approach onto loop (north of center)
  // Three loop nodes around the center: NE, S, NW.
  const loopE = { lid: "le",  x: cx + r, y: cy };
  const loopS = { lid: "ls",  x: cx, y: cy + r };
  const loopW = { lid: "lw",  x: cx - r, y: cy };

  // Edges: entry → top, top → loopE (curving right), loopE → loopS (curving),
  // loopS → exit (straight south). loopW is decoration (drawn in the renderer
  // for style, no traffic). Actually let's keep it functional: route via NE
  // arc only and not draw loopW so the geometry is symmetric in feel.
  // Use bezier control points to fake circular arcs.
  const arcK = 0.55;                  // bezier circle approx
  const ctrlOff = r * arcK;

  const nodes = [entry, top, loopE, loopS, exit, loopW];
  const edges = [
    {
      lid: "e_in",
      fromLid: "in", toLid: "rt",
      ctrl1: { x: cx, y: 8 },
      ctrl2: { x: cx, y: top.y - 8 },
      lanes: 2, hazards: [], kind: "straight",
    },
    {
      lid: "e_arc1",
      fromLid: "rt", toLid: "loopE_via",  // we'll add a virtual node
      ctrl1: { x: cx + ctrlOff, y: top.y },
      ctrl2: { x: loopE.x, y: cy - ctrlOff },
      lanes: 2, hazards: [], kind: "round",
    },
    {
      lid: "e_arc2",
      fromLid: "loopE_via", toLid: "loopS_via",
      ctrl1: { x: loopE.x, y: cy + ctrlOff },
      ctrl2: { x: cx + ctrlOff, y: loopS.y },
      lanes: 2,
      hazards: rng() < 0.5 ? [{ t: 0.5, lane: 0, kind: "pothole" }] : [],
      kind: "round",
    },
    {
      lid: "e_out",
      fromLid: "loopS_via", toLid: "out",
      ctrl1: { x: cx, y: loopS.y + 8 },
      ctrl2: { x: cx, y: h - 8 },
      lanes: 2, hazards: [], kind: "straight",
    },
  ];
  // Replace virtual nodes with real ones.
  nodes.push({ lid: "loopE_via", x: loopE.x, y: loopE.y });
  nodes.push({ lid: "loopS_via", x: loopS.x, y: loopS.y });
  // Decorative: also a "phantom exit" stub on the west side, drawn but
  // gameplay-wise unconnected. We mark it via a kind "deco_stub".
  edges.push({
    lid: "e_deco_w",
    fromLid: "lw",  toLid: "lw_stub",
    ctrl1: { x: loopW.x - 30, y: cy - 5 },
    ctrl2: { x: loopW.x - 60, y: cy },
    lanes: 2, hazards: [], kind: "deco",
  });
  nodes.push({ lid: "lw_stub", x: loopW.x - 80, y: cy });

  return { nodes, edges, entryLid: "in", exitLid: "out", height: h, _meta: { center: { x: cx, y: cy }, radius: r } };
}

function chunkFilterMerge(rng, w) {
  // Road splits into 2 lanes of separate paths, then merges. Lane 0 = left
  // path (cleaner), lane 1 = right path (longer, more potholes).
  // Visually: a teardrop. Gameplay: we don't actually move them onto
  // separate edges — the lane *is* the path. Hazards on the right side
  // simulate the "longer/dirtier" alternative.
  const h = 280 + Math.floor(rng() * 40);
  const cx = w/2;
  const a = { lid: "in",  x: cx, y: 0 };
  const b = { lid: "mid", x: cx, y: h * 0.5 };
  const c = { lid: "out", x: cx, y: h };
  // Two "fake split" passing edges that visually fan out and back. We model
  // it as a single edge with extra lane-positioned hazards, so the visual
  // still reads as a split. The lane offset visual still makes lane 0 vs
  // lane 1 feel like two separate paths.
  const e1 = {
    lid: "e1",
    fromLid: "in", toLid: "mid",
    ctrl1: { x: cx, y: h * 0.18 },
    ctrl2: { x: cx, y: h * 0.32 },
    lanes: 2,
    hazards: [
      { t: 0.45, lane: 1, kind: "pothole" },
      { t: 0.65, lane: 1, kind: "pothole" },
    ],
    kind: "filter",
  };
  const e2 = {
    lid: "e2",
    fromLid: "mid", toLid: "out",
    ctrl1: { x: cx, y: h * 0.6 },
    ctrl2: { x: cx, y: h * 0.85 },
    lanes: 2,
    hazards: rng() < 0.6 ? [{ t: 0.4, lane: 1, kind: "pothole" }] : [],
    kind: "filter",
  };
  return {
    nodes: [a, b, c],
    edges: [e1, e2],
    entryLid: "in", exitLid: "out", height: h,
    _meta: { filter: true },
  };
}

const CHUNK_AUTHORS = [
  { name: "straight",    fn: chunkStraight,    weight: 3 },
  { name: "hairpin",     fn: chunkHairpin,     weight: 2 },
  { name: "roundabout",  fn: chunkRoundabout,  weight: 2 },
  { name: "filter",      fn: chunkFilterMerge, weight: 2 },
];

function pickChunkAuthor(rng, exclude = null) {
  const pool = CHUNK_AUTHORS.filter((c) => c.name !== exclude);
  const total = pool.reduce((s, c) => s + c.weight, 0);
  let r = rng() * total;
  for (const c of pool) {
    if (r < c.weight) return c;
    r -= c.weight;
  }
  return pool[0];
}

// ────────────────────────────────────────────────────────────────────────────
// Stitcher: pick chunks, place them vertically in a column, link them with
// short connector edges.

function stitchMap(rng) {
  const chunkCount = 4 + Math.floor(rng() * 2);   // 4-5
  const w = WORLD_W;
  const chunks = [];
  let cursorY = 60;
  let last = null;
  for (let i = 0; i < chunkCount; i++) {
    const author = pickChunkAuthor(rng, last);
    last = author.name;
    const chunk = author.fn(rng, w);
    chunk._authorName = author.name;
    chunk._offsetY = cursorY;
    cursorY += chunk.height + 70; // gap for connector
    chunks.push(chunk);
  }
  // Total world height: cursorY (less the trailing gap)
  const totalH = cursorY - 70 + 60;

  // Translate each chunk's local nodes/edges into global nodes/edges with
  // unique IDs prefixed by chunk index.
  const nodes = [];
  const edges = [];
  let nodeId = 0;
  let edgeId = 0;
  const lidToGid = []; // per-chunk

  chunks.forEach((chunk, ci) => {
    const map = new Map();
    chunk.nodes.forEach((n) => {
      const gid = `n${nodeId++}`;
      map.set(n.lid, gid);
      nodes.push({ id: gid, x: n.x, y: n.y + chunk._offsetY, chunkIdx: ci });
    });
    lidToGid[ci] = map;
    chunk.edges.forEach((e) => {
      const gid = `e${edgeId++}`;
      const fromN = map.get(e.fromLid);
      const toN = map.get(e.toLid);
      const fp = nodes.find((n) => n.id === fromN);
      const tp = nodes.find((n) => n.id === toN);
      // Translate control points
      const ctrl1 = { x: e.ctrl1.x, y: e.ctrl1.y + chunk._offsetY };
      const ctrl2 = { x: e.ctrl2.x, y: e.ctrl2.y + chunk._offsetY };
      const polyline = bezierSample(fp, ctrl1, ctrl2, tp, 28);
      const arc = buildArcTable(polyline);
      edges.push({
        id: gid,
        fromNode: fromN,
        toNode: toN,
        lanes: e.lanes,
        kind: e.kind,
        hazards: e.hazards.map((h) => ({ ...h })),
        polyline,
        ctrl1, ctrl2,
        chunkIdx: ci,
        _arc: arc,
        length: arc.length,
      });
    });
  });

  // Connector edges between consecutive chunks: straight bezier from prev
  // exit → next entry.
  for (let i = 0; i < chunks.length - 1; i++) {
    const aExit = lidToGid[i].get(chunks[i].exitLid);
    const bEntry = lidToGid[i+1].get(chunks[i+1].entryLid);
    const ap = nodes.find((n) => n.id === aExit);
    const bp = nodes.find((n) => n.id === bEntry);
    const ctrl1 = { x: ap.x, y: ap.y + 24 };
    const ctrl2 = { x: bp.x, y: bp.y - 24 };
    const polyline = bezierSample(ap, ctrl1, ctrl2, bp, 16);
    const arc = buildArcTable(polyline);
    edges.push({
      id: `c${i}`, fromNode: aExit, toNode: bEntry,
      lanes: 2, kind: "connector", hazards: [],
      polyline, ctrl1, ctrl2,
      _arc: arc, length: arc.length,
    });
  }

  // Build adjacency: per node, the list of outgoing edges. For a chunk
  // entry/exit there's exactly one outgoing edge (the connector or the
  // chunk's first internal edge), so we just pick the first match. Deco
  // edges (inside a roundabout) are excluded from successor lookup.
  const successorByNode = new Map();
  for (const e of edges) {
    if (e.kind === "deco") continue;
    if (!successorByNode.has(e.fromNode)) successorByNode.set(e.fromNode, []);
    successorByNode.get(e.fromNode).push(e.id);
  }

  // Index edges/nodes for fast access
  const edgesById = Object.fromEntries(edges.map((e) => [e.id, e]));
  const nodesById = Object.fromEntries(nodes.map((n) => [n.id, n]));

  // Start: enter on the first chunk's first edge (the entry → first internal).
  const firstChunk = chunks[0];
  const firstEntryGid = lidToGid[0].get(firstChunk.entryLid);
  const startEdge = edges.find(
    (e) => e.fromNode === firstEntryGid && e.kind !== "deco" && e.kind !== "connector",
  ) || edges.find((e) => e.fromNode === firstEntryGid);

  // Home node: last chunk's exit. Driving home = reach this node.
  const lastChunk = chunks[chunks.length - 1];
  const homeNodeId = lidToGid[chunks.length - 1].get(lastChunk.exitLid);

  // Errand placement: pick random non-connector edges, place errand at random t.
  const errandEdgeCandidates = edges.filter(
    (e) => e.kind !== "deco" && e.kind !== "connector" && e.length > 80,
  );

  // Zone labels: derive a label per chunk for navigator HUD.
  const ZONE_NAMES = [
    "Arouca", "Champs Fleurs", "Curepe", "Valsayn", "St. Joseph", "Tunapuna",
    "Macoya", "Santa Cruz", "Maracas Valley", "Cumana", "Las Cuevas",
  ];
  // Shuffle and take chunkCount
  const labels = [...ZONE_NAMES].sort(() => rng() - 0.5).slice(0, chunks.length);
  const zones = chunks.map((ch, i) => {
    // Place label at the chunk's vertical midpoint, slightly off to the side.
    return {
      label: labels[i],
      x: w / 2 + (i % 2 === 0 ? -w * 0.32 : w * 0.32),
      y: ch._offsetY + ch.height / 2,
    };
  });

  return {
    id: `gen_${Date.now().toString(36)}`,
    width: w,
    height: totalH,
    nodes, edges, edgesById, nodesById,
    successorByNode,
    start: { edgeId: startEdge.id, t: 0, lane: 0 },
    homeNodeId,
    errandEdgeCandidates,
    zones,
    chunks: chunks.map((c) => ({ name: c._authorName, y: c._offsetY, h: c.height, meta: c._meta || null })),
  };
}

// Strip out the heavy server-only fields (arc tables, candidates) before
// sending to clients. Clients rebuild arc tables on receipt.
export function serializeGraph(graph) {
  return {
    id: graph.id,
    width: graph.width,
    height: graph.height,
    nodes: graph.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y })),
    edges: graph.edges.map((e) => ({
      id: e.id,
      fromNode: e.fromNode,
      toNode: e.toNode,
      lanes: e.lanes,
      kind: e.kind,
      hazards: e.hazards,
      polyline: e.polyline,
      length: e.length,
    })),
    homeNodeId: graph.homeNodeId,
    zones: graph.zones,
    chunks: graph.chunks,
  };
}

// Client side: rebuild arc tables + indices after receiving a serialized graph.
export function hydrateGraph(serialized) {
  const edges = serialized.edges.map((e) => ({
    ...e,
    _arc: buildArcTable(e.polyline),
  }));
  const edgesById = Object.fromEntries(edges.map((e) => [e.id, e]));
  const nodesById = Object.fromEntries(serialized.nodes.map((n) => [n.id, n]));
  const successorByNode = new Map();
  for (const e of edges) {
    if (e.kind === "deco") continue;
    if (!successorByNode.has(e.fromNode)) successorByNode.set(e.fromNode, []);
    successorByNode.get(e.fromNode).push(e.id);
  }
  return {
    ...serialized,
    edges,
    edgesById,
    nodesById,
    successorByNode,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Errand placement — pick errands and drop them on random non-connector edges.

export function rollErrandList(graph, count) {
  const pool = [...ERRAND_POOL];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const n = Math.min(count, pool.length);
  const picked = pool.slice(0, n);

  const cand = [...graph.errandEdgeCandidates];
  for (let i = cand.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cand[i], cand[j]] = [cand[j], cand[i]];
  }

  // Avoid placing two errands on the same edge.
  const used = new Set();
  const errands = [];
  for (const e of picked) {
    let target = cand.find((c) => !used.has(c.id));
    if (!target) target = cand[Math.floor(Math.random() * cand.length)];
    used.add(target.id);
    const t = 0.25 + Math.random() * 0.5;
    const p = pointAt(target, t);
    errands.push({
      type: e.type,
      label: e.label,
      icon: e.icon,
      flavor: e.flavor,
      edgeId: target.id,
      t,
      // Cached world position for client convenience
      x: p.x, y: p.y,
      done: false,
    });
  }
  return errands;
}

// ────────────────────────────────────────────────────────────────────────────
// Reunion grid (separate small map for the on-foot mini-game).

export function makeReunionGrid(rng = Math.random) {
  // Simple 12×12 grid of streets with a few walls. Keep walkable everywhere
  // except scattered '#' walls.
  const N = REUNION_GRID_SIZE;
  const tiles = [];
  for (let y = 0; y < N; y++) {
    const row = [];
    for (let x = 0; x < N; x++) {
      row.push(".");
    }
    tiles.push(row);
  }
  // Sprinkle walls
  const wallCount = 8 + Math.floor(rng() * 6);
  for (let i = 0; i < wallCount; i++) {
    const x = 1 + Math.floor(rng() * (N - 2));
    const y = 1 + Math.floor(rng() * (N - 2));
    // Don't wall the corners
    if ((x === 0 && y === 0) || (x === N-1 && y === N-1)) continue;
    tiles[y][x] = "#";
  }
  return {
    width: N, height: N, tiles,
    spawns: {
      driver:    { x: N - 1, y: N - 1, label: "End of the road" },
      navigator: { x: 0,     y: 0,     label: "Where we said we'd meet" },
    },
  };
}

export function isReunionWalkable(grid, x, y) {
  if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return false;
  return grid.tiles[y][x] !== "#";
}

// ────────────────────────────────────────────────────────────────────────────
// Game-mechanics helpers

export function tickMsForCombo(_combo) { return TICK_MS; }   // fixed tick now
export function comboMultiplier(combo) { return 1 + combo * COMBO_MULT_PER_LEVEL; }
export function speedForCombo(combo, braking) {
  const base = Math.min(SPEED_MAX, BASE_SPEED + combo * SPEED_PER_COMBO);
  return braking ? base * BRAKE_FACTOR : base;
}

export function makeRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

// Returns { ok: true } if there's a successor, otherwise { ok: false } meaning
// dead-end (treat as crash). For now successor selection is deterministic
// (first successor edge for the node). Future: lane-based routing.
export function pickSuccessor(graph, node, _arrivingLane) {
  const list = graph.successorByNode.get(node) || [];
  if (list.length === 0) return null;
  // For V1: single successor expected. If multiple (e.g. future filter
  // junctions), default to the first.
  return list[0];
}

// ────────────────────────────────────────────────────────────────────────────
// Room factory + reset.

export function freshRoom(code) {
  return {
    code,
    phase: "waiting",
    players: { driver: null, navigator: null },
    graph: null,                 // road graph for this round
    car: null,                   // { edgeId, t, lane (float), targetLane (int), facing }
    crashAt: null,
    argument: null,
    distance: 0,
    brakeUntil: 0,
    tickInterval: null,
    pendingStartAt: 0,
    lastLaneChangeAt: 0,
    errands: [],
    score: 0,
    combo: 0,
    bestCombo: 0,
    patience: PATIENCE_START,
    crashes: 0,
    hitPotholeIds: new Set(),    // pothole instances already triggered (per round)
    outcome: null,
    bestScoreThisSession: 0,
    // Reunion
    reunionGrid: null,
    driverAvatar: null,
    navigatorAvatar: null,
    reunionStartedAt: 0,
    reunionDecayInterval: null,
    reunionBonus: 0,
    reunionElapsedMs: 0,
    // Speed snapshot for client (server authoritative)
    lastTickAt: 0,
  };
}

export function resetRound(room, errandCount) {
  const count = errandCount ?? (ERRAND_COUNT_MIN + Math.floor(Math.random() * (ERRAND_COUNT_MAX - ERRAND_COUNT_MIN + 1)));
  // Generate a new graph every round so it can't be memorized.
  const seed = Math.floor(Math.random() * 2 ** 31);
  const rng = mulberry32(seed);
  room.graph = stitchMap(rng);
  room.errands = rollErrandList(room.graph, count);
  room.reunionGrid = makeReunionGrid(rng);

  room.phase = "ready";
  room.car = {
    edgeId: room.graph.start.edgeId,
    t: 0,
    lane: 0,
    targetLane: 0,
  };
  room.crashAt = null;
  room.argument = null;
  room.distance = 0;
  room.brakeUntil = 0;
  room.pendingStartAt = 0;
  room.lastLaneChangeAt = 0;
  room.hitPotholeIds = new Set();
  room.score = 0;
  room.combo = 0;
  room.bestCombo = 0;
  room.patience = PATIENCE_START;
  room.crashes = 0;
  room.outcome = null;
  room.driverAvatar = null;
  room.navigatorAvatar = null;
  room.reunionStartedAt = 0;
  room.reunionBonus = 0;
  room.reunionElapsedMs = 0;
}

// ────────────────────────────────────────────────────────────────────────────
// Barks + ending lines (unchanged from previous version).

export const REUNION_BARKS = {
  fast: [
    ["Found you fast.", "Made up faster."],
    ["Quickest reunion this side of Arouca.", "Couples therapy: cancelled."],
    ["You found me!", "I never doubted us."],
  ],
  slow: [
    ["Where WERE you?", "I went looking the wrong way."],
    ["This took longer than the actual drive.", "Maracas can wait. We needed this walk."],
    ["The vibes are mostly recovered.", "Mostly."],
  ],
};

export function pickReunionBark(elapsedMs) {
  const pool = elapsedMs <= 12_000 ? REUNION_BARKS.fast : REUNION_BARKS.slow;
  return pool[Math.floor(Math.random() * pool.length)];
}

export const CRASH_BARKS = [
  ["You said turn left!", "I said the OTHER left."],
  ["BRAKE was right there.", "I see one curve. ONE."],
  ["I trusted you.", "That was your first mistake."],
  ["You panicked!", "You accelerated into it."],
  ["The road is confusing.", "You are confusing."],
  ["I knew this would happen.", "Then why didn't you stop me?!"],
  ["You weren't listening.", "You weren't speaking words."],
  ["Slow down maybe??", "I am literally on cruise."],
  ["My job is to drive.", "My job is to lower my expectations."],
  ["Pothole!", "...you said that AFTER."],
];

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
