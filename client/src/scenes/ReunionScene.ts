import Phaser from "phaser";
import type { PublicState } from "../types";
import { store } from "../net";
import { sfx } from "../audio";

const HUD_TOP = 60;
const HUD_BOT = 110;
const SIDE_MARGIN = 16;
const TILE_MIN = 20;
const TILE_MAX = 52;
const VIS = 2; // 5x5 visibility around each player

const COLORS = {
  road:    0xe8dac1,
  roadEdge:0xd3c0a0,
  block:   0x4b3a2a,
  blockHi: 0x6b513a,
  hazard:  0xff5a5a,
  void:    0x07050a,
  board:   0x2c1f10,
  driver:    0xff7a59,
  navigator: 0x4ea1ff,
};

export class ReunionScene extends Phaser.Scene {
  private state!: PublicState;
  private originX = 0;
  private originY = 0;
  private mapW = 0;
  private mapH = 0;

  private mapLayer!: Phaser.GameObjects.Container;
  private fogLayer!: Phaser.GameObjects.Graphics;
  private driverSprite!: Phaser.GameObjects.Container;
  private navSprite!: Phaser.GameObjects.Container;
  private unsubscribe?: () => void;
  private TILE = TILE_MAX;

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
    board.fillRoundedRect(this.originX - 10, this.originY - 10, this.mapW + 20, this.mapH + 20, 18);

    this.mapLayer = this.add.container(this.originX, this.originY);
    this.drawMap();

    this.driverSprite = this.makeAvatar(COLORS.driver, "D");
    this.navSprite    = this.makeAvatar(COLORS.navigator, "N");

    if (this.state.driverAvatar) {
      this.placeInstantly(this.driverSprite, this.state.driverAvatar.x, this.state.driverAvatar.y);
    }
    if (this.state.navigatorAvatar) {
      this.placeInstantly(this.navSprite, this.state.navigatorAvatar.x, this.state.navigatorAvatar.y);
    }

    this.fogLayer = this.add.graphics();
    this.drawFog();

    const labelText = this.state.yourRole === "driver" ? this.state.driverSpawnLabel : this.state.navigatorSpawnLabel;
    this.add.text(
      this.scale.width / 2,
      this.originY + this.mapH + 22,
      `You are in: ${labelText}`,
      { fontFamily: "Fraunces, serif", fontSize: "16px", color: "#2a1d0f", fontStyle: "italic" }
    ).setOrigin(0.5);

    if (this.input.keyboard) {
      const k = this.input.keyboard;
      const tap = (a: "up" | "down" | "left" | "right") => () => { sfx.step(); store.reunionInput(a); };
      k.on("keydown-W", tap("up"));     k.on("keydown-UP",    tap("up"));
      k.on("keydown-S", tap("down"));   k.on("keydown-DOWN",  tap("down"));
      k.on("keydown-A", tap("left"));   k.on("keydown-LEFT",  tap("left"));
      k.on("keydown-D", tap("right"));  k.on("keydown-RIGHT", tap("right"));
    }

    this.unsubscribe = store.subscribe((s) => s && this.applyState(s));
    const onResize = () => { if (this.state) this.scene.restart({ state: this.state }); };
    this.scale.on("resize", onResize);
    this.events.once("shutdown", () => {
      this.unsubscribe?.();
      this.tweens.killAll();
      this.scale.off("resize", onResize);
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
          g.fillRect(px + 6, py + 6, TILE - 12, 3);
          g.fillRect(px + 6, py + TILE - 9, TILE - 12, 3);
        }
        this.mapLayer.add(g);
      }
    }
  }

  private makeAvatar(color: number, letter: string): Phaser.GameObjects.Container {
    const c = this.add.container(0, 0);
    const body = this.add.graphics();
    body.fillStyle(color, 1);
    body.fillCircle(0, 0, 14);
    body.lineStyle(2, 0x000000, 0.18);
    body.strokeCircle(0, 0, 14);
    const txt = this.add.text(0, 0, letter, {
      fontFamily: "Inter, sans-serif", fontSize: "14px", color: "#fff8ee", fontStyle: "700",
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
        if (Math.abs(x - me.x) <= VIS && Math.abs(y - me.y) <= VIS) continue;
        this.fogLayer.fillStyle(COLORS.void, 0.92);
        this.fogLayer.fillRect(this.originX + x * this.TILE, this.originY + y * this.TILE, this.TILE, this.TILE);
      }
    }
    if (them) {
      const visible = Math.abs(them.x - me.x) <= VIS && Math.abs(them.y - me.y) <= VIS;
      const partnerSprite = this.state.yourRole === "driver" ? this.navSprite : this.driverSprite;
      partnerSprite.setVisible(visible);
    }
    this.children.bringToTop(this.driverSprite);
    this.children.bringToTop(this.navSprite);
  }

  applyState(next: PublicState) {
    const prev = this.state;
    this.state = next;
    if (next.phase !== "reunion" && next.phase !== "complete") return;

    const tweenAvatar = (sprite: Phaser.GameObjects.Container,
                        prevPos: { x: number; y: number } | null,
                        nextPos: { x: number; y: number } | null) => {
      if (!nextPos) return;
      if (!prevPos || (prevPos.x === nextPos.x && prevPos.y === nextPos.y)) return;
      const { x, y } = this.worldOf(nextPos.x, nextPos.y);
      this.tweens.add({
        targets: sprite,
        x, y,
        duration: 160, ease: "Cubic.easeOut",
        onUpdate: () => this.drawFog(),
      });
    };

    tweenAvatar(this.driverSprite, prev.driverAvatar,    next.driverAvatar);
    tweenAvatar(this.navSprite,    prev.navigatorAvatar, next.navigatorAvatar);
    this.drawFog();

    if (next.phase === "complete" && next.outcome === "reunited") {
      sfx.reunite();
      const me = next.yourRole === "driver" ? next.driverAvatar : next.navigatorAvatar;
      if (me) {
        const { x, y } = this.worldOf(me.x, me.y);
        for (let i = 0; i < 14; i++) {
          const h = this.add.text(x, y, "♥", {
            fontFamily: "Inter, sans-serif", fontSize: "22px", color: "#ff5a8a",
          }).setOrigin(0.5);
          this.tweens.add({
            targets: h,
            x: x + Phaser.Math.Between(-90, 90),
            y: y + Phaser.Math.Between(-130, -50),
            alpha: 0, scale: { from: 0.6, to: 1.5 },
            duration: 1000 + Math.random() * 400, ease: "Cubic.easeOut",
            onComplete: () => h.destroy(),
          });
        }
        this.cameras.main.flash(220, 255, 220, 230);
      }
    }
  }
}
