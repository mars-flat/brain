/**
 * The vault graph, in the browser (§15.3): a hand-rolled force layout on
 * a canvas — the CSP allows no external scripts, and at vault scale
 * (hundreds of nodes) O(n²) repulsion per tick is nothing. Served
 * same-origin at /graph.js; data comes from /graph.json.
 *
 * Obsidian-style controls: a settings panel (display + force sliders,
 * arrows, animate, node search) persisted to localStorage, an eased
 * focus-dim on hover/search, and a summary-bearing hover card.
 * Interactions: drag background = pan, wheel = zoom, drag node = move,
 * hover = highlight neighborhood + card, click = open the node page,
 * legend chip = toggle a type.
 */

const wrap = document.getElementById("graphwrap");
const canvas = document.getElementById("graph");
const tip = document.getElementById("tip");
const tipDot = tip.querySelector(".dot");
const tipTitle = tip.querySelector("strong");
const tipMeta = tip.querySelector(".meta");
const tipSum = tip.querySelector(".sum");
const ctx = canvas.getContext("2d");

let nodes = [];
let edges = [];
const byId = new Map();
const labelRank = new Map();
const hidden = new Set();
const view = { x: 0, y: 0, k: 1 };
let alpha = 1;
let hover = null;
let drag = null;
let pan = null;
let moved = 0;
let focusT = 0; // eased 0..1 strength of the focus dim
let dirty = true;
let query = "";

// ── settings (Obsidian-style panel, persisted) ───────────────────────────

const S = Object.assign(
  {
    arrows: false,
    animate: true,
    nodeSize: 1,
    linkWidth: 1,
    labels: 1,
    repel: 1,
    linkDist: 80,
    center: 1,
  },
  JSON.parse(localStorage.getItem("brain-graph-settings") ?? "{}"),
);
const saveS = () => localStorage.setItem("brain-graph-settings", JSON.stringify(S));

for (const key of Object.keys(S)) {
  const el = document.getElementById(`gs-${key}`);
  if (!el) continue;
  if (el.type === "checkbox") {
    el.checked = S[key];
    el.addEventListener("input", () => {
      S[key] = el.checked;
      saveS();
      reheat(0.3);
      dirty = true;
    });
  } else {
    el.value = String(S[key]);
    el.addEventListener("input", () => {
      S[key] = Number(el.value);
      saveS();
      reheat(0.3);
      dirty = true;
    });
  }
}
const searchEl = document.getElementById("gs-search");
searchEl.addEventListener("input", () => {
  query = searchEl.value.trim().toLowerCase();
  dirty = true;
});

const styles = () => getComputedStyle(wrap);
const typeColor = (t) =>
  styles().getPropertyValue(`--g-${t}`).trim() || styles().getPropertyValue("--muted").trim();
const ink = (name) => styles().getPropertyValue(name).trim();
const lerp = (a, b, t) => a + (b - a) * t;

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  canvas.width = r.width * dpr;
  canvas.height = r.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  dirty = true;
}

function radius(n) {
  return (4 + 2 * Math.sqrt(n.degree)) * S.nodeSize;
}

function visible(n) {
  return !hidden.has(n.type);
}

// ── simulation ───────────────────────────────────────────────────────────

function seed() {
  // Start each type on its own spoke so clusters begin separated; the
  // golden-angle jitter keeps a deterministic, restart-stable layout.
  const types = [...new Set(nodes.map((n) => n.type))].sort();
  nodes.forEach((n, i) => {
    const spoke = (types.indexOf(n.type) / types.length) * 2 * Math.PI;
    const a = spoke + (i % 7) * 0.13;
    const d = 120 + ((i * 137.508) % 200);
    n.x = Math.cos(a) * d;
    n.y = Math.sin(a) * d;
    n.vx = 0;
    n.vy = 0;
  });
}

function tick() {
  const vis = nodes.filter(visible);
  const rep = 2400 * S.repel;
  for (let i = 0; i < vis.length; i++) {
    const a = vis[i];
    for (let j = i + 1; j < vis.length; j++) {
      const b = vis[j];
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 1) {
        dx = (i % 2 ? 1 : -1) * 0.5;
        dy = 0.5;
        d2 = 0.5;
      }
      const f = Math.min(rep / d2, 4);
      const d = Math.sqrt(d2);
      dx /= d;
      dy /= d;
      a.vx += dx * f;
      a.vy += dy * f;
      b.vx -= dx * f;
      b.vy -= dy * f;
    }
  }
  for (const e of edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b || !visible(a) || !visible(b)) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
    const f = (d - S.linkDist) * 0.02;
    a.vx += (dx / d) * f;
    a.vy += (dy / d) * f;
    b.vx -= (dx / d) * f;
    b.vy -= (dy / d) * f;
  }
  const grav = 0.012 * S.center;
  for (const n of vis) {
    n.vx -= n.x * grav;
    n.vy -= n.y * grav;
    if (n === drag?.node) continue;
    n.vx *= 0.82;
    n.vy *= 0.82;
    n.x += n.vx * alpha;
    n.y += n.vy * alpha;
  }
}

