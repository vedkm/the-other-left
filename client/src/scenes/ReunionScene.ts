import Phaser from "phaser";
import type { PublicState } from "../types";
import { store } from "../net";
import { sfx } from "../audio";

const HUD_TOP = 76;
const HUD_BOT = 130;
const SIDE_MARGIN = 12;
const TILE_MIN = 18;
const TILE_MAX = 38;
const VIS_RADIUS = 2; // 5×5 visibility around each avatar

const COLORS = {
  road:    0xe8dac1,
  roadEdge:0xd3c0a0,
  block:   0x4b3a2a,
  blockHi: 0x6b513a,
  void:    0x07050a,
  board:   0x2c1f10,
  driver:    0xff7a59,
  navigator: 0x4ea1ff,
  home:    0x7bd389,
};

export class ReunionScene extends Phaser.Scene {
  private state!: PublicState;
  private TILE = TILE_MAX;
  private originX = 0;
  private originY = 0;
  private mapW = 0;
  private mapH = 0;

  private mapLayer!: Phaser.GameObjects.Container;
  private fogLayer!: Phaser.GameObjects.Graphics;
  private driverSprite!: Phaser.GameObjects.Container;
  private navSprite!: Phaser.GameObjects.Container;
  private unsubscribe?: () => void;

  constructor() { super("ReunionScene"); }

  init(data?: { state?: PublicState }) {
    if (!data?.state) return;
    this.state = data.state;
    this.recomputeLayout();
  }

  private recomputeLayout() {
    const w = this.scale.width;
    const h = this.scale.height;
    const availW = Math.max(120, w - SIDE_MARGIN * 2);
    const availH = Math.max(120, h - HUD_TOP - HUD_BOT);
    const fit = Math.floor(Math.min(availW / this.state.map.width, availH / this.state.map.height));
    this.TILE = Math.max(TILE_MIN, Math.min(TILE_MAX, fit));
    this.mapW = this.state.map.width  * this.TILE;
    this.mapH = this.state.map.height * this.TILE;
    this.originX = Math.round((w - this.mapW) / 2);
    this.originY = Math.round(HUD_TOP + (availH - this.mapH) / 2);
  }

  create() {
    if (!this.state) return;
    this.recomputeLayout();

    const board = this.add.graphics();
    board.fillStyle(COLORS.board, 1);
    board.fillRoundedRect(this.originX - 8, this.originY - 8, this.mapW + 16, this.mapH + 16, 14);

    this.mapLayer = this.add.container(this.originX, this.originY);
    this.drawMap();

    this.driverSprite = this.makeAvatar(COLORS.driver, "🚶");
    this.navSprite    = this.makeAvatar(COLORS.navigator, "🚶");
    if (this.state.driverAvatar) {
      this.placeInstantly(this.driverSprite, this.state.driverAvatar.x, this.state.driverAvatar.y);
    }
    if (this.state.navigatorAvatar) {
      this.placeInstantly(this.navSprite, this.state.navigatorAvatar.x, this.state.navigatorAvatar.y);
    }

    this.fogLayer = this.add.graphics();
    this.drawFog();

    if (this.input.keyboard) {
      const k = this.input.keyboard;
      const tap = (a: "up" | "down" | "left" | "right") => () => { sfx.step(); store.reunionInput(a); };
      k.on("keydown-W",     tap("up"));    k.on("keydown-UP",    tap("up"));
      k.on("keydown-S",     tap("down"));  k.on("keydown-DOWN",  tap("down"));
      k.on("keydown-A",     tap("left"));  k.on("keydown-LEFT",  tap("left"));
      k.on("keydown-D",     tap("right")); k.on("keydown-RIGHT", tap("right"));
    }

    this.unsubscribe = store.subscribe((s) => s && this.applyState(s));
    const onResize = () => { if (this.state) this.scene.restart({ state: this.state }); };
    this.scale.on("resize", onResize);
    this.events.once("shutdown", () => {
      this.unsubscribe?.();
      try { this.tweens.killAll(); } catch {}
      try { this.scale.off("resize", onResize); } catch {}
    });
  }

