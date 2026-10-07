/**
 * TankVortex.io multiplayer server
 * Run: npm install && npm start
 * Open: http://localhost:3000
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const express = require("express");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const WORLD = 3200;
const TICK_MS = 50; // 20 TPS

const app = express();
app.use(express.json({ limit: "32kb" }));
app.use(express.static(__dirname));

const DATA_FILE = path.join(__dirname, "data.json");
function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return { users: {}, leaderboard: [] };
  }
}
function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}
const db = loadData();

// ── Simple accounts ──────────────────────────────────────────
app.post("/api/register", (req, res) => {
  const name = String(req.body.name || "").trim().slice(0, 16);
  const pass = String(req.body.pass || "").slice(0, 64);
  if (name.length < 2 || pass.length < 3)
    return res.status(400).json({ error: "Name min 2, pass min 3 chars" });
  const key = name.toLowerCase();
  if (db.users[key]) return res.status(400).json({ error: "Name taken" });
  db.users[key] = { name, pass, bestScore: 0, games: 0, created: Date.now() };
  saveData();
  res.json({ ok: true, name });
});

app.post("/api/login", (req, res) => {
  const name = String(req.body.name || "").trim().slice(0, 16);
  const pass = String(req.body.pass || "").slice(0, 64);
  const u = db.users[name.toLowerCase()];
  if (!u || u.pass !== pass) return res.status(401).json({ error: "Invalid login" });
  res.json({ ok: true, name: u.name, bestScore: u.bestScore });
});

app.get("/api/leaderboard", (_req, res) => {
  const board = Object.values(db.users)
    .map((u) => ({ name: u.name, bestScore: u.bestScore || 0, games: u.games || 0 }))
    .sort((a, b) => b.bestScore - a.bestScore)
    .slice(0, 50);
  res.json(board);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// ── Rooms / parties ──────────────────────────────────────────
const rooms = new Map(); // roomId -> Room

function makeId() {
  return Math.random().toString(36).slice(2, 9);
}

class Room {
  constructor(id, name, isParty = false) {
    this.id = id;
    this.name = name;
    this.isParty = isParty;
    this.clients = new Map(); // ws -> player
    this.shapes = [];
    this.bullets = [];
    this.chat = [];
    this.spawnShapes(50);
  }

  spawnShapes(n) {
    const types = [
      { sides: 4, r: 18, hp: 30, score: 4, color: "#fbbf24" },
      { sides: 3, r: 16, hp: 45, score: 8, color: "#f87171" },
      { sides: 5, r: 26, hp: 90, score: 20, color: "#c084fc" },
    ];
    for (let i = 0; i < n; i++) {
      const t = types[(Math.random() * types.length) | 0];
      this.shapes.push({
        id: makeId(),
        x: Math.random() * WORLD,
        y: Math.random() * WORLD,
        angle: Math.random() * Math.PI * 2,
        spin: (Math.random() - 0.5) * 0.02,
        maxHp: t.hp,
        ...t,
      });
    }
  }

  addPlayer(ws, name, tankId) {
    const p = {
      id: makeId(),
      name: name || "Pilot",
      x: WORLD / 2 + (Math.random() - 0.5) * 400,
      y: WORLD / 2 + (Math.random() - 0.5) * 400,
      vx: 0, vy: 0,
      angle: 0,
      r: 22,
      hp: 100, maxHp: 100,
      score: 0, level: 1, xp: 0, xpNeed: 10, upPoints: 0,
      tankId: tankId || "basic",
      stats: { speed: 1, reload: 1, bulletSpeed: 1, bulletDmg: 1, body: 1 },
      reload: 0,
      input: { ix: 0, iy: 0, shoot: false, angle: 0 },
      color: "#38bdf8",
      alive: true,
    };
    this.clients.set(ws, p);
    return p;
  }

  removePlayer(ws) {
    const p = this.clients.get(ws);
    if (!p) return;
    // save score
    const key = p.name.toLowerCase();
    if (db.users[key]) {
      db.users[key].bestScore = Math.max(db.users[key].bestScore || 0, p.score);
      db.users[key].games = (db.users[key].games || 0) + 1;
      saveData();
    }
    this.clients.delete(ws);
  }

  broadcast(obj, except = null) {
    const raw = JSON.stringify(obj);
    for (const [ws] of this.clients) {
      if (ws !== except && ws.readyState === 1) ws.send(raw);
    }
  }

  tick() {
    const players = [...this.clients.values()];

    for (const p of players) {
      if (!p.alive) continue;
      const { ix, iy, shoot, angle } = p.input;
      const len = Math.hypot(ix, iy) || 1;
      const accel = 0.55 * p.stats.speed;
      p.vx += (ix / len) * accel;
      p.vy += (iy / len) * accel;
      p.vx *= 0.9; p.vy *= 0.9;
      p.x = Math.max(p.r, Math.min(WORLD - p.r, p.x + p.vx));
      p.y = Math.max(p.r, Math.min(WORLD - p.r, p.y + p.vy));
      p.angle = angle;
      if (p.reload > 0) p.reload--;
      if (p.hp < p.maxHp) p.hp = Math.min(p.maxHp, p.hp + 0.04);

      if (shoot && p.reload <= 0) {
        const tank = TANKS[p.tankId] || TANKS.basic;
        const baseSpd = 7.2 * p.stats.bulletSpeed * (tank.bulletMul || 1);
        const dmg = 12 * p.stats.bulletDmg * (tank.dmgMul || 1);
        p.reload = (tank.reload || 14) / p.stats.reload;
        const barrels = tank.barrels || [{ a: 0 }];
        for (const b of barrels) {
          const a = p.angle + (b.a || 0) + (tank.spread ? (Math.random() - 0.5) * tank.spread : 0);
          this.bullets.push({
            id: makeId(),
            owner: p.id,
            x: p.x + Math.cos(a) * (p.r + 8),
            y: p.y + Math.sin(a) * (p.r + 8),
            vx: Math.cos(a) * baseSpd,
            vy: Math.sin(a) * baseSpd,
            r: tank.bulletR || 4,
            life: tank.life || 55,
            dmg,
            color: p.color,
          });
        }
      }
    }

    // bullets
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      b.x += b.vx; b.y += b.vy; b.life--;
      if (b.life <= 0 || b.x < 0 || b.y < 0 || b.x > WORLD || b.y > WORLD) {
        this.bullets.splice(i, 1);
        continue;
      }
      // hit shapes
      let hit = false;
      for (let j = this.shapes.length - 1; j >= 0; j--) {
        const s = this.shapes[j];
        if (Math.hypot(b.x - s.x, b.y - s.y) < b.r + s.r) {
          s.hp -= b.dmg;
          this.bullets.splice(i, 1);
          hit = true;
          if (s.hp <= 0) {
            const owner = players.find((p) => p.id === b.owner);
            if (owner) this.grantScore(owner, s.score);
            this.shapes.splice(j, 1);
            this.spawnShapes(1);
          }
          break;
        }
      }
      if (hit) continue;
      // hit players
      for (const p of players) {
        if (!p.alive || p.id === b.owner) continue;
        if (Math.hypot(b.x - p.x, b.y - p.y) < b.r + p.r) {
          p.hp -= b.dmg / Math.max(1, p.stats.body * 0.4);
          this.bullets.splice(i, 1);
          if (p.hp <= 0) {
            p.alive = false;
            const killer = players.find((x) => x.id === b.owner);
            if (killer) this.grantScore(killer, 25 + Math.floor(p.score * 0.1));
            this.broadcast({ t: "kill", killer: killer?.name || "?", victim: p.name });
            setTimeout(() => {
              p.alive = true;
              p.hp = p.maxHp;
              p.x = WORLD / 2 + (Math.random() - 0.5) * 600;
              p.y = WORLD / 2 + (Math.random() - 0.5) * 600;
              p.score = Math.floor(p.score * 0.5);
            }, 1500);
          }
          break;
        }
      }
    }

    // shape spin + body collision light
    for (const s of this.shapes) s.angle += s.spin;

    // snapshot
    const snap = {
      t: "state",
      players: players.map((p) => ({
        id: p.id, name: p.name, x: p.x, y: p.y, angle: p.angle,
        hp: p.hp, maxHp: p.maxHp, score: p.score, level: p.level,
        tankId: p.tankId, color: p.color, alive: p.alive, upPoints: p.upPoints,
      })),
      bullets: this.bullets.map((b) => ({
        id: b.id, x: b.x, y: b.y, r: b.r, color: b.color,
      })),
      shapes: this.shapes.map((s) => ({
        id: s.id, x: s.x, y: s.y, r: s.r, sides: s.sides,
        angle: s.angle, color: s.color, hp: s.hp, maxHp: s.maxHp,
      })),
    };
    this.broadcast(snap);
  }

  grantScore(p, n) {
    p.score += n;
    p.xp += n;
    while (p.xp >= p.xpNeed) {
      p.xp -= p.xpNeed;
      p.level++;
      p.upPoints++;
      p.xpNeed = Math.floor(10 + p.level * 8 + p.level * p.level * 0.6);
      p.maxHp = 100 + p.level * 6 + p.stats.body * 12;
      p.hp = Math.min(p.maxHp, p.hp + 20);
    }
  }
}

// Tank tree (original names)
const TANKS = {
  basic: { name: "Basic", reload: 14, barrels: [{ a: 0 }], color: "#38bdf8" },
  twin: { name: "Twin", reload: 12, barrels: [{ a: -0.12 }, { a: 0.12 }], color: "#60a5fa" },
  sniper: { name: "Sniper", reload: 22, bulletMul: 1.35, dmgMul: 1.4, life: 90, bulletR: 5, barrels: [{ a: 0 }], color: "#34d399" },
  machine: { name: "Machine", reload: 7, dmgMul: 0.7, spread: 0.28, barrels: [{ a: 0 }], color: "#f59e0b" },
  flank: { name: "Flank", reload: 14, barrels: [{ a: 0 }, { a: Math.PI }], color: "#a78bfa" },
  triple: { name: "Triple", reload: 13, barrels: [{ a: -0.18 }, { a: 0 }, { a: 0.18 }], color: "#22d3ee" },
  quad: { name: "Quad", reload: 16, barrels: [{ a: 0 }, { a: Math.PI / 2 }, { a: Math.PI }, { a: -Math.PI / 2 }], color: "#fb7185" },
  destroyer: { name: "Destroyer", reload: 28, dmgMul: 2.2, bulletR: 9, life: 45, barrels: [{ a: 0 }], color: "#ef4444" },
  hunter: { name: "Hunter", reload: 18, bulletMul: 1.2, dmgMul: 1.2, barrels: [{ a: 0 }], color: "#4ade80" },
  ranger: { name: "Ranger", reload: 26, bulletMul: 1.5, dmgMul: 1.5, life: 110, bulletR: 5, barrels: [{ a: 0 }], color: "#86efac" },
  sprayer: { name: "Sprayer", reload: 6, dmgMul: 0.55, spread: 0.4, barrels: [{ a: 0 }], color: "#fbbf24" },
  octo: { name: "Octo", reload: 18, barrels: [0,1,2,3,4,5,6,7].map((i) => ({ a: (i * Math.PI) / 4 })), color: "#c084fc" },
};

const TANK_TREE = {
  1: ["basic"],
  15: ["twin", "sniper", "machine", "flank"],
  30: ["triple", "quad", "destroyer", "hunter"],
  45: ["ranger", "sprayer", "octo"],
};

// default public room
rooms.set("public", new Room("public", "Public Arena"));

wss.on("connection", (ws) => {
  let room = null;
  let player = null;

  ws.send(JSON.stringify({
    t: "hello",
    tanks: Object.fromEntries(Object.entries(TANKS).map(([k, v]) => [k, { name: v.name, color: v.color }])),
    tree: TANK_TREE,
    rooms: [...rooms.values()].map((r) => ({ id: r.id, name: r.name, players: r.clients.size, party: r.isParty })),
  }));

  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    if (msg.t === "join") {
      const roomId = msg.roomId || "public";
      if (!rooms.has(roomId)) rooms.set(roomId, new Room(roomId, msg.roomName || roomId, !!msg.party));
      room = rooms.get(roomId);
      player = room.addPlayer(ws, msg.name, msg.tankId || "basic");
      const tank = TANKS[player.tankId];
      if (tank) player.color = tank.color;
      ws.send(JSON.stringify({ t: "joined", id: player.id, roomId: room.id, world: WORLD }));
      room.broadcast({ t: "chat", sys: true, text: `${player.name} joined` });
      return;
    }

    if (!room || !player) return;

    if (msg.t === "input") {
      player.input.ix = Math.max(-1, Math.min(1, +msg.ix || 0));
      player.input.iy = Math.max(-1, Math.min(1, +msg.iy || 0));
      player.input.shoot = !!msg.shoot;
      player.input.angle = +msg.angle || 0;
    }

    if (msg.t === "upgrade" && player.upPoints > 0 && player.stats[msg.stat] != null) {
      player.stats[msg.stat]++;
      player.upPoints--;
      if (msg.stat === "body") {
        player.maxHp = 100 + player.level * 6 + player.stats.body * 12;
        player.hp = Math.min(player.maxHp, player.hp + 15);
      }
    }

    if (msg.t === "tank") {
      const needLevel = Object.entries(TANK_TREE).find(([, list]) => list.includes(msg.id));
      if (needLevel && player.level >= +needLevel[0] && TANKS[msg.id]) {
        player.tankId = msg.id;
        player.color = TANKS[msg.id].color;
      }
    }

    if (msg.t === "chat") {
      const text = String(msg.text || "").slice(0, 80);
      if (!text) return;
      room.broadcast({ t: "chat", name: player.name, text });
    }

    if (msg.t === "party") {
      const pid = "party-" + makeId();
      rooms.set(pid, new Room(pid, msg.name || `${player.name}'s party`, true));
      // move player
      room.removePlayer(ws);
      room = rooms.get(pid);
      player = room.addPlayer(ws, player.name, player.tankId);
      ws.send(JSON.stringify({ t: "joined", id: player.id, roomId: room.id, world: WORLD, party: true }));
      room.broadcast({ t: "chat", sys: true, text: `Party ${room.name} created` });
    }
  });

  ws.on("close", () => {
    if (room) {
      const n = player?.name;
      room.removePlayer(ws);
      if (n) room.broadcast({ t: "chat", sys: true, text: `${n} left` });
      if (room.isParty && room.clients.size === 0 && room.id !== "public") rooms.delete(room.id);
    }
  });
});

setInterval(() => {
  for (const room of rooms.values()) {
    if (room.clients.size) room.tick();
  }
}, TICK_MS);

server.listen(PORT, () => {
  console.log(`TankVortex.io running → http://localhost:${PORT}`);
  console.log(`WebSocket → ws://localhost:${PORT}/ws`);
});
