import Phaser from "phaser";
import type { PublicState } from "../types";
import type { Tile, Direction } from "../../../shared/game";
import { projectTrajectory } from "../../../shared/game.js";
import { store } from "../net";
import { sfx } from "../audio";

// Reserved vertical pixels for HUD chrome (statusbar + d-pad + hint).
const HUD_TOP = 60;
const HUD_BOT = 110;
const SIDE_MARGIN = 16;
// Fallback bounds; actual tile size is computed from viewport.
const TILE_MIN = 22;
const TILE_MAX_NAV = 56;
const TILE_MAX_DRV = 70;
const COLORS = {
  road:    0xe8dac1,
  roadEdge:0xd3c0a0,
  block:   0x4b3a2a,
  blockHi: 0x6b513a,
  hazard:  0xff5a5a,
  hazardHi:0xffaaaa,
  start:   0x7bd389,
  dest:    0xffce4d,
  carBody: 0xff7a59,
  carInk:  0xfff8ee,
  brakeLite:0xff3322,
  void:    0x07050a,
  board:   0x2c1f10,
  trail:   0xff7a59,
  trailDim:0x6e3a28,
  trajectoryOk: 0xffce4d,
  trajectoryBad:0xff5a5a,
};

const DIR_TO_ANGLE: Record<Direction, number> = {
  north: -90, east: 0, south: 90, west: 180,
};

export class DriveScene extends Phaser.Scene {
  private state!: PublicState;
  private isDriver = false;
  private TILE = TILE_MAX_NAV;

  private originX = 0;
  private originY = 0;
  private mapW = 0;
  private mapH = 0;

  private mapLayer!: Phaser.GameObjects.Container;
  private trajectoryLayer?: Phaser.GameObjects.Graphics;
  private fogLayer?: Phaser.GameObjects.Graphics;
  private carContainer!: Phaser.GameObjects.Container;
  private carBrakeGlow?: Phaser.GameObjects.Graphics;
  private destStar?: Phaser.GameObjects.Text;
  private countdownText?: Phaser.GameObjects.Text;
  private startedTick = false;

  private moveTween?: Phaser.Tweens.Tween;
  private turnTween?: Phaser.Tweens.Tween;
  private unsubscribe?: () => void;

  constructor() { super("DriveScene"); }

  init(data?: { state?: PublicState }) {
    if (!data?.state) return;
    this.state = data.state;
    this.isDriver = this.state.yourRole === "driver";
    this.recomputeLayout();
  }

  private recomputeLayout() {
    const w = this.scale.width;
    const h = this.scale.height;
    const availW = Math.max(120, w - SIDE_MARGIN * 2);
    const availH = Math.max(120, h - HUD_TOP - HUD_BOT);
    const cols = this.state.map.width;
    const rows = this.state.map.height;
    const fit = Math.floor(Math.min(availW / cols, availH / rows));
    const cap = this.isDriver ? TILE_MAX_DRV : TILE_MAX_NAV;
    this.TILE = Math.max(TILE_MIN, Math.min(cap, fit));
    this.mapW = cols * this.TILE;
    this.mapH = rows * this.TILE;
    this.originX = Math.round((w - this.mapW) / 2);
    this.originY = Math.round(HUD_TOP + (availH - this.mapH) / 2);
  }

