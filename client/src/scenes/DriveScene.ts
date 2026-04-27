import Phaser from "phaser";
import type { PublicState, HydratedGraph } from "../types";
import { store } from "../net";
import { sfx } from "../audio";
import {
  pointAt, laneOffset, ROAD_LANE_WIDTH,
  FOG_RADIUS, FOG_AHEAD,
} from "../../../shared/game.js";

const HUD_TOP = 76;
const HUD_BOT_DRV = 210;
const HUD_BOT_NAV = 80;
const SIDE_MARGIN = 12;

const COLORS = {
  // Outside the asphalt — Trinidad-warm grass with dirt tint.
  grass:        0x6f8554,
  grassDark:    0x5a6e44,
  grassDirt:    0x8b8253,
  // Asphalt
  asphalt:      0x2b2a30,
  asphaltSheen: 0x3a3942,
  asphaltEdge:  0x1c1b22,
  shoulder:     0xc9b58c,
  laneMark:     0xfff4c4,
  laneMarkEdge: 0xeed68a,
  // Roundabout island
  islandFill:   0x4d6638,
  islandTop:    0x648151,
  islandTrunk:  0x6e4a2a,
  // Hazards / errands / home
  pothole:      0x18171c,
  potholeRim:   0x453a3a,
  errandRing:   0xffce4d,
  homeFill:     0x7bd389,
  homeRoof:     0x9b3b1f,
  homeOutline:  0x223326,
  // Car
  carBody:      0xff7a59,
  carShade:     0xb44a30,
  carRoof:      0xfff8ee,
  brakeLite:    0xff3322,
  headLite:     0xfff5a3,
  // Fog & UI accents
  void:         0x07050a,
  trajectory:   0xffce4d,
  trajectoryBad:0xff5a5a,
};

const STATIC_TILE_KEY = "tol_grass_tile";

export class DriveScene extends Phaser.Scene {
  private state!: PublicState;
  private graph!: HydratedGraph;
  private isDriver = false;
  private mapW = 0;
  private mapH = 0;
  private originX = 0;
  private originY = 0;
  private viewScale = 1;

  private mapLayer!: Phaser.GameObjects.Container;
  private bgLayer!: Phaser.GameObjects.Graphics;
  private roadStaticG!: Phaser.GameObjects.Graphics;
  private decoStaticG!: Phaser.GameObjects.Graphics;
  private hazardLayer!: Phaser.GameObjects.Container;
  private errandLayer!: Phaser.GameObjects.Container;
  private homeLayer!: Phaser.GameObjects.Container;
  private trajectoryLayer?: Phaser.GameObjects.Graphics;
  private fogRect?: Phaser.GameObjects.Rectangle;
  private fogMaskG?: Phaser.GameObjects.Graphics;
  private carContainer!: Phaser.GameObjects.Container;
  private carBrakeGlow?: Phaser.GameObjects.Graphics;

  private displayed = { x: 0, y: 0, angle: 0 };
  private targetPos = { x: 0, y: 0, angle: 0 };
  private prevCrashes = 0;
  private prevConsumed = new Set<string>();
  private countdownStarted = false;
  private unsubscribe?: () => void;
  private unsubscribeGraph?: () => void;

  constructor() { super("DriveScene"); }

  init(data?: { state?: PublicState }) {
    if (!data?.state) return;
    this.state = data.state;
    this.isDriver = this.state.yourRole === "driver";
    this.graph = store.graph!;
  }

