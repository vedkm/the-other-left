import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

import {
  MAP, freshRoom, resetRound, makeRoomCode,
  turnLeft, turnRight, forwardOf,
  classifyDriveTile, isReunionWalkable,
  pickCrashBark,
  tickMsForCombo, comboMultiplier,
  PATIENCE_START, PATIENCE_PER_TICK, PATIENCE_PER_CRASH, POST_CRASH_FREEZE_MS,
  COUNTDOWN_MS,
  ERRAND_BASE_SCORE, PERFECT_SATURDAY_BONUS, PATIENCE_BONUS_PER_POINT,
  REUNION_DECAY_PER_SEC, REUNION_BASE_BONUS, REUNION_MIN_BONUS,
  REUNION_BONUS_DECAY_PER_SEC, REUNION_TIMEOUT_MS,
  REUNION_SPAWNS,
} from "./shared/game.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
  },
});

const distDir = join(__dirname, "client", "dist");
app.use(express.static(distDir));
app.get("/room/:code", (_req, res) => {
  res.sendFile(join(distDir, "index.html"));
});

const RECONNECT_GRACE_MS = 30_000;

const rooms          = new Map();
const sessions       = new Map();
const clientToSocket = new Map();
const expiryTimers   = new Map();

function sendToClient(clientId, event, data) {
  const sid = clientToSocket.get(clientId);
  if (sid) io.to(sid).emit(event, data);
}

function bothConnected(room) {
  return !!(room.players.driver && clientToSocket.has(room.players.driver)
         && room.players.navigator && clientToSocket.has(room.players.navigator));
}

function publicState(room, role) {
  const reunionElapsed = room.reunionStartedAt
    ? Math.max(0, Date.now() - room.reunionStartedAt)
    : 0;
  const reunionTimeRemaining = room.phase === "reunion"
    ? Math.max(0, REUNION_TIMEOUT_MS - reunionElapsed)
    : 0;
  return {
    code: room.code,
    phase: room.phase,
    yourRole: role,
    partnerConnected: bothConnected(room),
    map: { width: MAP.width, height: MAP.height, tiles: MAP.tiles, zones: MAP.zones },
    home: MAP.home,
    car: room.car,
    crashAt: room.crashAt,
    argument: room.argument,
    distance: room.distance,
    braking: room.brakeTicks > 0,
    brakeTicks: room.brakeTicks,
    tickMs: tickMsForCombo(room.combo),
    countdownRemainingMs: Math.max(0, room.pendingStartAt - Date.now()),
    errands: room.errands,
    score: room.score,
    combo: room.combo,
    bestCombo: room.bestCombo,
    patience: Math.max(0, Math.round(room.patience)),
    patienceMax: PATIENCE_START,
    crashes: room.crashes,
    outcome: room.outcome,
    bestScoreThisSession: room.bestScoreThisSession,
    driverAvatar: room.driverAvatar,
    navigatorAvatar: room.navigatorAvatar,
    reunionElapsedMs: reunionElapsed,
    reunionTimeRemainingMs: reunionTimeRemaining,
    reunionBonus: room.reunionBonus,
  };
}

function broadcastRoom(room) {
  for (const role of ["driver", "navigator"]) {
    const cid = room.players[role];
    if (cid) sendToClient(cid, "state_updated", publicState(room, role));
  }
}

function stopTick(room) {
  if (room.tickInterval) {
    clearInterval(room.tickInterval);
    room.tickInterval = null;
  }
}

function scheduleNextTick(room) {
  stopTick(room);
  const ms = tickMsForCombo(room.combo);
  room.tickInterval = setInterval(() => tickRoom(room.code), ms);
}

function startTick(room) {
  room.pendingStartAt = Date.now() + COUNTDOWN_MS;
  scheduleNextTick(room);
}

// On-tile collisions for the car (errand pickups + home check).
function applyTileEffects(room) {
  // Errand pickup: if car is on an undone errand tile, complete it.
  for (const e of room.errands) {
    if (!e.done && e.x === room.car.x && e.y === room.car.y) {
      e.done = true;
      const mult = comboMultiplier(room.combo);
      const earned = Math.round(ERRAND_BASE_SCORE * mult);
      room.score += earned;
      room.combo += 1;
      if (room.combo > room.bestCombo) room.bestCombo = room.combo;
      // Tick speed-up applies on next reschedule
      scheduleNextTick(room);
    }
  }

  // Win condition: all errands done AND back at home
  const allDone = room.errands.every((e) => e.done);
  if (allDone && room.car.x === MAP.home.x && room.car.y === MAP.home.y) {
    finishDriving(room, "perfect");
  }
}

