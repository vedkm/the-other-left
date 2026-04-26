import { store } from "../net";
import type { PublicState } from "../types";
import { sfx, isMuted, setMuted } from "../audio";
import {
  turnLeft as gameTurnLeft, turnRight as gameTurnRight,
  pickEndingLine,
} from "../../../shared/game.js";
import type { Direction } from "../../../shared/game";

const overlay = document.getElementById("overlay")!;

export function clearOverlay() {
  overlay.innerHTML = "";
}

function panel(html: string): HTMLDivElement {
  clearOverlay();
  const p = document.createElement("div");
  p.className = "panel center";
  p.innerHTML = html;
  overlay.appendChild(p);
  return p;
}

function showToast(msg: string) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  overlay.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

store.onError((msg) => showToast(msg));

function urlRoomCode(): string | null {
  const m = window.location.pathname.match(/^\/room\/([A-Za-z0-9]{2,8})\/?$/);
  return m ? m[1].toUpperCase() : null;
}

export function renderLanding() {
  const initial = urlRoomCode() ?? "";
  const p = panel(`
    <h1 class="title">The Other Left</h1>
    <p class="tagline">A two-player game about Saturday errands and emotional damage.</p>
    <button class="primary" id="btn-create">Start a Saturday</button>
    <div class="divider"><span>or</span></div>
    <div class="row">
      <input class="code-input" id="code-input" maxlength="4" placeholder="CODE" value="${initial}" />
      <button id="btn-join">Join</button>
    </div>
    <p class="error" id="err"></p>
  `);
  const btnCreate = p.querySelector<HTMLButtonElement>("#btn-create")!;
  const btnJoin   = p.querySelector<HTMLButtonElement>("#btn-join")!;
  const input     = p.querySelector<HTMLInputElement>("#code-input")!;

  btnCreate.addEventListener("click", () => store.createRoom());
  const submit = () => {
    const code = input.value.trim().toUpperCase();
    if (code.length < 2) { input.focus(); return; }
    store.joinRoom(code);
  };
  btnJoin.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  input.focus();

  if (initial.length >= 2) {
    setTimeout(() => store.joinRoom(initial), 150);
  }
}

export function renderWaiting(state: PublicState) {
  const isDriver = state.yourRole === "driver";
  const link = `${window.location.origin}/room/${state.code}`;
  const both = state.partnerConnected;

  const p = panel(`
    <h2 class="subtitle">${both ? "Ready to drive?" : "Waiting for your partner"}</h2>
    <div class="bigcode">${state.code}</div>
    <p class="muted">You are the <strong>${isDriver ? "Driver" : "Navigator"}</strong>${both ? "" : ". Send your partner the code or this link:"}</p>
    ${both ? "" : `<div class="codeblock" id="link">${link}</div>
                   <div class="row"><button id="btn-copy" class="ghost">Copy link</button></div>`}
    ${both ? `<button class="primary" id="btn-start">Start the Saturday</button>` : ""}
  `);

  if (!both) {
    const copy = p.querySelector<HTMLButtonElement>("#btn-copy");
    copy?.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(link); copy.textContent = "Copied!"; setTimeout(() => copy.textContent = "Copy link", 1500); }
      catch { /* ignore */ }
    });
  } else {
    const start = p.querySelector<HTMLButtonElement>("#btn-start")!;
    let clicked = false;
    const trigger = (ev?: Event) => {
      ev?.preventDefault();
      if (clicked) return;
      clicked = true;
      start.textContent = "Starting…";
      store.startGame();
      setTimeout(() => {
        if (store.state?.phase === "ready") {
          clicked = false;
          start.textContent = "Start the Saturday";
        }
      }, 2500);
    };
    start.addEventListener("click", trigger);
    start.addEventListener("pointerdown", trigger);
  }
}

export function renderComplete(state: PublicState) {
  const win = state.outcome === "perfect";
  const [topLine, botLine] = pickEndingLine(win ? "perfect" : "tired");
  const isNewBest = state.score === state.bestScoreThisSession && state.score > 0;
  const errandsDone = state.errands.filter((e) => e.done).length;

  const p = panel(`
    <h2 class="subtitle">${win ? "Perfect Saturday." : "Forget it. Let's go home."}</h2>
    <p class="muted">${escapeHtml(topLine)}<br/>${escapeHtml(botLine)}</p>
    <div class="stats">
      <div class="stat"><div class="stat-num">${state.score}</div><div class="stat-label">SCORE</div></div>
      <div class="stat"><div class="stat-num">${errandsDone}<span class="stat-of">/${state.errands.length}</span></div><div class="stat-label">ERRANDS</div></div>
      <div class="stat"><div class="stat-num">${state.bestCombo}×</div><div class="stat-label">BEST COMBO</div></div>
      <div class="stat"><div class="stat-num">${state.crashes}</div><div class="stat-label">CRASHES</div></div>
    </div>
    ${isNewBest ? `<p class="new-best">★ NEW PERSONAL BEST ★</p>` : `<p class="muted">Best this session: ${state.bestScoreThisSession}</p>`}
    <div class="row">
      <button class="primary" id="btn-restart">Another Saturday</button>
    </div>
  `);
  const restart = p.querySelector<HTMLButtonElement>("#btn-restart")!;
  let clicked = false;
  const trigger = (ev?: Event) => {
    ev?.preventDefault();
    if (clicked) return;
    clicked = true;
    restart.textContent = "Loading…";
    store.restartRound();
    setTimeout(() => {
      if (store.state?.phase === "complete") {
        clicked = false;
        restart.textContent = "Another Saturday";
      }
    }, 2500);
  };
  restart.addEventListener("click", trigger);
  restart.addEventListener("pointerdown", trigger);
}

