/* LLM batch controller: builds ONE prompt for all cars, calls ONE API request, validates strict JSON. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LLM = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SYSTEM_PROMPT = `You are the driving controller for a fleet of autonomous cars at a signalized 4-way intersection.
Each car sees ONLY its own local sensors (no map, no coordinates). In ONE pass, decide the control command for EVERY car for the next tick.

PHYSICS
- Tick = 0.5 s. Your command is held for the whole tick. Speed limit 14 m/s, speed never below 0 (no reverse).
- ACCELERATE throttle t in [0,1] -> +3*t m/s^2. BRAKE intensity i in [0,1] -> -8*i m/s^2. MAINTAIN -> 0 m/s^2.
- Cars cannot stop instantly: plan ahead. Car length 4.5 m.

TELEMETRY FIELDS (per car)
v: own speed m/s.
front: vehicle directly ahead {gap: bumper-to-bumper m, dv: its speed minus mine (negative = closing), ttc: time to collision s, safe: minimum safe gap m for my current speed, cross: true if it is crossing traffic inside the box}. null = clear for 80 m.
rear: vehicle behind {gap, dv}. left/right: adjacent-lane vehicle {clr: lateral clearance m, off: longitudinal offset m}. (Informational; lane changes are not allowed.)
sig: {light: signal facing my lane RED|YELLOW|GREEN, d_line: distance from my front bumper to the stop line (negative = already past it), in_box: I am inside the intersection box, d_box_exit: distance my rear bumper must travel to clear the box, req_decel: deceleration m/s^2 needed to stop 1 m before the line, can_stop: COMFORT (can stop at <=4 m/s^2) | HARD (only with up to 8 m/s^2) | NO (physically cannot stop before the line) | STOPPED}.
stop: {comfort: stopping distance at 4 m/s^2, max: stopping distance at 8 m/s^2}.

RULES (apply all, then pick the MOST restrictive command)
R1 Following: if front.cross is true -> BRAKE 1.0. If front.gap < front.safe -> BRAKE with intensity = min(1, 0.4 + (front.safe - front.gap)/6). If front.gap < front.safe + 8 -> do not ACCELERATE (MAINTAIN).
R2 Red light (in_box false and d_line > -0.5):
   If can_stop is NO -> you cannot stop before the line any more: continue through (MAINTAIN, or ACCELERATE 0.5). Do NOT brake for the light; braking would leave you in the box.
   If v < 0.3 -> MAINTAIN (stay stopped; never ACCELERATE on RED).
   Else if d_line < 1.5 -> BRAKE 1.0.
   Else if d_line < v*0.5 + stop.comfort + 5 -> BRAKE with intensity = clamp(req_decel*1.25/8, 0.3, 1).
   Else MAINTAIN if v > 8, otherwise approach slowly (ACCELERATE 0.3).
R3 Yellow dilemma (in_box false, d_line > -0.5): decide ONLY from can_stop.
   can_stop COMFORT or STOPPED -> treat exactly as RED (stop before the line).
   can_stop HARD or NO -> past the point of no return: GO through (MAINTAIN or ACCELERATE 1.0). Never brake for the light once committed; never stop inside the box.
R4 Don't block the box: if in_box is false, d_line > -0.5 and front exists with front.gap < d_box_exit + 2 and (v + front.dv) < 3 -> treat as RED.
R5 In the box (in_box true): keep moving, never stop there unless R1 forces it.
R6 Otherwise cruise: if v < 12.5 -> ACCELERATE throttle 1.0; else MAINTAIN.

OUTPUT
Return ONLY a JSON object, no prose, no markdown:
{"actions":[{"id":0,"action":"ACCELERATE","throttle":0.8},{"id":1,"action":"BRAKE","intensity":0.5},{"id":2,"action":"MAINTAIN"}]}
Exactly one entry per car id in the input, same order. action is one of ACCELERATE, BRAKE, MAINTAIN. Numbers 0..1 with 2 decimals max.`;

  function buildUserPrompt(tick, packets) {
    return `tick ${tick}. ${packets.length} cars. Telemetry (one JSON per line):\n` + packets.map(p => JSON.stringify(p)).join('\n') + `\nReturn the JSON for all ${packets.length} cars.`;
  }

  // ---------- strict validation ----------
  function extractJSON(text) {
    if (typeof text !== 'string') return text;
    let t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    try { return JSON.parse(t); } catch (e) { /* fall through */ }
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { /* */ } }
    const c = t.indexOf('['), d = t.lastIndexOf(']');
    if (c >= 0 && d > c) { try { return JSON.parse(t.slice(c, d + 1)); } catch (e) { /* */ } }
    throw new Error('Response is not valid JSON');
  }
  function validate(obj, ids) {
    const arr = Array.isArray(obj) ? obj : obj && Array.isArray(obj.actions) ? obj.actions : null;
    if (!arr) throw new Error('Missing "actions" array');
    const out = [], seen = new Set();
    for (const a of arr) {
      if (!a || typeof a !== 'object') throw new Error('Non-object action');
      const id = +a.id, act = String(a.action || '').toUpperCase();
      if (!ids.includes(id)) continue;
      if (seen.has(id)) throw new Error('Duplicate id ' + id);
      if (!['ACCELERATE', 'BRAKE', 'MAINTAIN'].includes(act)) throw new Error('Bad action for id ' + id + ': ' + a.action);
      const o = { id, action: act };
      if (act === 'ACCELERATE') { const v = +a.throttle; if (!(v >= 0 && v <= 1)) throw new Error('Bad throttle for id ' + id); o.throttle = v; }
      if (act === 'BRAKE') { const v = +a.intensity; if (!(v >= 0 && v <= 1)) throw new Error('Bad intensity for id ' + id); o.intensity = v; }
      seen.add(id); out.push(o);
    }
    const missing = ids.filter(i => !seen.has(i));
    if (missing.length) throw new Error('Missing ids: ' + missing.join(','));
    return out;
  }

  // ---------- providers (exactly one HTTP request per decision) ----------
  const PRESETS = {
    groq: { label: 'Groq', base: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
    openai: { label: 'OpenAI', base: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' },
    gemini: { label: 'Google Gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash' },
    openrouter: { label: 'OpenRouter', base: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4.1-mini' },
    proxy: { label: 'Own proxy server', base: 'http://localhost:8787', model: 'default' }
  };

  async function callOpenAICompatible(cfg, system, user, signal) {
    const body = { model: cfg.model, temperature: 0, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
    if (cfg.jsonMode !== false) body.response_format = { type: 'json_object' };
    const res = await fetch(cfg.base.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST', signal,
      headers: Object.assign({ 'Content-Type': 'application/json' }, cfg.key ? { Authorization: 'Bearer ' + cfg.key } : {}),
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + (await res.text()).slice(0, 200));
    const j = await res.json();
    return { text: j.choices?.[0]?.message?.content ?? '', usage: j.usage || null };
  }

  /** One decision: one request, one optional repair request if the JSON is invalid. */
  async function decide(cfg, tick, packets, opts) {
    opts = opts || {};
    const ids = packets.map(p => p.id);
    const user = buildUserPrompt(tick, packets);
    const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
    let raw, err = null, actions = null, calls = 0;
    const call = opts.transport || callOpenAICompatible;
    try {
      calls++;
      raw = await call(cfg, SYSTEM_PROMPT, user, opts.signal);
      actions = validate(extractJSON(raw.text), ids);
    } catch (e) {
      err = e;
      if (e.name === 'AbortError') throw e;
      if (raw && opts.repair !== false) {
        // single batch repair request (still one request for all cars)
        calls++;
        const repairUser = user + `\n\nYour previous answer was rejected: ${e.message}. Return ONLY the corrected JSON object for all ${ids.length} cars.`;
        raw = await call(cfg, SYSTEM_PROMPT, repairUser, opts.signal);
        actions = validate(extractJSON(raw.text), ids);
        err = null;
      } else throw e;
    }
    const latency = (typeof performance !== 'undefined' ? performance : Date).now() - t0;
    return { actions, latency, raw: raw.text, usage: raw.usage, calls, repaired: calls > 1, prompt: user };
  }

  return { SYSTEM_PROMPT, buildUserPrompt, extractJSON, validate, decide, PRESETS, callOpenAICompatible };
});