// End of driving — apply outcome bonuses, then transition to reunion (the
// time-pressure mini-game). Reunion settles into "complete" once players touch
// or the timeout fires.
function finishDriving(room, outcome) {
  room.outcome = outcome;
  if (outcome === "perfect") {
    room.score += PERFECT_SATURDAY_BONUS;
    room.score += Math.round(room.patience * PATIENCE_BONUS_PER_POINT);
  } else {
    room.score += Math.round(room.patience * (PATIENCE_BONUS_PER_POINT * 0.4));
  }
  stopTick(room);
  startReunion(room);
}

function startReunion(room) {
  room.phase = "reunion";
  room.driverAvatar    = { x: REUNION_SPAWNS.driver.x,    y: REUNION_SPAWNS.driver.y };
  room.navigatorAvatar = { x: REUNION_SPAWNS.navigator.x, y: REUNION_SPAWNS.navigator.y };
  room.reunionStartedAt = Date.now();
  room.reunionBonus = 0;
  room.reunionElapsedMs = 0;
  if (room.reunionDecayInterval) clearInterval(room.reunionDecayInterval);
  // Decay tick: 1Hz drains score, also auto-finalizes on timeout.
  room.reunionDecayInterval = setInterval(() => {
    if (!rooms.has(room.code) || room.phase !== "reunion") {
      stopReunion(room);
      return;
    }
    const elapsed = Date.now() - room.reunionStartedAt;
    room.reunionElapsedMs = elapsed;
    room.score = Math.max(0, room.score - REUNION_DECAY_PER_SEC);
    if (elapsed >= REUNION_TIMEOUT_MS) {
      finalizeRound(room); // timed out — no bonus, just finalize
      broadcastRoom(room);
      return;
    }
    broadcastRoom(room);
  }, 1000);
}

function stopReunion(room) {
  if (room.reunionDecayInterval) {
    clearInterval(room.reunionDecayInterval);
    room.reunionDecayInterval = null;
  }
}

// Resume the reunion decay tick after a reconnection — extends the timer
// by however long the partner was missing so they aren't punished for it.
function resumeReunion(room, missedMs) {
  if (room.phase !== "reunion") return;
  room.reunionStartedAt += Math.max(0, missedMs); // pretend the missed time didn't happen
  if (room.reunionDecayInterval) clearInterval(room.reunionDecayInterval);
  room.reunionDecayInterval = setInterval(() => {
    if (!rooms.has(room.code) || room.phase !== "reunion") {
      stopReunion(room);
      return;
    }
    const elapsed = Date.now() - room.reunionStartedAt;
    room.reunionElapsedMs = elapsed;
    room.score = Math.max(0, room.score - REUNION_DECAY_PER_SEC);
    if (elapsed >= REUNION_TIMEOUT_MS) {
      finalizeRound(room);
      broadcastRoom(room);
      return;
    }
    broadcastRoom(room);
  }, 1000);
}

function completeReunion(room) {
  const elapsedSec = (Date.now() - room.reunionStartedAt) / 1000;
  const bonus = Math.max(
    REUNION_MIN_BONUS,
    Math.round(REUNION_BASE_BONUS - elapsedSec * REUNION_BONUS_DECAY_PER_SEC),
  );
  room.score += bonus;
  room.reunionBonus = bonus;
  room.reunionElapsedMs = Math.round(elapsedSec * 1000);
  finalizeRound(room);
}

function finalizeRound(room) {
  stopReunion(room);
  if (room.score > room.bestScoreThisSession) {
    room.bestScoreThisSession = room.score;
  }
  room.phase = "complete";
}

// Apply patience/crash on bad move; combo reset.
function handleCrash(room, atX, atY) {
  room.crashAt = { x: atX, y: atY };
  room.argument = pickCrashBark();
  room.combo = 0;
  room.crashes += 1;
  room.patience -= PATIENCE_PER_CRASH;
  if (room.patience <= 0) {
    room.patience = 0;
    finishDriving(room, "tired");
    return;
  }
  // Brief freeze so the driver can reorient.
  room.pendingStartAt = Date.now() + POST_CRASH_FREEZE_MS;
  // Reset tick at base speed since combo is gone
  scheduleNextTick(room);
}

// Single forward step: returns true if a normal move happened.
function attemptForward(room) {
  const next = forwardOf(room.car, room.car.direction);
  const result = classifyDriveTile(MAP, next.x, next.y);
  if (result === "crash") {
    handleCrash(room, next.x, next.y);
    return false;
  }
  room.car = { ...room.car, x: next.x, y: next.y };
  room.distance += 1;
  applyTileEffects(room);
  return true;
}

function tickRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  if (room.phase !== "driving") { stopTick(room); return; }
  if (!bothConnected(room)) return;
  if (Date.now() < room.pendingStartAt) return;

  if (room.brakeTicks > 0) {
    room.brakeTicks -= 1;
    broadcastRoom(room);
    return;
  }

  // Slow patience drain on each tick.
  room.patience -= PATIENCE_PER_TICK;
  if (room.patience <= 0) {
    room.patience = 0;
    finishDriving(room, "tired");
    broadcastRoom(room);
    return;
  }

  attemptForward(room);
  broadcastRoom(room);
}

function expireSession(clientId) {
  const session = sessions.get(clientId);
  if (!session) return;
  const room = rooms.get(session.code);
  sessions.delete(clientId);
  if (!room) return;
  if (room.players[session.role] === clientId) {
    room.players[session.role] = null;
  }
  if (!room.players.driver && !room.players.navigator) {
    stopTick(room);
    stopReunion(room);
    rooms.delete(room.code);
    return;
  }
  stopTick(room);
  stopReunion(room);
  resetRound(room);
  const otherRole = session.role === "driver" ? "navigator" : "driver";
  const otherCid = room.players[otherRole];
  if (otherCid) sendToClient(otherCid, "partner_disconnected");
}

function fail(socket, clientId, action, reason) {
  console.log(`[fail] ${action} from ${clientId}: ${reason}`);
  socket.emit("action_failed", { action, reason });
  const session = sessions.get(clientId);
  if (!session) return;
  const room = rooms.get(session.code);
  if (room) socket.emit("state_updated", publicState(room, session.role));
}

