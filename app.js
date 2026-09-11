/* Storyit — a small storyboard + screenplay tool. Everything lives in localStorage
   (and, when served by server.js, syncs live between devices). */

"use strict";

const STORE_KEY = "storyit.v1";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

/* ---------------- data ---------------- */
/* model.js provides: newShot, newScene, capacity, allItems, allPanels,
   rechunkItems, nextSceneNum, migrateProject, GRID_PRESETS, uid */

function newProject(name, aspect = DEFAULT_ASPECT, cols = DEFAULT_COLS, rows = DEFAULT_ROWS) {
  const p = { id: uid(), name, aspect, cols, rows, createdAt: Date.now(), updatedAt: Date.now(), pages: [] };
  rechunkItems(p, [newScene(1)]);
  return p;
}

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const db = JSON.parse(raw);
      if (db && Array.isArray(db.projects)) {
        db.projects.forEach(p => {
          if (p.framesHidden) p.pages.forEach(pg => (pg.panels || pg.items || []).forEach(x => { x.frameHidden = true; }));
          delete p.framesHidden;
          // old projects keep square frames so their art doesn't distort
          if (!p.aspect) p.aspect = "1:1";
          migrateProject(p); // panels + per-shot scene numbers -> items with scene rows
          allPanels(p).forEach(x => {
            // migrate flattened PNG drawings to the vector model (PNG becomes the base layer)
            if (typeof x.drawing === "string") x.drawing = { base: x.drawing, images: [], strokes: [] };
            if (x.drawing && !Array.isArray(x.drawing.images)) x.drawing.images = [];
            if (x.drawing && !Array.isArray(x.drawing.strokes)) x.drawing.strokes = [];
          });
        });
        // scripts arrived later — older stores won't have them
        if (!Array.isArray(db.scripts)) db.scripts = [];
        db.scripts.forEach(s => s.elements.forEach(el => {
          if (el.html === undefined) el.html = escapeHtml(el.text || "").replace(/\n/g, "<br>");
        }));
        if (!db.deleted || typeof db.deleted !== "object") db.deleted = {};
        return db;
      }
    }
  } catch (e) { /* corrupted — start fresh */ }
  return { projects: [], scripts: [], deleted: {} };
}

let db = load();
let currentId = null;
let currentScriptId = null;
let tool = "type";      // type | text | pen | eraser
let saveTimer = null;

const brush = { color: "#141414", size: 8, opacity: 1 }; // size in logical px (frame = 1600 wide)
let eraserSize = 36;

let activeTextCommit = null; // commit fn for the currently open on-canvas text editor
function commitActiveText() { if (activeTextCommit) activeTextCommit(); }

function save() {
  const p = currentProject();
  if (p) p.updatedAt = Date.now();
  const s = currentScript();
  if (s) s.updatedAt = Date.now();
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(db));
  } catch (e) {
    toast("Storage is full — try removing some imported images");
  }
  flashSaved();
  if (typeof syncFlush === "function") syncFlush();
}
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 400);
}

function currentProject() { return db.projects.find(p => p.id === currentId) || null; }
function currentScript() { return db.scripts.find(s => s.id === currentScriptId) || null; }

function flashSaved() {
  $$(".save-dot").forEach(el => {
    el.classList.remove("show");
    void el.offsetWidth; // restart the pop animation
    el.classList.add("show");
  });
  clearTimeout(flashSaved._t);
  flashSaved._t = setTimeout(() => $$(".save-dot").forEach(el => el.classList.remove("show")), 1800);
}

/* ---------------- little helpers ---------------- */

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 1400);
}

function holdButton(el, ms, onComplete, hint) {
  let t = null, fired = false;
  el.style.setProperty("--hold-ms", ms + "ms");
  el.addEventListener("pointerdown", e => {
    e.stopPropagation();
    e.preventDefault();
    fired = false;
    // capture so the hold survives tiny cursor drifts off the button
    try { el.setPointerCapture(e.pointerId); } catch (err) {}
    el.classList.add("holding");
    t = setTimeout(() => { fired = true; el.classList.remove("holding"); onComplete(); }, ms);
  });
  const cancel = () => { clearTimeout(t); el.classList.remove("holding"); };
  el.addEventListener("pointerup", () => {
    if (!fired && el.classList.contains("holding")) {
      el.classList.remove("shake"); void el.offsetWidth; el.classList.add("shake");
      toast(hint || "Press and hold");
    }
    cancel();
  });
  el.addEventListener("pointerleave", cancel);
  el.addEventListener("pointercancel", cancel);
  el.addEventListener("click", e => { e.stopPropagation(); e.preventDefault(); });
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* in square (frame-hidden) mode, scale the description font so the text fills the box */
function fitDescription(el) {
  const wrap = el.previousElementSibling;
  if (!wrap || !wrap.classList.contains("hidden")) { el.style.fontSize = ""; return; }
  if (!el.innerText.trim()) { el.style.fontSize = ""; return; }
  let size = 26;
  el.style.fontSize = size + "px";
  while (size > 13 && el.scrollHeight > el.clientHeight) {
    size -= 1;
    el.style.fontSize = size + "px";
  }
}

/* keep only text, <b>, <br>, and <div> line-wrappers from contenteditable HTML */
function sanitizeRich(html) {
  const root = document.createElement("div");
  root.innerHTML = html || "";
  const ser = node => [...node.childNodes].map(n => {
    if (n.nodeType === 3) return escapeHtml(n.textContent);
    const tag = n.nodeName;
    if (tag === "BR") return "<br>";
    if (tag === "B" || tag === "STRONG") return "<b>" + ser(n) + "</b>";
    if (tag === "DIV" || tag === "P") return "<div>" + ser(n) + "</div>";
    return ser(n);
  }).join("");
  return ser(root);
}

function svg(path, extra = "") {
  return `<svg viewBox="0 0 24 24" fill="none">${path.replace(/PP/g,
    'stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"')}${extra}</svg>`;
}
const ICON = {
  trash: svg('<path d="M4 7h16M10 7V5h4v2M6.5 7l.8 13h9.4l.8-13" PP/>'),
  up:    svg('<path d="M12 19V5M6 11l6-6 6 6" PP/>'),
  down:  svg('<path d="M12 5v14M6 13l6 6 6-6" PP/>'),
  x:     svg('<path d="M6 6l12 12M18 6L6 18" PP/>'),
  eye:   svg('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" PP/><circle cx="12" cy="12" r="3" PP/>'),
  eyeOff: svg('<path d="M4 4l16 16M9.9 5.9A9.4 9.4 0 0112 5.5c6 0 9.5 6.5 9.5 6.5a17.6 17.6 0 01-3.2 3.9M6 7.7A16.8 16.8 0 002.5 12S6 18.5 12 18.5a9 9 0 003.4-.7" PP/>'),
  frameClear: svg('<rect x="4.5" y="4.5" width="15" height="15" rx="3.5" PP/><path d="M9.5 9.5l5 5M14.5 9.5l-5 5" PP/>'),
  insert: svg('<rect x="4" y="4" width="16" height="16" rx="3.5" PP/><path d="M12 8.5v7M8.5 12h7" PP/>'),
  dup:   svg('<rect x="8.5" y="8.5" width="12" height="12" rx="2.5" PP/><path d="M15.5 4.5h-9a2 2 0 00-2 2v9" PP/>'),
  expand: svg('<path d="M13.5 4.5H19a.5.5 0 01.5.5v5.5M10.5 19.5H5a.5.5 0 01-.5-.5v-5.5M19.2 4.8L13 11M4.8 19.2L11 13" PP/>'),
  grip:  svg('<circle cx="9" cy="6" r="1.6" fill="currentColor"/><circle cx="15" cy="6" r="1.6" fill="currentColor"/><circle cx="9" cy="12" r="1.6" fill="currentColor"/><circle cx="15" cy="12" r="1.6" fill="currentColor"/><circle cx="9" cy="18" r="1.6" fill="currentColor"/><circle cx="15" cy="18" r="1.6" fill="currentColor"/>'),
  scene: svg('<path d="M4 7h16M4 12h9M4 17h16" PP/><path d="M17 10.5v3M15.5 12h3" PP/>'),
  pdf:   svg('<path d="M12 3v10M8 9.5l4 4 4-4M5 16.5V19a1.5 1.5 0 001.5 1.5h11A1.5 1.5 0 0019 19v-2.5" PP/>'),
};

/* FLIP: capture positions, mutate + rerender, spring everything home */
function flipPanels(change) {
  const before = new Map();
  $$(".panel[data-id]").forEach(el => before.set(el.dataset.id, el.getBoundingClientRect()));
  change();
  $$(".panel[data-id]").forEach(el => {
    const old = before.get(el.dataset.id);
    if (!old) return;
    const now = el.getBoundingClientRect();
    const dx = old.left - now.left, dy = old.top - now.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    el.animate(
      [{ transform: `translate(${dx}px, ${dy}px)`, zIndex: 10 }, { transform: "none" }],
      { duration: 420, easing: "cubic-bezier(.3, 1.25, .45, 1)" }
    );
  });
}

/* ---------------- view switching ---------------- */

function switchView(hideEl, showEl, then) {
  hideEl.classList.add("leaving");
  setTimeout(() => {
    hideEl.classList.remove("leaving");
    hideEl.hidden = true;
    showEl.hidden = false;
    const inner = $(".view-inner", showEl);
    inner.style.animation = "none";
    void inner.offsetWidth;
    inner.style.animation = "";
    window.scrollTo(0, 0);
    if (then) then();
  }, 200);
}

function goHome() {
  currentId = null;
  setTool("type");
  closePops();
  switchView($("#view-project"), $("#view-home"), renderHome);
}

function openProject(id) {
  currentId = id;
  animatePages = "all";
  switchView($("#view-home"), $("#view-project"), renderProject);
}

/* ---------------- home ---------------- */

function renderHome() {
  const grid = $("#project-grid");
  grid.innerHTML = "";
  const list = [...db.projects].sort((a, b) => b.updatedAt - a.updatedAt);
  $("#home-empty").hidden = list.length > 0 || db.scripts.length > 0;
  $("#label-projects").hidden = list.length === 0;
  renderScriptCards();

  list.forEach((p, i) => {
    const panels = allPanels(p);
    const filled = panels.filter(x => !panelIsEmpty(x)).length;

    const card = document.createElement("article");
    card.className = "project-card";
    card.style.setProperty("--i", i);
    card.innerHTML = `
      <h3></h3>
      <div class="meta">
        <span><b>${p.pages.length}</b> page${p.pages.length === 1 ? "" : "s"}</span>
        <span><b>${filled}</b> / ${panels.length} shots</span>
      </div>
      <div class="card-mini">${panels.slice(0, 12).map(x =>
        `<i class="${panelIsEmpty(x) ? "" : "filled"}"></i>`).join("")}</div>
      <button class="hold-delete" title="Hold to delete">${ICON.trash}</button>`;
    $("h3", card).textContent = p.name || "Untitled project";
    card.addEventListener("click", () => openProject(p.id));
    holdButton($(".hold-delete", card), 650, () => {
      card.classList.add("removing");
      setTimeout(() => {
        db.projects = db.projects.filter(x => x.id !== p.id);
        save();
        renderHome();
        toast("Project deleted");
      }, 260);
    }, "Hold the trash to delete the project");
    grid.appendChild(card);
  });
}
/* ============================================================
   DRAWING CORE — vector strokes + images per shot.
   A drawing is { base, images, strokes }:
   - base:    legacy flattened PNG from old projects, drawn under strokes
   - images:  [{id, src, x, y, w, h}] imported photos, bottom layer, in order
   - strokes: [{color, size, opacity, eraser?, pts:[x,y,p,...]}] and
              text ops {text, x, y, size, color}
   Coordinates live in a logical space LW=1600 wide; height follows the
   project's aspect ratio, so one drawing renders crisply at any size.
   ============================================================ */

const LW = 1600;
const ASPECTS = { "16:9": 16 / 9, "2.39:1": 2.39, "4:3": 4 / 3, "1:1": 1, "9:16": 9 / 16 };
const DEFAULT_ASPECT = "16:9";

function arOf(p) { return ASPECTS[p.aspect] || 1; }
function logicalH(p) { return Math.round(LW / arOf(p)); }
const FRAME_R = 40; // corner radius in logical units (matches the on-screen 12px)

function ensureDrawing(panel) {
  if (!panel.drawing) panel.drawing = { base: null, images: [], strokes: [] };
  return panel.drawing;
}
function drawingEmpty(d) { return !d || (!d.base && !d.images.length && !d.strokes.length); }

/* one shared cache of decoded images (imported photos + legacy bitmaps) */
const imgCache = (() => {
  const m = new Map();
  function entry(src) {
    let e = m.get(src);
    if (!e) {
      e = { img: new Image(), ok: false, cbs: [] };
      e.img.onload = () => { e.ok = true; e.cbs.splice(0).forEach(f => f()); };
      e.img.onerror = () => { e.cbs.length = 0; };
      e.img.src = src;
      m.set(src, e);
    }
    return e;
  }
  return {
    get(src, cb) {
      const e = entry(src);
      if (e.ok) return e.img;
      if (cb) e.cbs.push(cb);
      return null;
    },
    load(src) {
      const e = entry(src);
      return e.ok ? Promise.resolve(e.img)
        : new Promise(res => { e.cbs.push(() => res(e.img)); e.img.onerror = () => res(null); });
    },
  };
})();

/* Catmull-Rom densification: fast strokes sample sparse points, and straight
   connectors between them read as crooked polygons — interpolate a smooth
   curve through the samples before building geometry (render-time, so
   already-saved strokes get smoothed too; pressure lerps linearly) */
function smoothPts(pts) {
  const n = pts.length / 3;
  if (n < 3) return pts;
  // binomial pre-pass (¼,½,¼) over interior samples: irons out residual
  // jitter so the spline below curves through a steady centerline instead
  // of faithfully wobbling through every noisy sample (endpoints stay put)
  const sm = pts.slice();
  for (let i = 1; i < n - 1; i++)
    for (let c = 0; c < 3; c++)
      sm[i * 3 + c] = pts[(i - 1) * 3 + c] * 0.25 + pts[i * 3 + c] * 0.5 + pts[(i + 1) * 3 + c] * 0.25;
  const out = [sm[0], sm[1], sm[2]];
  const X = i => sm[i * 3], Y = i => sm[i * 3 + 1], P = i => sm[i * 3 + 2];
  for (let i = 0; i < n - 1; i++) {
    const a = Math.max(0, i - 1), d = Math.min(n - 1, i + 2);
    const seg = Math.hypot(X(i + 1) - X(i), Y(i + 1) - Y(i));
    const steps = Math.min(32, Math.max(1, Math.round(seg / 3)));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps, t2 = t * t, t3 = t2 * t;
      const cr = (p0, p1, p2, p3) =>
        0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (3 * p1 - p0 - 3 * p2 + p3) * t3);
      out.push(cr(X(a), X(i), X(i + 1), X(d)), cr(Y(a), Y(i), Y(i + 1), Y(d)),
               P(i) + (P(i + 1) - P(i)) * t);
    }
  }
  return out;
}

/* variable-width stroke -> one filled Path2D (uniform alpha even where it
   self-overlaps: circles at each point + quads between them, single fill) */
const strokePaths = new WeakMap();
function strokePath(s) {
  let path = strokePaths.get(s);
  if (path) return path;
  path = new Path2D();
  const pts = smoothPts(s.pts), n = pts.length / 3;
  // narrow pressure→width range reads as ink (subtle swell), not pencil
  // (lumpy pulsing); p=0.5 — the mouse constant — maps to exactly 1×
  const rad = i => Math.max(0.35, (s.size / 2) * (0.65 + 0.7 * pts[i * 3 + 2]));
  for (let i = 0; i < n; i++) {
    const x = pts[i * 3], y = pts[i * 3 + 1], r = rad(i);
    path.moveTo(x + r, y);
    path.arc(x, y, r, 0, Math.PI * 2);
  }
  for (let i = 0; i < n - 1; i++) {
    const x1 = pts[i * 3], y1 = pts[i * 3 + 1], r1 = rad(i);
    const x2 = pts[i * 3 + 3], y2 = pts[i * 3 + 4], r2 = rad(i + 1);
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
    if (len < 0.01) continue;
    const nx = -dy / len, ny = dx / len;
    path.moveTo(x1 + nx * r1, y1 + ny * r1);
    path.lineTo(x2 + nx * r2, y2 + ny * r2);
    path.lineTo(x2 - nx * r2, y2 - ny * r2);
    path.lineTo(x1 - nx * r1, y1 - ny * r1);
    path.closePath();
  }
  strokePaths.set(s, path);
  return path;
}

