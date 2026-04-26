import Phaser from "phaser";
import type { PublicState } from "../types";
import type { Tile, Direction } from "../../../shared/game";
import { projectTrajectory } from "../../../shared/game.js";
import { store } from "../net";
import { sfx } from "../audio";

const HUD_TOP = 76;
const HUD_BOT_DRV = 210;
const HUD_BOT_NAV = 80;
const SIDE_MARGIN = 12;
const TILE_MIN = 18;
const TILE_MAX_NAV = 40;
const TILE_MAX_DRV = 56;

const COLORS = {
  road:    0xe8dac1,
  roadEdge:0xd3c0a0,
  block:   0x4b3a2a,
  blockHi: 0x6b513a,
  hazard:  0xff5a5a,
  home:    0x7bd389,
  void:    0x07050a,
  board:   0x2c1f10,
  carBody: 0xff7a59,
  brakeLite:0xff3322,
  trajectoryOk: 0xffce4d,
  trajectoryBad:0xff5a5a,
  errand:  0xffce4d,
  errandActive: 0xff7a59,
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
  private markerLayer?: Phaser.GameObjects.Container;
  private trajectoryLayer?: Phaser.GameObjects.Graphics;
  private fogLayer?: Phaser.GameObjects.Graphics;
  private carContainer!: Phaser.GameObjects.Container;
  private carBrakeGlow?: Phaser.GameObjects.Graphics;

  private moveTween?: Phaser.Tweens.Tween;
  private turnTween?: Phaser.Tweens.Tween;
  private unsubscribe?: () => void;
  private prevCrashes = 0;
  private prevCombo = 0;
  private countdownStarted = false;

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
    const reservedBot = this.isDriver ? HUD_BOT_DRV : HUD_BOT_NAV;
    const availH = Math.max(120, h - HUD_TOP - reservedBot);
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
    this.prevCrashes = this.state.crashes;
    this.prevCombo = this.state.combo;

    if (!this.isDriver) {
      const board = this.add.graphics();
      board.fillStyle(COLORS.board, 1);
      board.fillRoundedRect(this.originX - 8, this.originY - 8, this.mapW + 16, this.mapH + 16, 14);
    } else {
      this.cameras.main.setBackgroundColor("#07050a");
    }

    this.mapLayer = this.add.container(this.originX, this.originY);
    this.drawMap();

    if (!this.isDriver) {
      this.drawZoneLabels();
      this.markerLayer = this.add.container(0, 0);
      this.drawMarkers();
      this.trajectoryLayer = this.add.graphics();
      this.drawTrajectory();
    }

    this.carContainer = this.makeCar();
    this.placeCarInstantly(this.state.car.x, this.state.car.y, this.state.car.direction);

    if (this.isDriver) {
      this.cameras.main.startFollow(this.carContainer, true, 0.18, 0.18);
      this.cameras.main.setZoom(1.0);
      this.fogLayer = this.add.graphics();
      this.drawFog();
    }

    if (this.isDriver && this.input.keyboard) {
      const k = this.input.keyboard;
      k.on("keydown-A",     () => { sfx.turn(); store.driverInput("turn_left"); });
      k.on("keydown-LEFT",  () => { sfx.turn(); store.driverInput("turn_left"); });
      k.on("keydown-D",     () => { sfx.turn(); store.driverInput("turn_right"); });
      k.on("keydown-RIGHT", () => { sfx.turn(); store.driverInput("turn_right"); });
      k.on("keydown-S",     () => { sfx.brake(); store.driverInput("brake"); });
      k.on("keydown-DOWN",  () => { sfx.brake(); store.driverInput("brake"); });
      k.on("keydown-SPACE", () => { sfx.brake(); store.driverInput("brake"); });
      k.on("keydown-W",     () => { sfx.engineTick(); store.driverInput("forward"); });
      k.on("keydown-UP",    () => { sfx.engineTick(); store.driverInput("forward"); });
    }

    if (this.state.countdownRemainingMs > 0 && !this.countdownStarted) {
      this.countdownStarted = true;
      this.showCountdown();
    }

    this.unsubscribe = store.subscribe((s) => s && this.applyState(s));
    const onResize = () => { if (this.state) this.scene.restart({ state: this.state }); };
    this.scale.on("resize", onResize);

    this.events.once("shutdown", () => {
      this.unsubscribe?.();
      try { this.tweens.killAll(); } catch {}
      try { this.cameras.main?.stopFollow(); } catch {}
      try { this.scale.off("resize", onResize); } catch {}
    });
  }

  private drawMap() {
    const tiles = this.state.map.tiles;
    const T = this.TILE;
    for (let y = 0; y < this.state.map.height; y++) {
      for (let x = 0; x < this.state.map.width; x++) {
        const t = tiles[y][x];
        const node = this.makeTile(t, x, y);
        this.mapLayer.add(node);
      }
    }
    void T;
  }

  private drawZoneLabels() {
    for (const z of this.state.map.zones) {
      const label = this.add.text(
        this.originX + z.x * this.TILE + this.TILE / 2,
        this.originY + z.y * this.TILE - 6,
        z.label.toUpperCase(),
        { fontFamily: "Inter, sans-serif", fontSize: "9px", color: "#7a6856", fontStyle: "600" }
      ).setOrigin(0.5).setAlpha(0.78);
      void label;
    }
  }

  private drawMarkers() {
    if (!this.markerLayer) return;
    this.markerLayer.removeAll(true);

    const drawMarker = (
      worldX: number, worldY: number,
      icon: string, color: number,
      pulse: boolean,
    ) => {
      // Position the Graphics object at the marker center, then draw the
      // circle at (0, 0) so any later transform pivots around the center.
      const ring = this.add.graphics({ x: worldX, y: worldY });
      const radius = this.TILE * 0.42;
      // Soft fill behind the ring for legibility on the road colour.
      ring.fillStyle(0xfff8ee, 0.55);
      ring.fillCircle(0, 0, radius);
      ring.lineStyle(2, color, 1);
      ring.strokeCircle(0, 0, radius);
      const iconSize = Math.max(14, Math.floor(this.TILE * 0.5));
      const txt = this.add.text(worldX, worldY, icon,
        { fontSize: `${iconSize}px` }).setOrigin(0.5);
      this.markerLayer!.add([ring, txt]);
      if (pulse) {
        this.tweens.add({
          targets: ring,
          alpha: { from: 1, to: 0.55 },
          duration: 1100, yoyo: true, repeat: -1, ease: "Sine.easeInOut",
        });
      }
    };

    const home = this.state.home;
    drawMarker(
      this.originX + home.x * this.TILE + this.TILE / 2,
      this.originY + home.y * this.TILE + this.TILE / 2,
      "🏠", COLORS.home, false,
    );
    for (const e of this.state.errands) {
      if (e.done) continue;
      drawMarker(
        this.originX + e.x * this.TILE + this.TILE / 2,
        this.originY + e.y * this.TILE + this.TILE / 2,
        e.icon, COLORS.errandActive, true,
      );
    }
  }

  private makeTile(t: Tile, x: number, y: number): Phaser.GameObjects.GameObject {
    const TILE = this.TILE;
    const g = this.add.graphics();
    const px = x * TILE;
    const py = y * TILE;
    const pad = 1.5;
    const r = 4;

    g.fillStyle(COLORS.road, 1);
    g.fillRoundedRect(px + pad, py + pad, TILE - pad * 2, TILE - pad * 2, r);
    g.lineStyle(1, COLORS.roadEdge, 0.9);
    g.strokeRoundedRect(px + pad, py + pad, TILE - pad * 2, TILE - pad * 2, r);

    if (t === "#") {
      g.fillStyle(COLORS.block, 1);
      g.fillRoundedRect(px + pad, py + pad, TILE - pad * 2, TILE - pad * 2, r);
      g.fillStyle(COLORS.blockHi, 1);
      g.fillRect(px + 4, py + 4,  TILE - 8, 2);
      g.fillRect(px + 4, py + TILE - 6, TILE - 8, 2);
    } else if (t === "X") {
      if (!this.isDriver) {
        g.fillStyle(COLORS.hazard, 1);
        g.fillRoundedRect(px + 6, py + 6, TILE - 12, TILE - 12, 5);
        const sym = this.add.text(px + TILE / 2, py + TILE / 2, "✕",
          { fontFamily: "Inter, sans-serif", fontSize: `${Math.max(12, Math.floor(TILE * 0.45))}px`, color: "#fff", fontStyle: "700" }
        ).setOrigin(0.5);
        return this.add.container(0, 0, [g, sym]);
      }
    } else if (t === "S") {
      if (!this.isDriver) {
        g.fillStyle(COLORS.home, 0.35);
        g.fillRoundedRect(px + 4, py + 4, TILE - 8, TILE - 8, 5);
      }
    }
    return g;
  }

  private makeCar(): Phaser.GameObjects.Container {
    const c = this.add.container(0, 0);
    const glow = this.add.graphics();
    glow.fillStyle(COLORS.brakeLite, 0.35);
    glow.fillCircle(-22, 0, 16);
    glow.setVisible(false);
    this.carBrakeGlow = glow;
    c.add(glow);
    const body = this.add.graphics();
    body.fillStyle(COLORS.carBody, 1);
    body.fillRoundedRect(-15, -10, 30, 20, 5);
    body.lineStyle(2, 0xb44a30, 1);
    body.strokeRoundedRect(-15, -10, 30, 20, 5);
    body.fillStyle(0xfff8ee, 0.92);
    body.fillRoundedRect(-2, -7, 12, 14, 3);
    body.fillStyle(0xfff5a3, 1);
    body.fillCircle(14, -6, 1.6);
    body.fillCircle(14,  6, 1.6);
    body.fillStyle(0xb40000, 1);
    body.fillCircle(-14, -6, 1.4);
    body.fillCircle(-14,  6, 1.4);
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
    const car = this.state.car;
    const radius = 7;
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
    // Outer black ring far beyond the visible window.
    this.fogLayer.fillStyle(COLORS.void, 1);
    const big = 40;
    this.fogLayer.fillRect(this.originX + (car.x - big) * this.TILE, this.originY + (car.y - big) * this.TILE, big * 2 * this.TILE, (big - radius) * this.TILE);
    this.fogLayer.fillRect(this.originX + (car.x - big) * this.TILE, this.originY + (car.y + radius + 1) * this.TILE, big * 2 * this.TILE, (big - radius) * this.TILE);
    this.fogLayer.fillRect(this.originX + (car.x - big) * this.TILE, this.originY + (car.y - radius) * this.TILE, (big - radius) * this.TILE, (radius * 2 + 1) * this.TILE);
    this.fogLayer.fillRect(this.originX + (car.x + radius + 1) * this.TILE, this.originY + (car.y - radius) * this.TILE, (big - radius) * this.TILE, (radius * 2 + 1) * this.TILE);
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
      const tile = this.state.map.tiles[p.y]?.[p.x];
      const willCrash = tile === undefined || tile === "#" || tile === "X";
      const color = willCrash && isLast ? COLORS.trajectoryBad : COLORS.trajectoryOk;
      this.trajectoryLayer.fillStyle(color, isLast ? 0.95 : 0.5);
      this.trajectoryLayer.fillCircle(wx, wy, 3 + i * 0.4);
    }
  }

  private showCountdown() {
    const txt = this.add.text(
      this.cameras.main.midPoint.x,
      this.cameras.main.midPoint.y - 20,
      "Ready?", {
        fontFamily: "Fraunces, serif", fontSize: "48px",
        color: "#fff8ee", fontStyle: "700",
      }
    ).setOrigin(0.5).setScrollFactor(0).setDepth(2000);
    sfx.countdown();
    let last = Math.ceil((this.state.countdownRemainingMs ?? 0) / 1000);
    const tickFn = () => {
      const left = Math.max(0, this.state.countdownRemainingMs ?? 0);
      const count = Math.max(0, Math.ceil(left / 1000));
      if (count <= 0) {
        txt.setText("GO!");
        sfx.go();
        this.tweens.add({ targets: txt, alpha: 0, scale: 1.5, duration: 450, onComplete: () => txt.destroy() });
        return;
      }
      if (count !== last) { sfx.countdown(); last = count; }
      txt.setText(String(count));
      this.time.delayedCall(120, tickFn);
    };
    tickFn();
  }

  applyState(next: PublicState) {
    const prev = this.state;
    this.state = next;
    if (next.phase !== "driving" && next.phase !== "complete") return;

    const movedTile = prev.car.x !== next.car.x || prev.car.y !== next.car.y;
    const turned    = prev.car.direction !== next.car.direction;
    const brakeChanged = prev.brakeTicks !== next.brakeTicks;
    const newCrash = next.crashes > this.prevCrashes;
    this.prevCrashes = next.crashes;
    const newErrandDone = next.errands.filter((e) => e.done).length
                        > prev.errands.filter((e) => e.done).length;
    const comboChanged = next.combo !== this.prevCombo;
    this.prevCombo = next.combo;

    if (turned) {
      this.turnTween?.stop();
      const targetAngle = DIR_TO_ANGLE[next.car.direction];
      const currentAngle = Phaser.Math.RadToDeg(this.carContainer.rotation);
      const delta = Phaser.Math.Angle.WrapDegrees(targetAngle - currentAngle);
      this.turnTween = this.tweens.add({
        targets: this.carContainer,
        rotation: Phaser.Math.DegToRad(currentAngle + delta),
        duration: 120,
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
        duration: Math.min(700, Math.max(220, next.tickMs * 0.8)),
        ease: "Sine.easeInOut",
        onUpdate: () => { this.drawFog(); },
      });
    }

    if (brakeChanged) {
      if (next.brakeTicks > prev.brakeTicks) sfx.brake();
      this.carBrakeGlow?.setVisible(next.braking);
    }

    if (newErrandDone) {
      sfx.win();
      const earned = next.score - prev.score;
      const { x, y } = this.worldOf(next.car.x, next.car.y);
      const txt = this.add.text(x, y - 8, `+${earned}`, {
        fontFamily: "Inter, sans-serif", fontSize: "14px",
        color: "#ff7a59", fontStyle: "700",
      }).setOrigin(0.5).setDepth(2000);
      this.tweens.add({
        targets: txt,
        y: y - 36, alpha: { from: 1, to: 0 },
        duration: 750, ease: "Cubic.easeOut",
        onComplete: () => txt.destroy(),
      });
      if (!this.isDriver) this.drawMarkers();
    }

    if (comboChanged && next.combo >= 3) {
      // Subtle combo callout — only on combo 3+ so it's a reward, not noise.
      const cx = this.cameras.main.midPoint.x;
      const cy = this.cameras.main.midPoint.y - 50;
      const color = next.combo >= 8 ? "#ff5a5a" : next.combo >= 5 ? "#ff7a59" : "#ffce4d";
      const t = this.add.text(cx, cy, `${next.combo}×`, {
        fontFamily: "Fraunces, serif", fontSize: "22px",
        color, fontStyle: "700",
      }).setOrigin(0.5).setScrollFactor(0).setDepth(2100);
      this.tweens.add({
        targets: t,
        y: cy - 18, alpha: { from: 1, to: 0 },
        duration: 550, ease: "Cubic.easeOut",
        onComplete: () => t.destroy(),
      });
    }

    if (newCrash) {
      sfx.crash();
      this.cameras.main.shake(360, 0.014);
      const flash = this.add.graphics();
      flash.fillStyle(0xff4444, 0.5);
      flash.setScrollFactor(0).setDepth(1500);
      flash.fillRect(0, 0, this.scale.width, this.scale.height);
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

    if (this.fogLayer) this.drawFog();
    if (this.trajectoryLayer) this.drawTrajectory();
  }
}
