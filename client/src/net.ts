import { io, Socket } from "socket.io-client";
import type { PublicState } from "./types";

type Listener = (state: PublicState | null) => void;
type FailListener = (info: { action: string; reason: string }) => void;

function getClientId(): string {
  const KEY = "tol_clientId";
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) || (Date.now().toString(36) + Math.random().toString(36).slice(2));
    localStorage.setItem(KEY, id);
  }
  return id;
}

const ACTION_REASONS: Record<string, string> = {
  no_session:      "Your session expired. Reload to start over.",
  no_room:         "The room is gone. Reload to start over.",
  partner_missing: "Waiting for your partner to reconnect…",
  wrong_phase:     "Hmm, the game state changed. Try again.",
};

class Store {
  state: PublicState | null = null;
  socket: Socket;
  connected = false;
  private listeners = new Set<Listener>();
  private errorListeners = new Set<(msg: string) => void>();
  private failListeners = new Set<FailListener>();
  private connectionListeners = new Set<(c: boolean) => void>();

  constructor() {
    const clientId = getClientId();
    this.socket = io({
      transports: ["websocket", "polling"],
      auth: { clientId },
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 3000,
    });

    this.socket.on("state_updated", (s: PublicState) => {
      this.state = s;
      this.notify();
    });

    this.socket.on("room_not_found", () => this.error("Room not found."));
    this.socket.on("room_full",      () => this.error("That room is already full."));
    this.socket.on("partner_disconnected", () => {
      this.state = null;
      this.notify();
      this.error("Your partner disconnected.");
    });

    this.socket.on("action_failed", ({ action, reason }: { action: string; reason: string }) => {
      const baseReason = reason.split(":")[0];
      const friendly = ACTION_REASONS[baseReason] ?? `That didn't work (${reason}).`;
      this.error(friendly);
      for (const l of this.failListeners) l({ action, reason });
      console.warn(`[action_failed] ${action}: ${reason}`);
    });

    this.socket.on("connect",    () => { this.connected = true;  this.notifyConn(); });
    this.socket.on("disconnect", () => { this.connected = false; this.notifyConn(); });
    this.socket.on("connect_error", (e) => { console.warn("[socket] connect_error:", e.message); });
  }

  onActionFailed(fn: FailListener): () => void {
    this.failListeners.add(fn);
    return () => this.failListeners.delete(fn);
  }

  onConnectionChange(fn: (c: boolean) => void): () => void {
    this.connectionListeners.add(fn);
    return () => this.connectionListeners.delete(fn);
  }

  private notifyConn() {
    for (const l of this.connectionListeners) l(this.connected);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onError(fn: (msg: string) => void): () => void {
    this.errorListeners.add(fn);
    return () => this.errorListeners.delete(fn);
  }

  private notify() { for (const l of this.listeners) l(this.state); }
  private error(m: string) { for (const l of this.errorListeners) l(m); }

  // Outbound events.
  createRoom()                    { this.socket.emit("create_room"); }
  joinRoom(code: string)          { this.socket.emit("join_room", { code }); }
  startGame()                     { this.socket.emit("start_game"); }
  driverInput(action: "forward" | "turn_left" | "turn_right" | "brake") {
    this.socket.emit("driver_input", { action });
  }
  beginReunion()                  { this.socket.emit("begin_reunion"); }
  reunionInput(action: "up" | "down" | "left" | "right") {
    this.socket.emit("reunion_input", { action });
  }
  restartRound()                  { this.socket.emit("restart_round"); }
  requestState()                  { this.socket.emit("request_state"); }
}

export const store = new Store();