const ART_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif';

function drawOp(ctx, s) {
  if (s.text !== undefined) {
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = s.opacity ?? 1;
    ctx.fillStyle = s.color;
    ctx.font = `600 ${s.size}px ${ART_FONT}`;
    ctx.textBaseline = "top";
    s.text.split("\n").forEach((line, i) => ctx.fillText(line, s.x, s.y + i * s.size * 1.3));
  } else {
    ctx.globalCompositeOperation = s.eraser ? "destination-out" : "source-over";
    ctx.globalAlpha = s.opacity ?? 1;
    ctx.fillStyle = s.color || "#000";
    ctx.fill(strokePath(s));
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
}

/* paint a whole drawing into an already-transformed ctx (logical coords).
   getImg: src => HTMLImageElement | null (may schedule a repaint itself) */
function drawArt(ctx, d, LH, getImg) {
  if (!d) return;
  for (const im of d.images) {
    const img = getImg(im.src);
    if (img) ctx.drawImage(img, im.x, im.y, im.w, im.h);
  }
  if (d.base) {
    const img = getImg(d.base);
    if (img) ctx.drawImage(img, 0, 0, LW, LH);
  }
  for (const s of d.strokes) drawOp(ctx, s);
}

/* ---------------- per-shot drawing history (undo / redo) ---------------- */

const hist = new Map(); // panelId -> {undo: [snapshot], redo: [snapshot]}
let lastTouchedId = null; // where a bare ⌘Z on the board goes

function histFor(id) {
  let h = hist.get(id);
  if (!h) { h = { undo: [], redo: [] }; hist.set(id, h); }
  return h;
}
/* strokes/images are treated as immutable once committed, so a snapshot
   is a cheap structural copy (strings are shared) */
function snapDrawing(d) {
  return d ? { base: d.base, images: d.images.map(i => ({ ...i })), strokes: d.strokes.slice() } : null;
}
function pushHist(panel, preSnap) {
  const h = histFor(panel.id);
  h.undo.push(preSnap);
  if (h.undo.length > 50) h.undo.shift();
  h.redo.length = 0;
  lastTouchedId = panel.id;
  updateUndoButtons();
}
function undoDrawing(panel) {
  const h = histFor(panel.id);
  if (!h.undo.length) { toast("Nothing to undo"); return; }
  h.redo.push(snapDrawing(panel.drawing));
  panel.drawing = h.undo.pop();
  afterHistoryChange(panel);
}
function redoDrawing(panel) {
  const h = histFor(panel.id);
  if (!h.redo.length) { toast("Nothing to redo"); return; }
  h.undo.push(snapDrawing(panel.drawing));
  panel.drawing = h.redo.pop();
  afterHistoryChange(panel);
}
function undoTargetPanel() {
  const p = currentProject();
  if (!p) return null;
  if (ED.on) return ED.panel;
  return lastTouchedId ? allPanels(p).find(x => x.id === lastTouchedId) || null : null;
}
function updateUndoButtons() {
  const t = undoTargetPanel();
  const h = t ? histFor(t.id) : { undo: [], redo: [] };
  const set = (sel, on) => { const b = $(sel); if (b) b.disabled = !on; };
  set("#btn-undo", h.undo.length); set("#btn-redo", h.redo.length);
  set("#ed-undo", h.undo.length); set("#ed-redo", h.redo.length);
}
function afterHistoryChange(panel) {
  if (drawingEmpty(panel.drawing)) panel.drawing = null;
  if (ED.on && ED.panel === panel) { edDeselect(); edInvalidate(); }
  redrawBoardPanel(panel.id);
  save();
  updateUndoButtons();
}

/* ---------------- input helpers ---------------- */

let lastPenAt = 0; // recent Apple Pencil use => single-finger touch pans in the editor
function pressureOf(e) {
  if (e.pointerType === "pen") { lastPenAt = Date.now(); return Math.min(1, Math.max(0.08, e.pressure || 0.5)); }
  return 0.5;
}
function coalesced(e) { return e.getCoalescedEvents ? e.getCoalescedEvents() : [e]; }
function predictedEvents(e) { return e.getPredictedEvents ? e.getPredictedEvents() : []; }

/* live-render copy of a stroke with the browser's predicted points appended —
   hides input→paint latency while drawing; predictions are never committed */
function withPrediction(stroke, e, toLogicalFn) {
  const preds = predictedEvents(e);
  if (!preds.length) return stroke;
  const temp = { ...stroke, pts: stroke.pts.slice() };
  preds.forEach(pe => {
    const l = toLogicalFn(pe.clientX, pe.clientY);
    addPoint(temp, l.x, l.y, pressureOf(pe));
  });
  return temp;
}

/* append a point (logical coords), skipping micro-moves.
   Velocity-adaptive one-pole stabilizer: damping is heaviest at slow
   speeds — where hand/sensor jitter lives — and eases off as the stroke
   speeds up so fast lines stay responsive (predicted points hide the
   added latency). Pressure is smoothed harder still, which otherwise
   makes thin strokes lumpy; raw=true bypasses the filter for the final
   pointer-up point so fast flicks aren't clipped short. */
const STAB_POS_MIN = 0.22, STAB_POS_MAX = 0.7, STAB_DIST = 9, STAB_PRESSURE = 0.22;
function addPoint(stroke, x, y, p, raw = false) {
  const pts = stroke.pts, n = pts.length;
  if (n >= 3 && !raw) {
    const dx = x - pts[n - 3], dy = y - pts[n - 2];
    const a = STAB_POS_MIN + (STAB_POS_MAX - STAB_POS_MIN) * Math.min(1, Math.hypot(dx, dy) / STAB_DIST);
    x = pts[n - 3] + dx * a;
    y = pts[n - 2] + dy * a;
    p = pts[n - 1] + (p - pts[n - 1]) * STAB_PRESSURE;
  }
  if (n >= 3) {
    const dx = x - pts[n - 3], dy = y - pts[n - 2];
    if (dx * dx + dy * dy < 0.36 && Math.abs(p - pts[n - 1]) < 0.03) return;
  }
  pts.push(Math.round(x * 10) / 10, Math.round(y * 10) / 10, Math.round(p * 100) / 100);
}

/* ---------------- image import ---------------- */

function fileToDataURL(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}
/* decode + downscale so localStorage stays sane */
async function importableImage(file) {
  if (!/^image\//.test(file.type)) return null;
  const url = await fileToDataURL(file);
  const img = await imgCache.load(url);
  if (!img) return null;
  const isPng = file.type === "image/png";
  const maxDim = isPng ? 1200 : 1600;
  let { width: w, height: h } = img;
  if (Math.max(w, h) <= maxDim && !isPng) return { src: url, w, h };
  const k = Math.min(1, maxDim / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.round(w * k); c.height = Math.round(h * k);
  const g = c.getContext("2d");
  g.drawImage(img, 0, 0, c.width, c.height);
  const out = isPng ? c.toDataURL("image/png") : c.toDataURL("image/jpeg", 0.85);
  return { src: out, w: c.width, h: c.height };
}

/* place an imported bitmap into a shot, fitted + centered */
async function importImageToPanel(panel, file, opts = {}) {
  const p = currentProject();
  if (!p) return;
  const data = await importableImage(file);
  if (!data) { toast("That file isn't an image"); return; }
  const LH = logicalH(p);
  const fit = Math.min((LW * (opts.scale || 0.9)) / data.w, (LH * (opts.scale || 0.9)) / data.h, 4);
  const w = data.w * fit, h = data.h * fit;
  const im = { id: uid(), src: data.src, x: (LW - w) / 2, y: (LH - h) / 2, w, h };
  const pre = snapDrawing(panel.drawing);
  ensureDrawing(panel).images.push(im);
  pushHist(panel, pre);
  if (panel.frameHidden) {
    panel.frameHidden = false;
    applyItemToDom(panel, ["frameHidden"]);
    updateGlobalEye();
  }
  save();
  redrawBoardPanel(panel.id, true);
  if (ED.on && ED.panel === panel) { edSetTool("select"); edSelect(im); edInvalidate(); }
  toast("Image added");
  return im;
}
/* ---------------- project ---------------- */

let animatePages = "all"; // "all" on open, a page id for a fresh page, or null

function applyAspect(p) {
  $("#pages").style.setProperty("--far", arOf(p));
  const chip = $("#btn-aspect");
  if (chip) chip.textContent = p.aspect || "1:1";
}
function applyGrid(p) {
  $("#pages").style.setProperty("--cols", p.cols || DEFAULT_COLS);
  const chip = $("#btn-grid");
  if (chip) chip.textContent = `${p.cols}×${p.rows}`;
}
/* change the grid: shots reflow into pages of the new size */
function setGrid(p, cols, rows) {
  if (p.cols === cols && p.rows === rows) return;
  p.cols = cols; p.rows = rows;
  const items = allItems(p);
  // blank shots that only padded out the old page size shouldn't carry over
  while (items.length && items[items.length - 1].kind === "shot" && panelIsEmpty(items[items.length - 1])) items.pop();
  rechunkItems(p, items);
  applyGrid(p);
  renderProject();
  save();
  requestAnimationFrame(() => {
    $$("#pages canvas").forEach(c => c._fit && c._fit());
    $$(".panel-text").forEach(fitDescription);
  });
  toast(`Grid set to ${cols}×${rows}`);
}

function renderProject() {
  commitActiveText(); // don't lose in-progress canvas text on re-render
  const p = currentProject();
  if (!p) return goHome();
  if (!p.pages.length) rechunkItems(p, [newScene(1)]); // a project that arrived over sync before its pages

  const nameInput = $("#project-name");
  nameInput.value = p.name;
  $("#print-header").textContent = p.name || "Untitled project";
  applyAspect(p);
  applyGrid(p);

  const pagesEl = $("#pages");
  pagesEl.innerHTML = "";
  p.pages.forEach((page, pi) => {
    const pageEl = document.createElement("div");
    pageEl.className = "page";
    pageEl.dataset.id = page.id;
    if (animatePages === "all") pageEl.style.animationDelay = pi * 60 + "ms";
    else if (animatePages === page.id) pageEl.style.animationDelay = "0ms";
    else pageEl.style.animation = "none";
    pageEl.innerHTML = `
      <div class="page-head">
        <span class="page-num">Page <b>${pi + 1}</b> / ${p.pages.length}</span>
        <button class="page-delete" title="Hold to delete page">${ICON.trash}</button>
      </div>
      <div class="page-grid"></div>`;

    holdButton($(".page-delete", pageEl), 650, () => deletePage(page.id), "Hold to delete the page");

    const grid = $(".page-grid", pageEl);
    page.items.forEach(item => {
      grid.appendChild(item.kind === "scene" ? buildSceneRow(item, p) : buildPanel(item, p));
    });
    pagesEl.appendChild(pageEl);
  });
  animatePages = null;

  updateMoveButtons(p);
  updateGlobalEye();
  updateUndoButtons();
  requestAnimationFrame(() => $$(".panel-text", pagesEl).forEach(fitDescription));
}

function updateMoveButtons(p) {
  const items = allItems(p);
  items.forEach((it, i) => {
    const el = itemEl(it.id);
    if (!el) return;
    const up = $(".move-up", el), down = $(".move-down", el);
    if (up) up.disabled = i === 0;
    if (down) down.disabled = i === items.length - 1;
  });
}

function itemEl(id) { return document.querySelector(`#pages [data-id="${id}"]`); }
function itemById(id) { const p = currentProject(); return p ? allItems(p).find(x => x.id === id) : null; }

/* ---- scene row: a full-width band that marks where a new scene starts ---- */

function buildSceneRow(item) {
  const el = document.createElement("div");
  el.className = "scene-row";
  el.dataset.id = item.id;
  el.innerHTML = `
    <div class="panel-actions scene-actions">
      <button class="move-up" title="Move scene row up">${ICON.up}</button>
      <button class="move-down" title="Move scene row down">${ICON.down}</button>
      <button class="hold-clear" title="Hold to remove scene row">${ICON.x}</button>
    </div>
    <span class="scene-label">Scene</span>
    <input class="scene-num" placeholder="1" spellcheck="false" maxlength="8" title="Scene number — 1, 2, 2A…">
    <input class="scene-title" placeholder="Scene title…" spellcheck="false" maxlength="80">`;
  const num = $(".scene-num", el), title = $(".scene-title", el);
  num.value = item.num || "";
  title.value = item.title || "";
  num.addEventListener("input", () => { item.num = num.value; saveSoon(); });
  title.addEventListener("input", () => { item.title = title.value; saveSoon(); });
  [num, title].forEach(i => i.addEventListener("keydown", e => { if (e.key === "Enter") e.target.blur(); }));
  $(".move-up", el).addEventListener("click", () => moveItem(item.id, -1));
  $(".move-down", el).addEventListener("click", () => moveItem(item.id, +1));
  holdButton($(".hold-clear", el), 500, () => deleteItem(item.id), "Hold to remove the scene row");
  return el;
}

/* ---- shot ---- */

/* a bold-capable single-field editor (description + note share this) */
function bindRichEditor(div, onInput) {
  div.addEventListener("input", () => {
    if (div.innerHTML === "<br>" || div.innerHTML === "<div><br></div>") div.innerHTML = "";
    onInput(sanitizeRich(div.innerHTML), div.innerText.replace(/\n+$/, ""));
  });
  div.addEventListener("paste", e => {
    e.preventDefault();
    document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
  });
}

function refreshPanelClasses(el, panel) {
  el.classList.toggle("has-note", !!(panel.note || "").trim());
  el.classList.toggle("frame-off", !!panel.frameHidden);
}

function buildPanel(panel) {
  const el = document.createElement("div");
  el.className = "panel";
  el.dataset.id = panel.id;
  el.innerHTML = `
    <div class="panel-actions">
      <button class="move-up" title="Move shot up">${ICON.up}</button>
      <button class="move-down" title="Move shot down">${ICON.down}</button>
      <button class="insert-shot" title="Insert blank shot after">${ICON.insert}</button>
      <button class="dup-shot" title="Duplicate shot">${ICON.dup}</button>
      <button class="add-scene" title="Start a new scene after this shot">${ICON.scene}</button>
      <button class="frame-toggle" title="${panel.frameHidden ? "Show frame" : "Hide frame — text-only shot"}">${panel.frameHidden ? ICON.eyeOff : ICON.eye}</button>
      <button class="hold-clear-drawing" title="Hold to clear drawing">${ICON.frameClear}</button>
      <button class="hold-clear" title="Hold to clear whole shot">${ICON.x}</button>
    </div>
    <div class="panel-top">
      <span class="drag-grip" title="Drag to reorder">${ICON.grip}</span>
      <input class="panel-title" placeholder="Shot title" spellcheck="false" maxlength="80">
      <input class="panel-num" placeholder="#" spellcheck="false" maxlength="8" title="Shot number — 1, 2, 1A…">
    </div>
    <div class="panel-note" contenteditable="true" spellcheck="false" data-placeholder="Note under the title… (optional)"></div>
    <div class="panel-rule"></div>
    <div class="frame-wrap${panel.frameHidden ? " hidden" : ""}"><div class="frame"><canvas></canvas><button class="frame-expand" title="Open shot editor — zoom, images, brushes">${ICON.expand}</button></div></div>
    <div class="panel-text" contenteditable="true" spellcheck="false" data-placeholder="Action, dialogue, camera notes… (⌘B = bold)"></div>`;

  const title = $(".panel-title", el);
  const num = $(".panel-num", el);
  const note = $(".panel-note", el);
  const text = $(".panel-text", el);
  title.value = panel.title || "";
  num.value = panel.num || "";
  note.innerHTML = panel.noteRich || "";
  text.innerHTML = panel.rich || "";
  refreshPanelClasses(el, panel);

  makeDragGrip($(".drag-grip", el), panel, el);

  title.addEventListener("input", () => {
    panel.title = title.value;
    if (ED.on && ED.panel === panel) $("#ed-title").textContent = panel.title || "Untitled shot";
    saveSoon();
  });
  num.addEventListener("input", () => {
    panel.num = num.value;
    if (ED.on && ED.panel === panel) $("#ed-label").textContent = panel.num || "—";
    saveSoon();
  });
  [title, num].forEach(i => i.addEventListener("keydown", e => { if (e.key === "Enter") e.target.blur(); }));
  bindRichEditor(note, (rich, plain) => {
    panel.noteRich = rich; panel.note = plain;
    refreshPanelClasses(el, panel);
    saveSoon();
  });
  bindRichEditor(text, (rich, plain) => {
    panel.rich = rich; panel.text = plain;
    fitDescription(text);
    saveSoon();
  });

  $(".move-up", el).addEventListener("click", () => moveItem(panel.id, -1));
  $(".move-down", el).addEventListener("click", () => moveItem(panel.id, +1));
  $(".insert-shot", el).addEventListener("click", () => insertShotAfter(panel.id));
  $(".dup-shot", el).addEventListener("click", () => duplicateShot(panel.id));
  $(".add-scene", el).addEventListener("click", () => insertSceneAfter(panel.id));
  holdButton($(".hold-clear", el), 500, () => clearPanel(panel.id), "Hold to clear the shot");

  $(".frame-toggle", el).addEventListener("click", () => {
    panel.frameHidden = !panel.frameHidden;
    applyItemToDom(panel, ["frameHidden"]);
    updateGlobalEye();
    save();
  });

  holdButton($(".hold-clear-drawing", el), 450, () => {
    if (panel.drawing) pushHist(panel, snapDrawing(panel.drawing));
    panel.drawing = null;
    redrawBoardPanel(panel.id, true);
    save();
    toast("Drawing cleared — ⌘Z to undo");
  }, "Hold to clear the drawing");

  const expandBtn = $(".frame-expand", el);
  expandBtn.addEventListener("pointerdown", e => e.stopPropagation());
  expandBtn.addEventListener("click", e => { e.stopPropagation(); edOpen(panel); });
  $(".frame", el).addEventListener("dblclick", () => { if (tool === "type") edOpen(panel); });

  setupCanvas($("canvas", el), panel);
  return el;
}

/* push model -> DOM for one item (used by remote sync and local toggles).
   Fields the user is currently typing in are left alone. */
function applyItemToDom(item, fields) {
  const el = itemEl(item.id);
  if (!el) return;
  const want = f => !fields || fields.includes(f);
  const ae = document.activeElement;
  const setInput = (sel, val) => { const i = $(sel, el); if (i && ae !== i && i.value !== (val || "")) i.value = val || ""; };
  const setRich = (sel, html) => { const d = $(sel, el); if (d && ae !== d && d.innerHTML !== (html || "")) d.innerHTML = html || ""; };
  if (item.kind === "scene") {
    if (want("num")) setInput(".scene-num", item.num);
    if (want("title")) setInput(".scene-title", item.title);
    return;
  }
  const inEd = ED.on && ED.panel === item;
  if (want("title")) { setInput(".panel-title", item.title); if (inEd) $("#ed-title").textContent = item.title || "Untitled shot"; }
  if (want("num")) { setInput(".panel-num", item.num); if (inEd) $("#ed-label").textContent = item.num || "—"; }
  if (want("noteRich")) setRich(".panel-note", item.noteRich);
  if (want("rich")) setRich(".panel-text", item.rich);
  if (want("frameHidden")) {
    $(".frame-wrap", el).classList.toggle("hidden", !!item.frameHidden);
    const ft = $(".frame-toggle", el);
    ft.innerHTML = item.frameHidden ? ICON.eyeOff : ICON.eye;
    ft.title = item.frameHidden ? "Show frame" : "Hide frame — text-only shot";
    if (!item.frameHidden) requestAnimationFrame(() => { const c = $("canvas", el); c && c._fit && c._fit(); });
  }
  if (want("drawing")) { redrawBoardPanel(item.id, false); if (inEd) edInvalidate(); }
  refreshPanelClasses(el, item);
  fitDescription($(".panel-text", el));
}

/* ---------------- structure ops ---------------- */

function panelIsEmpty(x) {
  if (x.kind === "scene") return false;
  return !x.title && !x.text && !x.note && !x.num && !x.drawing;
}

/* swap an item (shot or scene row) with its neighbour in the flat order */
function moveItem(id, dir) {
  const p = currentProject();
  const items = allItems(p);
  const i = items.findIndex(x => x.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= items.length) return;
  [items[i], items[j]] = [items[j], items[i]];
  rechunkItems(p, items);
  flipPanels(renderProject);
  save();
}

/* drag-and-drop: lift the shot out and drop it into another slot */
function reorderPanel(srcId, dstId) {
  const p = currentProject();
  const items = allItems(p);
  const i = items.findIndex(x => x.id === srcId);
  const jOrig = items.findIndex(x => x.id === dstId);
  if (i < 0 || jOrig < 0 || i === jOrig) return;
  const [moved] = items.splice(i, 1);
  items.splice(items.findIndex(x => x.id === dstId) + (i < jOrig ? 1 : 0), 0, moved);
  rechunkItems(p, items);
  flipPanels(renderProject);
  save();
  redrawBoardPanel(srcId, true);
}

function insertShotAfter(id, ready) {
  const p = currentProject();
  const items = allItems(p);
  const i = items.findIndex(x => x.id === id);
  if (i < 0) return;
  const np = ready || newShot();
  if (!ready) np.frameHidden = items[i].frameHidden;
  items.splice(i + 1, 0, np);
  // don't grow a whole new page when the board's very last slot was blank anyway
  const shots = items.filter(x => x.kind !== "scene");
  const last = items[items.length - 1];
  if (shots.length % capacity(p) === 1 && last.kind !== "scene" && panelIsEmpty(last)) items.pop();
  rechunkItems(p, items);
  flipPanels(renderProject);
  save();
  const el = itemEl(np.id);
  if (el) el.classList.add("pop");
  toast(ready ? "Shot duplicated" : "Shot inserted");
  return np;
}

function insertSceneAfter(id) {
  const p = currentProject();
  const items = allItems(p);
  const i = items.findIndex(x => x.id === id);
  if (i < 0) return;
  const sc = newScene(nextSceneNum(p, id));
  items.splice(i + 1, 0, sc);
  rechunkItems(p, items);
  flipPanels(renderProject);
  save();
  const el = itemEl(sc.id);
  if (el) { el.classList.add("pop"); setTimeout(() => $(".scene-title", el).focus(), 200); }
  toast(`Scene ${sc.num} starts here`);
}

/* remove a scene row (shots are cleared, never deleted, so the grid stays put) */
function deleteItem(id) {
  const p = currentProject();
  const items = allItems(p);
  const i = items.findIndex(x => x.id === id);
  if (i < 0 || items[i].kind !== "scene") return;
  items.splice(i, 1);
  rechunkItems(p, items);
  flipPanels(renderProject);
  save();
  toast("Scene row removed");
}

function duplicateShot(id) {
  const p = currentProject();
  const src = allPanels(p).find(x => x.id === id);
  if (!src) return;
  const copy = newShot();
  copy.title = src.title; copy.text = src.text; copy.rich = src.rich;
  copy.note = src.note; copy.noteRich = src.noteRich;
  copy.frameHidden = src.frameHidden;
  copy.drawing = snapDrawing(src.drawing);
  if (copy.drawing) copy.drawing.images.forEach(im => { im.id = uid(); });
  insertShotAfter(id, copy);
}

function clearPanel(id) {
  const p = currentProject();
  const panel = allPanels(p).find(x => x.id === id);
  if (!panel) return;
  if (panel.drawing) pushHist(panel, snapDrawing(panel.drawing));
  panel.title = ""; panel.num = ""; panel.note = ""; panel.noteRich = "";
  panel.text = ""; panel.rich = ""; panel.drawing = null;
  const el = itemEl(id);
  if (el) {
    el.classList.remove("pop"); void el.offsetWidth; el.classList.add("pop");
    applyItemToDom(panel);
  }
  save();
  toast("Shot cleared");
}

function addPage() {
  const p = currentProject();
  if (!p) return;
  const page = { id: uid(), items: Array.from({ length: capacity(p) }, newShot) };
  p.pages.push(page);
  animatePages = page.id;
  renderProject();
  save();
  const last = $("#pages").lastElementChild;
  last?.scrollIntoView({ behavior: "smooth", block: "center" });
  toast(`Page ${p.pages.length} added`);
}

function deletePage(pageId) {
  const p = currentProject();
  const pageEl = document.querySelector(`.page[data-id="${pageId}"]`);
  const finish = () => {
    p.pages = p.pages.filter(pg => pg.id !== pageId);
    if (p.pages.length === 0) rechunkItems(p, [newScene(1)]);
    renderProject();
    save();
    toast("Page deleted");
  };
  if (pageEl) { pageEl.classList.add("removing"); setTimeout(finish, 280); }
  else finish();
}

/* ---------------- drag grip: drag = reorder ---------------- */

function makeDragGrip(grip, panel, panelEl) {
  grip.addEventListener("pointerdown", e => {
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY;
    let dragging = false;
    const move = ev => {
      if (!dragging && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 6) {
        dragging = true;
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        startPanelDrag(panel, panelEl, ev);
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
}

function startPanelDrag(panel, panelEl, ev) {
  const rect = panelEl.getBoundingClientRect();
  const ghost = panelEl.cloneNode(true);
  ghost.classList.add("drag-ghost");
  ghost.style.width = rect.width + "px";
  ghost.style.height = rect.height + "px";
  // cloned canvases come back blank — copy the bitmaps over
  const srcCanvases = $$("canvas", panelEl);
  $$("canvas", ghost).forEach((c, i) => {
    const s = srcCanvases[i];
    if (!s || !s.width) return;
    c.width = s.width; c.height = s.height;
    c.getContext("2d").drawImage(s, 0, 0);
  });
  document.body.appendChild(ghost);
  panelEl.classList.add("dragging");

  const offX = ev.clientX - rect.left, offY = ev.clientY - rect.top;
  let targetId = null, lastX = ev.clientX, lastY = ev.clientY, rafOn = true;

  const place = () => {
    ghost.style.left = (lastX - offX) + "px";
    ghost.style.top = (lastY - offY) + "px";
  };
  place();

  const hitTest = () => {
    let best = null;
    for (const t of $$(".panel[data-id]")) {
      if (t === panelEl) continue;
      const r = t.getBoundingClientRect();
      if (lastX >= r.left && lastX <= r.right && lastY >= r.top && lastY <= r.bottom) { best = t; break; }
    }
    const id = best?.dataset.id || null;
    if (id !== targetId) {
      $$(".panel.drop-target").forEach(x => x.classList.remove("drop-target"));
      best?.classList.add("drop-target");
      targetId = id;
    }
  };

  // autoscroll near the viewport edges while dragging
  const tick = () => {
    if (!rafOn) return;
    const m = 90;
    if (lastY < m) window.scrollBy(0, -Math.ceil((m - lastY) / 4));
    else if (lastY > innerHeight - m) window.scrollBy(0, Math.ceil((lastY - (innerHeight - m)) / 4));
    hitTest();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  const move = e => { lastX = e.clientX; lastY = e.clientY; place(); };
  const up = () => {
    rafOn = false;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    $$(".panel.drop-target").forEach(x => x.classList.remove("drop-target"));
    panelEl.classList.remove("dragging");
    ghost.remove();
    if (targetId) reorderPanel(panel.id, targetId);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}

/* ---------------- board canvases (draw in place) ---------------- */

const DPR = Math.min(window.devicePixelRatio || 1, 2);

function paintBoardCanvas(canvas, panel) {
  const p = currentProject();
  if (!p || !canvas.width) return;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!panel.drawing) return;
  const s = canvas.width / LW;
  ctx.setTransform(s, 0, 0, s, 0, 0);
  drawArt(ctx, panel.drawing, logicalH(p), src => imgCache.get(src, () => paintBoardCanvas(canvas, panel)));
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function redrawBoardPanel(id, pop) {
  const el = document.querySelector(`.panel[data-id="${id}"]`);
  if (!el) return;
  const c = $("canvas", el);
  if (c && c._redraw) c._redraw();
  if (pop) {
    const f = $(".frame", el);
    if (f) { f.classList.remove("pop"); void f.offsetWidth; f.classList.add("pop"); }
  }
}

function setupCanvas(canvas, panel) {
  const ctx = canvas.getContext("2d");

  function fit() {
    const r = canvas.getBoundingClientRect();
    if (r.width < 4) { requestAnimationFrame(fit); return; }
    const w = Math.round(r.width * DPR), h = Math.round(r.height * DPR);
    if (canvas.width === w && canvas.height === h) return;
    canvas.width = w; canvas.height = h;
    paintBoardCanvas(canvas, panel);
  }
  requestAnimationFrame(fit);
  canvas._fit = fit; // for global resize handler
  canvas._redraw = () => paintBoardCanvas(canvas, panel);

  let live = null, preSnap = null, bg = null, rect = null;

  const toLogical = (cx, cy) => ({
    x: (cx - rect.left) / rect.width * LW,
    y: (cy - rect.top) / rect.height * (LW / arOf(currentProject())),
  });

  function renderLive(stroke = live) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bg, 0, 0);
    const s = canvas.width / LW;
    ctx.setTransform(s, 0, 0, s, 0, 0);
    strokePaths.delete(stroke);
    drawOp(ctx, stroke);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  canvas.addEventListener("pointerdown", e => {
    if (tool === "type") return;
    if (tool === "text") { e.preventDefault(); beginBoardText(e); return; }
    e.preventDefault();
    commitActiveText();
    canvas.setPointerCapture(e.pointerId);
    rect = canvas.getBoundingClientRect();
    preSnap = snapDrawing(panel.drawing);
    live = tool === "eraser"
      ? { size: eraserSize, opacity: 1, eraser: true, pts: [] }
      : { color: brush.color, size: brush.size, opacity: brush.opacity, pts: [] };
    bg = document.createElement("canvas");
    bg.width = canvas.width; bg.height = canvas.height;
    const bgc = bg.getContext("2d");
    if (panel.drawing) {
      const s = bg.width / LW;
      bgc.setTransform(s, 0, 0, s, 0, 0);
      drawArt(bgc, panel.drawing, logicalH(currentProject()), src => imgCache.get(src));
    }
    const l = toLogical(e.clientX, e.clientY);
    const pr = pressureOf(e);
    addPoint(live, l.x, l.y, pr);
    addPoint(live, l.x + 0.01, l.y + 0.01, pr); // dot on tap
    renderLive();
  });

  canvas.addEventListener("pointermove", e => {
    if (!live) return;
    coalesced(e).forEach(ce => {
      const l = toLogical(ce.clientX, ce.clientY);
      addPoint(live, l.x, l.y, pressureOf(ce));
    });
    renderLive(withPrediction(live, e, (cx, cy) => toLogical(cx, cy)));
  });

  const end = e => {
    if (!live) return;
    if (e && e.type === "pointerup" && rect) { // land the last point exactly where the pointer stopped
      const l = toLogical(e.clientX, e.clientY);
      addPoint(live, l.x, l.y, pressureOf(e), true);
    }
    const s = live;
    live = null; bg = null;
    strokePaths.delete(s);
    if (s.pts.length >= 3) {
      ensureDrawing(panel).strokes.push(s);
      pushHist(panel, preSnap);
      saveSoon();
    }
    preSnap = null;
    paintBoardCanvas(canvas, panel);
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);

  function beginBoardText(e) {
    commitActiveText(); // one editor at a time
    const frame = canvas.parentElement;
    rect = canvas.getBoundingClientRect();
    const x = Math.max(2, e.clientX - rect.left);
    const y = Math.max(2, e.clientY - rect.top - 10); // first line centers on the click
    const myColor = brush.color;

    const ta = document.createElement("textarea");
    ta.className = "canvas-text-input";
    ta.rows = 1;
    ta.style.left = x + "px";
    ta.style.top = y + "px";
    ta.style.color = myColor;
    frame.appendChild(ta);

    const grow = () => {
      ta.style.width = "24px";
      ta.style.width = Math.min(ta.scrollWidth + 4, rect.width - x - 4) + "px";
      ta.style.height = "auto";
      ta.style.height = ta.scrollHeight + "px";
    };
    grow();
    requestAnimationFrame(() => ta.focus());

    let done = false;
    const finish = commit => {
      if (done) return; done = true;
      if (activeTextCommit === doCommit) activeTextCommit = null;
      const val = ta.value.replace(/\s+$/, "");
      ta.remove();
      if (!commit || !val) return;
      const k = LW / rect.width;
      const op = { text: val, x: x * k, y: y * k, size: 15 * k, color: myColor };
      const pre = snapDrawing(panel.drawing);
      ensureDrawing(panel).strokes.push(op);
      pushHist(panel, pre);
      saveSoon();
      paintBoardCanvas(canvas, panel);
    };
    const doCommit = () => finish(true);
    activeTextCommit = doCommit;

    ta.addEventListener("input", grow);
    ta.addEventListener("keydown", ev => {
      ev.stopPropagation();
      if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); finish(true); }
      else if (ev.key === "Escape") finish(false);
    });
    ta.addEventListener("blur", () => finish(true));
    ta.addEventListener("pointerdown", ev => ev.stopPropagation());
  }
}

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    $$("canvas").forEach(c => c._fit && c._fit());
    $$(".panel-text").forEach(fitDescription);
    if (ED.on) { edResize(); edInvalidate(); }
  }, 150);
});

/* ---------------- drop / paste images onto shots ---------------- */

document.addEventListener("dragover", e => {
  if (currentId && e.dataTransfer?.types?.includes("Files")) e.preventDefault();
});
document.addEventListener("drop", e => {
  if (!currentId) return;
  e.preventDefault();
  const files = [...(e.dataTransfer?.files || [])];
  if (!files.length) return;
  if (ED.on) { files.forEach(f => importImageToPanel(ED.panel, f)); return; }
  const panelEl = e.target.closest?.(".panel[data-id]");
  if (!panelEl) return;
  const panel = allPanels(currentProject()).find(x => x.id === panelEl.dataset.id);
  if (panel) files.forEach(f => importImageToPanel(panel, f));
});
document.addEventListener("paste", e => {
  if (!ED.on) return;
  const files = [...(e.clipboardData?.files || [])].filter(f => /^image\//.test(f.type));
  if (!files.length) return;
  e.preventDefault();
  files.forEach(f => importImageToPanel(ED.panel, f));
});

/* ---------------- tools, brush & popovers ---------------- */

function setTool(t) {
  commitActiveText();
  tool = t;
  document.body.dataset.tool = t;
  $$(".toolbar .tool[data-tool]").forEach(b => b.classList.toggle("active", b.dataset.tool === t));
  if (t !== "type" && currentId) {
    const p = currentProject();
    if (p && allPanels(p).every(x => x.frameHidden)) toast("All frames are hidden — use an eye button to show one");
  }
}

let openPopEl = null;
function openPop(pop, anchor) {
  if (openPopEl === pop) return closePops();
  closePops();
  pop.hidden = false;
  openPopEl = pop;
  const r = anchor.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  let x = r.left + r.width / 2 - pr.width / 2;
  x = Math.max(10, Math.min(x, innerWidth - pr.width - 10));
  let y = r.top - pr.height - 14;
  if (y < 10) y = r.bottom + 14;
  pop.style.left = x + "px";
  pop.style.top = y + "px";
}
function closePops() {
  if (openPopEl) openPopEl.hidden = true;
  openPopEl = null;
}
document.addEventListener("pointerdown", e => {
  if (openPopEl && !openPopEl.contains(e.target) && !e.target.closest?.(".pop-anchor")) closePops();
});

function updateBrushUI() {
  $$(".swatch[data-color]").forEach(s => s.classList.toggle("active", s.dataset.color.toUpperCase() === brush.color.toUpperCase()));
  $$(".brush-btn .brush-dot").forEach(d => {
    d.style.background = brush.color;
    d.style.opacity = Math.max(0.3, brush.opacity);
    const px = Math.round(9 + (brush.size / 60) * 13);
    d.style.width = d.style.height = px + "px";
  });
  $("#brush-size").value = brush.size;
  $("#brush-size-val").textContent = brush.size;
  $("#brush-opacity").value = Math.round(brush.opacity * 100);
  $("#brush-op-val").textContent = Math.round(brush.opacity * 100) + "%";
  $("#eraser-size").value = eraserSize;
  $("#eraser-size-val").textContent = eraserSize;
  if (/^#[0-9A-Fa-f]{6}$/.test(brush.color)) $("#brush-color").value = brush.color;
}

$$(".swatch[data-color]").forEach(s => s.addEventListener("click", () => {
  brush.color = s.dataset.color;
  if (tool === "eraser") setTool("pen");
  if (ED.on && ED.tool === "eraser") edSetTool("pen");
  updateBrushUI();
}));
$("#brush-color").addEventListener("input", e => {
  brush.color = e.target.value;
  if (tool === "eraser") setTool("pen");
  if (ED.on && ED.tool === "eraser") edSetTool("pen");
  updateBrushUI();
});
$("#brush-size").addEventListener("input", e => { brush.size = +e.target.value; updateBrushUI(); });
$("#brush-opacity").addEventListener("input", e => { brush.opacity = +e.target.value / 100; updateBrushUI(); });
$("#eraser-size").addEventListener("input", e => { eraserSize = +e.target.value; updateBrushUI(); });

$("#btn-brush").addEventListener("click", () => openPop($("#brush-pop"), $("#btn-brush")));
$("#ed-brush").addEventListener("click", () => openPop($("#brush-pop"), $("#ed-brush")));

/* aspect ratio picker */
$("#btn-aspect").addEventListener("click", () => {
  const pop = $("#aspect-pop");
  const p = currentProject();
  if (p) $$(".aspect-opt", pop).forEach(b => b.classList.toggle("active", b.dataset.ar === p.aspect));
  openPop(pop, $("#btn-aspect"));
});
$$("#aspect-pop .aspect-opt").forEach(b => b.addEventListener("click", () => {
  const p = currentProject();
  if (!p) return;
  p.aspect = b.dataset.ar;
  closePops();
  applyAspect(p);
  save();
  requestAnimationFrame(() => {
    $$("#pages canvas").forEach(c => c._fit && c._fit());
    $$(".panel-text").forEach(fitDescription);
  });
  toast(`Frames set to ${p.aspect}`);
}));

function updateGlobalEye() {
  const p = currentProject();
  if (!p) return;
  const allHidden = allPanels(p).every(x => x.frameHidden);
  $("#btn-hide-frames").classList.toggle("frames-off", allHidden);
}

function toggleFrames() {
  const p = currentProject();
  if (!p) return;
  const hideAll = allPanels(p).some(x => !x.frameHidden);
  allPanels(p).forEach(x => { x.frameHidden = hideAll; applyItemToDom(x, ["frameHidden"]); });
  updateGlobalEye();
  save();
  toast(hideAll ? "All frames hidden" : "All frames shown");
}
/* ============================================================
   SHOT EDITOR — fullscreen focus mode: zoom, pan, brushes,
   image select/move/resize. Pencil or one finger draws, two
   fingers pan/zoom (which doubles as palm rejection).
   ============================================================ */

const ED = {
  on: false, panel: null,
  z: 1, tx: 0, ty: 0, fit: 1,
  tool: "pen",
  sel: null,
  live: null, preSnap: null,
  pointers: new Map(),
  gesture: null, // {t: "stroke" | "pan" | "pinch" | "img-move" | "img-resize", ...}
  space: false,
};
const edEl = $("#editor");
const edStage = $("#ed-stage");
const edCanvas = $("#ed-canvas");
const edCtx = edCanvas.getContext("2d");
const edBg = document.createElement("canvas");   // composited art at the current view
const edLiveC = document.createElement("canvas"); // art + in-progress stroke
const EDPR = Math.min(window.devicePixelRatio || 1, 2);

let edTextCommit = null;
function edCommitTextNow() { if (edTextCommit) edTextCommit(); }

function edScale() { return ED.fit * ED.z; }
function edLH() { return logicalH(currentProject()); }
function edToLogical(cx, cy) {
  const r = edStage.getBoundingClientRect();
  const s = edScale();
  return { x: (cx - r.left - ED.tx) / s, y: (cy - r.top - ED.ty) / s };
}

function edOpen(panel) {
  const p = currentProject();
  if (!p || ED.on) return;
  commitActiveText();
  ED.on = true;
  ED.panel = panel;
  ED.z = 1;
  ED.sel = null;
  ED.live = null;
  ED.gesture = null;
  ED.pointers.clear();
  edSetToolSilent("pen");
  edEl.hidden = false;
  document.body.classList.add("ed-open");
  $("#ed-label").textContent = panel.num || "—";
  $("#ed-title").textContent = panel.title || "Untitled shot";
  edResize();
  updateUndoButtons();
  updateBrushUI();
  edEl.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: "ease-out" });
  edStage.animate(
    [{ transform: "scale(.93)", opacity: 0 }, { transform: "none", opacity: 1 }],
    { duration: 300, easing: "cubic-bezier(.3, 1.2, .4, 1)" }
  );
  edInvalidate();
}

function edClose() {
  if (!ED.on) return;
  edCommitTextNow();
  if (ED.live) { ED.live = null; ED.preSnap = null; }
  const panel = ED.panel;
  ED.on = false;
  ED.panel = null;
  edDeselect();
  document.body.classList.remove("ed-open");
  closePops();
  const anim = edEl.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: "ease-in" });
  anim.onfinish = () => { edEl.hidden = true; };
  redrawBoardPanel(panel.id, false);
  updateUndoButtons();
  save();
}

