export type Direction = "north" | "east" | "south" | "west";
export type Tile = "S" | "." | "#" | "X";
export type Outcome = "perfect" | "tired" | null;

export interface MapData {
  id: string;
  width: number;
  height: number;
  start: { x: number; y: number; direction: Direction };
  home: { x: number; y: number };
  zones: { label: string; x: number; y: number }[];
  tiles: Tile[][];
}

export interface ErrandPoolItem {
  type: string;
  label: string;
  icon: string;
  flavor: string;
  tile: { x: number; y: number };
}

export interface Errand {
  type: string;
  label: string;
  icon: string;
  flavor: string;
  x: number;
  y: number;
  done: boolean;
}

export const MAP: MapData;
export const ERRAND_POOL: ErrandPoolItem[];

export const TICK_MS_BASE: number;
export const TICK_MS_FLOOR: number;
export const TICK_MS_PER_COMBO: number;
export const COMBO_MULT_PER_LEVEL: number;
export const PATIENCE_START: number;
export const PATIENCE_PER_TICK: number;
export const PATIENCE_PER_CRASH: number;
export const POST_CRASH_FREEZE_MS: number;
export const COUNTDOWN_MS: number;
export const ERRAND_COUNT_MIN: number;
export const ERRAND_COUNT_MAX: number;
export const ERRAND_BASE_SCORE: number;
export const PERFECT_SATURDAY_BONUS: number;
export const PATIENCE_BONUS_PER_POINT: number;

export const CRASH_BARKS: [string, string][];
export const ENDING_LINES: { perfect: [string, string][]; tired: [string, string][] };

export function turnLeft(dir: Direction): Direction;
export function turnRight(dir: Direction): Direction;
export function forwardOf(pos: { x: number; y: number }, dir: Direction): { x: number; y: number };
export function tileAt(
  map: { width: number; height: number; tiles: Tile[][] },
  x: number, y: number
): Tile | null;
export function isInBounds(map: { width: number; height: number }, x: number, y: number): boolean;
export function classifyDriveTile(
  map: { width: number; height: number; tiles: Tile[][] },
  x: number, y: number
): "move" | "crash";
export function projectTrajectory(
  map: { width: number; height: number; tiles: Tile[][] },
  car: { x: number; y: number; direction: Direction },
  maxLen?: number
): { x: number; y: number }[];
export function rollErrandList(count?: number): Errand[];
export function tickMsForCombo(combo: number): number;
export function comboMultiplier(combo: number): number;
export function makeRoomCode(): string;
export function pickCrashBark(): [string, string];
export function pickEndingLine(outcome: "perfect" | "tired"): [string, string];

export interface Room {
  code: string;
  phase: "waiting" | "ready" | "driving" | "complete";
  players: { driver: string | null; navigator: string | null };
  car: { x: number; y: number; direction: Direction };
  crashAt: { x: number; y: number } | null;
  argument: [string, string] | null;
  distance: number;
  brakeTicks: number;
  tickInterval: ReturnType<typeof setInterval> | null;
  pendingStartAt: number;
  errands: Errand[];
  score: number;
  combo: number;
  bestCombo: number;
  patience: number;
  crashes: number;
  outcome: Outcome;
  bestScoreThisSession: number;
}

export function freshRoom(code: string): Room;
export function resetRound(room: Room, errandCount?: number): void;
