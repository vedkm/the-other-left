# The Other Left

Two-player web game for couples. **Errand-date mode**: drive a Saturday errand list together on a procedurally generated Trinidad-style road map. Driver has fog-of-war + the errand list. Navigator has the full map. Score with combos that escalate speed. Run out of patience and you crash into the couch instead of bake-and-shark.

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
  server.js               # Express + Socket.io + 10Hz tick loop
  shared/
    game.js               # road graph types, chunk authors, stitcher, helpers
    game.d.ts             # types for the client
  client/
    package.json          # Vite + TS + Phaser
    vite.config.ts        # proxy /socket.io → :3000 in dev
    tsconfig.json
    index.html            # mounts #game and #combo-glow and #overlay
    src/
      main.ts             # phase router, scene mounting, polling fallback
      net.ts              # socket.io client + Store + clientId persistence + graph cache
      audio.ts            # Web Audio synth — engine, combos, crashes, win
      types.ts            # PublicState
      style.css           # all UI CSS
      ui/lobby.ts         # DOM overlays: status bar, errand strip, end screen, controls
      scenes/DriveScene.ts # road-graph rendering — driver + navigator views
      scenes/ReunionScene.ts # tile-grid mini-game between driving end and end-screen
  smoke-test.js           # node smoke-test.js — boots two clients, runs through a round
  render.yaml             # Render Blueprint
```

## Running it

| Command | What it does |
|---|---|
| `npm run dev` | Concurrent server (`node --watch server.js`) + Vite dev server (`:5173`, proxies socket to `:3000`). |
| `npm run build` | Builds the client into `client/dist/`. |
| `npm start` | Runs `node server.js` which serves the built client + socket.io. |
| `node smoke-test.js` | Runs the end-to-end socket smoke test. Server must be running on `:3000`. Currently **29/29 ✓**. |

To deploy: just `git push origin main`. Render builds + deploys automatically (~3 min).

## Map model — procedural road graph

**Each round generates a fresh map** so players can't memorize. The map is a directed graph in continuous (px) coordinates, *not* a tile grid.

### Graph shape

- **Nodes**: `{ id, x, y }`. Endpoints + junctions.
- **Edges**: `{ id, fromNode, toNode, lanes (typically 2), polyline (28 sampled points), kind, hazards }`. Each edge has a cubic-Bézier-sampled polyline. The polyline is the *centerline* of the lane bundle; lane offsets render perpendicular to the local tangent.
- **Successors**: `successorByNode` maps each node to its outgoing edges. V1 picks the first; future versions can route by lane to enable filter-junctions where wrong lane = wrong exit.

### Chunk authors (parametric, in `shared/game.js`)

Stitched together top-to-bottom into a column. Each is parametrically randomized so even the same chunk type never produces the same shape twice.

| chunk | purpose |
|---|---|
| `chunkStraight`     | 220-300px straight stretch with a slight bezier wobble. 0-2 random potholes. |
| `chunkHairpin`      | 3 stacked S-curves with alternating swing direction. Hard to drive at high combo without braking. |
| `chunkRoundabout`   | Big roundabout with center palm-tree island. Auto-routes through the loop; visually chaotic. |
| `chunkFilterMerge`  | Hint of a split: lane 1 has hazards (the "longer dirty path"), lane 0 is cleaner. |

The stitcher (`stitchMap(rng)`) picks 4–5 chunks (excluding repeating the same kind back-to-back), translates each chunk's local coords by its vertical offset, generates connector edges between consecutive chunk exit→entry ports, and indexes everything into `nodes/edges/edgesById/successorByNode`.

### Reunion phase keeps a separate grid

Reunion is a tile-based on-foot mini-game with completely different mechanics (5×5 visibility, walk to meet partner). Generated alongside each round as a 12×12 grid (`makeReunionGrid`). Driver and navigator spawn at opposite corners.

## Game mechanics

**Continuous motion**: car has `{ edgeId, t (0..1), lane (float), targetLane (int) }`. Server tick fires every `TICK_MS` (100ms). Each tick the car advances `speed * dt` along the current edge's polyline. When `t >= 1`, transition to the successor edge (driven from `successorByNode`).

**Driver controls**:
- LEFT / RIGHT = lane change (cooldown `LANE_CHANGE_COOLDOWN_MS` = 280ms). Smooth visual swerve toward `targetLane`.
- BRAKE = speed × `BRAKE_FACTOR` for 700ms + breaks combo.
- Keyboard: A/← lane left, D/→ lane right, S/↓/Space brake. (No WASD forward — the car cruises itself.)

**Navigator**: full map view, errand markers + dotted trajectory line projecting where the car is heading along its current lane. No controls.

**Hazards**:
- **Potholes**: `{ t, lane }` on an edge. If the car crosses a pothole's t while in that lane (`|lane - hazard.lane| < 0.6`), -10 patience + combo break. Not counted as a crash.
- **Off-road / dead-end**: car reaches a node with no successor → crash (-30 patience, combo reset, freeze, snap to t=0 on the same edge).

**Errands**: placed at random `{edgeId, t}` positions on non-connector edges. Picked up when the car crosses that t (any lane). Earns `100 × comboMultiplier` and increments combo.

**Win condition**: car reaches the home node (last chunk's exit) with all errands done.

**Speed scaling**:
- `BASE_SPEED = 110 px/sec` at combo 0.
- `+SPEED_PER_COMBO (14)` per combo level, capped at `SPEED_MAX (260)`.
- Brake → multiply by `BRAKE_FACTOR (0.35)`.

**Reunion phase** (unchanged behavior, separate map):
- Spawns at opposite corners of `reunionGrid`. 5×5 visibility, walk to meet.
- Score decays at `REUNION_DECAY_PER_SEC` (8/s). Touching = bonus `max(50, 500 − elapsedSec × 12)`.
- Hard timeout `REUNION_TIMEOUT_MS` (60s).

**Score / combo / juice** (largely unchanged):
- +100 per errand × `comboMultiplier(combo)` = `1 + combo * 0.2`.
- Combo callouts: NICE → GREAT → FIRE → ON FIRE! → INSANE → GODLIKE.
- Engine pitch rises with combo; chord stack per combo level.
- Screen-edge `#combo-glow` div has 5 escalating tiers (yellow → magenta).