function edResize() {
  const r = edStage.getBoundingClientRect();
  edCanvas.width = edBg.width = edLiveC.width = Math.max(1, Math.round(r.width * EDPR));
  edCanvas.height = edBg.height = edLiveC.height = Math.max(1, Math.round(r.height * EDPR));
  const LH = edLH();
  ED.fit = Math.min((r.width - 70) / LW, (r.height - 70) / LH) || 0.1;
  edCenterView();
}
function edCenterView() {
  const r = edStage.getBoundingClientRect();
  const s = edScale();
  ED.tx = (r.width - LW * s) / 2;
  ED.ty = (r.height - edLH() * s) / 2;
}

/* ---- rendering ---- */

let edDirty = false;
function edInvalidate() {
  if (!ED.on || edDirty) return;
  edDirty = true;
  requestAnimationFrame(() => {
    edDirty = false;
    if (!ED.on) return;
    edBuildBg();
    edPaint();
  });
}

function edArtTransform(g) {
  const s = edScale() * EDPR;
  g.setTransform(s, 0, 0, s, ED.tx * EDPR, ED.ty * EDPR);
}

function edBuildBg() {
  const g = edBg.getContext("2d");
  const LH = edLH();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, edBg.width, edBg.height);
  edArtTransform(g);
  g.save();
  rr(g, 0, 0, LW, LH, FRAME_R);
  g.clip();
  drawArt(g, ED.panel?.drawing, LH, src => imgCache.get(src, edInvalidate));
  g.restore();
  g.setTransform(1, 0, 0, 1, 0, 0);
}