const reheat = (a = 0.4) => {
  alpha = Math.max(alpha, a);
};

// ── focus (hover neighborhood, or search matches) ────────────────────────

function neighborhood(center) {
  const ids = new Set([center.id]);
  for (const e of edges) {
    if (e.from === center.id) ids.add(e.to);
    if (e.to === center.id) ids.add(e.from);
  }
  return ids;
}

function focusSet() {
  if (hover) return neighborhood(hover);
  if (query) {
    const s = new Set();
    for (const n of nodes)
      if (visible(n) && (n.title.toLowerCase().includes(query) || n.id.includes(query)))
        s.add(n.id);
    if (s.size) return s;
  }
  return null;
}

// ── rendering ────────────────────────────────────────────────────────────

function drawArrow(a, b, alphaNow, color) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.max(Math.hypot(dx, dy), 1);
  const ux = dx / d;
  const uy = dy / d;
  const bx = b.x - ux * (radius(b) + 2 / view.k);
  const by = b.y - uy * (radius(b) + 2 / view.k);
  const s = (4 + 2 * S.linkWidth) / view.k;
  ctx.globalAlpha = alphaNow;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(bx, by);
  ctx.lineTo(bx - ux * s - uy * s * 0.5, by - uy * s + ux * s * 0.5);
  ctx.lineTo(bx - ux * s + uy * s * 0.5, by - uy * s - ux * s * 0.5);
  ctx.closePath();
  ctx.fill();
}

