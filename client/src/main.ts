import Phaser from "phaser";
import "./style.css";
import { store } from "./net";
import type { PublicState, Phase } from "./types";
import { DriveScene } from "./scenes/DriveScene";
import { ReunionScene } from "./scenes/ReunionScene";
import {
  renderLanding, renderWaiting, renderComplete,
  renderStatusBar, renderHint, renderDriverDpad,
  renderReunionDpad, renderErrandStrip, clearOverlay,
} from "./ui/lobby";
import { sfx } from "./audio";

type SceneName = "drive" | "reunion" | null;
let phaserGame: Phaser.Game | null = null;
let booted = false;
let activeScene: SceneName = null;
let lastPhase: Phase | null = null;
let pendingShow: { name: SceneName; state: PublicState | null } | null = null;

function ensureGame(): Phaser.Game {
  if (phaserGame) return phaserGame;
  phaserGame = new Phaser.Game({
    type: Phaser.AUTO,
    parent: "game",
    width: window.innerWidth,
    height: window.innerHeight,
    transparent: true,
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.NO_CENTER,
    },
  });
  phaserGame.scene.add("DriveScene", DriveScene, false);
  phaserGame.scene.add("ReunionScene", ReunionScene, false);

  phaserGame.events.once("ready", () => {
    booted = true;
    if (pendingShow) {
      const { name, state } = pendingShow;
      pendingShow = null;
      applyShow(name, state);
    }
  });

  window.addEventListener("resize", () => {
    if (phaserGame) phaserGame.scale.resize(window.innerWidth, window.innerHeight);
  });
  window.addEventListener("orientationchange", () => {
    setTimeout(() => phaserGame?.scale.resize(window.innerWidth, window.innerHeight), 200);
  });
  return phaserGame;
}

function applyShow(name: SceneName, state: PublicState | null) {
  const g = phaserGame!;
  try {
    if (g.scene.getScene("DriveScene")?.scene.isActive())   g.scene.stop("DriveScene");
    if (g.scene.getScene("ReunionScene")?.scene.isActive()) g.scene.stop("ReunionScene");
  } catch (e) { console.warn("[scene stop]", e); }
  activeScene = name;
  if (!name || !state) return;
  try {
    if (name === "drive")   g.scene.start("DriveScene",   { state });
    if (name === "reunion") g.scene.start("ReunionScene", { state });
  } catch (e) { console.warn("[scene start]", e); }
}

function showScene(name: SceneName, state: PublicState | null) {
  ensureGame();
  if (booted) applyShow(name, state);
  else        pendingShow = { name, state };
}

function gameRoot() {
  return document.getElementById("game")!;
}

function hideGameCanvas() {
  gameRoot().style.opacity = "0";
}
function showGameCanvas() {
  gameRoot().style.opacity = "1";
  gameRoot().style.transition = "opacity .25s ease";
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
function pollWhileStuck(active: boolean) {
  if (active && !pollTimer) {
    pollTimer = setInterval(() => {
      if (!store.connected) return;
      const p = store.state?.phase;
      if (p === "complete" || p === "reunion") store.requestState();
    }, 2000);
  } else if (!active && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function render(state: PublicState | null) {
  if (!state) {
    showScene(null, null);
    hideGameCanvas();
    pollWhileStuck(false);
    renderLanding();
    return;
  }

  const phase = state.phase;
  const prev = lastPhase;
  lastPhase = phase;

  if (phase === "waiting" || phase === "ready") {
    showScene(null, null);
    hideGameCanvas();
    pollWhileStuck(false);
    renderWaiting(state);
    return;
  }

  if (phase === "driving") {
    clearOverlay();
    renderStatusBar(state);
    renderErrandStrip(state);
    showGameCanvas();
    // Wait for the graph to arrive before mounting DriveScene.
    if (store.graph) {
      if (activeScene !== "drive") showScene("drive", state);
    }
    pollWhileStuck(false);
    if (state.yourRole === "driver") {
      renderDriverDpad(state);
      if (state.countdownRemainingMs > 0) {
        renderHint("Get ready. Car cruises itself — tap LEFT/RIGHT to swerve lanes, BRAKE before hairpins.");
      }
    } else {
      const remaining = state.errands.filter((e) => !e.done).length;
      const hint = state.countdownRemainingMs > 0
        ? "Get ready. They only see what's right in front of them."
        : remaining === 0
          ? "All errands done. Send them home (🏠 marker)."
          : `${remaining} errand${remaining > 1 ? "s" : ""} left. Call out the road ahead — pothole left, big curve, pick a lane!`;
      renderHint(hint);
    }
    return;
  }

  if (phase === "reunion") {
    clearOverlay();
    renderStatusBar(state);
    showGameCanvas();
    if (activeScene !== "reunion") showScene("reunion", state);
    renderReunionDpad();
    const remaining = Math.ceil(state.reunionTimeRemainingMs / 1000);
    renderHint(`Find each other! ${remaining}s left · score is bleeding`);
    pollWhileStuck(true);
    return;
  }

  if (phase === "complete") {
    clearOverlay();
    renderStatusBar(state);
    // Stay in whichever scene we ended in (reunion shows the heart-burst).
    if (state.driverAvatar && state.navigatorAvatar) {
      if (activeScene !== "reunion") showScene("reunion", state);
    } else {
      if (activeScene !== "drive") showScene("drive", state);
    }
    if (prev !== "complete") {
      if (state.outcome === "perfect") sfx.win();
    }
    pollWhileStuck(true);
    setTimeout(() => {
      if (store.state?.phase === "complete") renderComplete(state);
    }, 1100);
    return;
  }
  pollWhileStuck(false);
}

store.subscribe((s) => render(s));
// Also re-render when the graph arrives, in case state.phase already says
// "driving" but the graph hadn't loaded yet.
store.subscribeGraph(() => render(store.state));
render(null);
