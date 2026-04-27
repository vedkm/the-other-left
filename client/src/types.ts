import type { Phase, CarState, Errand, Outcome, ReunionGrid, SerializedGraph, HydratedGraph } from "../../shared/game";

export type { Phase, ReunionGrid, SerializedGraph, HydratedGraph };
export type Role = "driver" | "navigator";

export interface PublicState {
  code: string;
  phase: Phase;
  yourRole: Role;
  partnerConnected: boolean;
  graphId: string | null;
  car: CarState | null;
  speed: number;
  homeNodeId: string | null;
  crashAt: { x: number; y: number } | null;
  argument: [string, string] | null;
  distance: number;
  braking: boolean;
  tickMs: number;
  countdownRemainingMs: number;
  errands: Errand[];
  consumedHazardIds: string[];
  score: number;
  combo: number;
  bestCombo: number;
  patience: number;
  patienceMax: number;
  crashes: number;
  outcome: Outcome;
  bestScoreThisSession: number;
  driverAvatar: { x: number; y: number } | null;
  navigatorAvatar: { x: number; y: number } | null;
  reunionElapsedMs: number;
  reunionTimeRemainingMs: number;
  reunionBonus: number;
  serverTime: number;
}