  create() {
    if (!this.state) return;
    this.recomputeLayout();

    // Background board (only for navigator — driver has full black void)
    if (!this.isDriver) {
      const board = this.add.graphics();
      board.fillStyle(COLORS.board, 1);
      board.fillRoundedRect(this.originX - 10, this.originY - 10, this.mapW + 20, this.mapH + 20, 18);
    } else {
      this.cameras.main.setBackgroundColor("#07050a");
    }

    this.mapLayer = this.add.container(this.originX, this.originY);
    this.drawMap();

    // Navigator-only flair: zone labels + trajectory line + destination star
    if (!this.isDriver) {
      this.drawZoneLabels();
      this.trajectoryLayer = this.add.graphics();
      this.drawTrajectory();

      const { x, y } = this.state.destination;
      this.destStar = this.add.text(
        this.originX + x * this.TILE + this.TILE / 2,
        this.originY + y * this.TILE + this.TILE / 2,
        "★",
        { fontFamily: "Fraunces, serif", fontSize: "30px", color: "#fff8ee" }
      ).setOrigin(0.5);
      this.tweens.add({
        targets: this.destStar,
        scale: { from: 1, to: 1.18 },
        duration: 700, yoyo: true, repeat: -1, ease: "Sine.easeInOut",
      });
    }

    this.carContainer = this.makeCar();
    this.placeCarInstantly(this.state.car.x, this.state.car.y, this.state.car.direction);

    // Camera follow for driver
    if (this.isDriver) {
      this.cameras.main.startFollow(this.carContainer, true, 0.18, 0.18);
      this.cameras.main.setZoom(1.0);

      this.fogLayer = this.add.graphics();
      this.fogLayer.setScrollFactor(1);
      this.drawFog();
    }

    // Keyboard
    if (this.isDriver && this.input.keyboard) {
      const k = this.input.keyboard;
      k.on("keydown-W",     () => { sfx.engineTick(); store.driverInput("forward"); });
      k.on("keydown-UP",    () => { sfx.engineTick(); store.driverInput("forward"); });
      k.on("keydown-A",     () => { sfx.turn(); store.driverInput("turn_left"); });
      k.on("keydown-LEFT",  () => { sfx.turn(); store.driverInput("turn_left"); });
      k.on("keydown-D",     () => { sfx.turn(); store.driverInput("turn_right"); });
      k.on("keydown-RIGHT", () => { sfx.turn(); store.driverInput("turn_right"); });
      k.on("keydown-S",     () => { sfx.brake(); store.driverInput("brake"); });
      k.on("keydown-DOWN",  () => { sfx.brake(); store.driverInput("brake"); });
      k.on("keydown-SPACE", () => { sfx.brake(); store.driverInput("brake"); });
    }

    // Countdown HUD
    if (this.state.countdownRemainingMs > 0) {
      this.showCountdown(this.state.countdownRemainingMs);
    }

    this.unsubscribe = store.subscribe((s) => s && this.applyState(s));

    // On viewport resize / orientation change, re-run create() with current state.
    const onResize = () => {
      if (this.state) this.scene.restart({ state: this.state });
    };
    this.scale.on("resize", onResize);

    this.events.once("shutdown", () => {
      this.unsubscribe?.();
      this.tweens.killAll();
      this.cameras.main.stopFollow();
      this.scale.off("resize", onResize);
    });
  }

  // === Drawing helpers ===

  private drawMap() {
    const tiles = this.state.map.tiles;
    for (let y = 0; y < this.state.map.height; y++) {
      for (let x = 0; x < this.state.map.width; x++) {
        const t = tiles[y][x];
        const node = this.makeTile(t, x, y);
        this.mapLayer.add(node);
      }
    }
  }

  private drawZoneLabels() {
    for (const z of this.state.map.zones) {
      const label = this.add.text(
        this.originX + z.x * this.TILE + this.TILE / 2,
        this.originY + z.y * this.TILE + this.TILE / 2 - 22,
        z.label.toUpperCase(),
        { fontFamily: "Inter, sans-serif", fontSize: "10px", color: "#7a6856", fontStyle: "600" }
      ).setOrigin(0.5);
      label.setAlpha(0.85);
    }
  }

  private makeTile(t: Tile, x: number, y: number): Phaser.GameObjects.GameObject {
    const TILE = this.TILE;
    const g = this.add.graphics();
    const px = x * TILE;
    const py = y * TILE;
    const pad = 2;
    const r = 5;

    g.fillStyle(COLORS.road, 1);
    g.fillRoundedRect(px + pad, py + pad, TILE - pad * 2, TILE - pad * 2, r);
    g.lineStyle(1, COLORS.roadEdge, 1);
    g.strokeRoundedRect(px + pad, py + pad, TILE - pad * 2, TILE - pad * 2, r);

    if (t === "#") {
      g.fillStyle(COLORS.block, 1);
      g.fillRoundedRect(px + pad, py + pad, TILE - pad * 2, TILE - pad * 2, r);
      g.fillStyle(COLORS.blockHi, 1);
      g.fillRect(px + 6, py + 6,  TILE - 12, 3);
      g.fillRect(px + 6, py + TILE - 9, TILE - 12, 3);
    } else if (t === "X") {
      // Hazard only revealed to navigator
      if (!this.isDriver) {
        g.fillStyle(COLORS.hazard, 1);
        g.fillRoundedRect(px + 8, py + 8, TILE - 16, TILE - 16, 6);
        const sym = this.add.text(px + TILE / 2, py + TILE / 2, "✕",
          { fontFamily: "Inter, sans-serif", fontSize: "18px", color: "#fff", fontStyle: "700" }
        ).setOrigin(0.5);
        return this.add.container(0, 0, [g, sym]);
      }
    } else if (t === "S") {
      if (!this.isDriver) {
        g.fillStyle(COLORS.start, 0.4);
        g.fillRoundedRect(px + 5, py + 5, TILE - 10, TILE - 10, 6);
      }
    } else if (t === "D") {
      if (!this.isDriver) {
        g.fillStyle(COLORS.dest, 0.5);
        g.fillRoundedRect(px + 5, py + 5, TILE - 10, TILE - 10, 6);
      }
    }
    return g;
  }