  create() {
    if (!this.state || !this.graph) return;
    this.recomputeLayout();
    this.prevCrashes = this.state.crashes;
    this.prevConsumed = new Set(this.state.consumedHazardIds);

    // Layers: bg → roads → deco → home → errands → hazards → car → trajectory → fog
    this.cameras.main.setBackgroundColor("#3a4a30");

    this.mapLayer = this.add.container(this.originX, this.originY);
    this.mapLayer.setScale(this.viewScale);

    this.bgLayer = this.add.graphics();
    this.mapLayer.add(this.bgLayer);
    this.drawGrass();

    this.decoStaticG = this.add.graphics();
    this.mapLayer.add(this.decoStaticG);
    this.roadStaticG = this.add.graphics();
    this.mapLayer.add(this.roadStaticG);
    this.drawRoads();

    this.homeLayer = this.add.container(0, 0);
    this.mapLayer.add(this.homeLayer);
    this.drawHome();

    this.errandLayer = this.add.container(0, 0);
    this.mapLayer.add(this.errandLayer);
    this.drawErrands();

    this.hazardLayer = this.add.container(0, 0);
    this.mapLayer.add(this.hazardLayer);
    this.drawHazards();

    if (!this.isDriver) {
      this.drawZoneLabels();
      this.trajectoryLayer = this.add.graphics();
      this.mapLayer.add(this.trajectoryLayer);
      this.drawTrajectory();
    }

    this.carContainer = this.makeCar();
    this.mapLayer.add(this.carContainer);
    this.snapCarToServer();

    if (this.isDriver) {
      this.cameras.main.startFollow(this.carContainer, true, 0.18, 0.18);
      this.cameras.main.setZoom(1.0);
      this.fogRect = this.add.rectangle(0, 0, 100, 100, 0x000000, 0.92)
        .setOrigin(0).setScrollFactor(0).setDepth(1500);
      this.fogMaskG = this.add.graphics();
      this.fogMaskG.setScrollFactor(0).setVisible(false);
      const mask = new Phaser.Display.Masks.GeometryMask(this, this.fogMaskG);
      mask.setInvertAlpha(true);
      this.fogRect.setMask(mask);
      this.resizeFog();
      this.drawFog();
    }

    if (this.isDriver && this.input.keyboard) {
      const k = this.input.keyboard;
      k.on("keydown-A",     () => { sfx.turn(); store.driverInput("lane_left"); });
      k.on("keydown-LEFT",  () => { sfx.turn(); store.driverInput("lane_left"); });
      k.on("keydown-D",     () => { sfx.turn(); store.driverInput("lane_right"); });
      k.on("keydown-RIGHT", () => { sfx.turn(); store.driverInput("lane_right"); });
      k.on("keydown-S",     () => { sfx.brake(); store.driverInput("brake"); });
      k.on("keydown-DOWN",  () => { sfx.brake(); store.driverInput("brake"); });
      k.on("keydown-SPACE", () => { sfx.brake(); store.driverInput("brake"); });
    }

    if (this.state.countdownRemainingMs > 0 && !this.countdownStarted) {
      this.countdownStarted = true;
      this.showCountdown();
    }

    this.unsubscribe = store.subscribe((s) => s && this.applyState(s));
    this.unsubscribeGraph = store.subscribeGraph(() => {
      // Graph swapped (new round). Force restart of scene.
      if (this.state) this.scene.restart({ state: this.state });
    });
    const onResize = () => { if (this.state) this.scene.restart({ state: this.state }); };
    this.scale.on("resize", onResize);

    this.events.once("shutdown", () => {
      this.unsubscribe?.();
      this.unsubscribeGraph?.();
      try { this.tweens.killAll(); } catch {}
      try { this.cameras.main?.stopFollow(); } catch {}
      try { this.scale.off("resize", onResize); } catch {}
    });
  }

