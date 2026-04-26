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
          start.textContent = "Start game";
        }
      }, 2500);
    };
    start.addEventListener("click", trigger);
    start.addEventListener("pointerdown", trigger);
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
    <p class="error" id="find-err"></p>
  `);
  const find = p.querySelector<HTMLButtonElement>("#btn-find")!;
  const err  = p.querySelector<HTMLParagraphElement>("#find-err")!;
  let clicked = false;

  // Listen for server failure reasons specific to this action.
  const offFail = store.onActionFailed(({ action, reason }) => {
    if (action !== "begin_reunion") return;
    clicked = false;
    find.textContent = "Find each other";
    err.textContent = `Server said: ${reason}`;
  });

  const trigger = (ev?: Event) => {
    ev?.preventDefault();
    if (clicked) return;
    clicked = true;
    find.textContent = "Finding…";
    err.textContent = "";
    if (!store.connected) {
      err.textContent = "Not connected to server. Reconnecting…";
      clicked = false;
      find.textContent = "Find each other";
      return;
    }
    store.beginReunion();
    setTimeout(() => {
      if (store.state?.phase === "crashed") {
        clicked = false;
        find.textContent = "Find each other";
        if (!err.textContent) err.textContent = "No response from server. Tap again.";
      }
    }, 3000);
  };
  find.addEventListener("click", trigger);
  find.addEventListener("pointerdown", trigger);
  // Clean up the failure listener when this modal is replaced.
  const observer = new MutationObserver(() => {
    if (!document.contains(p)) { offFail(); observer.disconnect(); }
  });
  observer.observe(document.body, { childList: true, subtree: true });
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
        restart.textContent = "Play again";
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
  // Three big thumb-sized zones across the bottom third of the screen.
  // Tap anywhere within a zone to trigger its action — no aiming required.
  const wrap = document.createElement("div");
  wrap.className = "driver-controls";
  wrap.innerHTML = `
    <div class="ctrl-zone left"   data-act="turn_left"  aria-label="Turn left">
      <div class="ctrl-btn"><span class="arrow">←</span><span class="ctrl-label">LEFT</span></div>
    </div>
    <div class="ctrl-zone center" data-act="brake"      aria-label="Brake">
      <div class="ctrl-btn brake">BRAKE</div>
    </div>
    <div class="ctrl-zone right"  data-act="turn_right" aria-label="Turn right">
      <div class="ctrl-btn"><span class="arrow">→</span><span class="ctrl-label">RIGHT</span></div>
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
    // pointerdown for instant response; covers touch + mouse + pen.
    zone.addEventListener("pointerdown", handler);
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
