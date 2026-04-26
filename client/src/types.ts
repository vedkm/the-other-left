import type { Direction, Tile } from "../../shared/game";

export type Phase = "waiting" | "ready" | "driving" | "crashed" | "reunion" | "complete";
export type Role = "driver" | "navigator";

export interface PublicState {
  code: string;
  phase: Phase;
  yourRole: Role;
  partnerConnected: boolean;
  map: { width: number; height: number; tiles: Tile[][]; zones: { label: string; x: number; y: number }[] };
  start: { x: number; y: number; direction: Direction };
  destination: { x: number; y: number };
  car: { x: number; y: number; direction: Direction };
  crashAt: { x: number; y: number } | null;
  argument: [string, string] | null;
  driverAvatar: { x: number; y: number } | null;
  navigatorAvatar: { x: number; y: number } | null;
  driverSpawnLabel: string;
  navigatorSpawnLabel: string;
  outcome: "destination_reached" | "reunited" | null;
  distance: number;
  braking: boolean;
  brakeTicks: number;
  tickMs: number;
  countdownRemainingMs: number;
}
