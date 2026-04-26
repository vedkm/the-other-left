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

const rooms = new Map();
const sessions = new Map();

function publicState(room, role) {
  return {
    code: room.code,
    phase: room.phase,
    yourRole: role,
    partnerConnected: !!(room.players.driver && room.players.navigator),
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
    const sid = room.players[role];
    if (sid) io.to(sid).emit("state_updated", publicState(room, role));
  }
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
  if (Date.now() < room.pendingStartAt) return; // countdown still running

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
  // valid move
  room.car = { ...room.car, x: next.x, y: next.y };
  room.distance++;
  broadcastRoom(room);
}

function leaveCurrentRoom(socket) {
  const session = sessions.get(socket.id);
  if (!session) return;
  const room = rooms.get(session.code);
  sessions.delete(socket.id);
  if (!room) return;
  if (room.players[session.role] === socket.id) {
    room.players[session.role] = null;
  }
  if (!room.players.driver && !room.players.navigator) {
    stopTick(room);
    rooms.delete(room.code);
    return;
  }
  // Pause/end the round on partner loss.
  stopTick(room);
  if (room.phase === "driving" || room.phase === "crashed" || room.phase === "reunion") {
    room.phase = "ready";
    resetRound(room);
  }
  const otherRole = session.role === "driver" ? "navigator" : "driver";
  const otherSid = room.players[otherRole];
  if (otherSid) io.to(otherSid).emit("partner_disconnected");
}

io.on("connection", (socket) => {
  socket.on("create_room", () => {
    leaveCurrentRoom(socket);
    let code;
    do { code = makeRoomCode(); } while (rooms.has(code));
    const room = freshRoom(code);
    room.players.driver = socket.id;
    rooms.set(code, room);
    sessions.set(socket.id, { code, role: "driver" });
    socket.emit("state_updated", publicState(room, "driver"));
  });

  socket.on("join_room", ({ code }) => {
    const upper = (code || "").toUpperCase().trim();
    const room = rooms.get(upper);
    if (!room) { socket.emit("room_not_found"); return; }
    if (room.players.driver && room.players.navigator) {
      socket.emit("room_full"); return;
    }
    leaveCurrentRoom(socket);
    const role = !room.players.driver ? "driver" : "navigator";
    room.players[role] = socket.id;
    sessions.set(socket.id, { code: upper, role });
    if (room.phase === "waiting" && room.players.driver && room.players.navigator) {
      room.phase = "ready";
    }
    broadcastRoom(room);
  });

  socket.on("start_game", () => {
    const session = sessions.get(socket.id);
    if (!session) return;
    const room = rooms.get(session.code);
    if (!room) return;
    if (!room.players.driver || !room.players.navigator) return;
    if (room.phase !== "ready" && room.phase !== "complete") return;
    resetRound(room);
    room.phase = "driving";
    startTick(room);
    broadcastRoom(room);
  });

  socket.on("driver_input", ({ action }) => {
    const session = sessions.get(socket.id);
    if (!session || session.role !== "driver") return;
    const room = rooms.get(session.code);
    if (!room || room.phase !== "driving") return;

    if (action === "turn_left") {
      room.car.direction = turnLeft(room.car.direction);
      broadcastRoom(room);
      return;
    }
    if (action === "turn_right") {
      room.car.direction = turnRight(room.car.direction);
      broadcastRoom(room);
      return;
    }
    if (action === "brake") {
      if (room.brakeTicks < BRAKE_MAX) {
        room.brakeTicks++;
        broadcastRoom(room);
      }
      return;
    }
    // "forward" (manual nudge) — useful during the countdown to lurch off the line.
    if (action === "forward") {
      if (Date.now() < room.pendingStartAt) return; // ignore during countdown
      // Single-step movement (same logic as tick) — gives keyboard expressiveness.
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
      return;
    }
  });

  socket.on("begin_reunion", () => {
    const session = sessions.get(socket.id);
    if (!session) return;
    const room = rooms.get(session.code);
    if (!room || room.phase !== "crashed") return;
    room.driverAvatar    = { ...MAP.driverSpawnAfterCrash };
    room.navigatorAvatar = { ...MAP.navigatorSpawnAfterCrash };
    room.phase = "reunion";
    broadcastRoom(room);
  });

  socket.on("reunion_input", ({ action }) => {
    const session = sessions.get(socket.id);
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
    const session = sessions.get(socket.id);
    if (!session) return;
    const room = rooms.get(session.code);
    if (!room) return;
    if (!room.players.driver || !room.players.navigator) return;
    resetRound(room);
    room.phase = "driving";
    startTick(room);
    broadcastRoom(room);
  });

  socket.on("disconnect", () => {
    leaveCurrentRoom(socket);
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`The Other Left listening on http://localhost:${PORT}`);
});