function edComposeLive(stroke = ED.live) {
  const g = edLiveC.getContext("2d");
  const LH = edLH();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, edLiveC.width, edLiveC.height);
  g.drawImage(edBg, 0, 0);
  edArtTransform(g);
  g.save();
  rr(g, 0, 0, LW, LH, FRAME_R);
  g.clip();
  strokePaths.delete(stroke);
  drawOp(g, stroke);
  g.restore();
  g.setTransform(1, 0, 0, 1, 0, 0);
}

function edPaint() {
  if (!ED.on) return;
  const g = edCtx;
  const LH = edLH();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, edCanvas.width, edCanvas.height);
  // white frame under the art
  edArtTransform(g);
  rr(g, 0, 0, LW, LH, FRAME_R);
  g.fillStyle = "#fff";
  g.fill();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.drawImage(ED.live ? edLiveC : edBg, 0, 0);
  // frame border, constant on-screen weight
  edArtTransform(g);
  rr(g, 0, 0, LW, LH, FRAME_R);
  g.lineWidth = 2.5 / edScale();
  g.strokeStyle = "#141414";
  g.stroke();
  g.setTransform(1, 0, 0, 1, 0, 0);
  $("#ed-zoom-chip").textContent = Math.round(ED.z * 100) + "%";
  edUpdateSelDom();
}

/* ---- zoom & pan ---- */

function edZoomAt(sx, sy, f) {
  const z2 = Math.min(10, Math.max(0.35, ED.z * f));
  f = z2 / ED.z;
  ED.tx = sx - (sx - ED.tx) * f;
  ED.ty = sy - (sy - ED.ty) * f;
  ED.z = z2;
  edInvalidate();
}
function edZoomCenter(f) {
  const r = edStage.getBoundingClientRect();
  edZoomAt(r.width / 2, r.height / 2, f);
}
function edZoomFit() {
  ED.z = 1;
  edCenterView();
  edInvalidate();
}

edStage.addEventListener("wheel", e => {
  if (!ED.on) return;
  e.preventDefault();
  const r = edStage.getBoundingClientRect();
  if (e.ctrlKey || e.metaKey) {
    edZoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.01));
  } else {
    ED.tx -= e.deltaX;
    ED.ty -= e.deltaY;
    edInvalidate();
  }
}, { passive: false });

/* ---- strokes ---- */

function edStartStroke(e) {
  ED.preSnap = snapDrawing(ED.panel.drawing);
  ED.live = ED.tool === "eraser"
    ? { size: eraserSize, opacity: 1, eraser: true, pts: [] }
    : { color: brush.color, size: brush.size, opacity: brush.opacity, pts: [] };
  const pr = pressureOf(e);
  coalesced(e).forEach(ce => {
    const l = edToLogical(ce.clientX, ce.clientY);
    addPoint(ED.live, l.x, l.y, pressureOf(ce));
  });
  if (ED.live.pts.length < 6) {
    const l = edToLogical(e.clientX, e.clientY);
    addPoint(ED.live, l.x + 0.01, l.y + 0.01, pr); // dot on tap
  }
  ED.gesture = { t: "stroke" };
  edComposeLive();
  edPaint();
}
function edEndStroke(commit) {
  const s = ED.live;
  if (!s) return;
  ED.live = null;
  strokePaths.delete(s);
  if (commit && s.pts.length >= 3) {
    ensureDrawing(ED.panel).strokes.push(s);
    pushHist(ED.panel, ED.preSnap);
    saveSoon();
  }
  ED.preSnap = null;
  edInvalidate();
}

/* ---- image selection ---- */

function edSelect(im) {
  ED.sel = im;
  $("#ed-sel").hidden = false;
  edUpdateSelDom();
}
function edDeselect() {
  ED.sel = null;
  const s = $("#ed-sel");
  if (s) s.hidden = true;
}
function edUpdateSelDom() {
  if (!ED.sel) return;
  const imgs = ED.panel?.drawing?.images || [];
  if (!imgs.includes(ED.sel)) return edDeselect(); // undone / deleted from under us
  const s = edScale();
  const el = $("#ed-sel");
  el.style.left = (ED.sel.x * s + ED.tx) + "px";
  el.style.top = (ED.sel.y * s + ED.ty) + "px";
  el.style.width = (ED.sel.w * s) + "px";
  el.style.height = (ED.sel.h * s) + "px";
}
function edSelectAt(e) {
  const l = edToLogical(e.clientX, e.clientY);
  const imgs = ED.panel.drawing?.images || [];
  for (let i = imgs.length - 1; i >= 0; i--) {
    const im = imgs[i];
    if (l.x >= im.x && l.x <= im.x + im.w && l.y >= im.y && l.y <= im.y + im.h) {
      edSelect(im);
      ED.gesture = { t: "img-move", pre: snapDrawing(ED.panel.drawing), lx: l.x, ly: l.y, x0: im.x, y0: im.y, moved: false };
      return;
    }
  }
  edDeselect();
}
function edDeleteSel() {
  if (!ED.sel) return;
  const d = ED.panel.drawing;
  const pre = snapDrawing(d);
  d.images = d.images.filter(im => im !== ED.sel);
  pushHist(ED.panel, pre);
  edDeselect();
  saveSoon();
  edInvalidate();
  toast("Image removed");
}
function edReorderSel(dir) {
  if (!ED.sel) return;
  const imgs = ED.panel.drawing.images;
  const i = imgs.indexOf(ED.sel);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= imgs.length) return;
  const pre = snapDrawing(ED.panel.drawing);
  [imgs[i], imgs[j]] = [imgs[j], imgs[i]];
  pushHist(ED.panel, pre);
  saveSoon();
  edInvalidate();
}