  private makeCar(): Phaser.GameObjects.Container {
    const c = this.add.container(0, 0);

    // Brake glow (drawn first, so it sits behind the body)
    const glow = this.add.graphics();
    glow.fillStyle(COLORS.brakeLite, 0.35);
    glow.fillCircle(-22, 0, 16);
    glow.setVisible(false);
    this.carBrakeGlow = glow;
    c.add(glow);

    const body = this.add.graphics();
    body.fillStyle(COLORS.carBody, 1);
    body.fillRoundedRect(-18, -12, 36, 24, 6);
    body.lineStyle(2, 0xb44a30, 1);
    body.strokeRoundedRect(-18, -12, 36, 24, 6);
    body.fillStyle(0xfff8ee, 0.92);
    body.fillRoundedRect(-2, -8, 14, 16, 3);
    body.fillStyle(0xfff5a3, 1);
    body.fillCircle(17, -7, 2);
    body.fillCircle(17,  7, 2);
    // brake lights at rear
    body.fillStyle(0xb40000, 1);
    body.fillCircle(-17, -7, 1.6);
    body.fillCircle(-17,  7, 1.6);
    c.add(body);

    return c;
  }

  private worldOf(tx: number, ty: number) {
    return {
      x: this.originX + tx * this.TILE + this.TILE / 2,
      y: this.originY + ty * this.TILE + this.TILE / 2,
    };
  }

  private placeCarInstantly(tx: number, ty: number, dir: Direction) {
    const { x, y } = this.worldOf(tx, ty);
    this.carContainer.setPosition(x, y);
    this.carContainer.setRotation(Phaser.Math.DegToRad(DIR_TO_ANGLE[dir]));
  }

  private isVisibleTile(tx: number, ty: number): boolean {
    const car = this.state.car;
    const dx = tx - car.x;
    const dy = ty - car.y;
    if (dx === 0 && dy === 0) return true;
    if (car.direction === "east"  && dy === 0 && dx >= 1 && dx <= 2) return true;
    if (car.direction === "west"  && dy === 0 && dx <= -1 && dx >= -2) return true;
    if (car.direction === "south" && dx === 0 && dy >= 1 && dy <= 2) return true;
    if (car.direction === "north" && dx === 0 && dy <= -1 && dy >= -2) return true;
    return false;
  }

