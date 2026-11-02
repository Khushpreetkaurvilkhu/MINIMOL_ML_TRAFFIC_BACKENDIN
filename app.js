(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const { CFG, consts: K } = Sim;
  const SUB_MS = (CFG.T * 1000) / CFG.sub; // real ms per physics sub-step at 1x

  const S = {
    mode: 'replay', playing: false, speed: 1, world: null, inTick: false, acc: 0, waiting: false,
    lastPrompt: '', lastRaw: '', lastActions: null, selected: 0, latencies: [], calls: 0, firstTryOk: 0, decisions: 0,
    events: [], wallStart: 0, wallMs: 0, abort: null, stepOnce: false, crashT: 0, lastPhase: ''
  };
  const REC = window.REPLAY || null;

  // ---------- canvas ----------
  const cv = $('#world'), ctx = cv.getContext('2d');
  let px = 1, size = 600;
  const VIEW = 60; // metres from centre to canvas edge
  function resize() {
    const r = cv.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
    size = r.width; cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); px = size / (2 * VIEW);
  }
  new ResizeObserver(() => { resize(); draw(); }).observe(cv);
  const W = (x, y) => [(x + VIEW) * px, (y + VIEW) * px];

  function drawRoads() {
    const rw = 7; // road half width (2 lanes each way)
    ctx.fillStyle = '#10161a'; ctx.fillRect(0, 0, size, size);
    // subtle verge pattern
    ctx.fillStyle = '#141b20';
    for (let i = 0; i < 4; i++) {
      const [qx, qy] = [i % 2 ? 1 : -1, i < 2 ? -1 : 1];
      const [x0, y0] = W(qx > 0 ? rw + 3 : -100, qy > 0 ? rw + 3 : -100);
      ctx.fillRect(x0, y0, (100 - rw - 3) * px, (100 - rw - 3) * px);
    }
    ctx.fillStyle = '#262a30';
    let [x, y] = W(-rw, -100); ctx.fillRect(x, y, 2 * rw * px, 200 * px);
    [x, y] = W(-100, -rw); ctx.fillRect(x, y, 200 * px, 2 * rw * px);
    // kerbs
    ctx.strokeStyle = '#3a4048'; ctx.lineWidth = Math.max(1, 0.35 * px);
    ctx.beginPath();
    for (const s of [-1, 1]) {
      line(s * rw, -100, s * rw, -rw); line(s * rw, rw, s * rw, 100);
      line(-100, s * rw, -rw, s * rw); line(rw, s * rw, 100, s * rw);
    }
    ctx.stroke();
    // centre double yellow
    ctx.strokeStyle = '#c99a2e'; ctx.lineWidth = Math.max(1, 0.18 * px);
    ctx.beginPath();
    for (const o of [-0.25, 0.25]) { line(o, -100, o, -9); line(o, 9, o, 100); line(-100, o, -9, o); line(9, o, 100, o); }
    ctx.stroke();
    // lane dividers (dashed)
    ctx.strokeStyle = 'rgba(230,235,240,.38)'; ctx.setLineDash([3 * px, 4 * px]); ctx.lineWidth = Math.max(1, 0.15 * px);
    ctx.beginPath();
    for (const o of [-3.5, 3.5]) { line(o, -100, o, -9); line(o, 9, o, 100); line(-100, o, -9, o); line(9, o, 100, o); }
    ctx.stroke(); ctx.setLineDash([]);
    // stop lines (approach side only)
    ctx.strokeStyle = '#e9edf1'; ctx.lineWidth = Math.max(1.5, 0.45 * px);
    ctx.beginPath();
    line(-7, -9, 0, -9);   // southbound (from N) uses x<0
    line(0, 9, 7, 9);      // northbound (from S)
    line(-9, 0, -9, 7);    // eastbound (from W) uses y>0
    line(9, -7, 9, 0);     // westbound (from E)
    ctx.stroke();
    // box "keep clear" hatching
    ctx.save();
    const [bx, by] = W(-7, -7); ctx.beginPath(); ctx.rect(bx, by, 14 * px, 14 * px); ctx.clip();
    ctx.strokeStyle = 'rgba(245,184,61,.10)'; ctx.lineWidth = Math.max(1, 0.25 * px);
    ctx.beginPath(); for (let k = -14; k <= 14; k += 2) line(-7 + k, -7, 7 + k, 7); ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = 'rgba(245,184,61,.35)'; ctx.lineWidth = 1; ctx.strokeRect(bx, by, 14 * px, 14 * px);
    // direction labels
    ctx.fillStyle = '#4a545e'; ctx.font = `600 ${Math.max(9, 2.6 * px)}px "JetBrains Mono"`; ctx.textAlign = 'center';
    ctx.fillText('N', ...W(10, -VIEW + 3)); ctx.fillText('S', ...W(-10, VIEW - 2)); ctx.fillText('W', ...W(-VIEW + 3, -9)); ctx.fillText('E', ...W(VIEW - 3, 10));
  }
  function line(x0, y0, x1, y1) { const [a, b] = W(x0, y0), [c, d] = W(x1, y1); ctx.moveTo(a, b); ctx.lineTo(c, d); }

  // traffic light heads: placed on the right kerb just before each stop line
  const HEADS = { N: [-9.6, -11, 'v'], S: [9.6, 11, 'v'], W: [-11, 9.6, 'h'], E: [11, -9.6, 'h'] };
  function drawLights(w) {
    for (const d of ['N', 'S', 'E', 'W']) {
      const st = Sim.lightFor(w, d);
      const [x, y, o] = HEADS[d];
      const [cx, cy] = W(x, y);
      const r = Math.max(2.2, 0.85 * px), g = r * 2.5;
      const lamps = ['RED', 'YELLOW', 'GREEN'];
      const flip = d === 'S' || d === 'E'; // order lamps red-first from the driver's view
      ctx.fillStyle = '#0a0d10'; ctx.strokeStyle = '#3a4250'; ctx.lineWidth = 1;
      const wBox = o === 'v' ? r * 2.8 : g * 3, hBox = o === 'v' ? g * 3 : r * 2.8;
      roundRect(cx - wBox / 2, cy - hBox / 2, wBox, hBox, r); ctx.fill(); ctx.stroke();
      lamps.forEach((L, i) => {
        const k = (flip ? 2 - i : i) - 1;
        const lx = o === 'v' ? cx : cx + k * g, ly = o === 'v' ? cy + k * g : cy;
        const on = st === L, col = L === 'RED' ? '#ff5a4e' : L === 'YELLOW' ? '#f5b83d' : '#37d67a';
        if (on) { ctx.shadowColor = col; ctx.shadowBlur = r * 4; }
        ctx.fillStyle = on ? col : 'rgba(255,255,255,.07)';
        ctx.beginPath(); ctx.arc(lx, ly, r, 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur = 0;
      });
    }
  }
  function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

  function carPose(c, f) {
    const s = c.sPrev != null && S.inTick ? c.sPrev + (c.s - c.sPrev) * f : c.s;
    return Sim.pose(c, s);
  }
  function drawCars(w, f) {
    const L = CFG.carLen * px, Wd = CFG.carW * px;
    for (const c of w.cars) {
      if (!c.active) continue;
      const p = carPose(c, f), [x, y] = W(p.x, p.y);
      const ang = Math.atan2(p.h[1], p.h[0]);
      ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
      if (S.selected === c.id) { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5; roundRect(-L / 2 - 3, -Wd / 2 - 3, L + 6, Wd + 6, 4); ctx.stroke(); }
      ctx.fillStyle = 'rgba(0,0,0,.35)'; roundRect(-L / 2 + 1, -Wd / 2 + 1.5, L, Wd, Wd * 0.3); ctx.fill();
      ctx.fillStyle = c.crashed ? '#ff2d2d' : c.color; roundRect(-L / 2, -Wd / 2, L, Wd, Wd * 0.3); ctx.fill();
      ctx.fillStyle = 'rgba(10,14,18,.55)'; roundRect(L * 0.05, -Wd * 0.36, L * 0.22, Wd * 0.72, 2); ctx.fill(); // windshield
      ctx.fillStyle = 'rgba(10,14,18,.35)'; roundRect(-L * 0.38, -Wd * 0.33, L * 0.14, Wd * 0.66, 2); ctx.fill();
      if (c.lastAction === 'BRAKE') { ctx.fillStyle = '#ff3b30'; ctx.shadowColor = '#ff3b30'; ctx.shadowBlur = 6; ctx.fillRect(-L / 2 - 0.5, -Wd / 2 + 1, 2, Wd * 0.28); ctx.fillRect(-L / 2 - 0.5, Wd / 2 - 1 - Wd * 0.28, 2, Wd * 0.28); ctx.shadowBlur = 0; }
      ctx.restore();
      if (px > 4) { ctx.fillStyle = '#0b0e11'; ctx.font = `600 ${Math.max(8, 1.25 * px)}px "JetBrains Mono"`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(c.id), x, y + 0.5); }
    }
  }
  function drawSensors(w, f) {
    if (!$('#chkSensors').checked) return;
    const c = w.cars[S.selected]; if (!c || !c.active) return;
    const pk = Sim.telemetry(w, c), p = carPose(c, f), h = p.h;
    const fwd = (d, lat) => W(p.x + h[0] * d - h[1] * lat, p.y + h[1] * d + h[0] * lat);
    const HL = CFG.carLen / 2;
    ctx.save();
    // front beam
    const fl = pk.front ? pk.front.gap : CFG.sensorRange;
    const danger = pk.front && pk.front.gap < pk.front.safe;
    ctx.fillStyle = danger ? 'rgba(255,90,78,.18)' : 'rgba(95,179,249,.12)';
    ctx.beginPath(); const a = fwd(HL, -1.15), b = fwd(HL + fl, -1.15), cc = fwd(HL + fl, 1.15), d = fwd(HL, 1.15);
    ctx.moveTo(...a); ctx.lineTo(...b); ctx.lineTo(...cc); ctx.lineTo(...d); ctx.fill();
    ctx.strokeStyle = danger ? '#ff5a4e' : '#5fb3f9'; ctx.lineWidth = 1.2; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(...fwd(HL, 0)); ctx.lineTo(...fwd(HL + fl, 0)); ctx.stroke();
    // rear beam
    if (pk.rear) { ctx.strokeStyle = 'rgba(199,146,234,.8)'; ctx.beginPath(); ctx.moveTo(...fwd(-HL, 0)); ctx.lineTo(...fwd(-HL - pk.rear.gap, 0)); ctx.stroke(); }
    ctx.setLineDash([]);
    // side zones
    for (const [side, sign] of [['left', -1], ['right', 1]]) {
      const hit = pk[side];
      ctx.fillStyle = hit ? 'rgba(245,184,61,.28)' : 'rgba(255,255,255,.04)';
      ctx.beginPath(); const s0 = fwd(-HL - 2, sign * 1.1), s1 = fwd(HL + 2, sign * 1.1), s2 = fwd(HL + 2, sign * 4.4), s3 = fwd(-HL - 2, sign * 4.4);
      ctx.moveTo(...s0); ctx.lineTo(...s1); ctx.lineTo(...s2); ctx.lineTo(...s3); ctx.fill();
    }
    // stop-line distance marker
    if (pk.sig.d_line > 0 && !pk.sig.in_box) {
      const col = pk.sig.light === 'RED' ? '#ff5a4e' : pk.sig.light === 'YELLOW' ? '#f5b83d' : '#37d67a';
      ctx.strokeStyle = col; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(...fwd(HL + pk.sig.d_line, -1.6)); ctx.lineTo(...fwd(HL + pk.sig.d_line, 1.6)); ctx.stroke();
    }
    ctx.restore();
  }
  function draw() {
    const w = S.world; if (!w) return;
    const f = S.inTick ? Math.min(1, S.acc / SUB_MS) : 1;
    drawRoads(); drawSensors(w, f); drawCars(w, f); drawLights(w);
  }

  // ---------- decisions ----------
  async function getDecision() {
    const w = S.world;
    const packets = Sim.telemetryAll(w);
    S.lastPrompt = LLM.buildUserPrompt(w.tick, packets);
    if (S.mode === 'baseline') { S.lastRaw = '(rule baseline: no LLM call)'; return { actions: Sim.baselinePolicy(w), latency: null }; }
    if (S.mode === 'replay') {
      const rec = REC && REC.ticks[w.tick];
      if (!rec) return null;
      S.lastRaw = JSON.stringify({ actions: rec.actions });
      S.calls += rec.repaired ? 2 : 1;
      return { actions: rec.actions, latency: rec.latency, repaired: rec.repaired };
    }
    // live
    const cfg = { base: $('#inBase').value.trim(), model: $('#inModel').value.trim(), key: $('#inKey').value.trim(), jsonMode: $('#chkJson').checked };
    if (!cfg.base || !cfg.model) throw new Error('Set a base URL and model first');
    S.abort = new AbortController();
    S.waiting = true; $('#waiting').hidden = false;
    try {
      const r = await LLM.decide(cfg, w.tick, packets, { signal: S.abort.signal });
      S.calls += r.calls; S.lastRaw = r.raw;
      return r;
    } finally { S.waiting = false; $('#waiting').hidden = true; }
  }

  async function startTick() {
    if (S.inTick || S.waiting) return;
    let d;
    try { d = await getDecision(); }
    catch (e) {
      if (e.name === 'AbortError') return;
      S.lastRaw = 'ERROR: ' + e.message;
      log(`<b>LLM error</b> ${esc(e.message.slice(0, 140))} — sim clock held, nothing moved`, true);
      pause(); showBanner('LLM call failed: ' + e.message.slice(0, 120), true);
      renderInspector(); return;
    }
    if (!d) { pause(); showBanner(`End of recorded LLM run (${REC ? REC.ticks.length : 0} ticks). Press Reset to replay.`, false); return; }
    S.decisions++; if (!d.repaired) S.firstTryOk++;
    if (d.latency != null) S.latencies.push(d.latency);
    S.lastActions = d.actions;
    Sim.beginTick(S.world, d.actions);
    S.inTick = true; S.acc = 0;
    if (S.mode === 'live' && S.world.tick + 1 >= +$('#inMaxTicks').value) { S.autoPauseAt = S.world.tick + 1; }
    renderHUD(); renderInspector();
  }

  function finishTick() {
    const w = S.world;
    const before = w.cleared;
    Sim.endTick(w);
    S.inTick = false;
    if (w.cleared > before) log(`<b>+${w.cleared - before}</b> cleared (total ${w.cleared})`);
    if (S.stepOnce) { S.stepOnce = false; pause(); }
    if (S.autoPauseAt && w.tick >= S.autoPauseAt) { S.autoPauseAt = null; pause(); showBanner('Auto-paused to protect your API quota. Press Play to continue.', false); }
    renderHUD(); renderInspector();
  }

  // ---------- loop ----------
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(100, now - last); last = now;
    if (S.playing) {
      S.wallMs += dt;
      if (!S.inTick) startTick();
      if (S.inTick) {
        S.acc += dt * S.speed;
        while (S.inTick && S.acc >= SUB_MS) {
          S.acc -= SUB_MS;
          const prevPhase = S.world.light.phase + S.world.light.state;
          Sim.subStep(S.world, { onCollision: (a, b) => { log(`<b>COLLISION</b> car ${a.id} × car ${b.id} at t=${S.world.t.toFixed(1)} s`, true); showBanner(`Collision: car ${a.id} and car ${b.id}. Run failed.`, true); pause(); } });
          const ph = S.world.light.phase + S.world.light.state;
          if (ph !== prevPhase) log(`signal ${S.world.light.phase} → <b>${S.world.light.state}</b>`);
          if (S.world._sub >= CFG.sub) finishTick();
        }
      }
    }
    draw();
    if (S.playing || S.inTick) renderHUDLight();
    requestAnimationFrame(frame);
  }

  function play() { if (S.playing) return; hideBanner(); S.playing = true; $('#btnPlay').textContent = 'Pause'; }
  function pause() { S.playing = false; $('#btnPlay').textContent = 'Play'; }
  $('#btnPlay').onclick = () => S.playing ? pause() : (S.mode === 'live' && !$('#inKey').value.trim() && !/localhost|127\.0\.0\.1/.test($('#inBase').value) ? showBanner('Paste an API key in Live LLM settings first.', false) : play());
  $('#btnStep').onclick = () => { if (S.inTick || S.waiting) return; S.stepOnce = true; play(); };
  $('#btnReset').onclick = reset;
  document.querySelectorAll('.speed button').forEach(b => b.onclick = () => { S.speed = +b.dataset.speed; document.querySelectorAll('.speed button').forEach(x => x.classList.toggle('on', x === b)); });
  $('#chkSensors').onchange = draw;

  function reset() {
    if (S.abort) S.abort.abort();
    pause(); hideBanner();
    const seed = REC && S.mode === 'replay' ? REC.seed : (REC ? REC.seed : 7);
    S.world = Sim.create(seed);
    Object.assign(S, { inTick: false, acc: 0, waiting: false, latencies: [], calls: 0, firstTryOk: 0, decisions: 0, events: [], wallMs: 0, lastActions: null, lastRaw: '', autoPauseAt: null });
    $('#waiting').hidden = true;
    S.lastPrompt = LLM.buildUserPrompt(0, Sim.telemetryAll(S.world));
    log('world reset · seed ' + seed);
    renderHUD(); renderInspector(); draw();
  }

  // ---------- modes ----------
  document.querySelectorAll('.modes button').forEach(b => b.onclick = () => {
    S.mode = b.dataset.mode;
    document.querySelectorAll('.modes button').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', String(x === b)); });
    $('#livePanel').hidden = S.mode !== 'live';
    reset();
  });
  const sel = $('#selProvider');
  Object.entries(LLM.PRESETS).forEach(([k, p]) => { const o = document.createElement('option'); o.value = k; o.textContent = p.label; sel.appendChild(o); });
  sel.onchange = () => { const p = LLM.PRESETS[sel.value]; $('#inBase').value = p.base; $('#inModel').value = p.model; };
  sel.value = 'groq'; sel.onchange();

  // ---------- selection ----------
  cv.addEventListener('click', e => {
    const r = cv.getBoundingClientRect();
    const wx = (e.clientX - r.left) / px - VIEW, wy = (e.clientY - r.top) / px - VIEW;
    let best = null, bd = 6;
    for (const c of S.world.cars) { if (!c.active) continue; const p = Sim.pose(c); const d = Math.hypot(p.x - wx, p.y - wy); if (d < bd) { bd = d; best = c; } }
    if (best) { S.selected = best.id; setTab('car'); draw(); }
  });

  // ---------- HUD ----------
  function renderHUDLight() {
    const w = S.world;
    $('#vTick').textContent = w.tick; $('#vTime').textContent = w.t.toFixed(1) + ' s';
    const L = w.light; $('#vSignal').innerHTML = `<span class="sigchip ${L.state === 'ALLRED' ? 'RED' : L.state}">${L.phase} ${L.state === 'ALLRED' ? 'ALL-RED' : L.state}</span>`;
  }
  function renderHUD() {
    const w = S.world;
    renderHUDLight();
    $('#vCollisions').textContent = w.collisions;
    $('#hCollisions').className = 'h-card big ' + (w.collisions ? 'bad' : 'ok');
    $('#hCollisions .d').textContent = w.collisions ? 'run failed' : 'must stay 0 ✓';
    const lat = S.latencies;
    if (lat.length) {
      const cur = lat[lat.length - 1], avg = lat.reduce((a, b) => a + b, 0) / lat.length;
      const p95 = [...lat].sort((a, b) => a - b)[Math.floor(lat.length * 0.95)];
      $('#vLatency').textContent = Math.round(cur);
      $('#dLatency').textContent = `avg ${Math.round(avg)} · p95 ${Math.round(p95)}${S.mode === 'replay' ? ' · recorded' : ''}`;
      const pts = lat.slice(-60), mx = Math.max(...pts, 1);
      $('#latSpark').innerHTML = `<polyline fill="none" stroke="#f5b83d" stroke-width="1.5" points="${pts.map((v, i) => `${(i / Math.max(1, pts.length - 1)) * 200},${27 - (v / mx) * 25}`).join(' ')}"/>`;
    } else { $('#vLatency').textContent = S.mode === 'baseline' ? 'n/a' : '—'; $('#dLatency').textContent = S.mode === 'baseline' ? 'no LLM in baseline mode' : 'avg — · p95 —'; $('#latSpark').innerHTML = ''; }
    $('#vCleared').textContent = w.cleared;
    $('#dThroughput').textContent = w.t > 5 ? `${(w.cleared / w.t * 60).toFixed(1)} veh/min (sim time)` : '— veh/min';
    $('#vCalls').textContent = S.mode === 'baseline' ? '0' : `${S.calls}`;
    $('#vValid').textContent = S.decisions && S.mode !== 'baseline' ? `${Math.round(S.firstTryOk / S.decisions * 100)}%` : '—';
    $('#vRed').textContent = w.redViolations;
    $('#modelLine').textContent = S.mode === 'replay' ? (REC ? `Source: recorded run · model ${REC.model} · ${REC.ticks.length} ticks · ${REC.recordedAt.slice(0, 10)}` : 'No recording loaded') : S.mode === 'live' ? `Source: live · ${$('#inModel').value}` : 'Source: hand-written rule policy (comparison only, no LLM)';
  }

  // ---------- inspector ----------
  let tab = 'car';
  function setTab(t) { tab = t; document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t)); renderInspector(); }
  document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => setTab(b.dataset.tab));
  function renderInspector() {
    const w = S.world, body = $('#tabBody');
    if (tab === 'car') {
      const c = w.cars[S.selected];
      if (!c || !c.active) { body.innerHTML = '<p class="empty">Selected car has left the scene. Click another car.</p>'; return; }
      const pk = Sim.telemetry(w, c);
      const a = S.lastActions && S.lastActions.find(x => x.id === c.id);
      const cmd = a ? `<span class="act ${a.action}">${a.action}${a.throttle != null ? ' ' + a.throttle : ''}${a.intensity != null ? ' ' + a.intensity : ''}</span>` : '<span class="empty">no command yet</span>';
      body.innerHTML = `
        <div class="lbl">Car ${c.id} · last LLM command</div><div>${cmd}</div>
        <div class="lbl">What the LLM sees for this car (local sensors only — no x/y, no map)</div>
        <dl class="kv">
          <dt>speed</dt><dd>${pk.v} m/s</dd>
          <dt>front</dt><dd>${pk.front ? `gap ${pk.front.gap} m · Δv ${pk.front.dv} · safe ${pk.front.safe} m${pk.front.ttc != null ? ' · ttc ' + pk.front.ttc + ' s' : ''}${pk.front.cross ? ' · CROSSING' : ''}` : 'clear (80 m)'}</dd>
          <dt>rear</dt><dd>${pk.rear ? `gap ${pk.rear.gap} m · Δv ${pk.rear.dv}` : 'clear'}</dd>
          <dt>left</dt><dd>${pk.left ? `clr ${pk.left.clr} m · off ${pk.left.off} m` : 'clear'}</dd>
          <dt>right</dt><dd>${pk.right ? `clr ${pk.right.clr} m · off ${pk.right.off} m` : 'clear'}</dd>
          <dt>signal</dt><dd><span class="sigchip ${pk.sig.light}">${pk.sig.light}</span> · line ${pk.sig.d_line} m${pk.sig.in_box ? ' · IN BOX' : ''}${pk.sig.req_decel != null ? ' · need ' + pk.sig.req_decel + ' m/s²' : ''}</dd>
          <dt>stopping</dt><dd>${pk.stop.comfort} m comfort · ${pk.stop.max} m max</dd>
        </dl>
        <div class="lbl">Raw packet</div><pre>${esc(JSON.stringify(pk))}</pre>`;
    } else if (tab === 'prompt') {
      body.innerHTML = `<div class="lbl">User message for tick ${w.tick} (${S.lastPrompt.length.toLocaleString()} chars · sent in ONE request)</div><pre>${esc(S.lastPrompt)}</pre><div class="lbl">System prompt</div><pre>${esc(LLM.SYSTEM_PROMPT)}</pre>`;
    } else if (tab === 'resp') {
      let pretty = S.lastRaw;
      try { const o = LLM.extractJSON(S.lastRaw); pretty = JSON.stringify(o.actions || o).replace(/},{/g, '},\n{'); } catch (e) { /* show raw */ }
      body.innerHTML = `<div class="lbl">${S.mode === 'replay' ? 'Recorded LLM output for this tick' : 'Latest LLM output'} · validated: every active id present, actions in schema</div><pre>${esc(pretty || '—')}</pre>`;
    } else {
      body.innerHTML = S.events.length ? `<ul class="log">${S.events.slice(-80).reverse().map(e => `<li class="${e.bad ? 'bad' : ''}">${e.t} ${e.h}</li>`).join('')}</ul>` : '<p class="empty">No events yet.</p>';
    }
  }
  function log(h, bad) { S.events.push({ t: (S.world ? S.world.t : 0).toFixed(1).padStart(6) + 's', h, bad }); if (tab === 'log') renderInspector(); }
  function showBanner(t, bad) { const b = $('#banner'); b.textContent = t; b.className = 'banner' + (bad ? '' : ' info'); b.hidden = false; }
  function hideBanner() { $('#banner').hidden = true; }

  // refresh the car tab a few times per second while running
  setInterval(() => { if (S.playing && tab === 'car') renderInspector(); }, 250);

  if (!REC) { document.querySelector('[data-mode=replay]').disabled = true; }
  resize(); reset();
  requestAnimationFrame(frame);
})();
