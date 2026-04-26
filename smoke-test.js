// Smoke test for portrait map (10×14) with auto-tick.
// Validates the slices end-to-end without depending on map-specific tile coords beyond start/spawns.
import { io } from "socket.io-client";

const URL = "http://localhost:3000";
const TICK_MS = 900;
const COUNTDOWN_MS = 2000;

function client(name) {
  const clientId = `test-${name}-${Math.random().toString(36).slice(2)}`;
  const s = io(URL, { transports: ["websocket"], auth: { clientId } });
  s.lastState = null;
  s.tag = name;
  s.failures = [];
  s.on("state_updated", (st) => { s.lastState = st; });
  s.on("action_failed", (f) => { s.failures.push(f); });
  return s;
}

function waitFor(s, predicate, label, timeoutMs = 6000) {
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
  log(sA1.map.width === 10 && sA1.map.height === 14, `map size 10x14`);
  log(sA1.start.x === 1 && sA1.start.y === 0, `start at (1,0)`);
  log(sA1.start.direction === "south", `start direction south`);
  log(sA1.destination.x === 8 && sA1.destination.y === 13, `destination at (8,13)`);

  B.emit("join_room", { code: sA1.code });
  await waitFor(B, (st) => st?.phase === "ready", "B ready");
  await waitFor(A, (st) => !!st?.partnerConnected, "A sees partner");

  console.log("\n— Auto-tick + crash by inaction —");
  // S=(1,0) facing south. (1,1)='.', (1,2)='.', (1,3)='#'. So 3rd tick crashes.
  A.emit("start_game");
  await waitFor(A, (st) => st.phase === "driving", "driving");
  log(A.lastState.car.x === 1 && A.lastState.car.y === 0, "car starts at (1,0)");
  log(A.lastState.car.direction === "south", "car faces south");

  // Wait for countdown + a couple ticks
  await sleep(COUNTDOWN_MS + TICK_MS * 1.5);
  log(A.lastState.distance >= 1, `auto-moved south (distance=${A.lastState.distance})`);

  // Wait for crash (will happen when car tries to enter (1,3)='#')
  const sCrash = await waitFor(A, (st) => st.phase === "crashed", "crashed", 6000);
  log(sCrash.crashAt?.x === 1 && sCrash.crashAt?.y === 3, `crashAt = (1,3)`);
  log(Array.isArray(sCrash.argument), "argument lines present");

  console.log("\n— Reunion phase (portrait spawns) —");
  A.emit("begin_reunion");
  const sR_A = await waitFor(A, (st) => st.phase === "reunion", "A reunion");
  const sR_B = await waitFor(B, (st) => st.phase === "reunion", "B reunion");
  log(sR_A.driverAvatar.x === 9 && sR_A.driverAvatar.y === 0, `driver spawn (9,0)`);
  log(sR_B.navigatorAvatar.x === 0 && sR_B.navigatorAvatar.y === 12, `nav spawn (0,12)`);

  // Walk both toward (5,8) on row 8 (which is all road).
  // Driver: (9,0)→south x3→(9,3)→west x1→(8,3)→south x3→(8,6)→west x3→(5,6)→west x2→(3,6)→south x2→(3,8)→east x2→(5,8)
  const drvPath = ["down","down","down","left","down","down","down","left","left","left","left","left","down","down","right","right"];
  for (const a of drvPath) { A.emit("reunion_input", { action: a }); await sleep(30); }
  await sleep(120);
  log(A.lastState.driverAvatar.x === 5 && A.lastState.driverAvatar.y === 8,
      `driver walked to (${A.lastState.driverAvatar.x},${A.lastState.driverAvatar.y})`);

  // Nav: (0,12)→up x4→(0,8)→east x5→(5,8)
  const navPath = ["up","up","up","up","right","right","right","right","right"];
  for (const a of navPath) {
    B.emit("reunion_input", { action: a });
    await sleep(30);
    if (B.lastState.phase === "complete") break;
  }
  await sleep(150);
  log(A.lastState.phase === "complete" && A.lastState.outcome === "reunited",
      `reunited at (${A.lastState.driverAvatar.x},${A.lastState.driverAvatar.y})`);

  console.log("\n— Brake skips a tick —");
  A.emit("restart_round");
  await waitFor(A, (st) => st.phase === "driving" && st.distance === 0, "restarted");
  // Wait out the countdown
  await sleep(COUNTDOWN_MS + 100);
  // Allow first auto-tick
  await sleep(TICK_MS + 100);
  const beforeBrake = A.lastState.distance;
  A.emit("driver_input", { action: "brake" });
  await sleep(50);
  log(A.lastState.brakeTicks === 1, "brake registered");
  await sleep(TICK_MS + 100);
  log(A.lastState.distance === beforeBrake, `tick consumed brake (distance unchanged at ${beforeBrake})`);

  A.disconnect();
  B.disconnect();
  console.log(`\n${pass}/${pass+fail} checks passed${fail ? ` (${fail} FAILED)` : ""}.`);
  process.exit(fail ? 1 : 0);
}

run().catch((e) => {
  console.error("test error:", e.message);
  process.exit(1);
});