  private drawFog() {
    if (!this.fogLayer) return;
    this.fogLayer.clear();
    // Solid black void over a generous area around the car (bigger than camera viewport).
    // Then "punch" the cone tiles by clearing them.
    // Phaser Graphics doesn't easily support erase; instead, draw black squares only over hidden tiles.
    const car = this.state.car;
    const radius = 6; // tiles around the car we render as black (covers the screen)
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const tx = car.x + dx;
        const ty = car.y + dy;
        if (this.isVisibleTile(tx, ty)) continue;
        this.fogLayer.fillStyle(COLORS.void, 1);
        this.fogLayer.fillRect(
          this.originX + tx * this.TILE,
          this.originY + ty * this.TILE,
          this.TILE, this.TILE,
        );
      }
    }
    // Also paint a giant black ring far from the car so off-grid edges aren't peeked.
    this.fogLayer.fillStyle(COLORS.void, 1);
    this.fogLayer.fillRect(this.originX + (car.x - 30) * this.TILE, this.originY + (car.y - 30) * this.TILE, 60 * this.TILE, (30 - radius) * this.TILE);
    this.fogLayer.fillRect(this.originX + (car.x - 30) * this.TILE, this.originY + (car.y + radius + 1) * this.TILE, 60 * this.TILE, (30 - radius) * this.TILE);
    this.fogLayer.fillRect(this.originX + (car.x - 30) * this.TILE, this.originY + (car.y - radius) * this.TILE, (30 - radius) * this.TILE, (radius * 2 + 1) * this.TILE);
    this.fogLayer.fillRect(this.originX + (car.x + radius + 1) * this.TILE, this.originY + (car.y - radius) * this.TILE, (30 - radius) * this.TILE, (radius * 2 + 1) * this.TILE);

    this.children.bringToTop(this.carContainer);
  }

  private drawTrajectory() {
    if (!this.trajectoryLayer) return;
    this.trajectoryLayer.clear();
    const points = projectTrajectory(this.state.map, this.state.car, 5);
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const wx = this.originX + p.x * this.TILE + this.TILE / 2;
      const wy = this.originY + p.y * this.TILE + this.TILE / 2;
      const isLast = i === points.length - 1;
      const cls = i < points.length - 1 ? "ok" : "tip";
      const tile = this.state.map.tiles[p.y]?.[p.x];
      const willCrash = tile === undefined || tile === "#" || tile === "X";
      const color = willCrash && isLast ? COLORS.trajectoryBad : COLORS.trajectoryOk;
      this.trajectoryLayer.fillStyle(color, cls === "tip" ? 0.95 : 0.55);
      this.trajectoryLayer.fillCircle(wx, wy, 4 + i * 0.5);
    }
  }

  private showCountdown(remainingMs: number) {
    this.countdownText?.destroy();
    const txt = this.add.text(
      this.cameras.main.midPoint.x,
      this.cameras.main.midPoint.y - 40,
      "Ready?", {
        fontFamily: "Fraunces, serif",
        fontSize: "56px",
        color: "#fff8ee",
        fontStyle: "700",
      }
    ).setOrigin(0.5).setScrollFactor(0).setDepth(2000);
    this.countdownText = txt;
    sfx.countdown();

    let count = Math.max(1, Math.ceil(remainingMs / 1000));
    let last = count;
    const tickFn = () => {
      const left = Math.max(0, this.state.countdownRemainingMs);
      count = Math.max(0, Math.ceil(left / 1000));
      if (count <= 0) {
        txt.setText("GO!");
        sfx.go();
        this.tweens.add({ targets: txt, alpha: 0, scale: 1.6, duration: 500, onComplete: () => txt.destroy() });
        return;
      }
      if (count !== last) { sfx.countdown(); last = count; }
      txt.setText(String(count));
      this.time.delayedCall(120, tickFn);
    };
    tickFn();
  }

  // === State diff / animation ===

  applyState(next: PublicState) {
    const prev = this.state;
    this.state = next;

    if (next.phase !== "driving" && next.phase !== "crashed") {
      // main.ts will swap scenes
      return;
    }

    const movedTile = prev.car.x !== next.car.x || prev.car.y !== next.car.y;
    const turned    = prev.car.direction !== next.car.direction;
    const brakeChanged = prev.brakeTicks !== next.brakeTicks;

    if (turned) {
      this.turnTween?.stop();
      const targetAngle = DIR_TO_ANGLE[next.car.direction];
      const currentAngle = Phaser.Math.RadToDeg(this.carContainer.rotation);
      const delta = Phaser.Math.Angle.WrapDegrees(targetAngle - currentAngle);
      this.turnTween = this.tweens.add({
        targets: this.carContainer,
        rotation: Phaser.Math.DegToRad(currentAngle + delta),
        duration: 140,
        ease: "Cubic.easeOut",
      });
    }

    if (movedTile) {
      sfx.engineTick();
      const { x, y } = this.worldOf(next.car.x, next.car.y);
      this.moveTween?.stop();
      this.moveTween = this.tweens.add({
        targets: this.carContainer,
        x, y,
        duration: Math.min(800, Math.max(300, next.tickMs * 0.85)),
        ease: "Sine.easeInOut",
        onUpdate: () => { this.drawFog(); },
      });
    }

    if (brakeChanged) {
      if (next.brakeTicks > prev.brakeTicks) sfx.brake();
      this.carBrakeGlow?.setVisible(next.braking);
    }

    if (this.fogLayer) this.drawFog();
    if (this.trajectoryLayer) this.drawTrajectory();

    // Countdown handling — only show once when entering driving.
    if (!this.startedTick && next.phase === "driving") {
      this.startedTick = true;
      // already showed in create() if needed
    }

    if (next.phase === "crashed") {
      sfx.crash();
      this.cameras.main.shake(360, 0.014);
      const flash = this.add.graphics();
      flash.fillStyle(0xff4444, 0.5);
      flash.fillRect(
        this.cameras.main.scrollX, this.cameras.main.scrollY,
        this.scale.width / this.cameras.main.zoom,
        this.scale.height / this.cameras.main.zoom,
      );
      flash.setDepth(1500);
      this.tweens.add({
        targets: flash, alpha: 0, duration: 380,
        onComplete: () => flash.destroy(),
      });
      if (next.crashAt) {
        const cx = Phaser.Math.Clamp(next.crashAt.x, 0, this.state.map.width  - 1);
        const cy = Phaser.Math.Clamp(next.crashAt.y, 0, this.state.map.height - 1);
        const wx = this.originX + cx * this.TILE + this.TILE / 2;
        const wy = this.originY + cy * this.TILE + this.TILE / 2;
        const burst = this.add.graphics();
        burst.fillStyle(0xffaa44, 1);
        burst.fillCircle(wx, wy, 6);
        burst.setDepth(1600);
        this.tweens.add({
          targets: burst,
          scale: { from: 1, to: 6 },
          alpha: { from: 1, to: 0 },
          duration: 480, ease: "Cubic.easeOut",
          onComplete: () => burst.destroy(),
        });
      }
    }
  }
}
