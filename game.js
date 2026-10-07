(() => {
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  const mini = document.getElementById("mini");
  const mctx = mini.getContext("2d");
  const TAU = Math.PI * 2;
  let W = 0, H = 0, WORLD = 3200;

  const keys = Object.create(null);
  const mouse = { x: 0, y: 0, down: false };
  let joy = { active: false, dx: 0, dy: 0 };

  let mode = "menu"; // menu | offline | online
  let ws = null, myId = null, roomId = null;
  let tanksMeta = {}, tankTree = {};
  let players = [], bullets = [], shapes = [];
  let me = null;
  let accountName = null;

  // offline player state
  const offline = {
    name: "Pilot", x: 1600, y: 1600, vx: 0, vy: 0, angle: 0, r: 22,
    hp: 100, maxHp: 100, score: 0, level: 1, xp: 0, xpNeed: 10, upPoints: 0,
    tankId: "basic", color: "#38bdf8", reload: 0,
    stats: { speed: 1, reload: 1, bulletSpeed: 1, bulletDmg: 1, body: 1 },
    alive: true,
  };
  const offBullets = [], offShapes = [], offParticles = [];

  const OFF_TANKS = {
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
  const OFF_TREE = { 1: ["basic"], 15: ["twin", "sniper", "machine", "flank"], 30: ["triple", "quad", "destroyer", "hunter"], 45: ["ranger", "sprayer", "octo"] };

  function resize() { W = canvas.width = innerWidth; H = canvas.height = innerHeight; }
  addEventListener("resize", resize); resize();

  function $(id) { return document.getElementById(id); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function chatLine(text, sys) {
    const d = document.createElement("div");
    if (sys) d.className = "sys";
    d.textContent = text;
    const log = $("chatLog");
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    while (log.children.length > 40) log.removeChild(log.firstChild);
  }

  function syncHudFrom(p) {
    if (!p) return;
    $("score").textContent = p.score | 0;
    $("level").textContent = p.level | 0;
    $("upPoints").textContent = p.upPoints | 0;
    $("players").textContent = mode === "online" ? players.length : 1;
  }

  function showUpgrades(p) {
    const bar = $("upgradeBar");
    if (!p || !p.upPoints) { bar.classList.add("hidden"); return; }
    bar.classList.remove("hidden");
    const row = $("upRow"); row.innerHTML = "";
    ["speed", "reload", "bulletSpeed", "bulletDmg", "body"].forEach((key) => {
      const b = document.createElement("button");
      b.className = "upBtn";
      const val = (p.stats && p.stats[key]) || 1;
      b.textContent = key + " (" + val + ")";
      b.onclick = () => {
        if (mode === "online" && ws?.readyState === 1) ws.send(JSON.stringify({ t: "upgrade", stat: key }));
        else if (mode === "offline" && offline.upPoints > 0) {
          offline.stats[key]++; offline.upPoints--;
          if (key === "body") { offline.maxHp = 100 + offline.level * 6 + offline.stats.body * 12; offline.hp = Math.min(offline.maxHp, offline.hp + 15); }
          syncHudFrom(offline); showUpgrades(offline); showTanks(offline);
        }
      };
      row.appendChild(b);
    });
  }

  function showTanks(p) {
    const bar = $("classBar");
    if (!p) { bar.classList.add("hidden"); return; }
    const tree = mode === "online" ? tankTree : OFF_TREE;
    const meta = mode === "online" ? tanksMeta : Object.fromEntries(Object.entries(OFF_TANKS).map(([k, v]) => [k, { name: v.name, color: v.color }]));
    const available = [];
    Object.entries(tree).forEach(([lvl, list]) => {
      if (p.level >= +lvl) list.forEach((id) => { if (id !== p.tankId) available.push(id); });
    });
    if (!available.length) { bar.classList.add("hidden"); return; }
    bar.classList.remove("hidden");
    const row = $("classRow"); row.innerHTML = "";
    available.forEach((id) => {
      const b = document.createElement("button");
      b.className = "classBtn";
      b.textContent = (meta[id]?.name || id);
      if (meta[id]?.color) b.style.borderColor = meta[id].color;
      b.onclick = () => {
        if (mode === "online" && ws?.readyState === 1) ws.send(JSON.stringify({ t: "tank", id }));
        else if (mode === "offline" && OFF_TANKS[id]) {
          offline.tankId = id; offline.color = OFF_TANKS[id].color; showTanks(offline);
        }
      };
      row.appendChild(b);
    });
  }

  async function api(path, body) {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "Request failed");
    return j;
  }

  async function refreshLeaderboard() {
    try {
      const board = await fetch("/api/leaderboard").then((r) => r.json());
      const box = $("lbList"); box.innerHTML = "";
      board.slice(0, 10).forEach((u, i) => {
        const d = document.createElement("div");
        d.innerHTML = `<span>${i + 1}. ${u.name}</span><span>${u.bestScore}</span>`;
        box.appendChild(d);
      });
    } catch {}
  }

  function wsUrl() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/ws`;
  }

  function connectOnline(opts) {
    $("menuMsg").textContent = "Connecting...";
    ws = new WebSocket(wsUrl());
    ws.onopen = () => {
      mode = "online";
      $("menu").style.display = "none";
      ws.send(JSON.stringify({
        t: "join",
        name: opts.name,
        roomId: opts.roomId || "public",
        roomName: opts.roomName,
        party: !!opts.party,
        tankId: "basic",
      }));
      if (opts.party) setTimeout(() => ws.send(JSON.stringify({ t: "party", name: opts.name + "'s party" })), 100);
    };
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.t === "hello") { tanksMeta = msg.tanks || {}; tankTree = msg.tree || {}; }
      if (msg.t === "joined") { myId = msg.id; roomId = msg.roomId; WORLD = msg.world || 3200; chatLine("Joined " + roomId, true); }
      if (msg.t === "state") {
        players = msg.players || [];
        bullets = msg.bullets || [];
        shapes = msg.shapes || [];
        me = players.find((p) => p.id === myId) || null;
        syncHudFrom(me);
        showUpgrades(me);
        showTanks(me);
        // live room scores on side list merge
        const box = $("lbList");
        if (players.length) {
          box.innerHTML = "";
          [...players].sort((a, b) => b.score - a.score).slice(0, 10).forEach((u, i) => {
            const d = document.createElement("div");
            d.innerHTML = `<span>${i + 1}. ${u.name}</span><span>${u.score}</span>`;
            box.appendChild(d);
          });
        }
      }
      if (msg.t === "chat") chatLine(msg.sys ? msg.text : `${msg.name}: ${msg.text}`, !!msg.sys);
      if (msg.t === "kill") chatLine(`${msg.killer} destroyed ${msg.victim}`, true);
    };
    ws.onclose = () => {
      chatLine("Disconnected", true);
      if (mode === "online") $("menuMsg").textContent = "Disconnected from server";
    };
    ws.onerror = () => { $("menuMsg").textContent = "Server offline — run npm start"; };
  }

  function sendInput() {
    if (mode !== "online" || !ws || ws.readyState !== 1 || !me) return;
    let ix = 0, iy = 0;
    if (keys.KeyW || keys.ArrowUp) iy -= 1;
    if (keys.KeyS || keys.ArrowDown) iy += 1;
    if (keys.KeyA || keys.ArrowLeft) ix -= 1;
    if (keys.KeyD || keys.ArrowRight) ix += 1;
    if (joy.active) { ix += joy.dx; iy += joy.dy; }
    const camX = me.x - W / 2, camY = me.y - H / 2;
    const wx = camX + mouse.x, wy = camY + mouse.y;
    const angle = Math.atan2(wy - me.y, wx - me.x);
    ws.send(JSON.stringify({ t: "input", ix, iy, shoot: mouse.down || keys.Space, angle }));
  }

  // ── Offline helpers ──
  function spawnOffShapes(n) {
    const types = [
      { sides: 4, r: 18, hp: 30, score: 4, color: "#fbbf24" },
      { sides: 3, r: 16, hp: 45, score: 8, color: "#f87171" },
      { sides: 5, r: 26, hp: 90, score: 20, color: "#c084fc" },
    ];
    for (let i = 0; i < n; i++) {
      const t = types[(Math.random() * types.length) | 0];
      offShapes.push({ x: Math.random() * WORLD, y: Math.random() * WORLD, angle: Math.random() * TAU, spin: (Math.random() - 0.5) * 0.02, maxHp: t.hp, ...t });
    }
  }
  function offGrant(n) {
    offline.score += n; offline.xp += n;
    while (offline.xp >= offline.xpNeed) {
      offline.xp -= offline.xpNeed; offline.level++; offline.upPoints++;
      offline.xpNeed = Math.floor(10 + offline.level * 8 + offline.level * offline.level * 0.6);
      offline.maxHp = 100 + offline.level * 6 + offline.stats.body * 12;
      offline.hp = Math.min(offline.maxHp, offline.hp + 20);
    }
    syncHudFrom(offline); showUpgrades(offline); showTanks(offline);
  }
  function offShoot() {
    if (offline.reload > 0 || !offline.alive) return;
    const tank = OFF_TANKS[offline.tankId] || OFF_TANKS.basic;
    const baseSpd = 7.2 * offline.stats.bulletSpeed * (tank.bulletMul || 1);
    const dmg = 12 * offline.stats.bulletDmg * (tank.dmgMul || 1);
    offline.reload = (tank.reload || 14) / offline.stats.reload;
    for (const b of (tank.barrels || [{ a: 0 }])) {
      const a = offline.angle + (b.a || 0) + (tank.spread ? (Math.random() - 0.5) * tank.spread : 0);
      offBullets.push({ x: offline.x + Math.cos(a) * 30, y: offline.y + Math.sin(a) * 30, vx: Math.cos(a) * baseSpd, vy: Math.sin(a) * baseSpd, r: tank.bulletR || 4, life: tank.life || 55, dmg, color: offline.color });
    }
  }
  function updateOffline() {
    let ix = 0, iy = 0;
    if (keys.KeyW || keys.ArrowUp) iy -= 1;
    if (keys.KeyS || keys.ArrowDown) iy += 1;
    if (keys.KeyA || keys.ArrowLeft) ix -= 1;
    if (keys.KeyD || keys.ArrowRight) ix += 1;
    if (joy.active) { ix += joy.dx; iy += joy.dy; }
    const len = Math.hypot(ix, iy) || 1;
    const accel = 0.55 * offline.stats.speed;
    offline.vx += (ix / len) * accel; offline.vy += (iy / len) * accel;
    offline.vx *= 0.9; offline.vy *= 0.9;
    offline.x = clamp(offline.x + offline.vx, offline.r, WORLD - offline.r);
    offline.y = clamp(offline.y + offline.vy, offline.r, WORLD - offline.r);
    offline.angle = Math.atan2(offline.y - (offline.y - (mouse.y - H / 2)) + (mouse.y - H / 2) - offline.y, offline.x + (mouse.x - W / 2) - offline.x);
    // fix aim
    offline.angle = Math.atan2((offline.y + (mouse.y - H / 2)) - offline.y, (offline.x + (mouse.x - W / 2)) - offline.x);
    if (offline.reload > 0) offline.reload--;
    if ((mouse.down || keys.Space) && offline.reload <= 0) offShoot();
    if (offline.hp < offline.maxHp) offline.hp = Math.min(offline.maxHp, offline.hp + 0.04);
    for (let i = offBullets.length - 1; i >= 0; i--) {
      const b = offBullets[i]; b.x += b.vx; b.y += b.vy; b.life--;
      if (b.life <= 0) { offBullets.splice(i, 1); continue; }
      for (let j = offShapes.length - 1; j >= 0; j--) {
        const s = offShapes[j];
        if (Math.hypot(b.x - s.x, b.y - s.y) < b.r + s.r) {
          s.hp -= b.dmg; offBullets.splice(i, 1);
          if (s.hp <= 0) { offGrant(s.score); offShapes.splice(j, 1); spawnOffShapes(1); }
          break;
        }
      }
    }
    for (const s of offShapes) s.angle += s.spin;
  }

  function drawTank(x, y, angle, r, color, tankId) {
    const tank = OFF_TANKS[tankId] || OFF_TANKS.basic;
    ctx.save(); ctx.translate(x, y); ctx.rotate(angle);
    const barrel = (ox, oy, len, wid) => { ctx.fillStyle = "#cbd5e1"; ctx.fillRect(ox, -wid / 2 + oy, len, wid); };
    const barrels = tank.barrels || [{ a: 0 }];
    // simple: draw main forward barrel(s) relative
    if (tankId === "octo" || tankId === "quad") {
      barrels.forEach((b) => {
        ctx.save(); ctx.rotate(b.a || 0); barrel(r * 0.2, 0, r * 1.2, 8); ctx.restore();
      });
    } else if (barrels.length >= 2 && Math.abs((barrels[0].a || 0) - (barrels[1].a || 0)) > 2) {
      barrel(r * 0.2, 0, r * 1.3, 9); ctx.rotate(Math.PI); barrel(r * 0.2, 0, r * 1.3, 9);
    } else if (barrels.length === 2) {
      barrel(r * 0.25, -7, r * 1.25, 8); barrel(r * 0.25, 7, r * 1.25, 8);
    } else if (barrels.length === 3) {
      barrel(r * 0.25, -10, r * 1.2, 7); barrel(r * 0.2, 0, r * 1.35, 8); barrel(r * 0.25, 10, r * 1.2, 7);
    } else {
      barrel(r * 0.2, 0, r * (tank.bulletMul > 1.3 ? 1.7 : 1.3), tank.spread ? 14 : 10);
    }
    ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fillStyle = color; ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = "rgba(0,0,0,0.35)"; ctx.stroke();
    ctx.restore();
  }

  function drawPoly(x, y, r, sides, angle, color) {
    ctx.beginPath();
    for (let i = 0; i < sides; i++) {
      const a = angle + (i / sides) * TAU;
      const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath(); ctx.fillStyle = color; ctx.fill();
  }

  function drawWorld(camX, camY, plist, blist, slist, focus) {
    ctx.clearRect(0, 0, W, H);
    ctx.save(); ctx.translate(-camX, -camY);
    ctx.fillStyle = "#0b1220"; ctx.fillRect(0, 0, WORLD, WORLD);
    ctx.strokeStyle = "rgba(148,163,184,0.08)";
    for (let x = 0; x <= WORLD; x += 80) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, WORLD); ctx.stroke(); }
    for (let y = 0; y <= WORLD; y += 80) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(WORLD, y); ctx.stroke(); }
    ctx.strokeStyle = "rgba(56,189,248,0.25)"; ctx.lineWidth = 4; ctx.strokeRect(2, 2, WORLD - 4, WORLD - 4);
    for (const s of slist) drawPoly(s.x, s.y, s.r, s.sides, s.angle || 0, s.color);
    for (const b of blist) { ctx.beginPath(); ctx.arc(b.x, b.y, b.r || 4, 0, TAU); ctx.fillStyle = b.color || "#fff"; ctx.fill(); }
    for (const p of plist) {
      if (p.alive === false) continue;
      drawTank(p.x, p.y, p.angle, p.r || 22, p.color || "#38bdf8", p.tankId || "basic");
      ctx.fillStyle = "rgba(0,0,0,0.45)"; ctx.fillRect(p.x - 28, p.y - 40, 56, 7);
      ctx.fillStyle = "#22c55e"; ctx.fillRect(p.x - 28, p.y - 40, 56 * (p.hp / (p.maxHp || 100)), 7);
      ctx.fillStyle = "#e2e8f0"; ctx.font = "12px system-ui"; ctx.textAlign = "center";
      ctx.fillText(p.name || "", p.x, p.y - 46);
    }
    ctx.restore();
    // minimap
    mctx.clearRect(0, 0, 120, 120);
    mctx.fillStyle = "rgba(8,15,30,0.9)"; mctx.fillRect(0, 0, 120, 120);
    mctx.fillStyle = "#fbbf24";
    for (const s of slist) mctx.fillRect((s.x / WORLD) * 120 - 1, (s.y / WORLD) * 120 - 1, 2, 2);
    for (const p of plist) {
      if (p.alive === false) continue;
      mctx.fillStyle = p.color || "#38bdf8";
      mctx.beginPath(); mctx.arc((p.x / WORLD) * 120, (p.y / WORLD) * 120, 3, 0, TAU); mctx.fill();
    }
  }

  function loop() {
    if (mode === "online") {
      sendInput();
      const focus = me || { x: WORLD / 2, y: WORLD / 2 };
      drawWorld(focus.x - W / 2, focus.y - H / 2, players, bullets, shapes, focus);
    } else if (mode === "offline") {
      updateOffline();
      drawWorld(offline.x - W / 2, offline.y - H / 2, [offline], offBullets, offShapes, offline);
      syncHudFrom(offline);
    }
    requestAnimationFrame(loop);
  }

  // inputs
  addEventListener("keydown", (e) => {
    keys[e.code] = true;
    if (e.code === "Enter" && mode !== "menu") {
      const inp = $("chatInput");
      if (document.activeElement !== inp) { e.preventDefault(); inp.focus(); }
    }
  });
  addEventListener("keyup", (e) => { keys[e.code] = false; });
  addEventListener("mousemove", (e) => { mouse.x = e.clientX; mouse.y = e.clientY; });
  addEventListener("mousedown", () => { mouse.down = true; });
  addEventListener("mouseup", () => { mouse.down = false; });

  $("chatForm").onsubmit = (e) => {
    e.preventDefault();
    const text = $("chatInput").value.trim();
    $("chatInput").value = "";
    $("chatInput").blur();
    if (!text) return;
    if (mode === "online" && ws?.readyState === 1) ws.send(JSON.stringify({ t: "chat", text }));
    else chatLine("You: " + text);
  };

  // mobile
  const joyBase = $("joyBase"), joyKnob = $("joyKnob");
  function joyHandler(cx, cy) {
    const rect = joyBase.getBoundingClientRect();
    const x0 = rect.left + rect.width / 2, y0 = rect.top + rect.height / 2;
    let dx = cx - x0, dy = cy - y0; const max = 35; const d = Math.hypot(dx, dy) || 1;
    if (d > max) { dx = dx / d * max; dy = dy / d * max; }
    joyKnob.style.left = 35 + dx + "px"; joyKnob.style.top = 35 + dy + "px";
    joy.active = true; joy.dx = dx / max; joy.dy = dy / max;
  }
  joyBase.addEventListener("touchstart", (e) => { e.preventDefault(); joyHandler(e.touches[0].clientX, e.touches[0].clientY); }, { passive: false });
  joyBase.addEventListener("touchmove", (e) => { e.preventDefault(); joyHandler(e.touches[0].clientX, e.touches[0].clientY); }, { passive: false });
  joyBase.addEventListener("touchend", () => { joy.active = false; joy.dx = 0; joy.dy = 0; joyKnob.style.left = "35px"; joyKnob.style.top = "35px"; });
  $("fireBtn").addEventListener("touchstart", (e) => { e.preventDefault(); mouse.down = true; }, { passive: false });
  $("fireBtn").addEventListener("touchend", () => { mouse.down = false; });

  $("loginBtn").onclick = async () => {
    try {
      const name = $("nameInput").value.trim();
      const pass = $("passInput").value;
      const r = await api("/api/login", { name, pass });
      accountName = r.name; $("menuMsg").textContent = "Logged in as " + r.name; $("menuMsg").style.color = "#34d399";
      refreshLeaderboard();
    } catch (e) { $("menuMsg").textContent = e.message; $("menuMsg").style.color = "#f87171"; }
  };
  $("regBtn").onclick = async () => {
    try {
      const name = $("nameInput").value.trim();
      const pass = $("passInput").value;
      await api("/api/register", { name, pass });
      accountName = name; $("menuMsg").textContent = "Registered! Click Login / Play"; $("menuMsg").style.color = "#34d399";
    } catch (e) { $("menuMsg").textContent = e.message; $("menuMsg").style.color = "#f87171"; }
  };
  $("playBtn").onclick = () => {
    const name = accountName || $("nameInput").value.trim() || "Pilot";
    connectOnline({ name, roomId: "public" });
  };
  $("partyBtn").onclick = () => {
    const name = accountName || $("nameInput").value.trim() || "Pilot";
    connectOnline({ name, party: true });
  };
  $("offlineBtn").onclick = () => {
    mode = "offline";
    offline.name = accountName || $("nameInput").value.trim() || "Pilot";
    $("menu").style.display = "none";
    spawnOffShapes(55);
    syncHudFrom(offline);
    chatLine("Offline practice mode", true);
  };

  refreshLeaderboard();
  loop();
})();