/* corner handles: drag to resize, aspect locked, opposite corner anchored */
$$("#ed-sel .h").forEach(h => {
  h.addEventListener("pointerdown", e => {
    if (!ED.sel) return;
    e.stopPropagation();
    e.preventDefault();
    try { edStage.setPointerCapture(e.pointerId); } catch (err) {}
    const im = ED.sel;
    const nw = h.classList.contains("nw"), ne = h.classList.contains("ne"), sw = h.classList.contains("sw");
    const dirX = (nw || sw) ? -1 : 1;
    const dirY = (nw || ne) ? -1 : 1;
    ED.gesture = {
      t: "img-resize",
      pre: snapDrawing(ED.panel.drawing),
      ax: dirX > 0 ? im.x : im.x + im.w,
      ay: dirY > 0 ? im.y : im.y + im.h,
      ratio: im.w / im.h,
      dirX, dirY,
      moved: false,
    };
  });
});
$("#ed-sel .ed-sel-bar").addEventListener("pointerdown", e => e.stopPropagation());
$("#ed-img-del").addEventListener("click", edDeleteSel);
$("#ed-img-front").addEventListener("click", () => edReorderSel(+1));
$("#ed-img-back").addEventListener("click", () => edReorderSel(-1));

/* ---- unified pointer gestures on the stage ---- */

function edStartPinch() {
  const [a, b] = [...ED.pointers.values()];
  ED.gesture = { t: "pinch", d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
}
function edPinchMove() {
  if (ED.pointers.size < 2) return;
  const [a, b] = [...ED.pointers.values()];
  const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const g = ED.gesture;
  const r = edStage.getBoundingClientRect();
  edZoomAt(mx - r.left, my - r.top, d / g.d);
  ED.tx += mx - g.mx;
  ED.ty += my - g.my;
  g.d = d; g.mx = mx; g.my = my;
  edInvalidate();
}

edStage.addEventListener("pointerdown", e => {
  if (!ED.on) return;
  if (e.target.closest(".ed-sel") || e.target.closest(".canvas-text-input")) return;
  try { edStage.setPointerCapture(e.pointerId); } catch (err) {}
  ED.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (ED.pointers.size === 2) {
    if (ED.gesture?.t === "stroke") edEndStroke(false); // two fingers = never a stroke
    edStartPinch();
    return;
  }
  if (ED.pointers.size > 2) return;
  edCommitTextNow();
  const drawTool = ED.tool === "pen" || ED.tool === "eraser";
  const touchPans = e.pointerType === "touch" && Date.now() - lastPenAt < 45000; // pencil user: finger pans
  if (ED.tool === "pan" || ED.space || e.button === 1 || (drawTool && touchPans)) {
    ED.gesture = { t: "pan", sx: e.clientX, sy: e.clientY, tx0: ED.tx, ty0: ED.ty };
    return;
  }
  if (drawTool) { e.preventDefault(); edStartStroke(e); return; }
  if (ED.tool === "text") { edBeginText(e); return; }
  if (ED.tool === "select") edSelectAt(e);
});

edStage.addEventListener("pointermove", e => {
  if (!ED.on) return;
  const pt = ED.pointers.get(e.pointerId);
  if (pt) { pt.x = e.clientX; pt.y = e.clientY; }
  edCursor(e);
  const g = ED.gesture;
  if (!g) return;
  if (g.t === "pinch") { edPinchMove(); return; }
  if (g.t === "pan") {
    if (!pt) return;
    ED.tx = g.tx0 + e.clientX - g.sx;
    ED.ty = g.ty0 + e.clientY - g.sy;
    edInvalidate();
    return;
  }
  if (g.t === "stroke" && ED.live) {
    coalesced(e).forEach(ce => {
      const l = edToLogical(ce.clientX, ce.clientY);
      addPoint(ED.live, l.x, l.y, pressureOf(ce));
    });
    edComposeLive(withPrediction(ED.live, e, (cx, cy) => edToLogical(cx, cy)));
    edPaint();
    return;
  }
  if (g.t === "img-move" && ED.sel) {
    const l = edToLogical(e.clientX, e.clientY);
    ED.sel.x = g.x0 + (l.x - g.lx);
    ED.sel.y = g.y0 + (l.y - g.ly);
    g.moved = true;
    edInvalidate();
    return;
  }
  if (g.t === "img-resize" && ED.sel) {
    const l = edToLogical(e.clientX, e.clientY);
    const im = ED.sel;
    let w = Math.max(40, (l.x - g.ax) * g.dirX);
    let h = Math.max(40 / g.ratio, (l.y - g.ay) * g.dirY);
    if (w / g.ratio > h) h = w / g.ratio; else w = h * g.ratio;
    im.w = w; im.h = h;
    im.x = g.dirX > 0 ? g.ax : g.ax - w;
    im.y = g.dirY > 0 ? g.ay : g.ay - h;
    g.moved = true;
    edInvalidate();
  }
});

function edPointerEnd(e) {
  if (!ED.on) return;
  ED.pointers.delete(e.pointerId);
  const g = ED.gesture;
  if (!g) return;
  if (g.t === "pinch") {
    if (ED.pointers.size < 2) ED.gesture = null;
    return;
  }
  if (g.t === "stroke") {
    if (ED.live && e.type === "pointerup") { // land the last point where the pointer stopped
      const l = edToLogical(e.clientX, e.clientY);
      addPoint(ED.live, l.x, l.y, pressureOf(e), true);
    }
    edEndStroke(true);
  }
  if ((g.t === "img-move" || g.t === "img-resize") && g.moved) {
    pushHist(ED.panel, g.pre);
    saveSoon();
  }
  ED.gesture = null;
}
edStage.addEventListener("pointerup", edPointerEnd);
edStage.addEventListener("pointercancel", edPointerEnd);
edStage.addEventListener("pointerleave", () => { $("#ed-cursor").hidden = true; });

/* brush-size cursor ring */
function edCursor(e) {
  const c = $("#ed-cursor");
  const drawTool = ED.tool === "pen" || ED.tool === "eraser";
  const size = (ED.tool === "eraser" ? eraserSize : brush.size) * edScale();
  if (!drawTool || e.pointerType === "touch" || ED.gesture?.t === "pan" || ED.gesture?.t === "pinch" || size < 5) {
    c.hidden = true;
    return;
  }
  const r = edStage.getBoundingClientRect();
  c.hidden = false;
  c.style.left = (e.clientX - r.left) + "px";
  c.style.top = (e.clientY - r.top) + "px";
  c.style.width = c.style.height = size + "px";
}

/* ---- text tool in the editor ---- */

function edBeginText(e) {
  edCommitTextNow();
  const r = edStage.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top - 10;
  const myColor = brush.color;
  const panel = ED.panel;

  const ta = document.createElement("textarea");
  ta.className = "canvas-text-input";
  ta.rows = 1;
  ta.style.left = x + "px";
  ta.style.top = y + "px";
  ta.style.color = myColor;
  edStage.appendChild(ta);

  const grow = () => {
    ta.style.width = "24px";
    ta.style.width = Math.min(ta.scrollWidth + 4, r.width - x - 4) + "px";
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
  };
  grow();
  requestAnimationFrame(() => ta.focus());

  let done = false;
  const finish = commit => {
    if (done) return; done = true;
    if (edTextCommit === doCommit) edTextCommit = null;
    const val = ta.value.replace(/\s+$/, "");
    ta.remove();
    if (!commit || !val || !ED.on) return;
    const l = edToLogical(e.clientX, e.clientY - 10);
    const op = { text: val, x: l.x, y: l.y, size: Math.max(8, 15 / edScale()), color: myColor };
    const pre = snapDrawing(panel.drawing);
    ensureDrawing(panel).strokes.push(op);
    pushHist(panel, pre);
    saveSoon();
    edInvalidate();
  };
  const doCommit = () => finish(true);
  edTextCommit = doCommit;

  ta.addEventListener("input", grow);
  ta.addEventListener("keydown", ev => {
    ev.stopPropagation();
    if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); finish(true); }
    else if (ev.key === "Escape") finish(false);
  });
  ta.addEventListener("blur", () => finish(true));
  ta.addEventListener("pointerdown", ev => ev.stopPropagation());
}

/* ---- editor toolbar ---- */

function edSetToolSilent(t) {
  ED.tool = t;
  $$("#editor [data-edtool]").forEach(b => b.classList.toggle("active", b.dataset.edtool === t));
  edStage.dataset.tool = t;
}
function edSetTool(t) {
  edCommitTextNow();
  edSetToolSilent(t);
  if (t !== "select") edDeselect();
  $("#ed-cursor").hidden = true;
}
$$("#editor [data-edtool]").forEach(b => b.addEventListener("click", () => edSetTool(b.dataset.edtool)));
$("#ed-close").addEventListener("click", edClose);
$("#ed-done").addEventListener("click", edClose);
$("#ed-undo").addEventListener("click", () => { if (ED.panel) undoDrawing(ED.panel); });
$("#ed-redo").addEventListener("click", () => { if (ED.panel) redoDrawing(ED.panel); });
$("#ed-zoom-in").addEventListener("click", () => edZoomCenter(1.25));
$("#ed-zoom-out").addEventListener("click", () => edZoomCenter(0.8));
$("#ed-zoom-fit").addEventListener("click", edZoomFit);
$("#ed-import").addEventListener("click", () => $("#ed-file").click());
$("#ed-file").addEventListener("change", e => {
  if (ED.on) [...e.target.files].forEach(f => importImageToPanel(ED.panel, f));
  e.target.value = "";
});

/* ---------- PDF export: render each page to a canvas, wrap the JPEGs
   in a hand-built PDF, and download it directly ---------- */

/* page sized to the content so the grid fills the sheet edge-to-edge:
   2 columns of full-width frames at the project's aspect, like on screen */
/* page geometry: fixed width, columns from the grid, height from the rows
   this page actually holds (scene rows and notes make pages taller) */
const PDF_W = 1190, PDF_MX = 70, PDF_GAP = 36, PDF_TOP = 64, PDF_GRID_TOP = 142;
const PDF_SCENE_H = 44, PDF_NOTE_LH = 24, PDF_NOTE_MAX = 2;

function noteLineCount(item) {
  const lines = richToLines(item.noteRich || "");
  return lines.some(l => l.length) ? Math.min(PDF_NOTE_MAX, lines.length) : 0;
}

function pdfPageLayout(p, page) {
  const cols = p.cols || DEFAULT_COLS;
  const colW = (PDF_W - PDF_MX * 2 - PDF_GAP * (cols - 1)) / cols;
  const frameH = Math.round(colW / arOf(p));
  const rows = [];
  let y = PDF_GRID_TOP, row = null;
  const closeRow = () => { if (!row) return; rows.push(row); y += row.h + PDF_GAP; row = null; };
  page.items.forEach(item => {
    if (item.kind === "scene") {
      closeRow();
      rows.push({ kind: "scene", y, h: PDF_SCENE_H, item });
      y += PDF_SCENE_H + 20;
      return;
    }
    if (!row || row.items.length === cols) { closeRow(); row = { kind: "shots", y, h: 0, items: [], noteLines: 0 }; }
    row.items.push(item);
    row.noteLines = Math.max(row.noteLines, noteLineCount(item));
    row.h = 46 + row.noteLines * PDF_NOTE_LH + frameH + 14 + 4 * 26 + 4; // title + note + frame + 4 text lines
  });
  closeRow();
  const H = Math.round(y - PDF_GAP + 56);
  const wPt = 595.28;
  return { W: PDF_W, H, wPt, hPt: +(wPt * H / PDF_W).toFixed(2), cols, colW, frameH, rows };
}

