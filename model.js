/* Storyit — storyboard data model helpers (pure, shared by app + tests).
   A project's pages hold ITEMS in order: shots and scene rows.
     shot:  { id, kind:"shot", num, title, note, noteRich, text, rich, drawing, frameHidden }
     scene: { id, kind:"scene", num, title }
   A page holds cols×rows shots; scene rows don't count toward capacity and
   ride along with the shot that follows them. */

(function (root) {
  "use strict";

  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

  const GRID_PRESETS = [[1, 1], [1, 2], [2, 2], [2, 3], [3, 2], [3, 3], [3, 4], [4, 4]];
  const DEFAULT_COLS = 2, DEFAULT_ROWS = 3;

  function newShot() {
    return { id: uid(), kind: "shot", num: "", title: "", note: "", noteRich: "", text: "", rich: "", drawing: null, frameHidden: true };
  }
  function newScene(num) {
    return { id: uid(), kind: "scene", num: String(num ?? ""), title: "" };
  }
  function capacity(p) { return Math.max(1, (p.cols || DEFAULT_COLS) * (p.rows || DEFAULT_ROWS)); }
  function allItems(p) { return p.pages.flatMap(pg => pg.items); }
  function allPanels(p) { return allItems(p).filter(x => x.kind !== "scene"); }

  /* rewrite p.pages from a flat item list, keeping existing page ids */
  function rechunkItems(p, items) {
    const cap = capacity(p);
    const pages = [];
    let cur = [], shots = 0, pending = []; // pending: scene rows waiting for their shot
    const flush = () => {
      const pg = p.pages[pages.length] || { id: uid(), items: [] };
      pg.items = cur;
      pages.push(pg);
      cur = []; shots = 0;
    };
    for (const it of items) {
      if (it.kind === "scene") { pending.push(it); continue; }
      if (shots === cap) flush();
      cur.push(...pending, it);
      pending = [];
      shots++;
    }
    // pad the tail so the last page is a full grid; trailing scene rows stay on it
    while (shots < cap) { cur.push(...pending, newShot()); pending = []; shots++; }
    cur.push(...pending);
    flush();
    p.pages = pages;
  }

  /* integer after the nearest preceding scene row; else count of scene rows + 1 */
  function nextSceneNum(p, afterItemId) {
    const items = allItems(p);
    let i = afterItemId ? items.findIndex(x => x.id === afterItemId) : items.length - 1;
    if (i < 0) i = items.length - 1;
    for (let j = i; j >= 0; j--) {
      if (items[j].kind !== "scene") continue;
      const n = parseInt(items[j].num, 10);
      if (String(n) === String(items[j].num).trim()) return n + 1;
      break;
    }
    return items.filter(x => x.kind === "scene").length + 1;
  }

  /* legacy shape: pages[].panels[] with panel.scene -> items with scene rows */
  function migrateProject(p) {
    if (!p.cols) p.cols = DEFAULT_COLS;
    if (!p.rows) p.rows = DEFAULT_ROWS;
    if (!Array.isArray(p.pages)) p.pages = [];
    const legacy = p.pages.some(pg => Array.isArray(pg.panels));
    if (!legacy) {
      p.pages.forEach(pg => { if (!Array.isArray(pg.items)) pg.items = []; });
      allItems(p).forEach(fillDefaults);
      if (!p.pages.length) rechunkItems(p, [newScene(1)]);
      return p;
    }
    const items = [];
    let scene = null;
    p.pages.forEach(pg => {
      (pg.panels || pg.items || []).forEach(x => {
        if (x.kind === "scene") { items.push(x); return; }
        const s = x.scene || 1;
        if (s !== scene) { items.push(newScene(s)); scene = s; }
        delete x.scene;
        items.push(fillDefaults(x));
      });
      delete pg.panels;
    });
    rechunkItems(p, items);
    return p;
  }
  const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  function fillDefaults(x) {
    if (x.kind === "scene") { if (x.num === undefined) x.num = ""; if (x.title === undefined) x.title = ""; return x; }
    x.kind = "shot";
    if (x.num === undefined) x.num = "";
    if (x.note === undefined) x.note = "";
    if (x.noteRich === undefined) x.noteRich = "";
    if (x.title === undefined) x.title = "";
    if (x.text === undefined) x.text = "";
    if (x.rich === undefined) x.rich = esc(x.text).replace(/\n/g, "<br>");
    if (x.noteRich === "" && x.note) x.noteRich = esc(x.note).replace(/\n/g, "<br>");
    if (x.drawing === undefined) x.drawing = null;
    if (x.frameHidden === undefined) x.frameHidden = true;
    return x;
  }

  const api = { GRID_PRESETS, DEFAULT_COLS, DEFAULT_ROWS, newShot, newScene, capacity, allItems, allPanels, rechunkItems, nextSceneNum, migrateProject, uid };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  Object.assign(root, api);
})(typeof globalThis !== "undefined" ? globalThis : this);