function draw(focus) {
  const r = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, r.width, r.height);
  ctx.save();
  ctx.translate(r.width / 2 + view.x, r.height / 2 + view.y);
  ctx.scale(view.k, view.k);

  const lineColor = ink("--line");
  const fgColor = ink("--fg");
  const mutedColor = ink("--muted");

  for (const e of edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b || !visible(a) || !visible(b)) continue;
    const lit = focus?.has(a.id) && focus?.has(b.id) && (a === hover || b === hover || !hover);
    const eAlpha = focus ? (lit ? lerp(0.35, 0.9, focusT) : lerp(0.35, 0.06, focusT)) : 0.35;
    ctx.globalAlpha = eAlpha;
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = ((lit && focus ? 1.6 : 1) * S.linkWidth) / view.k;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    if (S.arrows) drawArrow(a, b, eAlpha, lineColor);
    if (lit && focus && hover && view.k > 0.7) {
      ctx.globalAlpha = lerp(0, 0.9, focusT);
      ctx.fillStyle = mutedColor;
      ctx.font = `italic ${10 / view.k}px sans-serif`;
      ctx.fillText(e.rel, (a.x + b.x) / 2 + 4 / view.k, (a.y + b.y) / 2 - 4 / view.k);
    }
  }

  for (const n of nodes) {
    if (!visible(n)) continue;
    const base = n.active ? 1 : 0.45;
    const dim = focus && !focus.has(n.id);
    ctx.globalAlpha = dim ? lerp(base, 0.1, focusT) : base;
    ctx.fillStyle = typeColor(n.type);
    ctx.beginPath();
    ctx.arc(n.x, n.y, radius(n), 0, 2 * Math.PI);
    ctx.fill();
    if (n === hover) {
      ctx.strokeStyle = fgColor;
      ctx.lineWidth = 1.5 / view.k;
      ctx.stroke();
    }
    const labeled =
      (focus && focus.has(n.id)) ||
      (S.labels > 0 && (labelRank.get(n.id) ?? 999) < 12 * S.labels * Math.max(view.k, 0.4));
    if (!dim && labeled) {
      ctx.fillStyle = fgColor;
      ctx.font = `${11 / view.k}px sans-serif`;
      const t = n.title.length > 32 ? `${n.title.slice(0, 31)}…` : n.title;
      ctx.fillText(t, n.x + radius(n) + 3 / view.k, n.y + 3 / view.k);
    }
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

let lastFocus = null; // survives while the dim eases back out

function loop() {
  const f = focusSet();
  if (f) lastFocus = f;
  const target = f ? 1 : 0;
  if (Math.abs(focusT - target) > 0.005) {
    focusT += (target - focusT) * 0.18;
    dirty = true;
  }
  if (S.animate) alpha = Math.max(alpha, 0.04); // gentle perpetual drift
  if (alpha > 0.02) {
    tick();
    alpha *= 0.995;
    dirty = true;
  }
  if (dirty) {
    draw(focusT > 0.02 ? lastFocus : null);
    dirty = false;
  }
  requestAnimationFrame(loop);
}

// ── hover card ───────────────────────────────────────────────────────────

function showTip(n, x, y) {
  tipDot.style.background = typeColor(n.type);
  tipTitle.textContent = n.title;
  tipMeta.textContent = `${n.type} · ${n.degree} edge${n.degree === 1 ? "" : "s"}${n.active ? "" : " · superseded"}`;
  tipSum.textContent = n.summary ?? "";
  tipSum.hidden = !n.summary;
  tip.hidden = false;
  const r = canvas.getBoundingClientRect();
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  let lx = x + 16;
  let ly = y + 12;
  if (lx + tw > r.width - 8) lx = x - tw - 16;
  if (ly + th > r.height - 8) ly = y - th - 12;
  tip.style.left = `${Math.max(lx, 8)}px`;
  tip.style.top = `${Math.max(ly, 8)}px`;
  tip.classList.add("show");
}

function hideTip() {
  tip.classList.remove("show");
  tip.hidden = true;
}

// ── interaction ──────────────────────────────────────────────────────────

function toWorld(mx, my) {
  const r = canvas.getBoundingClientRect();
  return { x: (mx - r.width / 2 - view.x) / view.k, y: (my - r.height / 2 - view.y) / view.k };
}

function pick(mx, my) {
  const w = toWorld(mx, my);
  let best = null;
  let bestD = Infinity;
  for (const n of nodes) {
    if (!visible(n)) continue;
    const d = Math.hypot(n.x - w.x, n.y - w.y);
    if (d < Math.max(radius(n) + 4, 9) / Math.min(view.k, 1) && d < bestD) {
      best = n;
      bestD = d;
    }
  }
  return best;
}

canvas.addEventListener("pointerdown", (ev) => {
  canvas.setPointerCapture(ev.pointerId);
  moved = 0;
  const n = pick(ev.offsetX, ev.offsetY);
  if (n) drag = { node: n };
  else pan = { x: ev.offsetX - view.x, y: ev.offsetY - view.y };
});

canvas.addEventListener("pointermove", (ev) => {
  moved += Math.abs(ev.movementX) + Math.abs(ev.movementY);
  if (drag) {
    const w = toWorld(ev.offsetX, ev.offsetY);
    drag.node.x = w.x;
    drag.node.y = w.y;
    drag.node.vx = 0;
    drag.node.vy = 0;
    reheat(0.25);
    dirty = true;
    return;
  }
  if (pan) {
    view.x = ev.offsetX - pan.x;
    view.y = ev.offsetY - pan.y;
    dirty = true;
    return;
  }
  const n = pick(ev.offsetX, ev.offsetY);
  if (n !== hover) {
    hover = n;
    dirty = true;
  }
  if (n) {
    showTip(n, ev.offsetX, ev.offsetY);
    canvas.style.cursor = "pointer";
  } else {
    hideTip();
    canvas.style.cursor = "grab";
  }
});

canvas.addEventListener("pointerup", () => {
  if (drag && moved < 5) window.location.href = `/node/${encodeURIComponent(drag.node.id)}`;
  drag = null;
  pan = null;
});

canvas.addEventListener("pointerleave", () => {
  hover = null;
  hideTip();
  dirty = true;
});

canvas.addEventListener(
  "wheel",
  (ev) => {
    ev.preventDefault();
    const factor = Math.exp(-ev.deltaY * 0.0015);
    const k = Math.min(Math.max(view.k * factor, 0.2), 5);
    const r = canvas.getBoundingClientRect();
    const cx = ev.offsetX - r.width / 2;
    const cy = ev.offsetY - r.height / 2;
    view.x = cx - ((cx - view.x) / view.k) * k;
    view.y = cy - ((cy - view.y) / view.k) * k;
    view.k = k;
    dirty = true;
  },
  { passive: false },
);

for (const chip of document.querySelectorAll("#legend [data-type]")) {
  chip.addEventListener("click", () => {
    const t = chip.dataset.type;
    if (hidden.has(t)) hidden.delete(t);
    else hidden.add(t);
    chip.classList.toggle("off", hidden.has(t));
    reheat();
    dirty = true;
  });
}

window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  dirty = true;
});
new ResizeObserver(resize).observe(canvas);

// ── boot ─────────────────────────────────────────────────────────────────

const data = await (await fetch("/graph.json")).json();
nodes = data.nodes;
edges = data.edges;
for (const n of nodes) byId.set(n.id, n);
[...nodes]
  .sort((a, b) => b.degree - a.degree)
  .forEach((n, i) => {
    labelRank.set(n.id, i);
  });
seed();
for (let i = 0; i < 150; i++) tick(); // pre-settle so first paint isn't soup
resize();
loop();