  private drawMap() {
    const tiles = this.state.map.tiles;
    const TILE = this.TILE;
    for (let y = 0; y < this.state.map.height; y++) {
      for (let x = 0; x < this.state.map.width; x++) {
        const t = tiles[y][x];
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
        } else if (t === "S") {
          g.fillStyle(COLORS.home, 0.32);
          g.fillRoundedRect(px + 4, py + 4, TILE - 8, TILE - 8, 5);
        }
        this.mapLayer.add(g);
      }
    }
  }

  private makeAvatar(color: number, _icon: string): Phaser.GameObjects.Container {
    const c = this.add.container(0, 0);
    const ringSize = Math.floor(this.TILE * 0.42);
    const body = this.add.graphics();
    body.fillStyle(color, 0.95);
    body.fillCircle(0, 0, ringSize);
    body.lineStyle(2, 0x000000, 0.18);
    body.strokeCircle(0, 0, ringSize);
    const letter = color === COLORS.driver ? "D" : "N";
    const txt = this.add.text(0, 0, letter, {
      fontFamily: "Inter, sans-serif",
      fontSize: `${Math.floor(ringSize * 0.85)}px`,
      color: "#fff8ee", fontStyle: "800",
    }).setOrigin(0.5);
    c.add([body, txt]);
    return c;
  }

  private worldOf(tx: number, ty: number) {
    return {
      x: this.originX + tx * this.TILE + this.TILE / 2,
      y: this.originY + ty * this.TILE + this.TILE / 2,
    };
  }

  private placeInstantly(sprite: Phaser.GameObjects.Container, tx: number, ty: number) {
    const { x, y } = this.worldOf(tx, ty);
    sprite.setPosition(x, y);
  }

  private drawFog() {
    this.fogLayer.clear();
    const me = this.state.yourRole === "driver" ? this.state.driverAvatar : this.state.navigatorAvatar;
    const them = this.state.yourRole === "driver" ? this.state.navigatorAvatar : this.state.driverAvatar;
    if (!me) return;
    for (let y = 0; y < this.state.map.height; y++) {
      for (let x = 0; x < this.state.map.width; x++) {
        if (Math.abs(x - me.x) <= VIS_RADIUS && Math.abs(y - me.y) <= VIS_RADIUS) continue;
        this.fogLayer.fillStyle(COLORS.void, 0.92);
        this.fogLayer.fillRect(this.originX + x * this.TILE, this.originY + y * this.TILE, this.TILE, this.TILE);
      }
    }
    if (them) {
      const visible = Math.abs(them.x - me.x) <= VIS_RADIUS && Math.abs(them.y - me.y) <= VIS_RADIUS;
      const partner = this.state.yourRole === "driver" ? this.navSprite : this.driverSprite;
      partner.setVisible(visible);
    }
    this.children.bringToTop(this.driverSprite);
    this.children.bringToTop(this.navSprite);
  }

  applyState(next: PublicState) {
    const prev = this.state;
    this.state = next;
    if (next.phase !== "reunion" && next.phase !== "complete") return;

    const tweenAvatar = (
      sprite: Phaser.GameObjects.Container,
      prevPos: { x: number; y: number } | null,
      nextPos: { x: number; y: number } | null,
    ) => {
      if (!nextPos) return;
      if (!prevPos || (prevPos.x === nextPos.x && prevPos.y === nextPos.y)) return;
      const { x, y } = this.worldOf(nextPos.x, nextPos.y);
      this.tweens.add({
        targets: sprite,
        x, y, duration: 130, ease: "Cubic.easeOut",
        onUpdate: () => this.drawFog(),
      });
    };

    tweenAvatar(this.driverSprite, prev.driverAvatar,    next.driverAvatar);
    tweenAvatar(this.navSprite,    prev.navigatorAvatar, next.navigatorAvatar);
    this.drawFog();

    // Reunion completed (transitioned to complete with avatars on same tile)
    const justReunited = next.phase === "complete" && prev.phase === "reunion"
      && next.driverAvatar && next.navigatorAvatar
      && next.driverAvatar.x === next.navigatorAvatar.x
      && next.driverAvatar.y === next.navigatorAvatar.y;
    if (justReunited) {
      sfx.win();
      const me = next.yourRole === "driver" ? next.driverAvatar : next.navigatorAvatar;
      if (me) {
        const { x, y } = this.worldOf(me.x, me.y);
        for (let i = 0; i < 12; i++) {
          const h = this.add.text(x, y, "♥", {
            fontFamily: "Inter, sans-serif", fontSize: "20px", color: "#ff5a8a",
          }).setOrigin(0.5);
          this.tweens.add({
            targets: h,
            x: x + Phaser.Math.Between(-80, 80),
            y: y + Phaser.Math.Between(-110, -40),
            alpha: 0, scale: { from: 0.6, to: 1.4 },
            duration: 900 + Math.random() * 300, ease: "Cubic.easeOut",
            onComplete: () => h.destroy(),
          });
        }
        this.cameras.main.flash(220, 255, 220, 230);
      }
    }
  }
}
