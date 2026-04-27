// Type declarations for shared/game.js — road graph mode.
//
// World coordinates are continuous (px-equivalent). The map is a procedural
// road graph generated each round.

export type Outcome = "perfect" | "tired" | null;
export type Phase = "waiting" | "ready" | "driving" | "reunion" | "complete";

export type EdgeKind =
  | "straight"
  | "hairpin"
  | "round"
  | "filter"
  | "connector"
  | "deco";

export interface Pt { x: number; y: number; }

export interface Hazard {
  t: number;
  lane: number;
  kind: "pothole";
}

export interface Edge {
  id: string;
  fromNode: string;
  toNode: string;
  lanes: number;
  kind: EdgeKind;
  hazards: Hazard[];
  polyline: Pt[];
  length: number;
}

export interface Node {
  id: string;
  x: number;
  y: number;
}

export interface SerializedGraph {
  id: string;
  width: number;
  height: number;
  nodes: Node[];
  edges: Edge[];
  homeNodeId: string;
  zones: { label: string; x: number; y: number }[];
  chunks: { name: string; y: number; h: number; meta: any }[];
}

export interface HydratedGraph extends SerializedGraph {
  edges: (Edge & { _arc: { points: Pt[]; cum: number[]; length: number } })[];
  edgesById: Record<string, Edge & { _arc: { points: Pt[]; cum: number[]; length: number } }>;
  nodesById: Record<string, Node>;
  successorByNode: Map<string, string[]>;
}

export interface CarState {
  edgeId: string;
  t: number;
  lane: number;          // float (animated)
  targetLane: number;    // int (the lane the player has selected)
}

export interface Errand {
  type: string;
  label: string;
  icon: string;
  flavor: string;
  edgeId: string;
  t: number;
  x: number;
  y: number;
  done: boolean;
}

export interface ErrandPoolItem {
  type: string;
  label: string;
  icon: string;
  flavor: string;
}

export interface ReunionGrid {
  width: number;
  height: number;
  tiles: string[][];
  spawns: {
    driver:    { x: number; y: number; label: string };
    navigator: { x: number; y: number; label: string };
  };
}

export const ERRAND_POOL: ErrandPoolItem[];

export const TICK_MS: number;
export const BASE_SPEED: number;
export const SPEED_PER_COMBO: number;
export const SPEED_MAX: number;
export const BRAKE_FACTOR: number;
export const COMBO_MULT_PER_LEVEL: number;
export const PATIENCE_START: number;
export const PATIENCE_PER_SECOND: number;
export const PATIENCE_PER_CRASH: number;
export const PATIENCE_PER_POTHOLE: number;
export const POST_CRASH_FREEZE_MS: number;
export const COUNTDOWN_MS: number;
export const ERRAND_COUNT_MIN: number;
export const ERRAND_COUNT_MAX: number;
export const ERRAND_BASE_SCORE: number;
export const PERFECT_SATURDAY_BONUS: number;
export const PATIENCE_BONUS_PER_POINT: number;
export const LANE_CHANGE_COOLDOWN_MS: number;
export const ERRAND_RADIUS: number;
export const POTHOLE_RADIUS: number;

export const REUNION_DECAY_PER_SEC: number;
export const REUNION_BASE_BONUS: number;
export const REUNION_MIN_BONUS: number;
export const REUNION_BONUS_DECAY_PER_SEC: number;
export const REUNION_TIMEOUT_MS: number;
export const REUNION_VIS_RADIUS: number;
export const REUNION_GRID_SIZE: number;

export const WORLD_W: number;
export const WORLD_H: number;
export const ROAD_LANE_WIDTH: number;
export const FOG_AHEAD: number;
export const FOG_BEHIND: number;
export const FOG_RADIUS: number;

export const CRASH_BARKS: [string, string][];
export const ENDING_LINES: { perfect: [string, string][]; tired: [string, string][] };

export function pointAt(
  edge: { _arc: { points: Pt[]; cum: number[]; length: number } },
  t: number,
): { x: number; y: number; tangent: { dx: number; dy: number } };
export function carWorldPos(
  graph: HydratedGraph,
  edgeId: string,
  t: number,
  lane: number,
): { x: number; y: number; angle: number };
export function laneOffset(edge: Edge, laneFloat: number): number;

export function serializeGraph(graph: any): SerializedGraph;
export function hydrateGraph(serialized: SerializedGraph): HydratedGraph;

export function rollErrandList(graph: any, count: number): Errand[];

export function makeReunionGrid(rng?: () => number): ReunionGrid;
export function isReunionWalkable(grid: ReunionGrid, x: number, y: number): boolean;

export function tickMsForCombo(combo: number): number;
export function comboMultiplier(combo: number): number;
export function speedForCombo(combo: number, braking: boolean): number;

export function makeRoomCode(): string;
export function pickReunionBark(elapsedMs: number): [string, string];
export function pickEndingLine(outcome: "perfect" | "tired"): [string, string];
export function pickCrashBark(): [string, string];

export interface Room {
  code: string;
  phase: Phase;
  players: { driver: string | null; navigator: string | null };
  graph: HydratedGraph | null;
  car: CarState | null;
  crashAt: { x: number; y: number } | null;
  argument: [string, string] | null;
  distance: number;
  brakeUntil: number;
  tickInterval: ReturnType<typeof setInterval> | null;
  pendingStartAt: number;
  lastLaneChangeAt: number;
  errands: Errand[];
  score: number;
  combo: number;
  bestCombo: number;
  patience: number;
  crashes: number;
  hitPotholeIds: Set<string>;
  outcome: Outcome;
  bestScoreThisSession: number;
  reunionGrid: ReunionGrid | null;
  driverAvatar: { x: number; y: number } | null;
  navigatorAvatar: { x: number; y: number } | null;
  reunionStartedAt: number;
  reunionDecayInterval: ReturnType<typeof setInterval> | null;
  reunionBonus: number;
  reunionElapsedMs: number;
  lastTickAt: number;
}

export function freshRoom(code: string): Room;
export function resetRound(room: Room, errandCount?: number): void;

export function pickSuccessor(graph: HydratedGraph, node: string, arrivingLane: number): string | null;