## Rendering — DriveScene

Roads are drawn as **curved stroked polylines** in Phaser Graphics, *not* tiles. Layers (back to front):

1. **Grass background**: solid `#6f8554` covering map + 600px margin, sprinkled with darker patches and dirt tints.
2. **Roundabout center islands** (`decoStaticG`): green disk + tiny palm tree silhouette inside each roundabout chunk.
3. **Roads** (`roadStaticG`): drawn in passes — shoulder (light tan), asphalt edge (near-black), asphalt body (dark grey), centerline sheen, outer lane markings (offset polylines), dashed center separator (manual dash walk along arc-length).
4. **Home** marker: pulsing green halo + 🏠 emoji + "HOME" label at `homeNodeId`.
5. **Errand markers**: cream ring + emoji at each errand's cached `(x, y)`.
6. **Pothole hazards**: dark circle with crumbly rim. Filtered against `consumedHazardIds`.
7. **Trajectory line** (navigator only): forward-projected dots along the car's predicted path, traversing successor edges if it overflows the current edge.
8. **Car**: top-down container — drop shadow + body + windshield + rear window + headlights + taillights + brake glow. Rotates to edge tangent.
9. **Fog** (driver only): full-screen black `Rectangle` (0.92 alpha) with an inverted `GeometryMask` that punches a circle around the car + a forward-biased ellipse along the heading.

`update(time, delta)` lerps the rendered car position toward the server-authoritative target each frame for smooth motion between 100ms ticks.

## Server architecture

- Sessions identified by **clientId** (UUID in localStorage), NOT socket.id. Survives reconnects with a 30s grace window.
- `clientToSocket` maps the live socket per client. `sessions` maps client → room+role.
- `tickRoom(code)` runs from `setInterval` at 100ms. Pauses if either player is disconnected.
- **Two new dedicated events** (the graph is too heavy to send in every state update):
  - `graph_pushed`: emits the serialized road graph after every `resetRound` and on session restore.
  - `reunion_grid_pushed`: same for the reunion grid.
  - `state_updated` carries only the lightweight per-tick state.
- `fail(socket, clientId, action, reason)` emits `action_failed` AND resends current state.
- `request_state` event lets clients poll for state when they suspect they've missed a broadcast.

## Client architecture

