import type { Direction, Tile, Errand, Outcome } from "../../shared/game";

export type Phase = "waiting" | "ready" | "driving" | "complete";
export type Role = "driver" | "navigator";

export interface PublicState {
  code: string;
  phase: Phase;
  yourRole: Role;
  partnerConnected: boolean;
  map: { width: number; height: number; tiles: Tile[][]; zones: { label: string; x: number; y: number }[] };
  home: { x: number; y: number };
  car: { x: number; y: number; direction: Direction };
  crashAt: { x: number; y: number } | null;
  argument: [string, string] | null;
  distance: number;
  braking: boolean;
  brakeTicks: number;
  tickMs: number;
  countdownRemainingMs: number;
  errands: Errand[];
  score: number;
  combo: number;
  bestCombo: number;
  patience: number;
  patienceMax: number;
  crashes: number;
  outcome: Outcome;
  bestScoreThisSession: number;
}