function rr(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function fitText(g, s, maxW) {
  if (g.measureText(s).width <= maxW) return s;
  while (s && g.measureText(s + "…").width > maxW) s = s.slice(0, -1);
  return s + "…";
}

/* rich HTML -> [[{t, bold}], ...] one array per hard line */
function richToLines(html) {
  const root = document.createElement("div");
  root.innerHTML = html || "";
  const lines = [[]];
  (function walk(node, bold) {
    node.childNodes.forEach(n => {
      if (n.nodeType === 3) { if (n.textContent) lines[lines.length - 1].push({ t: n.textContent, bold }); }
      else if (n.nodeName === "BR") lines.push([]);
      else if (n.nodeName === "DIV" || n.nodeName === "P") {
        if (lines[lines.length - 1].length) lines.push([]);
        walk(n, bold);
      }
      else walk(n, bold || n.nodeName === "B" || n.nodeName === "STRONG");
    });
  })(root, false);
  while (lines.length > 1 && !lines[lines.length - 1].length) lines.pop();
  return lines;
}

/* word-wrapped rich text; returns number of lines drawn */
function drawRich(g, lines, x, y, maxW, lineH, fontPx, maxLines, color, fam) {
  g.fillStyle = color;
  let cx = x, line = 0;
  const setF = b => { g.font = `${b ? "bold" : "normal"} ${fontPx}px ${fam}`; };
  outer:
  for (let li = 0; li < lines.length; li++) {
    for (const seg of lines[li]) {
      setF(seg.bold);
      for (const tok of seg.t.split(/(\s+)/)) {
        if (!tok) continue;
        const w = g.measureText(tok).width;
        if (cx + w > x + maxW && cx > x) {
          line++;
          if (line >= maxLines) { g.fillText("…", cx, y + (maxLines - 1) * lineH); break outer; }
          cx = x;
          if (/^\s+$/.test(tok)) continue;
        }
        g.fillText(tok, cx, y + line * lineH);
        cx += w;
      }
    }
    if (li < lines.length - 1) {
      line++;
      if (line >= maxLines) { g.fillText("…", cx, y + (maxLines - 1) * lineH); break; }
      cx = x;
    }
  }
  return Math.min(line + 1, maxLines);
}

function renderPageBitmap(project, page, pi, L) {
  const { W, H, colW, frameH, rows } = L;
  const MX = PDF_MX, colGap = PDF_GAP, TOP = PDF_TOP;
  const LH = logicalH(project);
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d");
  const INK = "#141414", MUTED = "#8D877C", LINE = "#E4DFD5";
  const FAM = "system-ui, -apple-system, sans-serif";
  const MONO = "ui-monospace, Menlo, monospace";

  g.fillStyle = "#FFFFFF";
  g.fillRect(0, 0, W, H);
  g.textBaseline = "top";

  g.fillStyle = INK;
  g.font = "bold 36px " + FAM;
  g.fillText(fitText(g, project.name || "Untitled project", W - MX * 2 - 220), MX, TOP);
  g.textAlign = "right";
  g.fillStyle = MUTED;
  g.font = "bold 16px " + MONO;
  g.fillText(`PAGE ${pi + 1} / ${project.pages.length}`, W - MX, TOP + 14);
  g.textAlign = "left";

  rows.forEach(row => {
    if (row.kind === "scene") {
      const it = row.item;
      g.font = "bold 17px " + MONO;
      const label = `SCENE ${it.num || ""}`.trim();
      const bw = Math.ceil(g.measureText(label).width) + 24;
      g.fillStyle = INK;
      rr(g, MX, row.y + 6, bw, 31, 9); g.fill();
      g.fillStyle = "#FFFFFF";
      g.fillText(label, MX + 12, row.y + 14);
      let lineX = MX + bw + 14;
      if (it.title) {
        g.fillStyle = INK;
        g.font = "bold 22px " + FAM;
        const t = fitText(g, it.title, W - MX * 2 - bw - 60);
        g.fillText(t, MX + bw + 16, row.y + 9);
        lineX = MX + bw + 16 + Math.ceil(g.measureText(t).width) + 16;
      }
      g.fillStyle = INK;
      g.fillRect(lineX, row.y + 20, Math.max(0, W - MX - lineX), 3); // rule runs from the title to the margin
      return;
    }
    row.items.forEach((panel, ci) => {
      const cx = MX + ci * (colW + colGap);
      const cy = row.y;

      let tx = cx;
      if (panel.num) {
        g.font = "bold 17px " + MONO;
        const bw = Math.max(38, Math.ceil(g.measureText(panel.num).width) + 20);
        g.fillStyle = INK;
        rr(g, cx, cy, bw, 30, 9); g.fill();
        g.fillStyle = "#FFFFFF";
        g.textAlign = "center";
        g.fillText(panel.num, cx + bw / 2, cy + 8);
        g.textAlign = "left";
        tx = cx + bw + 14;
      }
      if (panel.title) {
        g.fillStyle = INK;
        g.font = "bold 24px " + FAM;
        g.fillText(fitText(g, panel.title, colW - (tx - cx)), tx, cy + 4);
      }

      let ty = cy + 46;
      if (row.noteLines) {
        const nl = richToLines(panel.noteRich || "");
        if (nl.some(l => l.length)) drawRich(g, nl, cx + 2, ty, colW - 2, PDF_NOTE_LH, 16, row.noteLines, MUTED, FAM);
        ty += row.noteLines * PDF_NOTE_LH;
      }
      if (!panel.frameHidden) {
        g.strokeStyle = INK;
        g.lineWidth = 3.5;
        rr(g, cx + 1.75, ty + 1.75, colW - 3.5, frameH - 3.5, 15); g.stroke();
        if (panel.drawing) {
          const art = document.createElement("canvas");
          art.width = (colW - 8) * 2;
          art.height = Math.max(1, Math.round(art.width * LH / LW));
          const ag = art.getContext("2d");
          const s = art.width / LW;
          ag.setTransform(s, 0, 0, s, 0, 0);
          ag.save();
          rr(ag, 0, 0, LW, LH, FRAME_R); ag.clip();
          drawArt(ag, panel.drawing, LH, src => imgCache.get(src)); // preloaded before export
          ag.restore();
          g.save();
          rr(g, cx + 4, ty + 4, colW - 8, frameH - 8, 12); g.clip();
          g.drawImage(art, cx + 4, ty + 4, colW - 8, frameH - 8);
          g.restore();
        }
        ty += frameH + 14;
      } else if (row.noteLines && (panel.note || "").trim()) {
        // no frame: a dashed rule separates the note from the description
        g.strokeStyle = LINE; g.lineWidth = 2; g.setLineDash([8, 6]);
        g.beginPath(); g.moveTo(cx, ty + 4); g.lineTo(cx + colW, ty + 4); g.stroke();
        g.setLineDash([]);
        ty += 14;
      }

      const lines = richToLines(panel.rich || "");
      if (lines.some(l => l.length)) {
        // text-only shots scale up like on screen: short notes big, long text small
        let fontPx = 18;
        if (panel.frameHidden) {
          const len = (panel.text || "").length;
          fontPx = len <= 40 ? 32 : len <= 100 ? 27 : len <= 220 ? 23 : 18;
        }
        const lineH = Math.round(fontPx * 1.45);
        const maxLines = Math.max(1, ((cy + row.h - ty - 4) / lineH) | 0);
        const used = drawRich(g, lines, cx + 16, ty + 2, colW - 16, lineH, fontPx, maxLines, INK, FAM);
        g.fillStyle = LINE;
        g.fillRect(cx, ty + 2, 3.5, used * lineH - 6);
      }
    });
  });

  const bin = atob(c.toDataURL("image/jpeg", 0.92).split(",")[1]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/* pages: [{bytes, W, H, wPt, hPt}] — each page carries its own size */
function pdfFromJpegs(pages) {
  const chunks = [];
  let offset = 0;
  const offsets = {};
  const latin1 = s => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff; return b; };
  const push = d => { const b = typeof d === "string" ? latin1(d) : d; chunks.push(b); offset += b.length; };
  const obj = (n, body) => { offsets[n] = offset; push(`${n} 0 obj\n${body}\nendobj\n`); };

  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  const N = pages.length;
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 3} 0 R`).join(" ")}] /Count ${N} >>`);
  pages.forEach((pg, i) => {
    const pn = 3 + i * 3, cn = pn + 1, xn = pn + 2;
    obj(pn, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pg.wPt} ${pg.hPt}] /Resources << /XObject << /Im ${xn} 0 R >> >> /Contents ${cn} 0 R >>`);
    const cs = `q ${pg.wPt} 0 0 ${pg.hPt} 0 0 cm /Im Do Q`;
    obj(cn, `<< /Length ${cs.length} >>\nstream\n${cs}\nendstream`);
    offsets[xn] = offset;
    push(`${xn} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${pg.W} /Height ${pg.H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${pg.bytes.length} >>\nstream\n`);
    push(pg.bytes);
    push("\nendstream\nendobj\n");
  });
  const total = 2 + N * 3;
  const xrefAt = offset;
  let xref = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= total; n++) xref += String(offsets[n]).padStart(10, "0") + " 00000 n \n";
  push(xref + `trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`);
  return new Blob(chunks, { type: "application/pdf" });
}

function downloadBlob(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function safeName(s, fallback) { return (s || fallback).replace(/[\/\\:*?"<>|]/g, "-"); }

async function exportPDF() {
  commitActiveText();
  edCommitTextNow();
  const p = currentProject();
  if (!p) return;

  // decode every referenced bitmap before rendering
  const srcs = new Set();
  allPanels(p).forEach(x => {
    if (!x.drawing) return;
    if (x.drawing.base) srcs.add(x.drawing.base);
    x.drawing.images.forEach(im => srcs.add(im.src));
  });
  await Promise.all([...srcs].map(s => imgCache.load(s)));

  const pages = p.pages.map((page, pi) => {
    const L = pdfPageLayout(p, page);
    return { bytes: renderPageBitmap(p, page, pi, L), W: L.W, H: L.H, wPt: L.wPt, hPt: L.hPt };
  });
  downloadBlob(pdfFromJpegs(pages), safeName(p.name, "Storyboard") + ".pdf");
  toast("PDF downloaded");
}

/* ---------------- external files: export menus + import ---------------- */

function exportBoard(kind) {
  const p = currentProject();
  if (!p) return;
  if (kind === "pdf") return exportPDF();
  commitActiveText();
  edCommitTextNow();
  if (kind === "txt") {
    downloadBlob(new Blob([TextIO.boardToTxt(p)], { type: "text/plain" }), safeName(p.name, "Storyboard") + ".txt");
    toast("Text downloaded — drawings aren't part of .txt");
  } else {
    downloadBlob(new Blob([TextIO.toBackup(p)], { type: "application/json" }), safeName(p.name, "Storyboard") + ".storyit.json");
    toast("Backup downloaded");
  }
}
function exportScript(kind) {
  const s = currentScript();
  if (!s) return;
  if (kind === "pdf") return exportScriptPDF();
  if (kind === "txt") {
    downloadBlob(new Blob([TextIO.scriptToTxt(s)], { type: "text/plain" }), safeName(s.name, "Script") + ".txt");
    toast("Text downloaded");
  } else {
    downloadBlob(new Blob([TextIO.toBackup(s)], { type: "application/json" }), safeName(s.name, "Script") + ".storyit.json");
    toast("Backup downloaded");
  }
}
$("#btn-export").addEventListener("click", () => openPop($("#export-pop"), $("#btn-export")));
$("#btn-script-export").addEventListener("click", () => openPop($("#script-export-pop"), $("#btn-script-export")));
$$("#export-pop .menu-opt").forEach(b => b.addEventListener("click", () => { closePops(); exportBoard(b.dataset.export); }));
$$("#script-export-pop .menu-opt").forEach(b => b.addEventListener("click", () => { closePops(); exportScript(b.dataset.export); }));

$("#btn-backup-all").addEventListener("click", () => {
  const stamp = new Date().toISOString().slice(0, 10);
  downloadBlob(new Blob([TextIO.toBackup(db)], { type: "application/json" }), `Storyit backup ${stamp}.storyit.json`);
  toast("Backup downloaded");
});

/* import: .txt storyboard / script, or a .storyit.json backup — always creates, never overwrites */
function importText(text, filename) {
  const kind = TextIO.detectImport(text);
  const base = (filename || "Imported").replace(/\.(txt|json)$/i, "").replace(/\.storyit$/i, "");
  if (kind === "board") {
    const p = TextIO.txtToBoard(text);
    if (!p.name) p.name = base;
    db.projects.push(p);
    return { projects: [p], scripts: [], note: "Drawings aren't stored in .txt" };
  }
  if (kind === "script") {
    const sc = TextIO.txtToScript(text);
    if (!sc.name) sc.name = base;
    db.scripts.push(sc);
    return { projects: [], scripts: [sc] };
  }
  if (kind === "backup") {
    const { projects, scripts } = TextIO.fromBackup(text);
    db.projects.push(...projects);
    db.scripts.push(...scripts);
    return { projects, scripts };
  }
  throw new Error("Not a Storyit file");
}

$("#btn-import").addEventListener("click", () => $("#import-file").click());
$("#import-file").addEventListener("change", async e => {
  const files = [...e.target.files];
  e.target.value = "";
  const got = { projects: [], scripts: [] };
  let note = "";
  for (const f of files) {
    try {
      const r = importText(await f.text(), f.name);
      got.projects.push(...r.projects); got.scripts.push(...r.scripts);
      if (r.note) note = r.note;
    } catch (err) {
      toast(`Couldn't read ${f.name}`);
    }
  }
  const n = got.projects.length + got.scripts.length;
  if (!n) return;
  save();
  if (n === 1) {
    got.projects.length ? openProject(got.projects[0].id) : openScript(got.scripts[0].id);
    toast(note ? `Imported — ${note}` : "Imported");
  } else {
    renderHome();
    toast(`Imported ${got.projects.length} storyboard${got.projects.length === 1 ? "" : "s"}, ${got.scripts.length} script${got.scripts.length === 1 ? "" : "s"}`);
  }
});

/* ---------------- wiring ---------------- */

/* new storyboard: pick aspect + grid first */
const createOpts = { aspect: DEFAULT_ASPECT, cols: DEFAULT_COLS, rows: DEFAULT_ROWS };
function renderCreatePop() {
  $$("#create-pop .aspect-opt").forEach(b => b.classList.toggle("active", b.dataset.ar === createOpts.aspect));
  $$("#create-pop .grid-opt").forEach(b => b.classList.toggle("active", +b.dataset.cols === createOpts.cols && +b.dataset.rows === createOpts.rows));
}
$("#btn-new-project").addEventListener("click", () => {
  renderCreatePop();
  openPop($("#create-pop"), $("#btn-new-project"));
});
$$("#create-pop .aspect-opt").forEach(b => b.addEventListener("click", () => { createOpts.aspect = b.dataset.ar; renderCreatePop(); }));
$$("#create-pop .grid-opt").forEach(b => b.addEventListener("click", () => { createOpts.cols = +b.dataset.cols; createOpts.rows = +b.dataset.rows; renderCreatePop(); }));
$("#btn-create-project").addEventListener("click", () => {
  closePops();
  const p = newProject("Untitled project", createOpts.aspect, createOpts.cols, createOpts.rows);
  db.projects.push(p);
  save();
  openProject(p.id);
  setTimeout(() => { const n = $("#project-name"); n.focus(); n.select(); }, 260);
});

/* grid picker inside a project */
$("#btn-grid").addEventListener("click", () => {
  const pop = $("#grid-pop");
  const p = currentProject();
  if (p) $$(".grid-opt", pop).forEach(b => b.classList.toggle("active", +b.dataset.cols === p.cols && +b.dataset.rows === p.rows));
  openPop(pop, $("#btn-grid"));
});
$$("#grid-pop .grid-opt").forEach(b => b.addEventListener("click", () => {
  const p = currentProject();
  closePops();
  if (p) setGrid(p, +b.dataset.cols, +b.dataset.rows);
}));

$("#btn-back").addEventListener("click", goHome);

$("#project-name").addEventListener("input", e => {
  const p = currentProject();
  if (p) { p.name = e.target.value; $("#print-header").textContent = p.name || "Untitled project"; saveSoon(); }
});
$("#project-name").addEventListener("keydown", e => { if (e.key === "Enter") e.target.blur(); });

$("#tool-type").addEventListener("click", () => setTool("type"));
$("#tool-text").addEventListener("click", () => setTool("text"));
$("#tool-pen").addEventListener("click", () => setTool("pen"));
$("#tool-eraser").addEventListener("click", () => setTool("eraser"));

$("#btn-undo").addEventListener("click", () => {
  const t = undoTargetPanel();
  t ? undoDrawing(t) : toast("Nothing to undo yet");
});
$("#btn-redo").addEventListener("click", () => {
  const t = undoTargetPanel();
  t ? redoDrawing(t) : toast("Nothing to redo");
});

$("#btn-export").addEventListener("click", exportPDF);
$("#btn-hide-frames").addEventListener("click", toggleFrames);
$("#btn-add-page").addEventListener("click", addPage);
$("#btn-add-page-bottom").addEventListener("click", addPage);

document.addEventListener("keydown", e => {
  const ae = document.activeElement;
  const typing = /^(INPUT|TEXTAREA)$/.test(ae?.tagName || "") || !!ae?.isContentEditable;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key === "s") { e.preventDefault(); save(); return; }
  if (mod && e.key === "p" && currentId && !ED.on) { e.preventDefault(); exportPDF(); return; }
  if (mod && e.key === "p" && currentScriptId) { e.preventDefault(); exportScriptPDF(); return; }
  if (mod && !typing && e.key.toLowerCase() === "z" && (ED.on || currentId)) {
    const t = undoTargetPanel();
    if (t) { e.preventDefault(); e.shiftKey ? redoDrawing(t) : undoDrawing(t); }
    return;
  }

  if (ED.on) {
    if (typing || mod || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === " ") { ED.space = true; edStage.classList.add("panning"); e.preventDefault(); }
    else if (k === "p") edSetTool("pen");
    else if (k === "e") edSetTool("eraser");
    else if (k === "t") edSetTool("text");
    else if (k === "v") edSetTool("select");
    else if (k === "+" || k === "=") edZoomCenter(1.25);
    else if (k === "-") edZoomCenter(0.8);
    else if (k === "0") edZoomFit();
    else if (k === "backspace" || k === "delete") edDeleteSel();
    else if (k === "escape") { if (ED.sel) edDeselect(); else edClose(); }
    return;
  }

  if (currentScriptId !== null) {
    if (mod && ["=", "+", "-", "_", "0"].includes(e.key)) {
      e.preventDefault();
      if (e.key === "0") resetScriptZoom();
      else zoomScript(e.key === "-" || e.key === "_" ? -0.1 : 0.1);
      return;
    }
    if (e.key === "Escape" && !mod) {
      if (typing) ae.blur();
      else closeScript();
    }
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (currentId === null) return;
  const k = e.key.toLowerCase();
  if (k === "v") setTool("type");
  else if (k === "t") setTool("text");
  else if (k === "p") setTool("pen");
  else if (k === "e") setTool("eraser");
  else if (k === "h") toggleFrames();
  else if (k === "n") addPage();
  else if (k === "escape") goHome();
});
document.addEventListener("keyup", e => {
  if (e.key === " ") { ED.space = false; edStage.classList.remove("panning"); }
});
/* ============================================================
   SCRIPTS — professional screenplay editor
   US Letter, 12pt Courier, industry margins. 1 page ≈ 1 minute.
   ============================================================ */

