import Phaser from "phaser";
import "./style.css";
import { store } from "./net";
import type { PublicState, Phase } from "./types";
import { DriveScene } from "./scenes/DriveScene";
import { ReunionScene } from "./scenes/ReunionScene";
import {
  renderLanding, renderWaiting, renderCrash, renderComplete,
  renderStatusBar, renderHint, renderDriverDpad, renderReunionDpad,
  renderMiniMap, clearOverlay,
} from "./ui/lobby";
import { sfx } from "./audio";

let phaserGame: Phaser.Game | null = null;
let booted = false;
let activeScene: "drive" | "reunion" | null = null;
let lastPhase: Phase | null = null;
let pendingShow: { name: "drive" | "reunion" | null; state: PublicState | null } | null = null;

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

  // Keep canvas in sync with viewport (orientation change, browser chrome resize)
  window.addEventListener("resize", () => {
    if (phaserGame) phaserGame.scale.resize(window.innerWidth, window.innerHeight);
  });
  window.addEventListener("orientationchange", () => {
    setTimeout(() => phaserGame?.scale.resize(window.innerWidth, window.innerHeight), 200);
  });
  return phaserGame;
}

function applyShow(name: "drive" | "reunion" | null, state: PublicState | null) {
  const g = phaserGame!;
  if (g.scene.getScene("DriveScene")?.scene.isActive())   g.scene.stop("DriveScene");
  if (g.scene.getScene("ReunionScene")?.scene.isActive()) g.scene.stop("ReunionScene");
  activeScene = name;
  if (!name || !state) return;
  if (name === "drive")   g.scene.start("DriveScene",   { state });
  if (name === "reunion") g.scene.start("ReunionScene", { state });
}

function showScene(name: "drive" | "reunion" | null, state: PublicState | null) {
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

function render(state: PublicState | null) {
  if (!state) {
    showScene(null, null);
    hideGameCanvas();
    renderLanding();
    return;
  }

  const phase = state.phase;
  const prev = lastPhase;
  lastPhase = phase;

  // Decide scene + overlays
  if (phase === "waiting" || phase === "ready") {
    showScene(null, null);
    hideGameCanvas();
    renderWaiting(state);
    return;
  }

  if (phase === "driving") {
    showGameCanvas();
    if (activeScene !== "drive") {
      showScene("drive", state);
    }
    clearOverlay();
    renderStatusBar(state);
    if (state.yourRole === "driver") {
      renderDriverDpad();
      const hint = state.countdownRemainingMs > 0
        ? "Get ready. The car will start moving on its own."
        : "A/← turn left · D/→ turn right · S/↓/space BRAKE · the car drives itself";
      renderHint(hint);
    } else {
      renderMiniMap(state);
      const hint = state.countdownRemainingMs > 0
        ? "Get ready. They can only see two tiles ahead."
        : "Yell directions. They can only see two tiles ahead. The dotted line shows where they'll go.";
      renderHint(hint);
    }
    return;
  }

  if (phase === "crashed") {
    // Keep the drive scene up so the crash effect plays, then show overlay.
    showGameCanvas();
    if (activeScene !== "drive") showScene("drive", state);
    clearOverlay();
    renderStatusBar(state);
    // Slight delay so the shake/flash plays before the modal pops.
    setTimeout(() => {
      // Only render if we're still in crashed phase
      if (store.state?.phase === "crashed") renderCrash(state);
    }, 380);
    return;
  }

  if (phase === "reunion") {
    showGameCanvas();
    if (activeScene !== "reunion") showScene("reunion", state);
    clearOverlay();
    renderStatusBar(state);
    renderReunionDpad();
    renderHint("Walk with arrows / WASD. You see 5×5 around you.");
    return;
  }

  if (phase === "complete") {
    if (state.outcome === "reunited") {
      if (activeScene !== "reunion") showScene("reunion", state);
    } else {
      if (activeScene !== "drive") showScene("drive", state);
    }
    clearOverlay();
    renderStatusBar(state);
    if (prev !== "complete") {
      if (state.outcome === "destination_reached") sfx.win();
      // reunite chime is played by the ReunionScene itself
    }
    const delay = state.outcome === "reunited" ? 1100 : 700;
    setTimeout(() => {
      if (store.state?.phase === "complete") renderComplete(state);
    }, delay);
    return;
  }
}

// Boot
store.subscribe((s) => render(s));
render(null);