export function renderDisconnected() {
  const p = panel(`
    <h2 class="subtitle">Partner disconnected.</h2>
    <p class="muted">The vibes are gone.</p>
    <button class="primary" id="btn-back">Back to start</button>
  `);
  p.querySelector<HTMLButtonElement>("#btn-back")!.addEventListener("click", () => {
    history.replaceState({}, "", "/");
    renderLanding();
  });
}

export function renderStatusBar(state: PublicState) {
  const bar = document.createElement("div");
  bar.className = "statusbar";
  const live = state.phase === "driving" || state.phase === "complete";
  const patiencePct = Math.max(0, Math.min(100, (state.patience / state.patienceMax) * 100));
  const patienceColor = patiencePct > 50 ? "#7bd389" : patiencePct > 25 ? "#ffce4d" : "#ff5a5a";

  bar.innerHTML = live
    ? `
      <span class="score-pill">${state.score}</span>
      ${state.combo > 0 ? `<span class="combo-pill">${state.combo}×</span>` : ""}
      <span class="patience-wrap"><span class="patience-bar"><span class="patience-fill" style="width:${patiencePct}%; background:${patienceColor}"></span></span></span>
      <button class="mute-btn" id="btn-mute" title="${isMuted() ? "Unmute" : "Mute"}">${isMuted() ? "🔇" : "🔊"}</button>
    `
    : `
      <span class="role">${state.yourRole === "driver" ? "Driver" : "Navigator"}</span>
      <span class="dot"></span>
      <span class="room-code">${state.code}</span>
      <button class="mute-btn" id="btn-mute" title="${isMuted() ? "Unmute" : "Mute"}">${isMuted() ? "🔇" : "🔊"}</button>
    `;
  overlay.appendChild(bar);
  const m = bar.querySelector<HTMLButtonElement>("#btn-mute");
  m?.addEventListener("click", () => {
    setMuted(!isMuted());
    m.textContent = isMuted() ? "🔇" : "🔊";
    m.title = isMuted() ? "Unmute" : "Mute";
  });
}

export function renderHint(text: string) {
  const h = document.createElement("div");
  h.className = "hintbar";
  h.textContent = text;
  overlay.appendChild(h);
}

// Errand strip: visible to both players. Compact icon list with completion state.
export function renderErrandStrip(state: PublicState) {
  const wrap = document.createElement("div");
  wrap.className = "errand-strip";
  const errandsHtml = state.errands.map((e) => `
    <div class="errand-chip ${e.done ? "done" : ""}" title="${escapeHtml(e.label)}">
      <span class="errand-icon">${e.icon}</span>
      <span class="errand-name">${escapeHtml(e.label)}</span>
    </div>
  `).join("");
  const homeReachable = state.errands.every((e) => e.done);
  wrap.innerHTML = `
    ${errandsHtml}
    ${homeReachable ? `<div class="errand-chip home"><span class="errand-icon">🏠</span><span class="errand-name">Go home!</span></div>` : ""}
  `;
  overlay.appendChild(wrap);
}

const DIR_ARROW: Record<Direction, string> = {
  north: "↑", east: "→", south: "↓", west: "←",
};

export function renderDriverDpad(state: PublicState) {
  const dir = state.car.direction;
  const leftArrow  = DIR_ARROW[gameTurnLeft(dir)];
  const rightArrow = DIR_ARROW[gameTurnRight(dir)];
  const wrap = document.createElement("div");
  wrap.className = "driver-controls";
  wrap.innerHTML = `
    <div class="ctrl-zone left"   data-act="turn_left"  aria-label="Turn left">
      <div class="ctrl-btn"><span class="arrow">${leftArrow}</span><span class="ctrl-label">TURN</span></div>
    </div>
    <div class="ctrl-zone center" data-act="brake"      aria-label="Brake">
      <div class="ctrl-btn brake">BRAKE</div>
    </div>
    <div class="ctrl-zone right"  data-act="turn_right" aria-label="Turn right">
      <div class="ctrl-btn"><span class="arrow">${rightArrow}</span><span class="ctrl-label">TURN</span></div>
    </div>
  `;
  wrap.querySelectorAll<HTMLDivElement>(".ctrl-zone").forEach((zone) => {
    const act = zone.dataset.act as "turn_left" | "turn_right" | "brake";
    const handler = (ev: Event) => {
      ev.preventDefault();
      zone.classList.add("tapped");
      setTimeout(() => zone.classList.remove("tapped"), 150);
      if (act === "brake") sfx.brake();
      else                 sfx.turn();
      store.driverInput(act);
    };
    zone.addEventListener("pointerdown", handler);
  });
  overlay.appendChild(wrap);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!
  ));
}
