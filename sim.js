/* Autonomous Intersection — simulation core (browser + Node).
 * World units: metres, seconds. Right-hand traffic, straight-through routes, 2 lanes per direction.
 * The sim clock only advances when a validated batch of actions is applied (step()).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Sim = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CFG = {
    N: 20,
    carLen: 4.5, carW: 1.9, laneW: 3.5,
    boxHalf: 7,            // intersection box is 14 x 14 m
    stopOff: 9,            // stop line is 9 m from the centre (2 m before the box)
    entry: 95,             // lanes start 95 m from the centre
    vMax: 14,              // m/s (~50 km/h)
    aMax: 3,               // m/s^2 at throttle 1.0
    bMax: 8,               // m/s^2 at brake intensity 1.0
    T: 0.5,                // seconds of sim time per LLM decision tick
    sub: 10,               // physics sub-steps per tick
    sensorRange: 80,
    light: { minGreen: 7, maxGreen: 18, yellow: 3, allRed: 2.5, gapOutDist: 35 }
  };
  const HL = CFG.carLen / 2, HW = CFG.carW / 2;
  const S_STOP = CFG.entry - CFG.stopOff;            // front-bumper s at stop line (86)
  const S_BOX_IN = CFG.entry - CFG.boxHalf;          // 88
  const S_BOX_OUT = CFG.entry + CFG.boxHalf;         // 102
  const S_END = CFG.entry * 2;                       // 190
  const DIRS = ['N', 'S', 'E', 'W'];                 // approach origin (N = comes from north, heads south)
  const PHASE_OF = { N: 'NS', S: 'NS', E: 'EW', W: 'EW' };
  const COLORS = ['#f2c14e', '#5fb3f9', '#f07167', '#7bd389', '#c792ea', '#ff9f43', '#4ecdc4', '#e8e8e8', '#ff6b9d', '#a3be8c'];

  function rng(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  const r1 = x => Math.round(x * 10) / 10;

  // ---------- geometry ----------
  function heading(dir) { return dir === 'N' ? [0, 1] : dir === 'S' ? [0, -1] : dir === 'W' ? [1, 0] : [-1, 0]; }
  function pose(c, sOverride) {
    const off = 1.75 + c.lane * CFG.laneW, s = sOverride != null ? sOverride : c.s;
    switch (c.dir) {
      case 'N': return { x: -off, y: -CFG.entry + s, h: [0, 1] };
      case 'S': return { x: off, y: CFG.entry - s, h: [0, -1] };
      case 'W': return { x: -CFG.entry + s, y: off, h: [1, 0] };
      default:  return { x: CFG.entry - s, y: -off, h: [-1, 0] };
    }
  }
  // axis-aligned half extents in world frame
  function extents(c) { const v = c.dir === 'N' || c.dir === 'S'; return v ? [HW, HL] : [HL, HW]; }

  // ---------- world ----------
  function create(seed) {
    const w = {
      seed: seed || 1, rand: rng(seed || 1), t: 0, tick: 0,
      cars: [], cleared: 0, collisions: 0, collisionLog: [], spawnQueue: [],
      light: { phase: 'NS', state: 'GREEN', timer: 0 },
      redViolations: 0, boxBlocks: 0, stats: { waitTime: 0, speedSum: 0, speedN: 0 }
    };
    const lanes = [];
    DIRS.forEach(d => [0, 1].forEach(l => lanes.push([d, l])));
    for (let i = 0; i < CFG.N; i++) {
      const [d, l] = lanes[i % lanes.length];
      const k = Math.floor(i / lanes.length);
      w.cars.push(newCar(w, i, d, l, 6 + k * 24, 8));
    }
    return w;
  }
  function newCar(w, id, dir, lane, s, v) {
    return { id, dir, lane, s, v, a: 0, active: true, color: COLORS[Math.floor(w.rand() * COLORS.length)], lastAction: 'MAINTAIN', passedLine: false, enteredOn: null, life: 0, wait: 0 };
  }

  // ---------- traffic light controller (infrastructure; may use loop detectors) ----------
  function lightFor(w, dir) {
    const L = w.light;
    if (PHASE_OF[dir] !== L.phase) return 'RED';
    return L.state === 'ALLRED' ? 'RED' : L.state;
  }
  function demand(w, phase, near) {
    return w.cars.filter(c => c.active && PHASE_OF[c.dir] === phase && !c.passedLine && (S_STOP - (c.s + HL)) < near).length;
  }
  function updateLight(w, dt) {
    const L = w.light, C = CFG.light;
    L.timer += dt;
    const other = L.phase === 'NS' ? 'EW' : 'NS';
    if (L.state === 'GREEN') {
      const redDemand = demand(w, other, 60);
      const greenDemand = demand(w, L.phase, C.gapOutDist);
      if (redDemand > 0 && ((L.timer >= C.minGreen && greenDemand === 0) || L.timer >= C.maxGreen)) { L.state = 'YELLOW'; L.timer = 0; }
    } else if (L.state === 'YELLOW' && L.timer >= C.yellow) { L.state = 'ALLRED'; L.timer = 0; }
    else if (L.state === 'ALLRED' && L.timer >= C.allRed) { L.phase = other; L.state = 'GREEN'; L.timer = 0; }
  }

  // ---------- local sensors (relative measurements only) ----------
  function sense(w, c) {
    const p = pose(c), h = p.h, n = [-h[1], h[0]]; // n = left normal in screen coords (y down) -> sign handled below
    const vi = c.v;
    let front = null, rear = null, left = null, right = null;
    for (const o of w.cars) {
      if (o === c || !o.active) continue;
      const q = pose(o);
      const dx = q.x - p.x, dy = q.y - p.y;
      const lon = dx * h[0] + dy * h[1];
      const lat = dx * n[0] + dy * n[1]; // + = right of car (screen y points down)
      const par = (o.dir === 'N' || o.dir === 'S') === (c.dir === 'N' || c.dir === 'S');
      const eLon = par ? HL : HW, eLat = par ? HW : HL;
      const ovx = q.h[0] * o.v, ovy = q.h[1] * o.v;
      const vLon = ovx * h[0] + ovy * h[1];
      if (Math.abs(lat) < HW + eLat + 0.2) {
        if (lon > 0) {
          const gap = lon - HL - eLon;
          if (gap < CFG.sensorRange && (!front || gap < front.gap)) front = { gap, dv: vLon - vi, crossing: !par };
        } else {
          const gap = -lon - HL - eLon;
          if (gap < CFG.sensorRange && (!rear || gap < rear.gap)) rear = { gap, dv: vLon - vi };
        }
      } else if (Math.abs(lat) < HW + eLat + 3.5 && Math.abs(lon) < HL + eLon + 4) {
        const clr = Math.abs(lat) - HW - eLat;
        const rec = { clearance: clr, offset: lon };
        if (lat > 0) { if (!right || clr < right.clearance) right = rec; }
        else if (!left || clr < left.clearance) left = rec;
      }
    }
    const fb = c.s + HL;
    return {
      v: vi, front, rear, left, right,
      signal: lightFor(w, c.dir),
      dLine: S_STOP - fb,
      inBox: (c.s + HL) > S_BOX_IN && (c.s - HL) < S_BOX_OUT,
      dBoxExit: S_BOX_OUT - (c.s - HL)   // distance the rear bumper must travel to leave the box
    };
  }

  // Telemetry packet sent to the LLM for one car. No world coordinates, no map.
  function telemetry(w, c) {
    const s = sense(w, c);
    const pkt = { id: c.id, v: r1(s.v) };
    if (s.front) {
      const lead = Math.max(0, s.v + s.front.dv);
      // safe gap from local readings only: own reaction over one tick + braking difference vs. the lead
      const safe = 3 + s.v * CFG.T + (s.v * s.v) / 12 - (lead * lead) / 16;
      pkt.front = { gap: r1(s.front.gap), dv: r1(s.front.dv), ttc: s.front.dv < -0.05 ? r1(s.front.gap / -s.front.dv) : null, safe: r1(Math.max(3, safe)) };
      if (s.front.crossing) pkt.front.cross = true;
    } else pkt.front = null;
    pkt.rear = s.rear ? { gap: r1(s.rear.gap), dv: r1(s.rear.dv) } : null;
    pkt.left = s.left ? { clr: r1(s.left.clearance), off: r1(s.left.offset) } : null;
    pkt.right = s.right ? { clr: r1(s.right.clearance), off: r1(s.right.offset) } : null;
    pkt.sig = { light: s.signal, d_line: r1(s.dLine), in_box: s.inBox, d_box_exit: r1(s.dBoxExit) };
    if (s.dLine > -0.5 && !s.inBox) {
      pkt.sig.req_decel = r1((s.v * s.v) / (2 * Math.max(0.2, s.dLine - 1)));
      // can this car still stop before the line, judged from its own speed and the signal sensor?
      pkt.sig.can_stop = s.v < 0.3 ? 'STOPPED' : (s.v * s.v) / 8 <= s.dLine - 0.5 ? 'COMFORT' : (s.v * s.v) / 16 <= s.dLine - 0.3 ? 'HARD' : 'NO';
    }
    pkt.stop = { comfort: r1(s.v * s.v / 8), max: r1(s.v * s.v / 16) }; // stopping distance at 4 and 8 m/s^2
    return pkt;
  }
  function telemetryAll(w) { return w.cars.filter(c => c.active).map(c => telemetry(w, c)); }

  // ---------- actions -> acceleration (physical limits, no instant stop) ----------
  function accelFor(act) {
    if (!act) return 0;
    if (act.action === 'ACCELERATE') return CFG.aMax * clamp01(act.throttle ?? 0.5);
    if (act.action === 'BRAKE') return -CFG.bMax * clamp01(act.intensity ?? 0.5);
    return 0;
  }
  const clamp01 = x => Math.max(0, Math.min(1, +x || 0));

  // ---------- collisions ----------
  function overlap(a, b) {
    const pa = pose(a), pb = pose(b), ea = extents(a), eb = extents(b);
    return Math.abs(pa.x - pb.x) < ea[0] + eb[0] && Math.abs(pa.y - pb.y) < ea[1] + eb[1];
  }

  // ---------- step: apply one validated batch of actions for T seconds ----------
  function beginTick(w, actions) {
    const byId = new Map(actions.map(a => [a.id, a]));
    for (const c of w.cars) if (c.active) { const a = byId.get(c.id); c.a = accelFor(a); c.lastAction = a ? a.action : 'MAINTAIN'; c.lastCmd = a; }
    w._sub = 0;
  }
  function subStep(w, hooks) {
    const dt = CFG.T / CFG.sub;
    const touching = w._touching || (w._touching = new Set());
    updateLight(w, dt);
    for (const c of w.cars) {
      if (!c.active) continue;
      c.sPrev = c.s;
      const beforeLine = c.s + HL <= S_STOP;
      const lightNow = lightFor(w, c.dir);
      c.v = Math.max(0, Math.min(CFG.vMax, c.v + c.a * dt));
      c.s += c.v * dt;
      c.life += dt;
      if (c.v < 0.5) c.wait += dt;
      if (beforeLine && c.s + HL > S_STOP) { c.passedLine = true; c.enteredOn = lightNow; if (lightNow === 'RED') w.redViolations++; }
    }
    // collision detection (counting only — never overrides the LLM's commands)
    const act = w.cars.filter(c => c.active);
    for (let i = 0; i < act.length; i++) for (let j = i + 1; j < act.length; j++) {
      const key = act[i].id + '-' + act[j].id;
      if (overlap(act[i], act[j])) {
        if (!touching.has(key)) { touching.add(key); w.collisions++; w.collisionLog.push({ t: r1(w.t), a: act[i].id, b: act[j].id }); act[i].crashed = act[j].crashed = true; hooks && hooks.onCollision && hooks.onCollision(act[i], act[j]); }
      } else touching.delete(key);
    }
    w.t += dt;
    w._sub++;
  }
  function endTick(w) {
    // exits & respawns (environment bookkeeping, not driving control)
    for (const c of w.cars) {
      if (c.active && c.s - HL > S_END) { c.active = false; w.cleared++; w.spawnQueue.push(c.id); w.stats.waitTime += c.wait; }
    }
    trySpawn(w);
    for (const c of w.cars) { c.sPrev = c.s; if (c.active) { w.stats.speedSum += c.v; w.stats.speedN++; } }
    w.tick++;
  }
  // Apply one validated batch of actions for T seconds of sim time.
  function step(w, actions, hooks) {
    beginTick(w, actions);
    for (let k = 0; k < CFG.sub; k++) subStep(w, hooks);
    endTick(w);
  }

  function trySpawn(w) {
    if (!w.spawnQueue.length) return;
    const lanes = [];
    DIRS.forEach(d => [0, 1].forEach(l => lanes.push([d, l])));
    // shuffle deterministically
    for (let i = lanes.length - 1; i > 0; i--) { const j = Math.floor(w.rand() * (i + 1)); [lanes[i], lanes[j]] = [lanes[j], lanes[i]]; }
    for (const [d, l] of lanes) {
      if (!w.spawnQueue.length) break;
      const inLane = w.cars.filter(c => c.active && c.dir === d && c.lane === l);
      const last = inLane.reduce((m, c) => (!m || c.s < m.s ? c : m), null);
      const gap = last ? last.s - HL - (HL + HL) : 999; // gap from a new car centred at s=HL
      if (gap < 22) continue;
      const v = Math.min(9, last ? Math.max(0, last.v + (gap > 40 ? 3 : 0)) : 9);
      const id = w.spawnQueue.shift();
      const c = w.cars[id];
      Object.assign(c, newCar(w, id, d, l, HL, last && gap < 40 ? Math.min(v, last.v) : v));
    }
  }

  // ---------- baseline (non-LLM) policy, used only for comparison & environment testing ----------
  function baselinePolicy(w) {
    return telemetryAll(w).map(p => {
      const v = p.v, T = CFG.T;
      let target = 3; // desired accel
      if (v > 12.5) target = 0;
      if (p.front) {
        const lead = Math.max(0, v + p.front.dv);
        const need = v * T + (v * v) / (2 * 6) - (lead * lead) / (2 * 8) + 3;
        if (p.front.gap < need) target = Math.min(target, -8 * Math.min(1, (need - p.front.gap) / 6 + 0.4));
        else if (p.front.gap < need + 8) target = Math.min(target, 0);
      }
      const s = p.sig;
      if (!s.in_box && s.d_line > -0.5) {
        const must = s.light === 'RED' || (s.light === 'YELLOW' && p.stop.comfort + v * T <= s.d_line + 1);
        const blocked = p.front && p.front.gap < s.d_box_exit + 2 && (v + p.front.dv) < 3;
        if (must || blocked) {
          const d = Math.max(0.1, s.d_line - 1);
          const req = (v * v) / (2 * d);
          if (d < v * T + p.stop.comfort + 4) target = Math.min(target, -Math.min(8, Math.max(req * 1.2, v < 0.3 ? 0 : 2)));
          if (d < 1.5) target = Math.min(target, v > 0 ? -8 : 0);
        }
      }
      if (target > 0.05) return { id: p.id, action: 'ACCELERATE', throttle: r1(Math.min(1, target / 3)) };
      if (target < -0.05) return { id: p.id, action: 'BRAKE', intensity: r1(Math.min(1, -target / 8)) };
      return { id: p.id, action: 'MAINTAIN' };
    });
  }

  return { CFG, create, step, beginTick, subStep, endTick, telemetry, telemetryAll, pose, extents, lightFor, baselinePolicy, consts: { S_STOP, S_BOX_IN, S_BOX_OUT, S_END, HL, HW } };
});