  update(_time: number, delta: number) {
    // Lerp displayed car toward target each frame for smooth motion between ticks.
    const k = Math.min(1, delta / 110);
    this.displayed.x += (this.targetPos.x - this.displayed.x) * k;
    this.displayed.y += (this.targetPos.y - this.displayed.y) * k;
    // Angle blend (handle wraparound).
    const da = Phaser.Math.Angle.Wrap(this.targetPos.angle - this.displayed.angle);
    this.displayed.angle += da * k;
    this.carContainer.setPosition(this.displayed.x, this.displayed.y);
    this.carContainer.setRotation(this.displayed.angle);
    if (this.fogRect) this.drawFog();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Layout

  private recomputeLayout() {
    const w = this.scale.width;
    const h = this.scale.height;
    const availW = Math.max(120, w - SIDE_MARGIN * 2);
    const reservedBot = this.isDriver ? HUD_BOT_DRV : HUD_BOT_NAV;
    const availH = Math.max(120, h - HUD_TOP - reservedBot);

    if (this.isDriver) {
      // Driver: render world at native scale, camera follows car.
      this.viewScale = 1;
      this.mapW = this.graph.width;
      this.mapH = this.graph.height;
      this.originX = 0;
      this.originY = 0;
    } else {
      // Navigator: scale entire graph to fit viewport.
      const fit = Math.min(availW / this.graph.width, availH / this.graph.height);
      this.viewScale = fit;
      this.mapW = this.graph.width * fit;
      this.mapH = this.graph.height * fit;
      this.originX = Math.round((w - this.mapW) / 2);
      this.originY = Math.round(HUD_TOP + (availH - this.mapH) / 2);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Drawing — static layers

  private drawGrass() {
    // Grass background covering the map area + a generous margin so the
    // edges don't pop into the void at the world boundary.
    const margin = 600;
    const w = this.graph.width + margin * 2;
    const h = this.graph.height + margin * 2;
    this.bgLayer.fillStyle(COLORS.grass, 1);
    this.bgLayer.fillRect(-margin, -margin, w, h);
    // Sprinkle darker patches for texture.
    const rng = mulberry32(0xa11ce);
    for (let i = 0; i < 220; i++) {
      const px = -margin + rng() * w;
      const py = -margin + rng() * h;
      this.bgLayer.fillStyle(COLORS.grassDark, 0.7);
      this.bgLayer.fillCircle(px, py, 6 + rng() * 14);
    }
    for (let i = 0; i < 90; i++) {
      const px = -margin + rng() * w;
      const py = -margin + rng() * h;
      this.bgLayer.fillStyle(COLORS.grassDirt, 0.5);
      this.bgLayer.fillCircle(px, py, 4 + rng() * 10);
    }
  }

  private drawRoads() {
    const g = this.roadStaticG;
    const dec = this.decoStaticG;

    // Pass 1: roundabout center islands first, so roads draw over them at
    // their edges (cleaner cap).
    for (const ch of this.graph.chunks) {
      if (ch.name === "roundabout" && ch.meta) {
        const cx = ch.meta.center.x;
        const cy = ch.meta.center.y + ch.y;
        const r = ch.meta.radius - ROAD_LANE_WIDTH; // inner island
        if (r > 0) {
          dec.fillStyle(COLORS.islandFill, 1);
          dec.fillCircle(cx, cy, r);
          // a tiny palm tree silhouette for vibes
          dec.fillStyle(COLORS.islandTrunk, 1);
          dec.fillRect(cx - 2, cy - 2, 4, r * 0.5);
          dec.fillStyle(COLORS.islandTop, 1);
          dec.fillCircle(cx, cy - 6, Math.max(8, r * 0.45));
          dec.fillCircle(cx - 8, cy - 2, Math.max(6, r * 0.32));
          dec.fillCircle(cx + 8, cy - 2, Math.max(6, r * 0.32));
        }
      }
    }

    // Pass 2: shoulder under each road.
    for (const e of this.graph.edges) {
      if (e.kind === "deco") {
        // Decorative stub: thin asphalt fade.
        this.strokePolyline(g, e.polyline,
          (e.lanes * ROAD_LANE_WIDTH) + 6, COLORS.asphaltEdge, 0.6);
        this.strokePolyline(g, e.polyline,
          (e.lanes * ROAD_LANE_WIDTH) - 2, COLORS.asphalt, 0.85);
        continue;
      }
      this.strokePolyline(g, e.polyline,
        e.lanes * ROAD_LANE_WIDTH + 10, COLORS.shoulder, 1);
    }

    // Pass 3: asphalt + outline.
    for (const e of this.graph.edges) {
      if (e.kind === "deco") continue;
      const w = e.lanes * ROAD_LANE_WIDTH;
      this.strokePolyline(g, e.polyline, w + 4, COLORS.asphaltEdge, 1);
      this.strokePolyline(g, e.polyline, w, COLORS.asphalt, 1);
      // Subtle sheen down the centerline (just a hair lighter), for depth.
      this.strokePolyline(g, e.polyline, w * 0.5, COLORS.asphaltSheen, 0.18);
    }

    // Pass 4: outer lane markings (solid white-ish lines along the road edges).
    for (const e of this.graph.edges) {
      if (e.kind === "deco") continue;
      const w = e.lanes * ROAD_LANE_WIDTH;
      this.strokeOffsetPolyline(g, e.polyline,  w / 2 - 2, 1.5, COLORS.laneMarkEdge, 0.8);
      this.strokeOffsetPolyline(g, e.polyline, -w / 2 + 2, 1.5, COLORS.laneMarkEdge, 0.8);
    }

    // Pass 5: dashed center lane separator (between lanes), for multi-lane.
    for (const e of this.graph.edges) {
      if (e.kind === "deco") continue;
      if (e.lanes < 2) continue;
      this.dashedPolyline(g, e.polyline, 0, 1.6, 14, 10, COLORS.laneMark, 0.95);
    }
  }

  private drawHome() {
    if (!this.graph.homeNodeId) return;
    const home = this.graph.nodesById[this.graph.homeNodeId];
    if (!home) return;
    const c = this.add.container(home.x, home.y);
    const halo = this.add.graphics();
    halo.fillStyle(COLORS.homeFill, 0.32);
    halo.fillCircle(0, 0, 38);
    halo.lineStyle(2, COLORS.homeFill, 0.65);
    halo.strokeCircle(0, 0, 38);
    c.add(halo);
    // Little house icon
    const ic = this.add.text(0, -2, "🏠", { fontSize: "30px" }).setOrigin(0.5);
    c.add(ic);
    const lbl = this.add.text(0, 26, "HOME", {
      fontFamily: "Inter, sans-serif", fontSize: "10px",
      color: "#1c2418", fontStyle: "800", backgroundColor: "#fff8eecc",
      padding: { left: 4, right: 4, top: 1, bottom: 1 },
    }).setOrigin(0.5);
    c.add(lbl);
    this.homeLayer.add(c);
    this.tweens.add({
      targets: halo,
      alpha: { from: 0.6, to: 0.95 },
      duration: 1300, yoyo: true, repeat: -1, ease: "Sine.easeInOut",
    });
  }

  private drawErrands() {
    this.errandLayer.removeAll(true);
    for (const e of this.state.errands) {
      if (e.done) continue;
      const c = this.add.container(e.x, e.y);
      const ring = this.add.graphics();
      ring.fillStyle(0xfff8ee, 0.7);
      ring.fillCircle(0, 0, 18);
      ring.lineStyle(2.5, COLORS.errandRing, 1);
      ring.strokeCircle(0, 0, 18);
      c.add(ring);
      const ic = this.add.text(0, -1, e.icon, { fontSize: "22px" }).setOrigin(0.5);
      c.add(ic);
      this.errandLayer.add(c);
      this.tweens.add({
        targets: ring,
        alpha: { from: 1, to: 0.55 },
        duration: 1100, yoyo: true, repeat: -1, ease: "Sine.easeInOut",
      });
    }
  }

  private drawHazards() {
    this.hazardLayer.removeAll(true);
    const consumed = new Set(this.state.consumedHazardIds);
    for (const e of this.graph.edges) {
      for (let i = 0; i < e.hazards.length; i++) {
        const h = e.hazards[i];
        const id = `${e.id}:${i}`;
        if (consumed.has(id)) continue;
        const p = pointAt(e as any, h.t);
        const off = laneOffset(e, h.lane);
        const nx = -p.tangent.dy;
        const ny = p.tangent.dx;
        const px = p.x + nx * off;
        const py = p.y + ny * off;
        const c = this.add.container(px, py);
        const rim = this.add.graphics();
        // Crumbly rim
        rim.fillStyle(COLORS.potholeRim, 1);
        rim.fillCircle(-2, 1, 11);
        rim.fillCircle(2, -1, 9);
        rim.fillCircle(0, 3, 10);
        c.add(rim);
        const hole = this.add.graphics();
        hole.fillStyle(COLORS.pothole, 1);
        hole.fillCircle(0, 0, 8);
        c.add(hole);
        this.hazardLayer.add(c);
      }
    }
  }

  private drawZoneLabels() {
    for (const z of this.graph.zones) {
      const txt = this.add.text(z.x, z.y, z.label.toUpperCase(), {
        fontFamily: "Inter, sans-serif", fontSize: "11px",
        color: "#fff8ee", fontStyle: "700",
        backgroundColor: "#0008",
        padding: { left: 4, right: 4, top: 1, bottom: 1 },
      }).setOrigin(0.5);
      this.mapLayer.add(txt);
    }
  }

  private drawTrajectory() {
    if (!this.trajectoryLayer || !this.state.car) return;
    this.trajectoryLayer.clear();
    const car = this.state.car;
    const edge = this.graph.edgesById[car.edgeId];
    if (!edge) return;
    // Sample a few points ahead from the car's current t along the current
    // edge; if we run off the end, hop to the successor.
    const total = 7;
    let curEdge = edge;
    let curT = car.t;
    let advancePerStep = 0.16;
    for (let i = 1; i <= total; i++) {
      curT += advancePerStep;
      while (curT > 1) {
        curT -= 1;
        const succ = this.graph.successorByNode.get(curEdge.toNode);
        const nextId = succ && succ[0];
        if (!nextId) { curT = 1; break; }
        curEdge = this.graph.edgesById[nextId];
      }
      const p = pointAt(curEdge as any, curT);
      const off = laneOffset(curEdge, car.targetLane);
      const nx = -p.tangent.dy;
      const ny = p.tangent.dx;
      const px = p.x + nx * off;
      const py = p.y + ny * off;
      const isLast = i === total;
      const r = 3 + i * 0.5;
      this.trajectoryLayer.fillStyle(COLORS.trajectory, isLast ? 0.95 : 0.55);
      this.trajectoryLayer.fillCircle(px, py, r);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Car

  private makeCar(): Phaser.GameObjects.Container {
    const c = this.add.container(0, 0);
    const glow = this.add.graphics();
    glow.fillStyle(COLORS.brakeLite, 0.45);
    glow.fillCircle(-22, 0, 18);
    glow.setVisible(false);
    this.carBrakeGlow = glow;
    c.add(glow);

    // Drop shadow under the car for depth.
    const shadow = this.add.graphics();
    shadow.fillStyle(0x000000, 0.32);
    shadow.fillEllipse(0, 5, 36, 16);
    c.add(shadow);

    const body = this.add.graphics();
    // Body
    body.fillStyle(COLORS.carBody, 1);
    body.fillRoundedRect(-17, -10, 34, 20, 5);
    body.lineStyle(1.5, COLORS.carShade, 1);
    body.strokeRoundedRect(-17, -10, 34, 20, 5);
    // Hood gradient suggestion (slightly darker rear)
    body.fillStyle(COLORS.carShade, 0.55);
    body.fillRect(-17, -10, 6, 20);
    // Windshield + rear window
    body.fillStyle(0x223344, 0.92);
    body.fillRoundedRect(2, -7, 9, 14, 2);    // windshield
    body.fillRoundedRect(-11, -6, 7, 12, 2);  // rear window
    // Headlights
    body.fillStyle(COLORS.headLite, 1);
    body.fillCircle(15, -6, 2);
    body.fillCircle(15,  6, 2);
    // Taillights
    body.fillStyle(0xb40000, 1);
    body.fillCircle(-15, -6, 1.6);
    body.fillCircle(-15,  6, 1.6);
    c.add(body);
    return c;
  }

  private snapCarToServer() {
    if (!this.state.car) return;
    const wp = carPos(this.graph, this.state.car.edgeId, this.state.car.t, this.state.car.lane);
    if (!wp) return;
    this.displayed.x = wp.x;
    this.displayed.y = wp.y;
    this.displayed.angle = wp.angle;
    this.targetPos.x = wp.x;
    this.targetPos.y = wp.y;
    this.targetPos.angle = wp.angle;
    this.carContainer.setPosition(wp.x, wp.y);
    this.carContainer.setRotation(wp.angle);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Fog

  private resizeFog() {
    if (!this.fogRect) return;
    this.fogRect.setSize(this.scale.width, this.scale.height);
    this.fogRect.setPosition(0, 0);
  }

  private drawFog() {
    if (!this.fogMaskG) return;
    this.fogMaskG.clear();
    // Visible window is in screen coordinates because the mask graphic uses
    // scrollFactor 0. Camera follows car, so car ≈ screen center.
    const cam = this.cameras.main;
    const cx = cam.midPoint.x - cam.scrollX;
    const cy = cam.midPoint.y - cam.scrollY;
    // Two overlapping disks: a wide one at the car, and a forward "cone"
    // ellipse that biases vision in the direction of motion.
    this.fogMaskG.fillStyle(0xffffff, 1);
    this.fogMaskG.fillCircle(cx, cy, FOG_RADIUS);
    // Forward bias
    const a = this.displayed.angle;
    const fwdX = cx + Math.cos(a) * FOG_AHEAD * 0.45;
    const fwdY = cy + Math.sin(a) * FOG_AHEAD * 0.45;
    this.fogMaskG.fillCircle(fwdX, fwdY, FOG_AHEAD * 0.55);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // State application

  applyState(next: PublicState) {
    const prev = this.state;
    this.state = next;
    if (next.phase !== "driving" && next.phase !== "complete") return;
    if (!next.car) return;

    // Compute car target world pos.
    const wp = carPos(this.graph, next.car.edgeId, next.car.t, next.car.lane);
    if (wp) {
      this.targetPos.x = wp.x;
      this.targetPos.y = wp.y;
      this.targetPos.angle = wp.angle;
    }

    // Engine pitch follows server combo.
    if (prev.combo !== next.combo) {
      sfx.engineTick(next.combo);
    }

    // Brake glow.
    this.carBrakeGlow?.setVisible(!!next.braking);

    // Errand finished: animate score popup at car position, redraw markers.
    const newDone = next.errands.filter((e) => e.done).length
                  > prev.errands.filter((e) => e.done).length;
    if (newDone) {
      sfx.win();
      const earned = next.score - prev.score;
      const txt = this.add.text(this.displayed.x, this.displayed.y - 22, `+${earned}`, {
        fontFamily: "Inter, sans-serif", fontSize: "14px",
        color: "#ff7a59", fontStyle: "700",
      }).setOrigin(0.5).setDepth(2000);
      this.mapLayer.add(txt);
      this.tweens.add({
        targets: txt,
        y: this.displayed.y - 56,
        alpha: { from: 1, to: 0 },
        duration: 750, ease: "Cubic.easeOut",
        onComplete: () => txt.destroy(),
      });
      this.drawErrands();
    }

    // Combo callouts.
    if (next.combo > prev.combo && next.combo >= 1) {
      sfx.comboHit(next.combo);
      this.spawnComboCallout(next.combo);
    }
    if (prev.combo > 0 && next.combo === 0 && next.phase === "driving") {
      sfx.miss(prev.combo);
    }
    if (this.isDriver) {
      const glow = document.getElementById("combo-glow");
      if (glow) {
        const level = Math.min(5, Math.ceil(next.combo / 2));
        glow.className = next.combo > 0 ? `combo-${level}` : "";
      }
    }

    // Hazards consumed: redraw remaining set.
    const nextConsumed = new Set(next.consumedHazardIds);
    if (nextConsumed.size !== this.prevConsumed.size) {
      // A new pothole was hit
      const newOnes = [...nextConsumed].filter((id) => !this.prevConsumed.has(id));
      if (newOnes.length > 0) {
        sfx.brake(); // muddy thump-style
        this.cameras.main.shake(160, 0.008);
      }
      this.drawHazards();
      this.prevConsumed = nextConsumed;
    }

    // Crash effects.
    if (next.crashes > this.prevCrashes) {
      this.prevCrashes = next.crashes;
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
    }

    if (this.trajectoryLayer) this.drawTrajectory();
  }

  private spawnComboCallout(level: number) {
    const tiers: { min: number; word: string; color: string }[] = [
      { min: 1,  word: "NICE",      color: "#ffce4d" },
      { min: 2,  word: "GREAT",     color: "#ffae3a" },
      { min: 3,  word: "FIRE",      color: "#ff7a59" },
      { min: 5,  word: "ON FIRE!",  color: "#ff5a5a" },
      { min: 7,  word: "INSANE",    color: "#ff3a8c" },
      { min: 10, word: "GODLIKE",   color: "#c44ef0" },
    ];
    const tier = tiers.reduce((acc, t) => level >= t.min ? t : acc, tiers[0]);
    const cx = this.cameras.main.midPoint.x;
    const cy = this.cameras.main.midPoint.y - 65;
    const word = this.add.text(cx, cy, tier.word, {
      fontFamily: "Fraunces, serif",
      fontSize: `${28 + Math.min(12, level * 1.5)}px`,
      color: tier.color, fontStyle: "700",
      stroke: "#000", strokeThickness: 3,
    }).setOrigin(0.5).setScrollFactor(0).setDepth(2100).setScale(0.3).setAlpha(0);
    const num = this.add.text(cx, cy + 30, `${level}× COMBO`, {
      fontFamily: "Inter, sans-serif", fontSize: "13px",
      color: tier.color, fontStyle: "800",
      stroke: "#000", strokeThickness: 2,
    }).setOrigin(0.5).setScrollFactor(0).setDepth(2100).setAlpha(0);
    this.tweens.add({
      targets: word, scale: { from: 0.3, to: 1 }, alpha: { from: 0, to: 1 },
      duration: 200, ease: "Back.easeOut",
    });
    this.tweens.add({
      targets: num, alpha: { from: 0, to: 1 }, duration: 180, delay: 80,
    });
    this.tweens.add({
      targets: [word, num], y: `-=18`, alpha: 0,
      delay: 480, duration: 380, ease: "Cubic.easeIn",
      onComplete: () => { word.destroy(); num.destroy(); },
    });
    if (level >= 5) this.cameras.main.flash(120, 255, 220, 100, false);
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

  // ──────────────────────────────────────────────────────────────────────────
  // Polyline drawing helpers

  private strokePolyline(g: Phaser.GameObjects.Graphics, pts: { x: number; y: number }[], width: number, color: number, alpha: number) {
    g.lineStyle(width, color, alpha);
    g.beginPath();
    g.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
    g.strokePath();
  }

  // Draws a polyline parallel to the given centerline, offset perpendicularly.
  private strokeOffsetPolyline(
    g: Phaser.GameObjects.Graphics, pts: { x: number; y: number }[],
    offset: number, width: number, color: number, alpha: number,
  ) {
    if (pts.length < 2) return;
    g.lineStyle(width, color, alpha);
    g.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(pts.length - 1, i + 1)];
      const tx = b.x - a.x, ty = b.y - a.y;
      const len = Math.hypot(tx, ty) || 1;
      const nx = -ty / len, ny = tx / len;
      const x = pts[i].x + nx * offset;
      const y = pts[i].y + ny * offset;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.strokePath();
  }

  // Draws short dashes along a polyline (cumulative arc-length walk).
  private dashedPolyline(
    g: Phaser.GameObjects.Graphics, pts: { x: number; y: number }[],
    offset: number, width: number, dashLen: number, gapLen: number,
    color: number, alpha: number,
  ) {
    if (pts.length < 2) return;
    // Build cumulative arclength array.
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i-1] + Math.hypot(pts[i].x - pts[i-1].x, pts[i].y - pts[i-1].y));
    const totalLen = cum[cum.length - 1];
    const period = dashLen + gapLen;
    g.lineStyle(width, color, alpha);
    let pos = 0;
    while (pos < totalLen) {
      const a = pos;
      const b = Math.min(pos + dashLen, totalLen);
      const pa = sampleAt(pts, cum, a, offset);
      const pb = sampleAt(pts, cum, b, offset);
      g.beginPath();
      g.moveTo(pa.x, pa.y);
      g.lineTo(pb.x, pb.y);
      g.strokePath();
      pos += period;
    }
  }
}

void STATIC_TILE_KEY;

// ────────────────────────────────────────────────────────────────────────────

function sampleAt(pts: { x: number; y: number }[], cum: number[], target: number, offset: number) {
  let i = 1;
  while (i < cum.length && cum[i] < target) i++;
  if (i >= cum.length) i = cum.length - 1;
  const segStart = cum[i - 1];
  const segLen = (cum[i] - segStart) || 1;
  const localT = (target - segStart) / segLen;
  const a = pts[i - 1];
  const b = pts[i];
  const tx = b.x - a.x, ty = b.y - a.y;
  const len = Math.hypot(tx, ty) || 1;
  const nx = -ty / len, ny = tx / len;
  return {
    x: a.x + tx * localT + nx * offset,
    y: a.y + ty * localT + ny * offset,
  };
}

function carPos(graph: HydratedGraph, edgeId: string, t: number, lane: number) {
  const edge = graph.edgesById[edgeId];
  if (!edge) return null;
  const p = pointAt(edge as any, t);
  const off = laneOffset(edge, lane);
  const nx = -p.tangent.dy;
  const ny = p.tangent.dx;
  return {
    x: p.x + nx * off,
    y: p.y + ny * off,
    angle: Math.atan2(p.tangent.dy, p.tangent.dx),
  };
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