const SCRIPT_TYPES = ["scene", "action", "character", "parenthetical", "dialogue", "transition", "shot"];
/* what Enter at the end of an element creates next */
const S_NEXT = { scene: "action", action: "action", character: "dialogue", parenthetical: "dialogue", dialogue: "character", transition: "scene", shot: "action" };
/* column widths in characters (Courier = 10 chars/inch @ 12pt) */
const S_WIDTH = { scene: 60, action: 60, character: 33, parenthetical: 25, dialogue: 35, transition: 60, shot: 60 };
/* indent from the 1.5" left margin, in characters */
const S_INDENT = { scene: 0, action: 0, character: 22, parenthetical: 16, dialogue: 10, transition: 0, shot: 0 };
/* element pairs that sit on adjacent lines with no blank line between */
const S_TIGHT = new Set(["character>dialogue", "character>parenthetical", "parenthetical>dialogue", "dialogue>parenthetical"]);
const S_CAPS = new Set(["scene", "character", "transition", "shot"]);
const S_PH = {
  scene: "INT. LOCATION - DAY",
  action: "What happens…",
  character: "CHARACTER",
  parenthetical: "(beat)",
  dialogue: "What they say…",
  transition: "CUT TO:",
  shot: "CLOSE ON -",
};
const LINES_PER_PAGE = 54; // 12pt Courier, 1" top + bottom margins

function newScriptElement(type, text = "") {
  return { id: uid(), type, text, html: escapeHtml(text) };
}
function newScript(name) {
  return { id: uid(), name, author: "", createdAt: Date.now(), updatedAt: Date.now(), elements: [newScriptElement("scene")] };
}

/* keep only text, <b>, <i>, <u>, <br> from contenteditable HTML */
function sanitizeScriptRich(html) {
  const root = document.createElement("div");
  root.innerHTML = html || "";
  const ser = node => [...node.childNodes].map(n => {
    if (n.nodeType === 3) return escapeHtml(n.textContent);
    const t = n.nodeName;
    if (t === "BR") return "<br>";
    if (t === "B" || t === "STRONG") return "<b>" + ser(n) + "</b>";
    if (t === "I" || t === "EM") return "<i>" + ser(n) + "</i>";
    if (t === "U") return "<u>" + ser(n) + "</u>";
    if (t === "DIV" || t === "P") return "<br>" + ser(n);
    return ser(n);
  }).join("");
  return ser(root).replace(/^<br>/, "");
}

/* rich HTML -> hard lines, each an array of {t, b, i, u} runs */
function parseRuns(html) {
  const root = document.createElement("div");
  root.innerHTML = html || "";
  const lines = [[]];
  (function walk(node, st) {
    node.childNodes.forEach(n => {
      if (n.nodeType === 3) { if (n.textContent) lines[lines.length - 1].push({ t: n.textContent, b: st.b, i: st.i, u: st.u }); }
      else if (n.nodeName === "BR") lines.push([]);
      else if (n.nodeName === "DIV" || n.nodeName === "P") { if (lines[lines.length - 1].length) lines.push([]); walk(n, st); }
      else walk(n, {
        b: st.b || n.nodeName === "B" || n.nodeName === "STRONG",
        i: st.i || n.nodeName === "I" || n.nodeName === "EM",
        u: st.u || n.nodeName === "U",
      });
    });
  })(root, { b: false, i: false, u: false });
  while (lines.length > 1 && !lines[lines.length - 1].length) lines.pop();
  return lines;
}

/* greedy word-wrap of one hard line of runs at `width` chars */
function wrapHard(runs, width) {
  const out = [[]];
  let len = 0;
  const put = (t, st) => {
    const line = out[out.length - 1];
    const last = line[line.length - 1];
    if (last && last.b === st.b && last.i === st.i && last.u === st.u) last.t += t;
    else line.push({ t, b: st.b, i: st.i, u: st.u });
    len += t.length;
  };
  const nl = () => { out.push([]); len = 0; };
  for (const r of runs) {
    const st = { b: !!r.b, i: !!r.i, u: !!r.u };
    for (let tok of r.t.split(/(\s+)/)) {
      if (!tok) continue;
      if (/^\s+$/.test(tok)) {
        if (len === 0) continue;
        if (len + tok.length > width) { nl(); continue; }
        put(tok, st);
        continue;
      }
      if (len && len + tok.length > width) nl();
      while (tok.length > width) { // token longer than a whole line: hard-split it
        put(tok.slice(0, width), st);
        tok = tok.slice(width);
        nl();
      }
      if (tok) put(tok, st);
    }
  }
  return out;
}

function wrapAll(hardLines, width) {
  const out = [];
  hardLines.forEach(hl => out.push(...wrapHard(hl, width)));
  return out;
}

/* ---- pagination: shared by the on-screen page breaks and the PDF ---- */

function layoutScript(script) {
  const pages = [], breakBefore = new Map(), contd = new Set();
  let cur = [];
  const blank = () => ({ x: 0, runs: [], blank: true });
  const flush = () => { pages.push(cur); cur = []; };
  let prevType = null, last = null, lastSpeaker = null;

  script.elements.forEach(el => {
    let wrapped = wrapAll(parseRuns(el.html), S_WIDTH[el.type]);
    if (!wrapped.length) wrapped = [[]];
    if (S_CAPS.has(el.type)) wrapped.forEach(l => l.forEach(r => { r.t = r.t.toUpperCase(); }));

    // same character speaking again with no scene change -> (CONT'D)
    if (el.type === "scene") lastSpeaker = null;
    else if (el.type === "character") {
      const name = el.text.replace(/\(.*\)/g, "").trim().toUpperCase();
      if (name && name === lastSpeaker && !/\(CONT'?D\)/i.test(el.text)) {
        contd.add(el.id);
        const lastLine = wrapped[wrapped.length - 1];
        lastLine.push({ t: " (CONT'D)", b: false, i: false, u: false });
      }
      if (name) lastSpeaker = name;
    }
    const lines = wrapped.map(runs => {
      const len = runs.reduce((n, r) => n + r.t.length, 0);
      const x = el.type === "transition" ? Math.max(0, S_WIDTH.transition - len) : S_INDENT[el.type];
      return { x, runs };
    });
    const gap = (prevType === null || S_TIGHT.has(prevType + ">" + el.type)) ? 0 : 1;

    if (cur.length && cur.length + gap + lines.length > LINES_PER_PAGE && lines.length < LINES_PER_PAGE) {
      // element moves whole to the next page; pull a lone heading down with it
      if (last && (last.type === "scene" || last.type === "character") && last.count <= 2 &&
          cur.length - last.count - last.gap > 0) {
        const carried = cur.splice(cur.length - last.count, last.count);
        while (cur.length && cur[cur.length - 1].blank) cur.pop();
        flush();
        breakBefore.set(last.id, pages.length);
        cur.push(...carried);
        if (!S_TIGHT.has(last.type + ">" + el.type)) cur.push(blank());
      } else flush();
    } else if (cur.length) {
      for (let i = 0; i < gap; i++) cur.push(blank());
      if (cur.length >= LINES_PER_PAGE) flush();
    }

    lines.forEach((line, li) => {
      if (cur.length >= LINES_PER_PAGE) flush();
      if (li === 0 && cur.length === 0 && pages.length && !breakBefore.has(el.id))
        breakBefore.set(el.id, pages.length);
      cur.push(line);
    });

    last = { id: el.id, type: el.type, count: lines.length, gap };
    prevType = el.type;
  });
  if (cur.length || !pages.length) flush();
  return { pages, breakBefore, contd };
}

/* ---------------- home cards ---------------- */

function renderScriptCards() {
  const grid = $("#script-grid");
  grid.innerHTML = "";
  const list = [...db.scripts].sort((a, b) => b.updatedAt - a.updatedAt);
  $("#label-scripts").hidden = list.length === 0;

  list.forEach((s, i) => {
    const pages = layoutScript(s).pages.length;
    const scenes = s.elements.filter(el => el.type === "scene" && el.text.trim()).length;
    const card = document.createElement("article");
    card.className = "project-card script-card";
    card.style.setProperty("--i", i);
    const mini = s.elements.filter(el => el.text.trim()).slice(0, 7).map(el =>
      `<i class="t-${el.type}" style="--w:${Math.min(24 + el.text.length * 1.4, 100)}%"></i>`).join("");
    card.innerHTML = `
      <h3></h3>
      <div class="meta">
        <span><b>${pages}</b> page${pages === 1 ? "" : "s"}</span>
        <span><b>${scenes}</b> scene${scenes === 1 ? "" : "s"}</span>
      </div>
      <div class="script-mini">${mini || '<i class="t-action" style="--w:38%"></i>'}</div>
      <button class="hold-delete" title="Hold to delete">${ICON.trash}</button>`;
    $("h3", card).textContent = s.name || "Untitled script";
    card.addEventListener("click", () => openScript(s.id));
    holdButton($(".hold-delete", card), 650, () => {
      card.classList.add("removing");
      setTimeout(() => {
        db.scripts = db.scripts.filter(x => x.id !== s.id);
        save();
        renderHome();
        toast("Script deleted");
      }, 260);
    }, "Hold the trash to delete the script");
    grid.appendChild(card);
  });
}

/* ---------------- editor ---------------- */

function openScript(id) {
  currentScriptId = id;
  switchView($("#view-home"), $("#view-script"), renderScriptEditor);
}
function closeScript() {
  save();
  currentScriptId = null;
  $("#scene-nav").hidden = true; // fixed-position rail would linger over home
  switchView($("#view-script"), $("#view-home"), renderHome);
}

function renderScriptEditor(keepFocus) {
  const s = currentScript();
  if (!s) return closeScript();
  $("#script-name").value = s.name;
  $("#script-author").value = s.author || "";
  if (!scriptZoomStored) scriptZoom = fitScriptZoom();
  applyScriptZoom(scriptZoomStored);
  let navOpen = false;
  try { navOpen = !!localStorage.getItem("storyit.sceneNav"); } catch (e) {}
  const showNav = navOpen && window.innerWidth > 1100; // don't persist the narrow-screen override
  $("#scene-nav").hidden = !showNav;
  $("#btn-scene-nav").classList.toggle("nav-on", showNav);
  const doc = $("#script-doc");
  doc.innerHTML = "";
  s.elements.forEach(el => doc.appendChild(buildScriptEl(el)));
  updateScriptSpacing();
  applyPagination();
  if (keepFocus) return; // a remote re-render must not steal the caret
  const edits = $$(".s-edit", doc);
  const lastEdit = edits[edits.length - 1];
  if (lastEdit) setTimeout(() => focusEditEnd(lastEdit), 240);
}

function buildScriptEl(el) {
  const w = document.createElement("div");
  w.className = "s-el";
  w.dataset.id = el.id;
  w.dataset.type = el.type;
  const edit = document.createElement("div");
  edit.className = "s-edit";
  edit.contentEditable = "true";
  edit.spellcheck = false;
  edit.setAttribute("data-ph", S_PH[el.type]);
  edit.innerHTML = el.html || "";
  w.appendChild(edit);
  return w;
}

/* caret helpers — <br> is ignored consistently on both sides */
function editLen(edit) {
  const r = document.createRange();
  r.selectNodeContents(edit);
  return r.toString().length;
}
function caretTextOffset(edit) {
  const sel = getSelection();
  if (!sel.rangeCount) return 0;
  const r = sel.getRangeAt(0);
  const pre = r.cloneRange();
  pre.selectNodeContents(edit);
  pre.setEnd(r.startContainer, r.startOffset);
  return pre.toString().length;
}
function placeCaret(edit, atEnd) {
  edit.focus();
  const r = document.createRange();
  r.selectNodeContents(edit);
  r.collapse(!atEnd);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}
const focusEditStart = edit => placeCaret(edit, false);
const focusEditEnd = edit => placeCaret(edit, true);
function setCaretAt(edit, off) {
  edit.focus();
  const walker = document.createTreeWalker(edit, NodeFilter.SHOW_TEXT);
  let n, acc = 0;
  while ((n = walker.nextNode())) {
    if (acc + n.length >= off) {
      const r = document.createRange();
      r.setStart(n, off - acc);
      r.collapse(true);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      return;
    }
    acc += n.length;
  }
  focusEditEnd(edit);
}
function caretOnEdgeLine(edit, up) {
  const sel = getSelection();
  if (!sel.rangeCount) return true;
  const rects = sel.getRangeAt(0).getClientRects();
  if (!rects.length) return true; // empty element
  const cr = rects[0], er = edit.getBoundingClientRect();
  const lh = parseFloat(getComputedStyle(edit).lineHeight) || 20;
  return up ? (cr.top - er.top < lh * 0.6) : (er.bottom - cr.bottom < lh * 0.6);
}

function elFromEdit(edit) {
  const w = edit.closest(".s-el");
  const s = currentScript();
  return { w, el: s ? s.elements.find(x => x.id === w.dataset.id) : null };
}
function prevElWrap(w) {
  let n = w.previousElementSibling;
  while (n && !n.classList.contains("s-el")) n = n.previousElementSibling;
  return n;
}
function nextElWrap(w) {
  let n = w.nextElementSibling;
  while (n && !n.classList.contains("s-el")) n = n.nextElementSibling;
  return n;
}

function syncEdit(el, edit) {
  if (edit.innerHTML === "<br>" || edit.innerHTML === "<div><br></div>") edit.innerHTML = "";
  el.html = sanitizeScriptRich(edit.innerHTML);
  el.text = edit.innerText.replace(/\n+$/, "");
}

function setElType(el, w, type) {
  if (el.type === type) return;
  el.type = type;
  w.dataset.type = type;
  const edit = $(".s-edit", w);
  edit.setAttribute("data-ph", S_PH[type]);
  if (type !== "character") delete edit.dataset.sug;
  updateScriptSpacing();
  if (w.contains(document.activeElement)) updateTypeToolbar(type);
  saveSoon();
  paginateSoon();
}

/* autoformat: recognize what the writer is typing and switch the element */
function autoFormatScript(el, w) {
  const t = el.text.trim();
  if (el.type === "action") {
    if (/^(INT|EXT|EST|I\/E|INT\/EXT)[.\s\/]/i.test(t)) return setElType(el, w, "scene");
    if (/TO:$/.test(t) && t === t.toUpperCase() && t.length <= 26 && !t.includes("\n")) return setElType(el, w, "transition");
    if (/^(ANGLE ON|CLOSE ON|POV|INSERT|BACK TO)\b/.test(t) && t === t.toUpperCase()) return setElType(el, w, "shot");
  }
  if (el.type === "dialogue" && t.startsWith("(")) return setElType(el, w, "parenthetical");
}

/* ---- character-name autocomplete: ghost-complete names already in the script ---- */

function characterNames(s, exceptId) {
  const counts = new Map();
  s.elements.forEach(el => {
    if (el.type !== "character" || el.id === exceptId) return;
    const name = el.text.replace(/\(.*\)/g, "").trim().toUpperCase();
    if (name) counts.set(name, (counts.get(name) || 0) + 1);
  });
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0]);
}

function updateCharSuggestion(el, edit) {
  delete edit.dataset.sug;
  if (el.type !== "character") return;
  const typed = el.text.trim().toUpperCase();
  if (!typed || el.text.includes("(")) return;
  const s = currentScript();
  const hit = characterNames(s, el.id).find(n => n.startsWith(typed) && n !== typed);
  if (hit && caretTextOffset(edit) === editLen(edit)) edit.dataset.sug = hit.slice(typed.length);
}

function acceptCharSuggestion(el, edit) {
  const sug = edit.dataset.sug;
  if (!sug) return false;
  delete edit.dataset.sug;
  edit.textContent = el.text.trimEnd() + sug;
  syncEdit(el, edit);
  focusEditEnd(edit);
  saveSoon();
  return true;
}

function updateScriptSpacing() {
  let prev = null;
  $$("#script-doc .s-el").forEach(w => {
    w.classList.toggle("tight", prev !== null && S_TIGHT.has(prev + ">" + w.dataset.type));
    prev = w.dataset.type;
  });
}

function updateTypeToolbar(type) {
  $$("#script-toolbar .ttool").forEach(b => b.classList.toggle("active", b.dataset.stype === type));
}

let paginateTimer = null;
function paginateSoon() {
  clearTimeout(paginateTimer);
  paginateTimer = setTimeout(applyPagination, 250);
}

