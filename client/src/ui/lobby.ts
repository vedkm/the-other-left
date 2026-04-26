import { store } from "../net";
import type { PublicState } from "../types";
import { sfx, isMuted, setMuted } from "../audio";

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

// Wire global toast handler once.
store.onError((msg) => showToast(msg));

// Re-derive landing if URL has /room/CODE.
function urlRoomCode(): string | null {
  const m = window.location.pathname.match(/^\/room\/([A-Za-z0-9]{2,8})\/?$/);
  return m ? m[1].toUpperCase() : null;
}

export function renderLanding() {
  const initial = urlRoomCode() ?? "";
  const p = panel(`
    <h1 class="title">The Other Left</h1>
    <p class="tagline">A two-player game about trust, directions, and emotional damage.</p>
    <button class="primary" id="btn-create">Create a room</button>
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

  // If we landed on /room/CODE, auto-join after a tick once socket is ready.
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
                   <div class="row">
                     <button id="btn-copy" class="ghost">Copy link</button>
                   </div>`}
    ${both ? `<button class="primary" id="btn-start">Start game</button>` : ""}
  `);

  if (!both) {
    const copy = p.querySelector<HTMLButtonElement>("#btn-copy");
    copy?.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(link); copy.textContent = "Copied!"; setTimeout(() => copy.textContent = "Copy link", 1500); }
      catch { /* ignore */ }
    });
  } else {
    const start = p.querySelector<HTMLButtonElement>("#btn-start")!;
    start.addEventListener("click", () => store.startGame());
  }
}

export function renderCrash(state: PublicState) {
  const arg = state.argument ?? ["Things were said.", "Things were misheard."];
  const p = panel(`
    <h2 class="subtitle">You crashed.</h2>
    <div class="argument">
      <p><span class="speaker">Driver:</span>${escapeHtml(arg[0])}</p>
      <p><span class="speaker">Navigator:</span>${escapeHtml(arg[1])}</p>
    </div>
    <p class="muted">You have been separated.</p>
    <button class="primary" id="btn-find">Find each other</button>
  `);
  const find = p.querySelector<HTMLButtonElement>("#btn-find")!;
  find.addEventListener("click", () => store.beginReunion());
}

export function renderComplete(state: PublicState) {
  const win = state.outcome === "destination_reached";
  const p = panel(`
    <h2 class="subtitle">${win ? "You made it." : "Reunited."}</h2>
    <p class="muted">${win
      ? "Relationship survived the drive."
      : "You found each other again. Honestly, that is also a win."}</p>
    <div class="row">
      <button class="primary" id="btn-restart">Play again</button>
    </div>
  `);
  const restart = p.querySelector<HTMLButtonElement>("#btn-restart")!;
  restart.addEventListener("click", () => store.restartRound());
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
  const distHtml = (state.phase === "driving" || state.phase === "crashed")
    ? `<span class="dot"></span><span>Distance <strong>${state.distance}</strong></span>`
    : "";
  const brakeHtml = (state.phase === "driving" && state.braking)
    ? `<span class="dot"></span><span class="brake-indicator">BRAKING ${state.brakeTicks}</span>`
    : "";
  bar.innerHTML = `
    <span class="role">${state.yourRole === "driver" ? "Driver" : "Navigator"}</span>
    <span class="dot"></span>
    <span>Room <span class="room-code">${state.code}</span></span>
    ${distHtml}
    ${brakeHtml}
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

export function renderDriverDpad() {
  const wrap = document.createElement("div");
  wrap.className = "dpad-wrap driver-dpad";
  wrap.innerHTML = `
    <button data-act="turn_left"  data-sfx="turn"  title="Turn left (A / Left)">↺</button>
    <button data-act="brake"      data-sfx="brake" class="brake" title="Brake (S / Down / Space)">BRAKE</button>
    <button data-act="turn_right" data-sfx="turn"  title="Turn right (D / Right)">↻</button>
  `;
  wrap.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
    b.addEventListener("click", () => {
      const act = b.dataset.act as "forward" | "turn_left" | "turn_right" | "brake";
      const cue = b.dataset.sfx;
      if (cue === "turn") sfx.turn();
      else if (cue === "brake") sfx.brake();
      store.driverInput(act);
    });
  });
  overlay.appendChild(wrap);
}

export function renderReunionDpad() {
  const wrap = document.createElement("div");
  wrap.className = "dpad-wrap";
  wrap.innerHTML = `
    <button data-act="left">◀</button>
    <button data-act="up">▲</button>
    <button data-act="down">▼</button>
    <button data-act="right">▶</button>
  `;
  wrap.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
    b.addEventListener("click", () => {
      const act = b.dataset.act as "up" | "down" | "left" | "right";
      sfx.step();
      store.reunionInput(act);
    });
  });
  overlay.appendChild(wrap);
}

export function renderMiniMap(state: PublicState) {
  // Tiny "you are here" chip on the navigator, showing how far the car has driven
  if (state.yourRole !== "navigator") return;
  const total = 25; // approximate path length on mvp map
  const progress = Math.min(1, state.distance / total);
  const chip = document.createElement("div");
  chip.className = "minimap-chip";
  chip.innerHTML = `
    <div class="meter"><div class="meter-fill" style="width:${Math.round(progress * 100)}%"></div></div>
    <div class="meter-label">${state.distance} tiles · ${Math.round(progress * 100)}% to ★</div>
  `;
  overlay.appendChild(chip);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!
  ));
}
