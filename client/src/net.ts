import { io, Socket } from "socket.io-client";
import type { PublicState } from "./types";

type Listener = (state: PublicState | null) => void;

class Store {
  state: PublicState | null = null;
  socket: Socket;
  private listeners = new Set<Listener>();
  private errorListeners = new Set<(msg: string) => void>();

  constructor() {
    this.socket = io({ transports: ["websocket", "polling"] });

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
}

export const store = new Store();
