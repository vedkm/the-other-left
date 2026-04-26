import Phaser from "phaser";
import "./style.css";
import { store } from "./net";
import type { PublicState, Phase } from "./types";
import { DriveScene } from "./scenes/DriveScene";
import {
  renderLanding, renderWaiting, renderComplete,
  renderStatusBar, renderHint, renderDriverDpad,
  renderErrandStrip, clearOverlay,
} from "./ui/lobby";
import { sfx } from "./audio";

let phaserGame: Phaser.Game | null = null;
let booted = false;
let activeScene: "drive" | null = null;
let lastPhase: Phase | null = null;
let pendingShow: { name: "drive" | null; state: PublicState | null } | null = null;

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

function applyShow(name: "drive" | null, state: PublicState | null) {
  const g = phaserGame!;
  try {
    if (g.scene.getScene("DriveScene")?.scene.isActive()) g.scene.stop("DriveScene");
  } catch (e) { console.warn("[scene stop]", e); }
  activeScene = name;
  if (!name || !state) return;
  try {
    if (name === "drive") g.scene.start("DriveScene", { state });
  } catch (e) { console.warn("[scene start]", e); }
}

function showScene(name: "drive" | null, state: PublicState | null) {
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
      if (p === "complete") store.requestState();
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
    if (activeScene !== "drive") showScene("drive", state);
    pollWhileStuck(false);
    if (state.yourRole === "driver") {
      renderDriverDpad(state);
      if (state.countdownRemainingMs > 0) {
        renderHint("Get ready. Car drives itself. Tap LEFT/RIGHT to steer, BRAKE to stop.");
      }
    } else {
      const remaining = state.errands.filter((e) => !e.done).length;
      const hint = state.countdownRemainingMs > 0
        ? "Get ready. They see only two tiles ahead."
        : remaining === 0
          ? "All errands done. Send them home (🏠 in your top-left)."
          : `${remaining} errand${remaining > 1 ? "s" : ""} left. Yell directions — dotted line shows where they're heading.`;
      renderHint(hint);
    }
    return;
  }

  if (phase === "complete") {
    clearOverlay();
    renderStatusBar(state);
    if (activeScene !== "drive") showScene("drive", state);
    if (prev !== "complete") {
      if (state.outcome === "perfect") sfx.win();
    }
    pollWhileStuck(true);
    setTimeout(() => {
      if (store.state?.phase === "complete") renderComplete(state);
    }, 700);
    return;
  }
  pollWhileStuck(false);
}

store.subscribe((s) => render(s));
render(null);