- `store` (`net.ts`) is the central state cache + emit wrapper. Holds `state` (per-tick), `graph` (the hydrated road graph), and `reunionGrid`. Subscribers in `main.ts` and the scenes.
- `hydrateGraph(serialized)` rebuilds arc-length tables and successor indices client-side (the server strips them before sending).
- `main.ts#render(state)` is the phase router: clears overlays first, then mounts scene + HUD. DOM-cleanup-before-Phaser-swap ordering is intentional. Driving phase waits for `store.graph` before mounting `DriveScene`.
- `DriveScene` reads `store.graph` directly; `ReunionScene` reads `store.reunionGrid`. Both branch on `isDriver` for camera/fog/controls.
- `audio.ts` is hand-rolled Web Audio synth. No asset files. Unlocks on first user gesture (iOS autoplay rules).

## Tuning knobs (in `shared/game.js`)

| Constant | Current | Effect |
|---|---|---|
| `TICK_MS` | 100 | server tick rate |
| `BASE_SPEED` | 110 | px/sec at combo 0 |
| `SPEED_PER_COMBO` | 14 | px/sec added per combo level |
| `SPEED_MAX` | 260 | speed ceiling |
| `BRAKE_FACTOR` | 0.35 | speed multiplier while braking |
| `LANE_CHANGE_COOLDOWN_MS` | 280 | min ms between consecutive lane changes |
| `COMBO_MULT_PER_LEVEL` | 0.2 | score multiplier per combo |
| `PATIENCE_START` | 150 | resource pool |
| `PATIENCE_PER_SECOND` | 1 | drain over time |
| `PATIENCE_PER_POTHOLE` | 10 | pothole hit penalty |
| `PATIENCE_PER_CRASH` | 30 | dead-end crash penalty |
| `POST_CRASH_FREEZE_MS` | 1500 | how long the car freezes after a crash |
| `ERRAND_COUNT_MIN/MAX` | 4 / 5 | how many errands per round |
| `PERFECT_SATURDAY_BONUS` | 500 | bonus for completing all + home |
| `WORLD_W / WORLD_H` | 960 / 1600 | map world bounds |
| `ROAD_LANE_WIDTH` | 22 | px per lane (visual + collision) |
| `FOG_RADIUS` / `FOG_AHEAD` / `FOG_BEHIND` | 130 / 280 / 90 | driver fog window |

## Design decisions worth remembering

- **Why a road graph, not a tile grid**: a grid can't express filter lanes, merges, roundabouts, or hairpins — no amount of pretty graphics fixes that. Procedural chunks + bezier polylines deliver actual road feel.
- **Why parametric chunks instead of templates**: with 4 chunk types you'd memorize the templates after a few rounds. Each chunk randomizes its own dimensions, swing direction, hazard placement, etc. So even a "roundabout chunk" produces a different roundabout each time.
- **Why a separate reunion grid**: reunion is a different mini-game (on-foot, fog-of-war, visibility-radius). Forcing it onto the road graph would muddy both. Keeping a small generated tile grid for reunion only is cleaner.
- **Tried & rejected**: tile-grid driving (boring; "felt like chess"), fixed pre-authored Trinidad map (memorizable in 3 rounds), full procgen with L-systems (generic-looking road soup; chunk-templates produce more intentional shapes).
- **Phaser version**: pinned to `^3.80.0`. Phaser 4 dropped the default export and has rough edges; don't auto-upgrade.
- **Mobile-first**: the canvas uses `Phaser.Scale.RESIZE` and fills the viewport. No letterboxing.
- **Why Render not Cloudflare**: Cloudflare Pages is serverless, doesn't fit our persistent WebSocket server. Cloudflare Workers + Durable Objects is possible but a full server rewrite. Stick with Render.

## Known issues / next polish

- Sound is hand-rolled synth — works but unprofessional. Real audio assets would be a polish layer.
- No persistence across server restarts — Render's free tier wipes in-memory state. Personal best is session-only.
- No road trip / campaign / story arc layered on top yet (was discussed; pending).
- **Lane→exit junction routing not used yet**: the graph supports it but `pickSuccessor` always picks the first outgoing edge. Future iteration: filter-junctions where wrong lane = wrong path.
- More chunk variety wanted: T-junction, multi-lane highway with on-ramps, bridge, town grid.

## Communication / process

User is **Ved** (github `vedkm`). Wants direct recommendations, not option menus. When he says "go and build" — ship the full vertical slice (server + client + smoke + push) in one push.
