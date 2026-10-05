/* Storyit — multi-device sync.
   Part 1 (pure, shared with server.js + tests): entity-level ops, per-field
   last-writer-wins, diffing, drawing merge.
   Part 2 (browser only): transport to server.js, DOM patching, status pill.

   Every entity (project, item, script, element) carries
     ft: { field: timestampMs }   when the field was last written
     fc: { field: clientId }      by whom (breaks timestamp ties)
   Structure (page order / element order) is a single timestamped field
   stored as ft._pages / ft._order. Deleted ids live in db.deleted[id] = t. */

(function (root) {
  "use strict";

  const PROJECT_FIELDS = ["name", "aspect", "cols", "rows", "createdAt", "updatedAt"];
  const ITEM_FIELDS = ["kind", "num", "title", "note", "noteRich", "text", "rich", "drawing", "frameHidden"];
  const SCRIPT_FIELDS = ["name", "author", "createdAt", "updatedAt"];
  const SEL_FIELDS = ["type", "text", "html"];

  /* ---------- helpers ---------- */

  const findProject = (db, id) => db.projects.find(p => p.id === id) || null;
  const findScript = (db, id) => db.scripts.find(s => s.id === id) || null;
  const itemsOf = p => p.pages.flatMap(pg => pg.items);
  const findItem = (p, id) => { for (const pg of p.pages) for (const it of pg.items) if (it.id === id) return it; return null; };

  function ensureMeta(e) { if (!e.ft) e.ft = {}; if (!e.fc) e.fc = {}; return e; }
  function wins(e, field, t, client) {
    const cur = (e.ft && e.ft[field]) || 0;
    if (t > cur) return true;
    if (t < cur) return false;
    const curC = (e.fc && e.fc[field]) || "";
    return (client || "") > curC;
  }
  function setField(e, field, value, t, client) {
    ensureMeta(e);
    e[field] = value;
    e.ft[field] = t;
    e.fc[field] = client || "";
  }
  function maxFt(e) { let m = 0; if (e.ft) for (const k in e.ft) m = Math.max(m, e.ft[k] || 0); return m; }

  /* cheap identity for a drawing: strokes are immutable once committed, so
     counts + endpoints are enough to notice a push, an undo or an image move
     (shapes are editable, so their key carries every field) */
  function drawingSig(d) {
    if (!d) return "";
    let s = (d.base ? d.base.length : 0) + "|";
    for (const im of d.images || []) s += `${im.id}:${im.x}:${im.y}:${im.w}:${im.h}:${im.src ? im.src.length : 0},`;
    s += "|" + (d.strokes || []).length + "|";
    for (const st of d.strokes || []) s += strokeKey(st) + ",";
    return s;
  }
  function strokeKey(st) {
    if (st.shape) return `s${st.shape}:${st.x}:${st.y}:${st.w}:${st.h}:${st.rot}:${st.size}:${st.color}:${st.opacity}:${st.avatar || 0}`;
    if (st.text !== undefined) return `t${st.text.length}:${st.x}:${st.y}:${st.size}`;
    const n = st.pts.length;
    return `${n}:${st.pts[0]}:${st.pts[1]}:${st.pts[n - 3]}:${st.pts[n - 2]}:${st.size}:${st.eraser ? 1 : 0}`;
  }

  /* three-way merge for one shot's drawing.
     base   = last state both sides agreed on (may be null)
     local  = what this device has now
     remote = what just arrived
     If both sides only ADDED strokes/images on top of base, keep both.
     Anything else (undo, clear, reorder) is last-writer-wins: remote. */
  function mergeDrawing(base, local, remote) {
    if (!remote) return remote;
    if (drawingSig(local) === drawingSig(base)) return remote;
    if (!local) return remote;
    const b = base || { base: null, images: [], strokes: [] };
    const extends_ = d => {
      if (!d || (d.base || null) !== (b.base || null)) return false;
      if (d.strokes.length < b.strokes.length) return false;
      for (let i = 0; i < b.strokes.length; i++) if (strokeKey(d.strokes[i]) !== strokeKey(b.strokes[i])) return false;
      const ids = new Set(d.images.map(im => im.id));
      return b.images.every(im => ids.has(im.id));
    };
    if (!extends_(local) || !extends_(remote)) return remote;
    const n = b.strokes.length;
    const baseIds = new Set(b.images.map(im => im.id));
    const remoteIds = new Set(remote.images.map(im => im.id));
    const images = remote.images.map(im => ({ ...im }));
    local.images.forEach(im => { if (!baseIds.has(im.id) && !remoteIds.has(im.id)) images.push({ ...im }); });
    return {
      base: remote.base || null,
      images,
      strokes: [...b.strokes, ...local.strokes.slice(n), ...remote.strokes.slice(n)],
    };
  }

  /* ---------- apply ---------- */

  function newChanged() {
    return {
      projects: new Set(), structure: new Set(), items: new Map(),
      scripts: new Set(), sorder: new Set(), sels: new Map(),
      deleted: new Set(), any: false,
    };
  }
  const mapSet = (m, a, b, f) => {
    let inner = m.get(a); if (!inner) { inner = new Map(); m.set(a, inner); }
    let set = inner.get(b); if (!set) { set = new Set(); inner.set(b, set); }
    set.add(f);
  };

  function applyOps(db, ops, client) {
    if (!db.deleted) db.deleted = {};
    const ch = newChanged();
    for (const op of ops || []) {
      try { applyOne(db, op, client, ch); } catch (e) { /* a bad op never poisons the batch */ }
    }
    return { changed: ch };
  }

  function applyOne(db, op, client, ch) {
    const tomb = id => db.deleted[id] || 0;
    const opMax = op => { let m = op.t || 0; if (op.ft) for (const k in op.ft) m = Math.max(m, op.ft[k] || 0); return m; };
    const who = f => (op.fc && op.fc[f]) || client;

    switch (op.k) {
      case "project": {
        let p = findProject(db, op.id);
        if (!p) {
          if (opMax(op) <= tomb(op.id)) return;
          delete db.deleted[op.id];
          p = ensureMeta({ id: op.id, pages: [] });
          db.projects.push(p);
          ch.any = true;
        }
        for (const f of PROJECT_FIELDS) {
          if (!(f in op.f)) continue;
          if (wins(p, f, op.ft[f] || 0, who(f))) { setField(p, f, op.f[f], op.ft[f] || 0, who(f)); ch.projects.add(p.id); ch.any = true; }
        }
        return;
      }
      case "item": {
        const p = findProject(db, op.pid);
        if (!p) return;
        let it = findItem(p, op.id);
        if (!it) {
          it = ensureMeta({ id: op.id, kind: op.f.kind || "shot" });
          if (!p.pages.length) p.pages.push({ id: root.uid ? root.uid() : "pg" + Date.now(), items: [] });
          p.pages[p.pages.length - 1].items.push(it); // a following pages op places it properly
          ch.structure.add(p.id); ch.any = true;
        }
        for (const f of ITEM_FIELDS) {
          if (!(f in op.f)) continue;
          if (wins(it, f, op.ft[f] || 0, who(f))) { setField(it, f, op.f[f], op.ft[f] || 0, who(f)); mapSet(ch.items, p.id, it.id, f); ch.any = true; }
        }
        return;
      }
      case "pages": {
        const p = findProject(db, op.pid);
        if (!p) return;
        if (!wins(p, "_pages", op.t || 0, client)) return;
        const byId = new Map(itemsOf(p).map(it => [it.id, it]));
        const pages = op.pages.map(pg => ({ id: pg.id, items: pg.items.map(id => byId.get(id)).filter(Boolean) }));
        p.pages = pages;
        ensureMeta(p); p.ft._pages = op.t || 0; p.fc._pages = client || "";
        ch.structure.add(p.id); ch.any = true;
        return;
      }
      case "project.del": {
        const p = findProject(db, op.id);
        const t = op.t || 0;
        if (p && t < maxFt(p)) return; // someone edited it more recently than this delete
        db.deleted[op.id] = Math.max(tomb(op.id), t);
        if (p) { db.projects = db.projects.filter(x => x !== p); ch.deleted.add(op.id); ch.any = true; }
        return;
      }
      case "script": {
        let s = findScript(db, op.id);
        if (!s) {
          if (opMax(op) <= tomb(op.id)) return;
          delete db.deleted[op.id];
          s = ensureMeta({ id: op.id, elements: [] });
          db.scripts.push(s);
          ch.any = true;
        }
        for (const f of SCRIPT_FIELDS) {
          if (!(f in op.f)) continue;
          if (wins(s, f, op.ft[f] || 0, who(f))) { setField(s, f, op.f[f], op.ft[f] || 0, who(f)); ch.scripts.add(s.id); ch.any = true; }
        }
        return;
      }
      case "sel": {
        const s = findScript(db, op.sid);
        if (!s) return;
        let el = s.elements.find(e => e.id === op.id);
        if (!el) { el = ensureMeta({ id: op.id, type: "action", text: "", html: "" }); s.elements.push(el); ch.sorder.add(s.id); ch.any = true; }
        for (const f of SEL_FIELDS) {
          if (!(f in op.f)) continue;
          if (wins(el, f, op.ft[f] || 0, who(f))) { setField(el, f, op.f[f], op.ft[f] || 0, who(f)); mapSet(ch.sels, s.id, el.id, f); ch.any = true; }
        }
        return;
      }
      case "sorder": {
        const s = findScript(db, op.sid);
        if (!s) return;
        if (!wins(s, "_order", op.t || 0, client)) return;
        const byId = new Map(s.elements.map(e => [e.id, e]));
        s.elements = op.ids.map(id => byId.get(id)).filter(Boolean);
        ensureMeta(s); s.ft._order = op.t || 0; s.fc._order = client || "";
        ch.sorder.add(s.id); ch.any = true;
        return;
      }
      case "script.del": {
        const s = findScript(db, op.id);
        const t = op.t || 0;
        if (s && t < maxFt(s)) return;
        db.deleted[op.id] = Math.max(tomb(op.id), t);
        if (s) { db.scripts = db.scripts.filter(x => x !== s); ch.deleted.add(op.id); ch.any = true; }
        return;
      }
    }
  }

  /* ---------- diff ---------- */

  const same = (f, a, b) => f === "drawing" ? drawingSig(a) === drawingSig(b) : a === b;

  /* ops that turn `prev` into `cur`. Changed fields on cur get ft=now/fc=client. */
  function diffDb(prev, cur, now, client) {
    now = now || Date.now();
    const ops = [];
    if (!cur.deleted) cur.deleted = {};
    const prevProjects = new Map((prev.projects || []).map(p => [p.id, p]));
    const prevScripts = new Map((prev.scripts || []).map(s => [s.id, s]));

    const fieldOps = (kind, base, e, pe, fields) => {
      const f = {}, ft = {};
      let any = false;
      for (const k of fields) {
        if (pe && same(k, e[k], pe[k])) { if (pe.ft && pe.ft[k] && (!e.ft || !e.ft[k])) { ensureMeta(e); e.ft[k] = pe.ft[k]; e.fc[k] = (pe.fc && pe.fc[k]) || ""; } continue; }
        if (!pe && e[k] === undefined) continue;
        setField(e, k, e[k], now, client);
        f[k] = e[k]; ft[k] = now; any = true;
      }
      if (any) ops.push({ k: kind, ...base, f, ft });
    };

    for (const p of cur.projects) {
      const pp = prevProjects.get(p.id) || null;
      fieldOps("project", { id: p.id }, p, pp, PROJECT_FIELDS);
      const prevItems = pp ? new Map(itemsOf(pp).map(it => [it.id, it])) : new Map();
      for (const it of itemsOf(p)) fieldOps("item", { pid: p.id, id: it.id }, it, prevItems.get(it.id) || null, ITEM_FIELDS);
      const shape = pg => pg.map(x => x.id + ":" + x.items.map(i => i.id).join(",")).join(";");
      if (!pp || shape(pp.pages) !== shape(p.pages)) {
        ensureMeta(p); p.ft._pages = now; p.fc._pages = client || "";
        ops.push({ k: "pages", pid: p.id, pages: p.pages.map(pg => ({ id: pg.id, items: pg.items.map(i => i.id) })), t: now });
      }
    }
    for (const [id] of prevProjects) {
      if (!findProject(cur, id)) { cur.deleted[id] = now; ops.push({ k: "project.del", id, t: now }); }
    }

    for (const s of cur.scripts) {
      const ps = prevScripts.get(s.id) || null;
      fieldOps("script", { id: s.id }, s, ps, SCRIPT_FIELDS);
      const prevEls = ps ? new Map(ps.elements.map(e => [e.id, e])) : new Map();
      for (const el of s.elements) fieldOps("sel", { sid: s.id, id: el.id }, el, prevEls.get(el.id) || null, SEL_FIELDS);
      const order = s.elements.map(e => e.id).join(",");
      if (!ps || ps.elements.map(e => e.id).join(",") !== order) {
        ensureMeta(s); s.ft._order = now; s.fc._order = client || "";
        ops.push({ k: "sorder", sid: s.id, ids: s.elements.map(e => e.id), t: now });
      }
    }
    for (const [id] of prevScripts) {
      if (!findScript(cur, id)) { cur.deleted[id] = now; ops.push({ k: "script.del", id, t: now }); }
    }
    return ops;
  }

  /* the whole db as ops that carry its existing timestamps (server -> client merge) */
  function dbToOps(db) {
    const ops = [];
    const full = (kind, base, e, fields) => {
      const f = {}, ft = {};
      for (const k of fields) { if (e[k] !== undefined) { f[k] = e[k]; ft[k] = (e.ft && e.ft[k]) || 0; } }
      ops.push({ k: kind, ...base, f, ft, fc: e.fc || {} });
    };
    for (const p of db.projects || []) {
      full("project", { id: p.id }, p, PROJECT_FIELDS);
      for (const it of itemsOf(p)) full("item", { pid: p.id, id: it.id }, it, ITEM_FIELDS);
      ops.push({ k: "pages", pid: p.id, pages: p.pages.map(pg => ({ id: pg.id, items: pg.items.map(i => i.id) })), t: (p.ft && p.ft._pages) || 0 });
    }
    for (const s of db.scripts || []) {
      full("script", { id: s.id }, s, SCRIPT_FIELDS);
      for (const el of s.elements) full("sel", { sid: s.id, id: el.id }, el, SEL_FIELDS);
      ops.push({ k: "sorder", sid: s.id, ids: s.elements.map(e => e.id), t: (s.ft && s.ft._order) || 0 });
    }
    for (const id in db.deleted || {}) {
      // a tombstone doesn't say what it was; both ops are harmless for a missing id
      const t = db.deleted[id];
      ops.push({ k: "project.del", id, t });
      ops.push({ k: "script.del", id, t });
    }
    return ops;
  }

  const core = { applyOps, diffDb, dbToOps, drawingSig, mergeDrawing, PROJECT_FIELDS, ITEM_FIELDS, SCRIPT_FIELDS, SEL_FIELDS };
  if (typeof module !== "undefined" && module.exports) { module.exports = core; return; }
  root.SyncCore = core;

  /* ============================================================
     Part 2 — browser client
     ============================================================ */
  if (typeof window === "undefined" || typeof document === "undefined") return;

  const SYNC = {
    on: false,
    client: "",
    prev: null,      // clone of the state the server is known to have
    rev: 0,
    es: null,
    pending: false,
    sending: false,
    backoff: 1000,
    retryTimer: null,
    lastState: "local",
  };
  try {
    SYNC.client = sessionStorage.getItem("storyit.client") || "";
    if (!SYNC.client) { SYNC.client = Math.random().toString(36).slice(2, 10); sessionStorage.setItem("storyit.client", SYNC.client); }
  } catch (e) { SYNC.client = Math.random().toString(36).slice(2, 10); }

  const snapshot = o => (typeof structuredClone === "function" ? structuredClone(o) : JSON.parse(JSON.stringify(o)));
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  function setPill(state, text) {
    SYNC.lastState = state;
    const label = text || { local: "Local only", synced: "Synced", syncing: "Syncing…", offline: "Offline — retrying" }[state];
    $$("[data-sync-pill]").forEach(el => {
      el.dataset.state = state;
      const span = el.querySelector("span");
      if (span) span.textContent = label;
      el.title = state === "local"
        ? "Not connected to a Storyit server — run `node server.js` and open its address to sync between devices"
        : label;
    });
  }

  function persistLocal() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(db)); } catch (e) { /* full */ }
  }

  async function syncInit() {
    setPill("local");
    if (!/^https?:$/.test(location.protocol)) return;
    let info = null;
    try {
      const r = await fetch("/api/info", { cache: "no-store" });
      if (r.ok) info = await r.json();
    } catch (e) { /* not hosted */ }
    if (!info || !info.hosted) return;
    SYNC.on = true;
    showIpadTip(info.url);
    await syncPull();
    openStream();
  }

  function showIpadTip(url) {
    const tip = document.getElementById("ipad-tip");
    if (!tip || !url) return;
    tip.innerHTML = `On your iPad, open <code></code> on the same Wi-Fi, then Share → <b>Add to Home Screen</b>. Everything you do on either device syncs live.`;
    tip.querySelector("code").textContent = url;
    tip.hidden = false;
  }

  /* full reconcile: merge the server's copy into ours field by field, then push what we had that's newer */
  async function syncPull() {
    setPill("syncing");
    let state;
    try {
      const r = await fetch("/api/state", { cache: "no-store" });
      if (!r.ok) throw new Error(r.status);
      state = await r.json();
    } catch (e) {
      setPill("offline");
      scheduleRetry(() => syncPull());
      return;
    }
    const serverDb = state.db || { projects: [], scripts: [], deleted: {} };
    const before = viewSignature();
    applyOps(db, dbToOps(serverDb), "server");
    db.projects.forEach(p => { if (typeof migrateProject === "function") migrateProject(p); });
    SYNC.prev = snapshot(serverDb);
    SYNC.rev = state.rev || 0;
    persistLocal();
    refreshView(before);
    setPill("synced");
    syncFlush();
  }

  function openStream() {
    if (SYNC.es) SYNC.es.close();
    const es = new EventSource("/api/events");
    SYNC.es = es;
    es.addEventListener("hello", e => {
      const d = JSON.parse(e.data);
      if (SYNC.prev && d.rev !== SYNC.rev) syncPull(); // we missed something while disconnected
      else if (SYNC.lastState === "offline") { setPill("synced"); syncFlush(); }
    });
    es.onmessage = e => {
      const msg = JSON.parse(e.data);
      SYNC.rev = msg.rev;
      if (msg.client === SYNC.client) return; // our own echo
      applyRemote(msg.ops || []);
    };
    es.onerror = () => { setPill("offline"); };
  }

  function scheduleRetry(fn) {
    clearTimeout(SYNC.retryTimer);
    SYNC.retryTimer = setTimeout(fn, SYNC.backoff);
    SYNC.backoff = Math.min(15000, SYNC.backoff * 2);
  }

  /* called after every local save(): send what changed since the server last heard from us */
  function syncFlush() {
    if (!SYNC.on || !SYNC.prev) return;
    SYNC.pending = true;
    if (SYNC.sending) return;
    doSend();
  }
  async function doSend() {
    SYNC.pending = false;
    const ops = diffDb(SYNC.prev, db, Date.now(), SYNC.client);
    if (!ops.length) { if (SYNC.lastState !== "offline") setPill("synced"); return; }
    const snap = snapshot(db);
    const body = JSON.stringify({ client: SYNC.client, ops });
    SYNC.sending = true;
    setPill("syncing");
    try {
      const r = await fetch("/api/ops", { method: "POST", headers: { "Content-Type": "application/json" }, body });
      if (!r.ok) throw new Error(r.status);
      const res = await r.json();
      // remote ops that landed while we were sending were applied to both db and prev; keep those in prev
      SYNC.prev = snap;
      SYNC.rev = Math.max(SYNC.rev, res.rev || 0);
      SYNC.backoff = 1000;
      setPill("synced");
    } catch (e) {
      SYNC.pending = true;
      setPill("offline");
      scheduleRetry(() => { SYNC.sending = false; if (SYNC.pending) doSend(); });
      return;
    }
    SYNC.sending = false;
    if (SYNC.pending) doSend();
  }

  /* ---------- applying remote changes to the live app ---------- */

  function viewSignature() {
    return { project: currentId, script: currentScriptId, focus: captureFocus() };
  }

  function applyRemote(ops) {
    if (!ops.length) return;
    const before = viewSignature();
    // drawings both sides touched: three-way merge instead of clobbering
    const merges = [];
    for (const op of ops) {
      if (op.k !== "item" || !op.f || !("drawing" in op.f)) continue;
      const p = db.projects.find(x => x.id === op.pid);
      const it = p && itemsOf(p).find(x => x.id === op.id);
      if (!it) continue;
      const pp = SYNC.prev && SYNC.prev.projects.find(x => x.id === op.pid);
      const pit = pp && itemsOf(pp).find(x => x.id === op.id);
      const base = pit ? pit.drawing : null;
      if (drawingSig(it.drawing) !== drawingSig(base)) merges.push({ it, merged: mergeDrawing(base, it.drawing, op.f.drawing) });
    }
    const { changed } = applyOps(db, ops, "remote");
    if (SYNC.prev) applyOps(SYNC.prev, ops, "remote");
    merges.forEach(({ it, merged }) => { if (drawingSig(merged) !== drawingSig(it.drawing)) { it.drawing = merged; ensureMeta(it); it.ft.drawing = Date.now(); it.fc.drawing = SYNC.client; } });
    persistLocal();
    if (!changed.any) return;
    patchView(changed, before);
    if (merges.length) syncFlush();
  }

  function captureFocus() {
    const ae = document.activeElement;
    if (!ae) return null;
    const host = ae.closest("[data-id]");
    if (!host) return null;
    const f = { id: host.dataset.id, cls: ae.className.split(" ")[0], sel: null };
    if (ae.tagName === "INPUT") f.sel = [ae.selectionStart, ae.selectionEnd];
    else if (ae.isContentEditable) {
      const s = getSelection();
      if (s.rangeCount) { const r = s.getRangeAt(0).cloneRange(); r.selectNodeContents(ae); r.setEnd(s.getRangeAt(0).startContainer, s.getRangeAt(0).startOffset); f.sel = r.toString().length; }
    }
    return f;
  }
  function restoreFocus(f) {
    if (!f) return;
    const host = document.querySelector(`[data-id="${f.id}"]`);
    if (!host) return;
    const el = host.classList.contains(f.cls) ? host : host.querySelector("." + f.cls);
    if (!el) return;
    el.focus({ preventScroll: true });
    try {
      if (el.tagName === "INPUT" && f.sel) el.setSelectionRange(f.sel[0], f.sel[1]);
      else if (el.isContentEditable && typeof f.sel === "number" && typeof setCaretAt === "function") setCaretAt(el, f.sel);
    } catch (e) { /* fine */ }
  }

  function refreshView(before) {
    if (currentId !== null) {
      if (!db.projects.find(p => p.id === currentId)) { toast("This storyboard was deleted on another device"); goHome(); return; }
      renderProject();
      restoreFocus(before.focus);
    } else if (currentScriptId !== null) {
      if (!db.scripts.find(s => s.id === currentScriptId)) { toast("This script was deleted on another device"); closeScript(); return; }
      renderScriptEditor(true);
      restoreFocus(before.focus);
    } else renderHome();
  }

  function patchView(ch, before) {
    if (currentId !== null) {
      if (ch.deleted.has(currentId)) { toast("This storyboard was deleted on another device"); goHome(); return; }
      const p = db.projects.find(x => x.id === currentId);
      if (!p) return;
      if (!p.pages.length && typeof rechunkItems === "function") rechunkItems(p, [newScene(1)]);
      if (ch.structure.has(currentId)) { renderProject(); restoreFocus(before.focus); return; }
      if (ch.projects.has(currentId)) {
        const n = document.getElementById("project-name");
        if (document.activeElement !== n && n.value !== p.name) n.value = p.name;
        document.getElementById("print-header").textContent = p.name || "Untitled project";
        applyAspect(p); applyGrid(p);
        requestAnimationFrame(() => $$("#pages canvas").forEach(c => c._fit && c._fit()));
      }
      const items = ch.items.get(currentId);
      if (items) {
        items.forEach((fields, id) => { const it = itemsOf(p).find(x => x.id === id); if (it) applyItemToDom(it, [...fields]); });
        updateGlobalEye();
      }
      return;
    }
    if (currentScriptId !== null) {
      if (ch.deleted.has(currentScriptId)) { toast("This script was deleted on another device"); closeScript(); return; }
      const s = db.scripts.find(x => x.id === currentScriptId);
      if (!s) return;
      if (ch.sorder.has(currentScriptId)) { renderScriptEditor(true); restoreFocus(before.focus); return; }
      if (ch.scripts.has(currentScriptId)) {
        const n = document.getElementById("script-name"), a = document.getElementById("script-author");
        if (document.activeElement !== n && n.value !== s.name) n.value = s.name;
        if (document.activeElement !== a && a.value !== (s.author || "")) a.value = s.author || "";
      }
      const els = ch.sels.get(currentScriptId);
      if (els) {
        els.forEach((fields, id) => {
          const el = s.elements.find(x => x.id === id);
          const w = document.querySelector(`#script-doc .s-el[data-id="${id}"]`);
          if (!el || !w) return;
          const edit = w.querySelector(".s-edit");
          if (fields.has("type")) { w.dataset.type = el.type; edit.setAttribute("data-ph", S_PH[el.type]); }
          if (fields.has("html") && document.activeElement !== edit && edit.innerHTML !== (el.html || "")) edit.innerHTML = el.html || "";
        });
        updateScriptSpacing();
        paginateSoon();
      }
      return;
    }
    renderHome();
  }

  root.syncFlush = syncFlush;
  root.syncInit = syncInit;
  root.SYNC = SYNC;
  syncInit();
})(typeof globalThis !== "undefined" ? globalThis : this);
