import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

import {
  freshRoom, resetRound, makeRoomCode,
  serializeGraph, pointAt, laneOffset,
  isReunionWalkable,
  pickCrashBark,
  speedForCombo, comboMultiplier, pickSuccessor,
  TICK_MS,
  PATIENCE_START, PATIENCE_PER_SECOND, PATIENCE_PER_CRASH, PATIENCE_PER_POTHOLE,
  POST_CRASH_FREEZE_MS, COUNTDOWN_MS,
  ERRAND_BASE_SCORE, PERFECT_SATURDAY_BONUS, PATIENCE_BONUS_PER_POINT,
  ERRAND_RADIUS, POTHOLE_RADIUS,
  LANE_CHANGE_COOLDOWN_MS,
  REUNION_DECAY_PER_SEC, REUNION_BASE_BONUS, REUNION_MIN_BONUS,
  REUNION_BONUS_DECAY_PER_SEC, REUNION_TIMEOUT_MS,
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

function pushGraphToRoom(room) {
  if (!room.graph) return;
  const serialized = serializeGraph(room.graph);
  for (const role of ["driver", "navigator"]) {
    const cid = room.players[role];
    if (cid) sendToClient(cid, "graph_pushed", { graph: serialized });
  }
}

function pushReunionGridToRoom(room) {
  if (!room.reunionGrid) return;
  for (const role of ["driver", "navigator"]) {
    const cid = room.players[role];
    if (cid) sendToClient(cid, "reunion_grid_pushed", { grid: room.reunionGrid });
  }
}

function publicState(room, role) {
  const reunionElapsed = room.reunionStartedAt
    ? Math.max(0, Date.now() - room.reunionStartedAt)
    : 0;
  const reunionTimeRemaining = room.phase === "reunion"
    ? Math.max(0, REUNION_TIMEOUT_MS - reunionElapsed)
    : 0;
  const speed = room.phase === "driving"
    ? speedForCombo(room.combo, Date.now() < room.brakeUntil)
    : 0;
  return {
    code: room.code,
    phase: room.phase,
    yourRole: role,
    partnerConnected: bothConnected(room),
    graphId: room.graph?.id ?? null,
    car: room.car ? {
      edgeId: room.car.edgeId,
      t: room.car.t,
      lane: room.car.lane,
      targetLane: room.car.targetLane,
    } : null,
    speed,
    homeNodeId: room.graph?.homeNodeId ?? null,
    crashAt: room.crashAt,
    argument: room.argument,
    distance: Math.round(room.distance),
    braking: Date.now() < room.brakeUntil,
    tickMs: TICK_MS,
    countdownRemainingMs: Math.max(0, room.pendingStartAt - Date.now()),
    errands: room.errands,
    consumedHazardIds: Array.from(room.hitPotholeIds),
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
    serverTime: Date.now(),
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

function scheduleTick(room) {
  stopTick(room);
  room.tickInterval = setInterval(() => tickRoom(room.code), TICK_MS);
  room.lastTickAt = Date.now();
}

function startTick(room) {
  room.pendingStartAt = Date.now() + COUNTDOWN_MS;
  scheduleTick(room);
}

function carWorldPosFast(graph, edgeId, t, lane) {
  const e = graph.edgesById[edgeId];
  if (!e) return null;
  const p = pointAt(e, t);
  const off = laneOffset(e, lane);
  const nx = -p.tangent.dy;
  const ny = p.tangent.dx;
  return { x: p.x + nx * off, y: p.y + ny * off };
}

// ────────────────────────────────────────────────────────────────────────────
// Driving tick. Advances continuous motion, runs collision/pickup/transition.

function tickRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  if (room.phase !== "driving") { stopTick(room); return; }
  if (!bothConnected(room)) return;

  const now = Date.now();
  const dtMs = Math.min(250, now - (room.lastTickAt || now));
  room.lastTickAt = now;
  const dt = dtMs / 1000;

  if (now < room.pendingStartAt) {
    broadcastRoom(room);
    return;
  }

  // Patience decays continuously.
  room.patience -= PATIENCE_PER_SECOND * dt;
  if (room.patience <= 0) {
    room.patience = 0;
    finishDriving(room, "tired");
    broadcastRoom(room);
    return;
  }

  // Animate the car's lane toward its target lane (smooth visual swerve).
  if (Math.abs(room.car.lane - room.car.targetLane) > 0.001) {
    const laneStep = 4.5 * dt; // lanes/sec
    const diff = room.car.targetLane - room.car.lane;
    const move = Math.sign(diff) * Math.min(Math.abs(diff), laneStep);
    room.car.lane += move;
  } else {
    room.car.lane = room.car.targetLane;
  }

  // Advance position along edge.
  const speed = speedForCombo(room.combo, now < room.brakeUntil);
  const edge = room.graph.edgesById[room.car.edgeId];
  if (!edge) {
    // Should never happen, but treat as crash if it does.
    handleCrash(room, 0, 0);
    broadcastRoom(room);
    return;
  }
  const dPx = speed * dt;
  const dT = dPx / Math.max(1, edge.length);
  let newT = room.car.t + dT;

  // Hazards on this edge: check if we just crossed any in our (rounded) lane.
  for (const [idx, h] of edge.hazards.entries()) {
    const hid = `${edge.id}:${idx}`;
    if (room.hitPotholeIds.has(hid)) continue;
    const wasBefore = room.car.t < h.t;
    const isAfter = newT >= h.t;
    if (wasBefore && isAfter) {
      // Did we hit it? Compare lane (player's continuous lane vs hazard lane).
      if (Math.abs(room.car.lane - h.lane) < 0.6) {
        room.hitPotholeIds.add(hid);
        applyPotholeHit(room);
      }
    }
  }

  // Errands on this edge: same crossing logic, lane-agnostic (any lane picks up).
  for (const er of room.errands) {
    if (er.done) continue;
    if (er.edgeId !== edge.id) continue;
    const wasBefore = room.car.t < er.t;
    const isAfter = newT >= er.t;
    if (wasBefore && isAfter) {
      er.done = true;
      const mult = comboMultiplier(room.combo);
      const earned = Math.round(ERRAND_BASE_SCORE * mult);
      room.score += earned;
      room.combo += 1;
      if (room.combo > room.bestCombo) room.bestCombo = room.combo;
    }
  }

  // Reached the end of the edge: transition to next edge or finish.
  if (newT >= 1) {
    const overflow = newT - 1;
    const nodeId = edge.toNode;

    // Reached home? (all errands done + at home node = perfect)
    const allDone = room.errands.every((e) => e.done);
    if (nodeId === room.graph.homeNodeId && allDone) {
      finishDriving(room, "perfect");
      broadcastRoom(room);
      return;
    }

    // Pick successor based on lane (V1: just first successor).
    const arrivingLane = Math.round(room.car.lane);
    const nextEdgeId = pickSuccessor(room.graph, nodeId, arrivingLane);
    if (!nextEdgeId) {
      // Dead end: if it's home but not all done, freeze briefly + bounce back.
      if (nodeId === room.graph.homeNodeId) {
        // Stop at home node, await all errands.
        room.car.t = 1;
        // Tiny crash-style bump so the player feels the dead-end.
        handleCrash(room, edge.polyline[edge.polyline.length - 1].x, edge.polyline[edge.polyline.length - 1].y);
      } else {
        handleCrash(room, edge.polyline[edge.polyline.length - 1].x, edge.polyline[edge.polyline.length - 1].y);
      }
      broadcastRoom(room);
      return;
    }
    const nextEdge = room.graph.edgesById[nextEdgeId];
    room.car.edgeId = nextEdge.id;
    room.car.t = Math.min(0.999, overflow);
    // Clamp targetLane to next edge's lane count.
    if (room.car.targetLane >= nextEdge.lanes) room.car.targetLane = nextEdge.lanes - 1;
    if (room.car.lane >= nextEdge.lanes) room.car.lane = nextEdge.lanes - 1;
    room.distance += edge.length;
  } else {
    room.car.t = newT;
  }
  room.distance += dPx;

  broadcastRoom(room);
}

function applyPotholeHit(room) {
  room.combo = 0;
  room.patience -= PATIENCE_PER_POTHOLE;
  if (room.patience <= 0) {
    room.patience = 0;
    finishDriving(room, "tired");
    return;
  }
  // Brief speed reset ramp via combo at 0; no freeze. The thump SFX fires
  // client-side from observing combo break + consumedHazardIds growth.
}

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
  // Reset to the start of the current edge so the player has a chance to
  // recover instead of immediately crashing again.
  room.car.t = 0;
  // Keep target lane sane (clamp).
  const edge = room.graph.edgesById[room.car.edgeId];
  if (edge) {
    if (room.car.targetLane >= edge.lanes) room.car.targetLane = edge.lanes - 1;
    if (room.car.lane >= edge.lanes) room.car.lane = edge.lanes - 1;
  }
  room.pendingStartAt = Date.now() + POST_CRASH_FREEZE_MS;
}

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
  if (!room.reunionGrid) return;
  const sp = room.reunionGrid.spawns;
  room.driverAvatar    = { x: sp.driver.x,    y: sp.driver.y };
  room.navigatorAvatar = { x: sp.navigator.x, y: sp.navigator.y };
  room.reunionStartedAt = Date.now();
  room.reunionBonus = 0;
  room.reunionElapsedMs = 0;
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

function stopReunion(room) {
  if (room.reunionDecayInterval) {
    clearInterval(room.reunionDecayInterval);
    room.reunionDecayInterval = null;
  }
}

function resumeReunion(room, missedMs) {
  if (room.phase !== "reunion") return;
  room.reunionStartedAt += Math.max(0, missedMs);
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

// ────────────────────────────────────────────────────────────────────────────

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
  pushGraphToRoom(room);
  pushReunionGridToRoom(room);
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
      // Push the graph + reunion grid first so the state can resolve.
      if (room.graph) socket.emit("graph_pushed", { graph: serializeGraph(room.graph) });
      if (room.reunionGrid) socket.emit("reunion_grid_pushed", { grid: room.reunionGrid });
      socket.emit("state_updated", publicState(room, restoredSession.role));
      const otherRole = restoredSession.role === "driver" ? "navigator" : "driver";
      const otherCid = room.players[otherRole];
      if (otherCid) sendToClient(otherCid, "state_updated", publicState(room, otherRole));
      if (room.phase === "driving" && bothConnected(room) && !room.tickInterval) {
        room.pendingStartAt = Date.now() + 800;
        scheduleTick(room);
      }
      if (room.phase === "reunion" && bothConnected(room) && !room.reunionDecayInterval) {
        resumeReunion(room, 0);
      }
    }
  }

  socket.on("request_state", () => {
    const session = sessions.get(clientId);
    if (!session) return;
    const room = rooms.get(session.code);
    if (room) {
      if (room.graph) socket.emit("graph_pushed", { graph: serializeGraph(room.graph) });
      if (room.reunionGrid) socket.emit("reunion_grid_pushed", { grid: room.reunionGrid });
      socket.emit("state_updated", publicState(room, session.role));
    }
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
      if (room.graph) socket.emit("graph_pushed", { graph: serializeGraph(room.graph) });
      if (room.reunionGrid) socket.emit("reunion_grid_pushed", { grid: room.reunionGrid });
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
    if (room.graph) socket.emit("graph_pushed", { graph: serializeGraph(room.graph) });
    if (room.reunionGrid) socket.emit("reunion_grid_pushed", { grid: room.reunionGrid });
    broadcastRoom(room);
  });

  socket.on("start_game", () => {
    const session = sessions.get(clientId);
    if (!session)                      return fail(socket, clientId, "start_game", "no_session");
    const room = rooms.get(session.code);
    if (!room)                         return fail(socket, clientId, "start_game", "no_room");
    if (!bothConnected(room))          return fail(socket, clientId, "start_game", "partner_missing");
    if (room.phase !== "ready" && room.phase !== "complete" && room.phase !== "waiting")
                                       return fail(socket, clientId, "start_game", `wrong_phase:${room.phase}`);
    resetRound(room);
    pushGraphToRoom(room);
    pushReunionGridToRoom(room);
    room.phase = "driving";
    startTick(room);
    broadcastRoom(room);
  });

  socket.on("driver_input", ({ action }) => {
    const session = sessions.get(clientId);
    if (!session || session.role !== "driver") return;
    const room = rooms.get(session.code);
    if (!room || room.phase !== "driving") return;
    if (!room.car) return;

    const now = Date.now();

    if (action === "lane_left" || action === "lane_right") {
      if (now - room.lastLaneChangeAt < LANE_CHANGE_COOLDOWN_MS) return;
      const edge = room.graph.edgesById[room.car.edgeId];
      if (!edge) return;
      const delta = action === "lane_left" ? -1 : 1;
      const next = room.car.targetLane + delta;
      if (next < 0 || next >= edge.lanes) return;
      room.car.targetLane = next;
      room.lastLaneChangeAt = now;
      broadcastRoom(room);
      return;
    }
    if (action === "brake") {
      if (room.combo > 0) room.combo = 0;
      // Brake = reduced speed for a short window. Keep it short so it's
      // tactical, not a "stop and think" pause.
      room.brakeUntil = now + 700;
      broadcastRoom(room);
      return;
    }
  });

  socket.on("reunion_input", ({ action }) => {
    const session = sessions.get(clientId);
    if (!session) return;
    const room = rooms.get(session.code);
    if (!room || room.phase !== "reunion") return;
    if (!room.reunionGrid) return;

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
    if (!isReunionWalkable(room.reunionGrid, nx, ny)) return;
    avatar.x = nx;
    avatar.y = ny;

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
    pushGraphToRoom(room);
    pushReunionGridToRoom(room);
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

void carWorldPosFast; // reserved for future spatial queries