function applyPagination() {
  const s = currentScript();
  if (!s) return;
  const layout = layoutScript(s);
  $$("#script-doc .s-break").forEach(b => b.remove());
  let scn = 0;
  const sceneById = new Map();
  s.elements.forEach(el => { if (el.type === "scene") sceneById.set(el.id, ++scn); });
  $$("#script-doc .s-el").forEach(w => {
    const pg = layout.breakBefore.get(w.dataset.id);
    if (pg !== undefined) {
      const d = document.createElement("div");
      d.className = "s-break";
      d.innerHTML = `<span>PAGE ${pg + 1}</span>`;
      w.parentNode.insertBefore(d, w);
    }
    w.classList.toggle("contd", layout.contd.has(w.dataset.id));
    const num = sceneById.get(w.dataset.id);
    if (num) w.dataset.scn = num;
    else delete w.dataset.scn;
  });
  const n = Math.max(1, layout.pages.length);
  $("#script-pagecount").textContent = n + (n === 1 ? " page" : " pages");
  renderSceneNav(s);
}

/* ---- scene navigator ---- */

function renderSceneNav(s) {
  const list = $("#scene-nav-list");
  list.innerHTML = "";
  let n = 0;
  s.elements.forEach(el => {
    if (el.type !== "scene") return;
    n++;
    const row = document.createElement("button");
    row.className = "scene-nav-row";
    row.innerHTML = `<span class="scene-nav-num">${n}</span><span class="scene-nav-txt"></span>`;
    $(".scene-nav-txt", row).textContent = (el.text.trim() || "Untitled scene").toUpperCase();
    row.addEventListener("click", () => {
      const w = document.querySelector(`#script-doc .s-el[data-id="${el.id}"]`);
      if (!w) return;
      w.scrollIntoView({ behavior: "smooth", block: "center" });
      w.classList.remove("flash"); void w.offsetWidth; w.classList.add("flash");
    });
    list.appendChild(row);
  });
  if (!n) list.innerHTML = '<div class="scene-nav-empty">No scenes yet</div>';
}

function toggleSceneNav(force) {
  const nav = $("#scene-nav");
  const show = force !== undefined ? force : nav.hidden;
  nav.hidden = !show;
  $("#btn-scene-nav").classList.toggle("nav-on", show);
  try { localStorage.setItem("storyit.sceneNav", show ? "1" : ""); } catch (e) {}
}

/* ---- zoom (buttons, ⌘+/−/0, pinch / ⌘scroll) ---- */

/* the sheet is a fixed 816px US-Letter page; zoom scales the whole sheet
   (CSS zoom, so layout + scrolling follow) and the text never rewraps */
const SHEET_W = 816;
const clampZoom = z => Math.min(2.5, Math.max(0.35, z));
let scriptZoom = 1, scriptZoomStored = false;
try {
  const v = parseFloat(localStorage.getItem("storyit.scriptZoom"));
  if (v > 0) { scriptZoom = clampZoom(v); scriptZoomStored = true; }
} catch (e) {}

/* zoom that fits the sheet in the stage on narrow screens (never above 100%) */
function fitScriptZoom() {
  const avail = $("#script-stage").clientWidth - 40;
  return clampZoom(Math.min(1, avail / SHEET_W));
}
function applyScriptZoom(persist = true) {
  $("#script-paper").style.zoom = scriptZoom;
  $("#btn-zoom-reset").textContent = Math.round(scriptZoom * 100) + "%";
  if (persist) {
    scriptZoomStored = true;
    try { localStorage.setItem("storyit.scriptZoom", scriptZoom); } catch (e) {}
  }
}
function zoomScript(delta) {
  scriptZoom = clampZoom(scriptZoom + delta);
  applyScriptZoom();
}
function resetScriptZoom() {
  scriptZoom = fitScriptZoom();
  applyScriptZoom();
}

function removeScriptEl(el, w) {
  const s = currentScript();
  s.elements = s.elements.filter(x => x.id !== el.id);
  if (!s.elements.length) {
    const ne = newScriptElement("scene");
    s.elements.push(ne);
    $("#script-doc").appendChild(buildScriptEl(ne));
  }
  w.remove();
  updateScriptSpacing();
  saveSoon();
  paginateSoon();
}

/* ---- editor events (delegated) ---- */

const scriptDoc = $("#script-doc");

scriptDoc.addEventListener("input", e => {
  const edit = e.target.closest?.(".s-edit");
  if (!edit) return;
  const { w, el } = elFromEdit(edit);
  if (!el) return;
  syncEdit(el, edit);
  autoFormatScript(el, w);
  updateCharSuggestion(el, edit);
  saveSoon();
  paginateSoon();
});

scriptDoc.addEventListener("paste", e => {
  const edit = e.target.closest?.(".s-edit");
  if (!edit) return;
  e.preventDefault();
  document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
});

scriptDoc.addEventListener("focusin", e => {
  const edit = e.target.closest?.(".s-edit");
  if (!edit) return;
  const { el } = elFromEdit(edit);
  if (el) updateTypeToolbar(el.type);
});

/* parentheticals get their parens on the way out */
scriptDoc.addEventListener("focusout", e => {
  const edit = e.target.closest?.(".s-edit");
  if (!edit) return;
  const { el } = elFromEdit(edit);
  if (!el) return;
  delete edit.dataset.sug;
  const t = el.text.trim();
  if (el.type === "parenthetical" && t && !/^\(.*\)$/s.test(t)) {
    edit.innerHTML = escapeHtml("(" + t.replace(/^\(+|\)+$/g, "") + ")");
    syncEdit(el, edit);
    saveSoon();
    paginateSoon();
  }
});

scriptDoc.addEventListener("keydown", e => {
  const edit = e.target.closest?.(".s-edit");
  if (!edit) return;
  const { w, el } = elFromEdit(edit);
  if (!el) return;
  const s = currentScript();
  const mod = e.metaKey || e.ctrlKey;

  if (mod && !e.shiftKey && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === "b" || k === "i" || k === "u") {
      e.preventDefault();
      document.execCommand(k === "b" ? "bold" : k === "i" ? "italic" : "underline");
      syncEdit(el, edit);
      saveSoon();
      return;
    }
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= 7) {
      e.preventDefault();
      setElType(el, w, SCRIPT_TYPES[n - 1]);
      return;
    }
    return;
  }

  if (e.key === "ArrowRight" && edit.dataset.sug) {
    if (acceptCharSuggestion(el, edit)) { e.preventDefault(); return; }
  }
  if (e.key === "Escape" && edit.dataset.sug) {
    delete edit.dataset.sug;
    e.stopPropagation();
    return;
  }

  if (e.key === "Tab") {
    e.preventDefault();
    const i = SCRIPT_TYPES.indexOf(el.type);
    const step = e.shiftKey ? SCRIPT_TYPES.length - 1 : 1;
    setElType(el, w, SCRIPT_TYPES[(i + step) % SCRIPT_TYPES.length]);
    return;
  }

  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (edit.dataset.sug) acceptCharSuggestion(el, edit); // take the name, then fall through to the split
    if (!editLen(edit) && el.type !== "action") { setElType(el, w, "action"); return; }
    const sel = getSelection();
    if (!sel.rangeCount) return;
    const r = sel.getRangeAt(0);
    r.deleteContents();
    const after = document.createRange();
    after.selectNodeContents(edit);
    after.setStart(r.startContainer, r.startOffset);
    const frag = after.extractContents();
    const tmp = document.createElement("div");
    tmp.appendChild(frag);
    const tailHtml = sanitizeScriptRich(tmp.innerHTML);
    const hasTail = (tmp.textContent || "").trim().length > 0;
    syncEdit(el, edit);
    const ne = newScriptElement(hasTail ? el.type : S_NEXT[el.type]);
    if (hasTail) { ne.html = tailHtml; ne.text = tmp.textContent || ""; }
    s.elements.splice(s.elements.findIndex(x => x.id === el.id) + 1, 0, ne);
    const nw = buildScriptEl(ne);
    w.after(nw);
    updateScriptSpacing();
    focusEditStart($(".s-edit", nw));
    saveSoon();
    paginateSoon();
    return;
  }

  if (e.key === "Backspace" && !mod) {
    if (caretTextOffset(edit) === 0 && getSelection().isCollapsed) {
      const pw = prevElWrap(w), nw = nextElWrap(w);
      if (editLen(edit) === 0 && s.elements.length > 1) {
        e.preventDefault();
        removeScriptEl(el, w);
        const t = pw ? $(".s-edit", pw) : (nw ? $(".s-edit", nw) : $("#script-doc .s-edit"));
        if (t) focusEditEnd(t);
      } else if (pw) {
        e.preventDefault();
        const pEl = s.elements.find(x => x.id === pw.dataset.id);
        const pEdit = $(".s-edit", pw);
        if (editLen(pEdit) === 0) {
          removeScriptEl(pEl, pw); // swallow the empty element above
        } else {
          const at = editLen(pEdit);
          pEdit.innerHTML = pEl.html + el.html;
          syncEdit(pEl, pEdit);
          removeScriptEl(el, w);
          setCaretAt(pEdit, at);
        }
      }
    }
    return;
  }

  if (e.key === "ArrowUp" || e.key === "ArrowDown") {
    const up = e.key === "ArrowUp";
    if (caretOnEdgeLine(edit, up)) {
      const target = up ? prevElWrap(w) : nextElWrap(w);
      if (target) {
        e.preventDefault();
        const te = $(".s-edit", target);
        up ? focusEditEnd(te) : focusEditStart(te);
      }
    }
  }
});

/* ---------------- script PDF export (real text, Courier 12pt) ---------------- */

function pdfTextEsc(s) {
  return s
    .replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"')
    .replace(/–/g, "-").replace(/—/g, "--").replace(/…/g, "...")
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "?")
    .replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function buildScriptPdfStreams(script) {
  const { pages } = layoutScript(script);
  const body = pages.length ? pages : [[]];
  const CW = 7.2, LH = 12, LEFT = 108, TOPY = 792 - 72;

  const allPages = [];
  // title page — centered, upper third
  const t = [];
  const center = (text, row) => {
    if (!text.trim()) return;
    t.push({ row, x: Math.max(0, Math.round((60 - text.length) / 2)), runs: [{ t: text }] });
  };
  center((script.name || "Untitled script").toUpperCase(), 16);
  center("Written by", 20);
  center(script.author || "", 22);
  allPages.push({ lines: t, num: 0 });
  body.forEach((lines, i) => allPages.push({
    lines: lines.map((l, ri) => ({ row: ri, x: l.x, runs: l.runs })),
    num: i + 1,
  }));

  return allPages.map(pg => {
    let cs = "BT\n";
    const rects = [];
    if (pg.num >= 2) {
      const n = pg.num + ".";
      cs += `/F1 12 Tf 1 0 0 1 ${(612 - 72 - n.length * CW).toFixed(2)} 750 Tm (${n}) Tj\n`;
    }
    pg.lines.forEach(line => {
      if (!line.runs.length) return;
      let cx = line.x;
      const y = TOPY - LH * (line.row + 1) + 2.5;
      line.runs.forEach(r => {
        if (!r.t.length) return;
        const f = r.b && r.i ? "/F4" : r.b ? "/F2" : r.i ? "/F3" : "/F1";
        const x = LEFT + cx * CW;
        cs += `${f} 12 Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${pdfTextEsc(r.t)}) Tj\n`;
        if (r.u) rects.push(`${x.toFixed(2)} ${(y - 1.6).toFixed(2)} ${(r.t.length * CW).toFixed(2)} 0.7 re f`);
        cx += r.t.length;
      });
    });
    cs += "ET\n";
    if (rects.length) cs += "0 g " + rects.join(" ") + "\n";
    return cs;
  });
}

function scriptPdfBlob(streams) {
  const chunks = [];
  let offset = 0;
  const offsets = {};
  const latin1 = s => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff; return b; };
  const push = d => { const b = typeof d === "string" ? latin1(d) : d; chunks.push(b); offset += b.length; };
  const obj = (n, body) => { offsets[n] = offset; push(`${n} 0 obj\n${body}\nendobj\n`); };

  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  const N = streams.length;
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, `<< /Type /Pages /Kids [${streams.map((_, i) => `${7 + i * 2} 0 R`).join(" ")}] /Count ${N} >>`);
  ["Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique"].forEach((f, i) =>
    obj(3 + i, `<< /Type /Font /Subtype /Type1 /BaseFont /${f} /Encoding /WinAnsiEncoding >>`));
  const res = "<< /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R /F4 6 0 R >> >>";
  streams.forEach((cs, i) => {
    const pn = 7 + i * 2;
    obj(pn, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources ${res} /Contents ${pn + 1} 0 R >>`);
    obj(pn + 1, `<< /Length ${cs.length} >>\nstream\n${cs}\nendstream`);
  });
  const total = 6 + N * 2, xrefAt = offset;
  let xref = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= total; n++) xref += String(offsets[n]).padStart(10, "0") + " 00000 n \n";
  push(xref + `trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`);
  return new Blob(chunks, { type: "application/pdf" });
}

function exportScriptPDF() {
  const s = currentScript();
  if (!s) return;
  downloadBlob(scriptPdfBlob(buildScriptPdfStreams(s)), safeName(s.name, "Script") + ".pdf");
  toast("PDF downloaded");
}

/* ---- script wiring ---- */

$("#btn-new-script").addEventListener("click", () => {
  const s = newScript("Untitled script");
  db.scripts.push(s);
  save();
  openScript(s.id);
  setTimeout(() => { const n = $("#script-name"); n.focus(); n.select(); }, 260);
});
$("#btn-script-back").addEventListener("click", closeScript);
$("#btn-script-export").addEventListener("click", exportScriptPDF);

$("#script-name").addEventListener("input", e => {
  const s = currentScript();
  if (s) { s.name = e.target.value; saveSoon(); }
});
$("#script-name").addEventListener("keydown", e => { if (e.key === "Enter") e.target.blur(); });
$("#script-author").addEventListener("input", e => {
  const s = currentScript();
  if (s) { s.author = e.target.value; saveSoon(); }
});
$("#script-author").addEventListener("keydown", e => { if (e.key === "Enter") e.target.blur(); });

$$("#script-toolbar .ttool[data-stype]").forEach(b => {
  b.addEventListener("mousedown", e => e.preventDefault()); // keep the editor focused
  b.addEventListener("click", () => {
    let edit = document.activeElement?.closest?.(".s-edit");
    if (!edit) { const all = $$("#script-doc .s-edit"); edit = all[all.length - 1]; }
    if (!edit) return;
    const { w, el } = elFromEdit(edit);
    if (el) { setElType(el, w, b.dataset.stype); focusEditEnd(edit); }
  });
});

$("#btn-scene-nav").addEventListener("click", () => toggleSceneNav());

[["#btn-zoom-in", 0.1], ["#btn-zoom-out", -0.1]].forEach(([sel, d]) => {
  const b = $(sel);
  b.addEventListener("mousedown", e => e.preventDefault());
  b.addEventListener("click", () => zoomScript(d));
});
$("#btn-zoom-reset").addEventListener("mousedown", e => e.preventDefault());
$("#btn-zoom-reset").addEventListener("click", resetScriptZoom);

/* trackpad pinch arrives as ctrl+wheel; ⌘+scroll zooms too */
$("#script-stage").addEventListener("wheel", e => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  zoomScript(-e.deltaY * 0.004);
}, { passive: false });

/* two-finger pinch on touch screens (iPad) zooms the sheet */
(() => {
  const stage = $("#script-stage");
  const dist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY) || 1;
  let base = null;
  stage.addEventListener("touchstart", e => {
    if (e.touches.length === 2) base = { d: dist(e.touches), z: scriptZoom };
  }, { passive: true });
  stage.addEventListener("touchmove", e => {
    if (e.touches.length !== 2 || !base) return;
    e.preventDefault();
    scriptZoom = clampZoom(base.z * dist(e.touches) / base.d);
    applyScriptZoom(false);
  }, { passive: false });
  const end = e => { if (e.touches.length < 2 && base) { base = null; applyScriptZoom(); } };
  stage.addEventListener("touchend", end);
  stage.addEventListener("touchcancel", end);
})();

/* ---------------- boot ---------------- */

$("#view-project").hidden = true;
$("#view-script").hidden = true;
renderHome();
updateBrushUI();
updateUndoButtons();
