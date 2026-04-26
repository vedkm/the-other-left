# The Other Left

Two-player web game for couples. **Errand-date mode**: drive a Saturday errand list together. Driver has limited cone-of-sight + the errand list. Navigator has the full map. Score with combos that escalate speed. Run out of patience and you crash into the couch instead of bake-and-shark.

## Stack

- **Server**: Node 20+ / Express / Socket.io. ESM modules. In-memory rooms (no DB).
- **Client**: Vite + TypeScript + Phaser 3 (`3.90.x`). Mobile-first portrait.
- **Shared**: plain JS module (`shared/game.js`) used by both server and client. `.d.ts` provides TS types for the client side.
- **Hosting**: Render (auto-deploys on push to `main`). `render.yaml` at root configures it.
- **Repo**: https://github.com/vedkm/the-other-left

## Layout

```
the-other-left/
  package.json            # root: server deps + monorepo-ish scripts
  server.js               # Express + Socket.io + game tick loop
  shared/
    game.js               # MAP, ERRAND_POOL, helpers, room factory
    game.d.ts             # types for the client
  client/
    package.json          # Vite + TS + Phaser
    vite.config.ts        # proxy /socket.io → :3000 in dev
    tsconfig.json
    index.html            # mounts #game and #combo-glow and #overlay
    src/
      main.ts             # phase router, scene mounting, polling fallback
      net.ts              # socket.io client + Store + clientId persistence
      audio.ts            # Web Audio synth — engine, combos, crashes, win
      types.ts            # PublicState
      style.css           # all UI CSS
      ui/lobby.ts         # DOM overlays: status bar, errand strip, end screen, controls
      scenes/DriveScene.ts # the only Phaser scene — handles driver + navigator views
  smoke-test.js           # node smoke-test.js — boots two clients, runs through a round
  render.yaml             # Render Blueprint
```

## Running it

| Command | What it does |
|---|---|
| `npm run dev` | Concurrent server (`node --watch server.js`) + Vite dev server (`:5173`, proxies socket to `:3000`). |
| `npm run build` | Builds the client into `client/dist/`. |
| `npm start` | Runs `node server.js` which serves the built client + socket.io. |
| `node smoke-test.js` | Runs the end-to-end socket smoke test. Server must be running on `:3000`. Currently **17/17 ✓**. |

To deploy: just `git push origin main`. Render builds + deploys automatically (~3 min).

## Game mechanics — current state

**Mode**: errand date. Each round rolls 4–5 random errands from `ERRAND_POOL` (17 items: pharmacy, doubles, roti, KFC, ice cream, car wash, ramen, ATM, gas, bug spray, top-up, mango stand, Las Cuevas, Maracas Bay, Maracas lookout, drop-off cousin, coffee). Hit each errand tile, return to home (S), collect bonuses.

**Map**: 12 cols × 18 rows, mostly grid streets with a few `X` hazards on N-S corridors. Start at (0,0) facing south — col 0 is a clean N-S corridor so the car never instant-crashes. Named zones: Arouca / Champs Fleurs / Centre / Coast / Maracas.

**Driver**:
- Sees a fog cone — current tile + 2 ahead in facing direction. Everything else solid black.
- Camera follows the car.
- Controls: 3 full-bottom tap zones (LEFT / BRAKE / RIGHT). Buttons show *screen-relative* arrows (e.g. when going south, LEFT = ←). Keyboard: WASD/arrows/Space.
- Tap-to-turn-and-go: turn = rotate AND step one tile, resetting auto-tick. Feels responsive.

**Navigator**:
- Sees full map with active errand markers (alpha-pulsing rings around emoji icons), home marker, dotted trajectory line projecting where the car is heading.
- No controls — just yells at the driver.

**Driving loop**:
- Auto-tick fires every `tickMsForCombo(combo)` (1000ms base, -40ms per combo level, floor 400ms).
- Each tick: `attemptForward(room)` — moves the car one tile. Walls/`X`/off-map = crash.
- Brake skips next tick AND breaks combo (real cost, not free pause).
- Crashes drain 30 patience, reset combo, brief 1.5s freeze. NOT a phase change.
- Patience drains 1/tick.

**Win/loss**:
- All errands done + return to home → `outcome: "perfect"` → +500 bonus + (patience × 5).
- Patience hits 0 → `outcome: "tired"` → small partial-patience bonus.

**Reunion phase** (between driving-end and the end screen, runs every round):
- Spawns driver + navigator at opposite map corners (Maracas Bay vs home).
- Each player walks independently with 5×5 visibility (`ReunionScene`).
- Score decays at `REUNION_DECAY_PER_SEC` (8/s) while separated — visible "−8/s" pill in HUD.
- Touching = stop the bleed + scaled bonus: `max(50, 500 − elapsedSec × 12)`.
  Faster reunion = bigger bonus.
