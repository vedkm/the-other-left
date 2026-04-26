// Smoke test: verifies the real-time tick gameplay.
// Boots two clients, runs through driving / crash / reunion / restart.
import { io } from "socket.io-client";

const URL = "http://localhost:3000";
const TICK_MS = 900;
const COUNTDOWN_MS = 2000;

function client(name) {
  const s = io(URL, { transports: ["websocket"] });
  s.lastState = null;
  s.history = [];
  s.tag = name;
  s.on("state_updated", (st) => {
    s.lastState = st;
    s.history.push({ phase: st.phase, x: st.car.x, y: st.car.y, dir: st.car.direction, dist: st.distance, brake: st.brakeTicks });
  });
  s.on("room_not_found", () => s.history.push({ err: "not_found" }));
  s.on("room_full",      () => s.history.push({ err: "full" }));
  return s;
}

function waitFor(s, predicate, label, timeoutMs = 5000) {
  const safe = (st) => { try { return st && predicate(st); } catch { return false; } };
  return new Promise((resolve, reject) => {
    if (safe(s.lastState)) return resolve(s.lastState);
    const timer = setTimeout(() => reject(new Error(`[${s.tag}] timeout: ${label} (last phase=${s.lastState?.phase})`)), timeoutMs);
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
  log(sA1.tickMs === TICK_MS, `tickMs = ${sA1.tickMs}`);

  B.emit("join_room", { code: sA1.code });
  await waitFor(B, (st) => st?.phase === "ready", "B ready");
  await waitFor(A, (st) => !!st?.partnerConnected, "A sees partner");

  console.log("\n— Auto-tick after start —");
  const startedAt = Date.now();
  A.emit("start_game");
  await waitFor(A, (st) => st.phase === "driving", "driving");
  log(A.lastState.car.x === 1 && A.lastState.car.y === 0, "car at start (1,0)");
  log(A.lastState.countdownRemainingMs > 0, "countdown active");
  log(A.lastState.distance === 0, "distance starts at 0");

  // Wait for countdown + 2 ticks
  await sleep(COUNTDOWN_MS + TICK_MS * 2 + 200);
  const elapsed = Date.now() - startedAt;
  log(A.lastState.distance >= 1, `car auto-moved (distance=${A.lastState.distance} after ${elapsed}ms)`);
  log(A.lastState.car.x > 1, `car advanced east (x=${A.lastState.car.x})`);

  console.log("\n— Brake skips a tick —");
  const beforeBrakeDist = A.lastState.distance;
  A.emit("driver_input", { action: "brake" });
  await waitFor(A, (st) => st.brakeTicks === 1, "brake registered");
  // The next tick should NOT advance distance.
  await sleep(TICK_MS + 100);
  log(A.lastState.distance === beforeBrakeDist, `tick consumed brake (distance unchanged at ${beforeBrakeDist})`);
  // After brake, car should resume
  await sleep(TICK_MS + 200);
  log(A.lastState.distance > beforeBrakeDist, `car resumed after brake (distance=${A.lastState.distance})`);

  console.log("\n— Crash by turning into a wall —");
  // Force a crash: brake hard, rotate 180° (south to face down), then south is row 1 col X = '#'.
  // First, brake to give us breathing room.
  for (let i = 0; i < 3; i++) A.emit("driver_input", { action: "brake" });
  await sleep(50);
  // Turn right twice = face south. From wherever we are on row 0, south is row 1 which is mostly '#'.
  A.emit("driver_input", { action: "turn_right" });
  await sleep(50);
  // Wait for brakes to clear and tick to fire (will try to move south into wall)
  const sCrash = await waitFor(A, (st) => st.phase === "crashed", "crashed", 8000);
  log(!!sCrash.crashAt, `crashAt = (${sCrash.crashAt.x},${sCrash.crashAt.y})`);
  log(Array.isArray(sCrash.argument), "argument lines present");

  console.log("\n— Reunion phase (new spawns far apart) —");
  A.emit("begin_reunion");
  const sR_A = await waitFor(A, (st) => st.phase === "reunion", "A reunion");
  const sR_B = await waitFor(B, (st) => st.phase === "reunion", "B reunion");
  log(sR_A.driverAvatar.x === 0 && sR_A.driverAvatar.y === 9, `driver spawn (0,9)`);
  log(sR_B.navigatorAvatar.x === 14 && sR_B.navigatorAvatar.y === 0, `navigator spawn (14,0)`);

  // Walk both to a meeting point — easier path: meet on row 8 around col 7
  // Driver from (0,9) → (0,8) → (1,8) → (2,8) → ... walking east on row 8
  // Navigator from (14,0) → (14,1) → ... down right side
  // Let's just teleport-test by sending many moves; actual pathfinding can be unreliable due to walls.
  // Drive driver east on row 9? Row 9 = ".###.#####...D#" — col 0='.', 1-3='#'. Stuck.
  // Driver path: (0,9) up to (0,8) which is '.', then east through row 8 (which is ".........#....#"): cols 0-8 are '.', col 9 is '#'. So (0,8)→(8,8) east, all '.'.
  // Navigator path: (14,0) row 0 col 14='.'. (14,1) row 1 col 14='#'. Stuck. Try west: (13,0) row 0 col 13='.'. Continue west on row 0: row 0 = ".S.............", all cols 0-14 are '.' or 'S'. So navigator can walk west on row 0 toward S.
  // Then south at col 11: (11,1)='.', (11,2)='.'. Then east: (11,2)→(14,2). Down to (14,3)='.', (14,4)='.', (14,5)='.'. Then west to (13,5)='.', south through (13,6)→(13,9)='D' (which is walkable in reunion).
  // OK but that's a long walk. Let's just send moves.
  const driverPath = ["up", "right", "right", "right", "right", "right", "right", "right"]; // (0,9)→(0,8)→(1,8)..(8,8)
  const navPath    = ["left","left","left","down","down","down","right","right","right","down","down","down","down","down","down","down"];
  // The above for navigator: (14,0)→(13,0)→(12,0)→(11,0)→(11,1)→(11,2)→(11,3) blocked? Row 3 col 11='.'. Let me re-check: row 3 = ".#####.######..". cols: . # # # # # . # # # # # # . . — col 11='#'. So (11,3)='#'. Stuck. Re-plan.
  // Actually just doing a coverage test is fine — verify reunion happens via SOME path. Let me just walk both into a known cell.
  // Easier: have driver walk east along row 8 to (4,8), navigator drop to (14,2) and walk west to (4,8).
  // Driver: (0,9)→up→(0,8)→right x4→(4,8)
  // Navigator: (14,0)→left→(13,0)... wait, just have nav drop from (14,2) (already accessible).
  // (14,0)→left→(13,0)→...→(11,0)→down→(11,1)→down→(11,2)→right x3→(14,2)→down x3→(14,5)→left→(13,5)→down→...
  // Forget perfect pathing — just do enough moves on both sides and check phase change.
  const drvMoves = ["up","right","right","right","right"]; // ends at (4,8)
  for (const a of drvMoves) { A.emit("reunion_input", { action: a }); await sleep(35); }
  await sleep(100);
  log(A.lastState.driverAvatar.x === 4 && A.lastState.driverAvatar.y === 8, `driver walked to (${A.lastState.driverAvatar.x},${A.lastState.driverAvatar.y})`);

  // Navigator walks from (14,0) all the way to (4,8). Path:
  // west to (11,0), down to (11,2), east to (14,2), down to (14,5), west to (13,5), down to (13,8), west to (4,8).
  // Row 8 cols 4..13: row 8 = ".........#....#" → col 9='#'. So can't walk west past col 9. From (13,8) west to (10,8), then (9,8)='#' blocks. So from (13,8) we only reach (10,8). Hmm.
  // Alternative: meet on row 8 cols 0-8 (which are '.'). Driver is at (4,8). Nav needs to reach (4,8).
  // Nav route: from (14,0) west to (4,0) [along row 0], down to (4,1)? Row 1 col 4='#'. Try (3,0) → down? Row 1 col 3='.'. So nav goes (4,0)→(3,0)→(3,1)='.'→(3,2)='.'→ check below.
  // Row 2 col 3='.', col 4='.'. So (3,2)→east→(4,2)='.'. Row 3 col 4='#'. Hmm.
  // From (3,2) west to (0,2)='.'. Row 3 col 0='.'. So (0,2)→down→(0,3)='.'→(0,4)='.'→(0,5)='.'→(0,6)='.'→(0,7)='.'→(0,8)='.'→(0,9)? But that's old driver spawn.
  // Or stop at (0,8) and meet driver there. Driver is at (4,8). From nav (0,8) east to (4,8): row 8 col 0-4 all '.'. So driver could come back to (0,8) or nav goes east.
  // Let me have nav walk: (14,0)→west to (3,0)[11 lefts]→down to (3,2)[2 downs]→west to (0,2)[3 lefts]→down to (0,8)[6 downs]→east to (4,8)[4 rights]. That's 26 moves.
  // Long but ok.
  const navMoves = [
    "left","left","left","left","left","left","left","left","left","left","left", // (14,0)→(3,0)
    "down","down",                                                                  // (3,0)→(3,2)
    "left","left","left",                                                            // (3,2)→(0,2)
    "down","down","down","down","down","down",                                       // (0,2)→(0,8)
    "right","right","right","right",                                                 // (0,8)→(4,8) — driver here!
  ];
  for (const a of navMoves) {
    B.emit("reunion_input", { action: a });
    await sleep(30);
    if (B.lastState.phase === "complete") break;
  }
  await sleep(150);
  log(A.lastState.phase === "complete" && A.lastState.outcome === "reunited",
      `reunited at (${A.lastState.driverAvatar.x},${A.lastState.driverAvatar.y}); nav at (${A.lastState.navigatorAvatar.x},${A.lastState.navigatorAvatar.y})`);

  console.log("\n— Restart begins a fresh round —");
  A.emit("restart_round");
  const sRestart = await waitFor(A, (st) => st.phase === "driving" && st.distance === 0 && st.car.x === 1 && st.car.y === 0, "restarted to driving");
  log(sRestart.countdownRemainingMs > 0, "fresh countdown on restart");

  A.disconnect();
  B.disconnect();
  console.log(`\n${pass}/${pass+fail} checks passed${fail ? ` (${fail} FAILED)` : ""}.`);
  process.exit(fail ? 1 : 0);
}

run().catch((e) => {
  console.error("test error:", e.message);
  process.exit(1);
});
