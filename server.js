import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

import {
  MAP, freshRoom, resetRound, makeRoomCode,
  turnLeft, turnRight, forwardOf,
  classifyDriveTile, isReunionWalkable,
  pickArgument,
  TICK_MS, BRAKE_MAX, COUNTDOWN_MS,
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

// Identity is the persistent clientId from the browser (UUID in localStorage).
// Sockets come and go (network blips, phone sleep) — clientId survives.
const rooms          = new Map();   // code     → room
const sessions       = new Map();   // clientId → { code, role }
const clientToSocket = new Map();   // clientId → socket.id
const expiryTimers   = new Map();   // clientId → timeout handle

function sendToClient(clientId, event, data) {
  const sid = clientToSocket.get(clientId);
  if (sid) io.to(sid).emit(event, data);
}

function publicState(room, role) {
  return {
    code: room.code,
    phase: room.phase,
    yourRole: role,
    partnerConnected: !!(
      room.players.driver && clientToSocket.has(room.players.driver) &&
      room.players.navigator && clientToSocket.has(room.players.navigator)
    ),
    map: { width: MAP.width, height: MAP.height, tiles: MAP.tiles, zones: MAP.zones },
    start: MAP.start,
    destination: MAP.destination,
    car: room.car,
    crashAt: room.crashAt,
    argument: room.argument,
    driverAvatar: room.driverAvatar,
    navigatorAvatar: room.navigatorAvatar,
    driverSpawnLabel: MAP.driverSpawnAfterCrash.label,
    navigatorSpawnLabel: MAP.navigatorSpawnAfterCrash.label,
    outcome: room.outcome,
    distance: room.distance,
    braking: room.brakeTicks > 0,
    brakeTicks: room.brakeTicks,
    tickMs: TICK_MS,
    countdownRemainingMs: Math.max(0, room.pendingStartAt - Date.now()),
  };
}

function broadcastRoom(room) {
  for (const role of ["driver", "navigator"]) {
    const cid = room.players[role];
    if (cid) sendToClient(cid, "state_updated", publicState(room, role));
  }
}

function bothConnected(room) {
  return !!(room.players.driver && clientToSocket.has(room.players.driver)
         && room.players.navigator && clientToSocket.has(room.players.navigator));
}

function stopTick(room) {
  if (room.tickInterval) {
    clearInterval(room.tickInterval);
    room.tickInterval = null;
  }
}
function startTick(room) {
  stopTick(room);
  room.pendingStartAt = Date.now() + COUNTDOWN_MS;
  room.tickInterval = setInterval(() => tickRoom(room.code), TICK_MS);
}

function tickRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  if (room.phase !== "driving") { stopTick(room); return; }
  // Pause if a partner is missing — don't run the car into a wall while they're away.
  if (!bothConnected(room)) return;
  if (Date.now() < room.pendingStartAt) return;

  if (room.brakeTicks > 0) {
    room.brakeTicks--;
    broadcastRoom(room);
    return;
  }

  const next = forwardOf(room.car, room.car.direction);
  const result = classifyDriveTile(MAP, next.x, next.y);

  if (result === "win") {
    room.car = { ...room.car, x: next.x, y: next.y };
    room.distance++;
    room.phase = "complete";
    room.outcome = "destination_reached";
    stopTick(room);
    broadcastRoom(room);
    return;
  }
  if (result === "crash") {
    room.crashAt = { x: next.x, y: next.y };
    room.argument = pickArgument();
    room.phase = "crashed";
    stopTick(room);
    broadcastRoom(room);
    return;
  }
  room.car = { ...room.car, x: next.x, y: next.y };
  room.distance++;
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
    rooms.delete(room.code);
    return;
  }
  // True partner-loss after grace period — reset to a fresh round so the remaining player can wait for a new partner.
  stopTick(room);
  resetRound(room);
  const otherRole = session.role === "driver" ? "navigator" : "driver";
  const otherCid = room.players[otherRole];
  if (otherCid) sendToClient(otherCid, "partner_disconnected");
}