- Hard timeout `REUNION_TIMEOUT_MS` (60s): no bonus, just finalize.
- Reunion timer pauses when a partner disconnects; resumes on reconnect (the missed time isn't counted).

**Score / combo / juice**:
- +100 per errand × `comboMultiplier(combo)` = `1 + combo * 0.2`.
- Combo callouts: NICE → GREAT → FIRE → ON FIRE! → INSANE → GODLIKE.
- Pitch-rising chord per combo (pentatonic), bass thump at 4+, sparkle at 7+.
- Engine pitch literally rises with combo (`sfx.engineTick(combo)`).
- Screen-edge `#combo-glow` div with 5 escalating tiers (yellow → magenta).
- Combo pill in HUD scales up + tier-colors with level.

## Server architecture

- Sessions identified by **clientId** (UUID in localStorage), NOT socket.id. Survives reconnects with a 30s grace window.
- `clientToSocket` maps the live socket per client. `sessions` maps client → room+role.
- `tickRoom(code)` runs from `setInterval`. Pauses if either player is disconnected.
- `fail(socket, clientId, action, reason)` emits `action_failed` AND resends current state — out-of-sync clients self-heal.
- `request_state` event lets clients poll for state when they suspect they've missed a broadcast (used as a 2s safety-net while in transient phases).

## Client architecture

- `store` (`net.ts`) is the central state cache + emit wrapper. Subscribers in `main.ts` (overlays/scenes) and `DriveScene` (game render).
- `main.ts#render(state)` is the phase router: clears overlays first, then mounts scene + HUD. DOM-cleanup-before-Phaser-swap ordering is intentional — a Phaser exception during transition can't strand a modal.
- `DriveScene` handles BOTH driver and navigator. `isDriver` flag branches behavior (camera follow vs centered, fog vs no-fog, controls vs markers).
- `audio.ts` is hand-rolled Web Audio synth. No asset files. Unlocks on first user gesture (iOS autoplay rules).

## Tuning knobs (in `shared/game.js`)

| Constant | Current | Effect |
|---|---|---|
| `TICK_MS_BASE` | 1000 | starting tick speed |
| `TICK_MS_FLOOR` | 400 | fastest the tick can get |
| `TICK_MS_PER_COMBO` | 40 | how aggressively speed escalates |
| `COMBO_MULT_PER_LEVEL` | 0.2 | score multiplier per combo |
| `PATIENCE_START` | 150 | resource pool |
| `PATIENCE_PER_TICK` | 1 | drain over time |
| `PATIENCE_PER_CRASH` | 30 | crash penalty |
| `POST_CRASH_FREEZE_MS` | 1500 | how long the car freezes after a crash |
| `ERRAND_COUNT_MIN/MAX` | 4 / 5 | how many errands per round |
| `PERFECT_SATURDAY_BONUS` | 500 | bonus for completing all + home |
| `REUNION_DECAY_PER_SEC` | 8 | score bleed per second of reunion |
| `REUNION_BASE_BONUS` | 500 | reunion bonus at 0s (drops 12/s) |
| `REUNION_MIN_BONUS` | 50 | floor for reunion bonus |
| `REUNION_TIMEOUT_MS` | 60000 | reunion auto-times-out without bonus |

## Design decisions worth remembering

- **Tried & rejected**: single-destination MVP map, infinite endless mode, reunion-phase-on-every-crash (replaced with reunion-phase-as-finale), top-down with relative-direction buttons (replaced with screen-direction arrows).
- **Phaser version**: pinned to `^3.80.0`. Phaser 4 dropped the default export and has rough edges; don't auto-upgrade.
- **Mobile-first**: the canvas uses `Phaser.Scale.RESIZE` and fills the viewport. No letterboxing. Tile size auto-fits per viewport. Both portrait + landscape work; portrait is the natural fit.
- **Why Render not Cloudflare**: Cloudflare Pages is serverless, doesn't fit our persistent WebSocket server. Cloudflare Workers + Durable Objects is possible but a full server rewrite. Stick with Render.

## Known issues / next polish

- Sound is hand-rolled synth — works but unprofessional. Real audio assets would be a polish layer.
- No persistence across server restarts — Render's free tier wipes in-memory state. Personal best is session-only.
- No procedural map variation — same 12×18 map every round; only the errand list rolls.
- No road trip / campaign / story arc layered on top yet (was discussed; pending).

## Communication / process

User is **Ved** (github `vedkm`). Wants direct recommendations, not option menus. When he says "go and build" — ship the full vertical slice (server + client + smoke + push) in one push.
