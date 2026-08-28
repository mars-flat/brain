/**
 * The vault graph, in the browser (§15.3): a hand-rolled force layout on
 * a canvas — the CSP allows no external scripts, and at vault scale
 * (hundreds of nodes) O(n²) repulsion per tick is nothing. Served
 * same-origin at /graph.js; data comes from /graph.json.
 *
 * Interactions: drag background = pan, wheel = zoom, drag node = move,
 * hover = highlight neighborhood + tooltip, click = open the node page,
 * legend chip = toggle a type.
 */

const wrap = document.getElementById("graphwrap");
const canvas = document.getElementById("graph");
const tip = document.getElementById("tip");
const ctx = canvas.getContext("2d");

let nodes = [];
let edges = [];
const byId = new Map();
const hidden = new Set();
const view = { x: 0, y: 0, k: 1 };
let alpha = 1;
let hover = null;
let drag = null;
let pan = null;
let moved = 0;

const styles = () => getComputedStyle(wrap);
const typeColor = (t) =>
  styles().getPropertyValue(`--g-${t}`).trim() || styles().getPropertyValue("--muted").trim();
const ink = (name) => styles().getPropertyValue(name).trim();

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  canvas.width = r.width * dpr;
  canvas.height = r.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

function radius(n) {
  return 4 + 2 * Math.sqrt(n.degree);
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
      const f = Math.min(2400 / d2, 4);
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
    const f = (d - 80) * 0.02;
    a.vx += (dx / d) * f;
    a.vy += (dy / d) * f;
    b.vx -= (dx / d) * f;
    b.vy -= (dy / d) * f;
  }
  for (const n of vis) {
    n.vx -= n.x * 0.012; // gravity toward origin
    n.vy -= n.y * 0.012;
    if (n === drag?.node) continue;
    n.vx *= 0.82;
    n.vy *= 0.82;
    n.x += n.vx * alpha;
    n.y += n.vy * alpha;
  }
}

function loop() {
  if (alpha > 0.02) {
    alpha *= 0.995;
    tick();
    draw();
  }
  requestAnimationFrame(loop);
}

const reheat = (a = 0.4) => {
  alpha = Math.max(alpha, a);
};

// ── rendering ────────────────────────────────────────────────────────────

function neighborhood(center) {
  const ids = new Set([center.id]);
  for (const e of edges) {
    if (e.from === center.id) ids.add(e.to);
    if (e.to === center.id) ids.add(e.from);
  }
  return ids;
}

function draw() {
  const r = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, r.width, r.height);
  ctx.save();
  ctx.translate(r.width / 2 + view.x, r.height / 2 + view.y);
  ctx.scale(view.k, view.k);

  const focus = hover ? neighborhood(hover) : null;
  const lineColor = ink("--line");
  const fgColor = ink("--fg");
  const mutedColor = ink("--muted");

  for (const e of edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b || !visible(a) || !visible(b)) continue;
    const lit = focus?.has(a.id) && focus?.has(b.id) && (a === hover || b === hover);
    ctx.globalAlpha = focus ? (lit ? 0.9 : 0.06) : 0.35;
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = (lit ? 1.6 : 1) / view.k;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    if (lit && view.k > 0.7) {
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = mutedColor;
      ctx.font = `italic ${10 / view.k}px sans-serif`;
      ctx.fillText(e.rel, (a.x + b.x) / 2 + 4 / view.k, (a.y + b.y) / 2 - 4 / view.k);
    }
  }

  const labeled = new Set(
    (focus
      ? nodes.filter((n) => focus.has(n.id))
      : [...nodes].sort((a, b) => b.degree - a.degree).slice(0, 12)
    ).map((n) => n.id),
  );
  for (const n of nodes) {
    if (!visible(n)) continue;
    const dim = focus && !focus.has(n.id);
    ctx.globalAlpha = dim ? 0.12 : n.active ? 1 : 0.45;
    ctx.fillStyle = typeColor(n.type);
    ctx.beginPath();
    ctx.arc(n.x, n.y, radius(n), 0, 2 * Math.PI);
    ctx.fill();
    if (n === hover) {
      ctx.strokeStyle = fgColor;
      ctx.lineWidth = 1.5 / view.k;
      ctx.stroke();
    }
    if (!dim && (view.k > 1.4 || labeled.has(n.id))) {
      ctx.fillStyle = fgColor;
      ctx.font = `${11 / view.k}px sans-serif`;
      const t = n.title.length > 32 ? `${n.title.slice(0, 31)}…` : n.title;
      ctx.fillText(t, n.x + radius(n) + 3 / view.k, n.y + 3 / view.k);
    }
  }
  ctx.restore();
  ctx.globalAlpha = 1;
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
    draw();
    return;
  }
  if (pan) {
    view.x = ev.offsetX - pan.x;
    view.y = ev.offsetY - pan.y;
    draw();
    return;
  }
  const n = pick(ev.offsetX, ev.offsetY);
  if (n !== hover) {
    hover = n;
    draw();
  }
  if (n) {
    tip.hidden = false;
    tip.style.left = `${ev.offsetX + 14}px`;
    tip.style.top = `${ev.offsetY + 10}px`;
    tip.innerHTML = `<strong></strong><br><span class="muted"></span>`;
    tip.querySelector("strong").textContent = n.title;
    tip.querySelector("span").textContent =
      `${n.type} · ${n.degree} edge${n.degree === 1 ? "" : "s"}${n.active ? "" : " · superseded"}`;
    canvas.style.cursor = "pointer";
  } else {
    tip.hidden = true;
    canvas.style.cursor = "grab";
  }
});

canvas.addEventListener("pointerup", (ev) => {
  if (drag && moved < 5) window.location.href = `/node/${encodeURIComponent(drag.node.id)}`;
  drag = null;
  pan = null;
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
    draw();
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
    draw();
  });
}

window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", draw);
new ResizeObserver(resize).observe(canvas);

// ── boot ─────────────────────────────────────────────────────────────────

const data = await (await fetch("/graph.json")).json();
nodes = data.nodes;
edges = data.edges;
for (const n of nodes) byId.set(n.id, n);
seed();
for (let i = 0; i < 150; i++) tick(); // pre-settle so first paint isn't soup
resize();
loop();