// fail() now resyncs the client with current state so a missed broadcast
// or out-of-sync UI auto-corrects rather than getting stuck.
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

  // Cancel any pending expiry — they're back within the grace window.
  const pending = expiryTimers.get(clientId);
  if (pending) {
    clearTimeout(pending);
    expiryTimers.delete(clientId);
  }

  // If another socket previously claimed this clientId (duplicate tab, weird reconnect),
  // disconnect the old one — last-tab-wins.
  const previousSid = clientToSocket.get(clientId);
  if (previousSid && previousSid !== socket.id) {
    const old = io.sockets.sockets.get(previousSid);
    if (old) old.disconnect();
  }
  clientToSocket.set(clientId, socket.id);

  // Restore session if known, and notify partner that we're back.
  const restoredSession = sessions.get(clientId);
  if (restoredSession) {
    const room = rooms.get(restoredSession.code);
    if (room) {
      socket.emit("state_updated", publicState(room, restoredSession.role));
      const otherRole = restoredSession.role === "driver" ? "navigator" : "driver";
      const otherCid = room.players[otherRole];
      if (otherCid) {
        // Tell both sides the partner-state changed (so any "disconnected" UI clears).
        sendToClient(otherCid, "state_updated", publicState(room, otherRole));
      }
      // If we were driving, resume the countdown briefly so they can settle in.
      if (room.phase === "driving" && bothConnected(room) && !room.tickInterval) {
        startTick(room);
      }
    }
  }

  // Polled by clients that suspect they're out of sync (a missed broadcast).
  // Cheap; just resends current state.
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

    // Already in this room? Just rebind silently (e.g., refresh during play).
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

    if (action === "turn_left")  { room.car.direction = turnLeft(room.car.direction);  broadcastRoom(room); return; }
    if (action === "turn_right") { room.car.direction = turnRight(room.car.direction); broadcastRoom(room); return; }
    if (action === "brake") {
      if (room.brakeTicks < BRAKE_MAX) { room.brakeTicks++; broadcastRoom(room); }
      return;
    }
    if (action === "forward") {
      if (Date.now() < room.pendingStartAt) return;
      const next = forwardOf(room.car, room.car.direction);
      const result = classifyDriveTile(MAP, next.x, next.y);
      if (result === "win") {
        room.car = { ...room.car, x: next.x, y: next.y };
        room.distance++;
        room.phase = "complete";
        room.outcome = "destination_reached";
        stopTick(room);
        broadcastRoom(room);
        return;
      }
      if (result === "crash") {
        room.crashAt = { x: next.x, y: next.y };
        room.argument = pickArgument();
        room.phase = "crashed";
        stopTick(room);
        broadcastRoom(room);
        return;
      }
      room.car = { ...room.car, x: next.x, y: next.y };
      room.distance++;
      broadcastRoom(room);
    }
  });

  socket.on("begin_reunion", () => {
    const session = sessions.get(clientId);
    if (!session)                      return fail(socket, clientId, "begin_reunion", "no_session");
    const room = rooms.get(session.code);
    if (!room)                         return fail(socket, clientId, "begin_reunion", "no_room");
    if (!bothConnected(room))          return fail(socket, clientId, "begin_reunion", "partner_missing");
    if (room.phase !== "crashed")      return fail(socket, clientId, "begin_reunion", `wrong_phase:${room.phase}`);
    room.driverAvatar    = { ...MAP.driverSpawnAfterCrash };
    room.navigatorAvatar = { ...MAP.navigatorSpawnAfterCrash };
    room.phase = "reunion";
    broadcastRoom(room);
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
    if (
      room.driverAvatar.x === room.navigatorAvatar.x &&
      room.driverAvatar.y === room.navigatorAvatar.y
    ) {
      room.phase = "complete";
      room.outcome = "reunited";
    }
    broadcastRoom(room);
  });

  socket.on("restart_round", () => {
    const session = sessions.get(clientId);
    if (!session)                      return fail(socket, clientId, "restart_round", "no_session");
    const room = rooms.get(session.code);
    if (!room)                         return fail(socket, clientId, "restart_round", "no_room");
    if (!bothConnected(room))          return fail(socket, clientId, "restart_round", "partner_missing");
    resetRound(room);
    room.phase = "driving";
    startTick(room);
    broadcastRoom(room);
  });

  socket.on("disconnect", () => {
    if (clientToSocket.get(clientId) === socket.id) {
      clientToSocket.delete(clientId);
    }
    // Pause the game until they're back (or grace period expires).
    const session = sessions.get(clientId);
    if (session) {
      const room = rooms.get(session.code);
      if (room) {
        // Stop the tick — driver can't react while disconnected.
        stopTick(room);
        // Tell partner we're temporarily gone (they can show a "waiting" state).
        const otherRole = session.role === "driver" ? "navigator" : "driver";
        const otherCid = room.players[otherRole];
        if (otherCid) sendToClient(otherCid, "state_updated", publicState(room, otherRole));
      }
      // Schedule grace-period expiry.
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
