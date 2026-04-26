# The Other Left

A two-player web game for couples about Saturday errands and emotional damage.

One of you drives, the other navigates. Driver only sees a fog cone two tiles ahead — they have the to-do list. Navigator sees the full map — they know where everything is. Hit the errands together, return home before patience runs out. Don't crash. Try not to fight.

> *"You said turn left!"*
> *"I said the OTHER left."*

## Run it locally

```bash
npm install
npm run dev          # server :3000 + Vite :5173
# or, prod-style:
npm run build && npm start
```

Open in two browsers / devices. One creates a room, the other joins with the code (or via the `/room/XXXX` link).

## Smoke test

```bash
npm start          # in one terminal
node smoke-test.js # in another
```

## Stack

Node + Express + Socket.io · Vite + TypeScript + Phaser 3 · in-memory rooms · Render auto-deploy.

For implementation details, gameplay specifics, and tuning knobs see [`CLAUDE.md`](./CLAUDE.md).
