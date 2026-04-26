export type Direction = "north" | "east" | "south" | "west";
export type Tile = "S" | "D" | "." | "#" | "X";

export interface MapData {
  id: string;
  width: number;
  height: number;
  start: { x: number; y: number; direction: Direction };
  destination: { x: number; y: number };
  driverSpawnAfterCrash:    { x: number; y: number; label: string };
  navigatorSpawnAfterCrash: { x: number; y: number; label: string };
  zones: { label: string; x: number; y: number }[];
  tiles: Tile[][];
}

export const MAP: MapData;
export const ARGUMENTS: [string, string][];
export const TICK_MS: number;
export const BRAKE_MAX: number;
export const COUNTDOWN_MS: number;

export function pickArgument(): [string, string];
export function turnLeft(dir: Direction): Direction;
export function turnRight(dir: Direction): Direction;
export function forwardOf(pos: { x: number; y: number }, dir: Direction): { x: number; y: number };
export function projectTrajectory(
  map: { width: number; height: number; tiles: Tile[][] },
  car: { x: number; y: number; direction: Direction },
  maxLen?: number
): { x: number; y: number }[];

export function tileAt(
  map: { width: number; height: number; tiles: Tile[][] },
  x: number, y: number
): Tile | null;
export function isInBounds(
  map: { width: number; height: number },
  x: number, y: number
): boolean;
export function classifyDriveTile(
  map: { width: number; height: number; tiles: Tile[][] },
  x: number, y: number
): "move" | "win" | "crash";
export function isReunionWalkable(
  map: { width: number; height: number; tiles: Tile[][] },
  x: number, y: number
): boolean;
export function makeRoomCode(): string;

export interface Room {
  code: string;
  phase: "waiting" | "ready" | "driving" | "crashed" | "reunion" | "complete";
  players: { driver: string | null; navigator: string | null };
  car: { x: number; y: number; direction: Direction };
  crashAt: { x: number; y: number } | null;
  argument: [string, string] | null;
  driverAvatar: { x: number; y: number; label?: string } | null;
  navigatorAvatar: { x: number; y: number; label?: string } | null;
  outcome: "destination_reached" | "reunited" | null;
  distance: number;
  brakeTicks: number;
  tickInterval: ReturnType<typeof setInterval> | null;
  pendingStartAt: number;
}

export function freshRoom(code: string): Room;
export function resetRound(room: Room): void;
