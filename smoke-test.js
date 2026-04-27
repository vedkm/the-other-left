// Smoke test for road-graph errand-date mode.
import { io } from "socket.io-client";

const URL = "http://localhost:3000";

function client(name) {
  const clientId = `test-${name}-${Math.random().toString(36).slice(2)}`;
  const s = io(URL, { transports: ["websocket"], auth: { clientId } });
  s.lastState = null;
  s.lastGraph = null;
  s.lastReunionGrid = null;
  s.tag = name;
  s.on("state_updated", (st) => { s.lastState = st; });
  s.on("graph_pushed", ({ graph }) => { s.lastGraph = graph; });
  s.on("reunion_grid_pushed", ({ grid }) => { s.lastReunionGrid = grid; });
  s.on("action_failed", (f) => console.warn(`[${name}] action_failed`, f));
  return s;
}

function waitFor(s, predicate, label, timeoutMs = 8000) {
  const safe = (st) => { try { return st && predicate(st); } catch { return false; } };
  return new Promise((resolve, reject) => {
    if (safe(s.lastState)) return resolve(s.lastState);
    const timer = setTimeout(
      () => reject(new Error(`[${s.tag}] timeout: ${label} (last phase=${s.lastState?.phase})`)),
      timeoutMs,
    );
    const handler = (st) => {
      if (safe(st)) { clearTimeout(timer); s.off("state_updated", handler); resolve(st); }
    };
    s.on("state_updated", handler);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const log = (ok, msg) => { ok ? pass++ : fail++; console.log(ok ? "  ✓" : "  ✗", msg); };

async function run() {
  const A = client("A");
  const B = client("B");
  await new Promise((r) => A.on("connect", r));
  await new Promise((r) => B.on("connect", r));

  console.log("\n— Room flow —");
  A.emit("create_room");
  const sA1 = await waitFor(A, (st) => !!st?.code, "room created");
  log(sA1.yourRole === "driver", "A is driver");
  log(typeof sA1.code === "string" && sA1.code.length === 4, `room code: ${sA1.code}`);

  B.emit("join_room", { code: sA1.code });
  await waitFor(B, (st) => st?.phase === "ready", "B ready");
  await waitFor(A, (st) => !!st?.partnerConnected, "A sees partner");

  console.log("\n— Round start: graph + errands roll —");
  A.emit("start_game");
  const sDrive = await waitFor(A, (st) => st.phase === "driving", "driving");
  // graph_pushed should arrive around the same time
  await sleep(150);
  log(!!A.lastGraph, "graph_pushed received");
  log(Array.isArray(A.lastGraph?.nodes) && A.lastGraph.nodes.length > 4, `graph has ${A.lastGraph?.nodes?.length} nodes`);
  log(Array.isArray(A.lastGraph?.edges) && A.lastGraph.edges.length > 4, `graph has ${A.lastGraph?.edges?.length} edges`);
  log(typeof A.lastGraph?.homeNodeId === "string", "graph has homeNodeId");
  log(Array.isArray(A.lastGraph?.zones) && A.lastGraph.zones.length > 0, `graph has ${A.lastGraph?.zones?.length} zones`);
  log(Array.isArray(A.lastGraph?.chunks) && A.lastGraph.chunks.length >= 4, `graph has ${A.lastGraph?.chunks?.length} chunks`);
  log(!!A.lastReunionGrid, "reunion_grid_pushed received");
  log(A.lastReunionGrid?.width === 12 && A.lastReunionGrid?.height === 12, `reunion grid 12×12`);

  log(sDrive.errands.length >= 4 && sDrive.errands.length <= 5, `errand list size = ${sDrive.errands.length}`);
  log(sDrive.errands.every((e) => !e.done), "all errands start undone");
  log(sDrive.errands.every((e) => typeof e.edgeId === "string" && typeof e.t === "number"), "errands placed on edges with t");
  log(sDrive.score === 0, "score starts at 0");
  log(sDrive.combo === 0, "combo starts at 0");
  log(sDrive.patience === 150, `patience starts at 150 (got ${sDrive.patience})`);

  console.log("\n— Continuous motion advances the car —");
  await sleep(2700); // past countdown
  const beforeT = A.lastState.car?.t ?? 0;
  const beforeEdge = A.lastState.car?.edgeId;
  await sleep(1200);
  const afterT = A.lastState.car?.t ?? 0;
  const afterEdge = A.lastState.car?.edgeId;
  const advanced = afterEdge !== beforeEdge || afterT > beforeT;
  log(advanced, `car advanced (edge ${beforeEdge}→${afterEdge}, t ${beforeT.toFixed(2)}→${afterT.toFixed(2)})`);
  log(A.lastState.distance > 0, `distance accumulated: ${A.lastState.distance}`);
  log(A.lastState.patience < 150, `patience drained: ${A.lastState.patience}`);

  console.log("\n— Lane change input —");
  A.emit("driver_input", { action: "lane_right" });
  await sleep(150);
  log(A.lastState.car.targetLane === 1, `targetLane = ${A.lastState.car.targetLane}`);
  await sleep(350); // past LANE_CHANGE_COOLDOWN_MS (280)
  A.emit("driver_input", { action: "lane_left" });
  await sleep(200);
  log(A.lastState.car.targetLane === 0, `targetLane = ${A.lastState.car.targetLane}`);

  console.log("\n— Brake reduces speed temporarily —");
  const beforeBrake = A.lastState.distance;
  A.emit("driver_input", { action: "brake" });
  await sleep(150);
  log(A.lastState.braking === true, "braking flag set");
  await sleep(900);
  const afterBrake = A.lastState.distance;
  log(afterBrake > beforeBrake, `distance still grew while braked: ${beforeBrake}→${afterBrake}`);

  console.log("\n— Reunion fields exist on state —");
  log(typeof A.lastState.reunionTimeRemainingMs === "number", "reunionTimeRemainingMs in state");
  log(typeof A.lastState.reunionBonus === "number", "reunionBonus in state");

  console.log("\n— Restart re-rolls the graph —");
  const oldGraphId = A.lastGraph?.id;
  A.lastState = null;
  A.lastGraph = null;
  A.emit("restart_round");
  const sRestart = await waitFor(A, (st) => st.phase === "driving" && st.distance === 0, "restarted to driving");
  await sleep(150);
  log(!!A.lastGraph, "new graph_pushed on restart");
  log(A.lastGraph?.id !== oldGraphId, `graph id changed: ${oldGraphId} → ${A.lastGraph?.id}`);
  log(sRestart.errands.every((e) => !e.done), "errands re-rolled and undone");
  log(sRestart.patience === 150, `patience reset to 150 (got ${sRestart.patience})`);

  A.disconnect();
  B.disconnect();
  console.log(`\n${pass}/${pass+fail} checks passed${fail ? ` (${fail} FAILED)` : ""}.`);
  process.exit(fail ? 1 : 0);
}

run().catch((e) => {
  console.error("test error:", e.message);
  process.exit(1);
});