io.on("connection", (socket) => {
  const clientId = socket.handshake.auth?.clientId;
  if (!clientId || typeof clientId !== "string") {
    socket.disconnect();
    return;
  }

  const pending = expiryTimers.get(clientId);
  if (pending) {
    clearTimeout(pending);
    expiryTimers.delete(clientId);
  }

  const previousSid = clientToSocket.get(clientId);
  if (previousSid && previousSid !== socket.id) {
    const old = io.sockets.sockets.get(previousSid);
    if (old) old.disconnect();
  }
  clientToSocket.set(clientId, socket.id);

  const restoredSession = sessions.get(clientId);
  if (restoredSession) {
    const room = rooms.get(restoredSession.code);
    if (room) {
      socket.emit("state_updated", publicState(room, restoredSession.role));
      const otherRole = restoredSession.role === "driver" ? "navigator" : "driver";
      const otherCid = room.players[otherRole];
      if (otherCid) sendToClient(otherCid, "state_updated", publicState(room, otherRole));
      if (room.phase === "driving" && bothConnected(room) && !room.tickInterval) {
        // Resume from where we paused, with a small grace window.
        room.pendingStartAt = Date.now() + 800;
        scheduleNextTick(room);
      }
      if (room.phase === "reunion" && bothConnected(room) && !room.reunionDecayInterval) {
        // Estimate how long the timer was paused — best we can do without
        // tracking pause time explicitly. Resumes without resetting positions.
        resumeReunion(room, 0);
      }
    }
  }

  socket.on("request_state", () => {
    const session = sessions.get(clientId);
    if (!session) return;
    const room = rooms.get(session.code);
    if (room) socket.emit("state_updated", publicState(room, session.role));
  });

  socket.on("create_room", () => {
    expireSession(clientId);
    let code;
    do { code = makeRoomCode(); } while (rooms.has(code));
    const room = freshRoom(code);
    room.players.driver = clientId;
    rooms.set(code, room);
    sessions.set(clientId, { code, role: "driver" });
    sendToClient(clientId, "state_updated", publicState(room, "driver"));
  });

  socket.on("join_room", ({ code }) => {
    const upper = (code || "").toUpperCase().trim();
    const room = rooms.get(upper);
    if (!room) { socket.emit("room_not_found"); return; }

    if (room.players.driver === clientId || room.players.navigator === clientId) {
      const role = room.players.driver === clientId ? "driver" : "navigator";
      sessions.set(clientId, { code: upper, role });
      sendToClient(clientId, "state_updated", publicState(room, role));
      return;
    }

    if (room.players.driver && room.players.navigator) {
      socket.emit("room_full"); return;
    }

    expireSession(clientId);
    const role = !room.players.driver ? "driver" : "navigator";
    room.players[role] = clientId;
    sessions.set(clientId, { code: upper, role });
    if (room.phase === "waiting" && room.players.driver && room.players.navigator) {
      room.phase = "ready";
    }
    broadcastRoom(room);
  });

  socket.on("start_game", () => {
    const session = sessions.get(clientId);
    if (!session)                      return fail(socket, clientId, "start_game", "no_session");
    const room = rooms.get(session.code);
    if (!room)                         return fail(socket, clientId, "start_game", "no_room");
    if (!bothConnected(room))          return fail(socket, clientId, "start_game", "partner_missing");
    if (room.phase !== "ready" && room.phase !== "complete")
                                       return fail(socket, clientId, "start_game", `wrong_phase:${room.phase}`);
    resetRound(room);
    room.phase = "driving";
    startTick(room);
    broadcastRoom(room);
  });

  socket.on("driver_input", ({ action }) => {
    const session = sessions.get(clientId);
    if (!session || session.role !== "driver") return;
    const room = rooms.get(session.code);
    if (!room || room.phase !== "driving") return;

    if (action === "turn_left" || action === "turn_right") {
      room.car.direction = action === "turn_left"
        ? turnLeft(room.car.direction)
        : turnRight(room.car.direction);
      // Tap-to-turn-and-go: rotate AND step one tile if the round is live.
      if (Date.now() >= room.pendingStartAt && room.brakeTicks === 0) {
        const moved = attemptForward(room);
        if (moved) scheduleNextTick(room);
      }
      broadcastRoom(room);
      return;
    }
    if (action === "brake") {
      // Brake breaks combo (real cost!) — encourages risk-taking instead of pause-tap-pause.
      if (room.combo > 0) room.combo = 0;
      if (room.brakeTicks < 3) { room.brakeTicks += 1; }
      scheduleNextTick(room); // refresh interval at new combo speed
      broadcastRoom(room);
      return;
    }
    if (action === "forward") {
      if (Date.now() < room.pendingStartAt) return;
      attemptForward(room);
      scheduleNextTick(room);
      broadcastRoom(room);
    }
  });

  socket.on("reunion_input", ({ action }) => {
    const session = sessions.get(clientId);
    if (!session) return;
    const room = rooms.get(session.code);
    if (!room || room.phase !== "reunion") return;

    const avatar = session.role === "driver" ? room.driverAvatar : room.navigatorAvatar;
    if (!avatar) return;
    const deltas = {
      up:    { dx: 0,  dy: -1 },
      down:  { dx: 0,  dy:  1 },
      left:  { dx: -1, dy:  0 },
      right: { dx: 1,  dy:  0 },
    };
    const d = deltas[action];
    if (!d) return;
    const nx = avatar.x + d.dx;
    const ny = avatar.y + d.dy;
    if (!isReunionWalkable(MAP, nx, ny)) return;
    avatar.x = nx;
    avatar.y = ny;

    // Same tile = reunited!
    if (
      room.driverAvatar.x === room.navigatorAvatar.x &&
      room.driverAvatar.y === room.navigatorAvatar.y
    ) {
      completeReunion(room);
    }
    broadcastRoom(room);
  });

  socket.on("restart_round", () => {
    const session = sessions.get(clientId);
    if (!session)                      return fail(socket, clientId, "restart_round", "no_session");
    const room = rooms.get(session.code);
    if (!room)                         return fail(socket, clientId, "restart_round", "no_room");
    if (!bothConnected(room))          return fail(socket, clientId, "restart_round", "partner_missing");
    stopReunion(room);
    resetRound(room);
    room.phase = "driving";
    startTick(room);
    broadcastRoom(room);
  });

  socket.on("disconnect", () => {
    if (clientToSocket.get(clientId) === socket.id) {
      clientToSocket.delete(clientId);
    }
    const session = sessions.get(clientId);
    if (session) {
      const room = rooms.get(session.code);
      if (room) {
        // Pause both timers — neither phase should advance while a partner is missing.
        stopTick(room);
        stopReunion(room);
        const otherRole = session.role === "driver" ? "navigator" : "driver";
        const otherCid = room.players[otherRole];
        if (otherCid) sendToClient(otherCid, "state_updated", publicState(room, otherRole));
      }
      const t = setTimeout(() => {
        if (!clientToSocket.has(clientId)) expireSession(clientId);
        expiryTimers.delete(clientId);
      }, RECONNECT_GRACE_MS);
      expiryTimers.set(clientId, t);
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`The Other Left listening on http://localhost:${PORT}`);
});
