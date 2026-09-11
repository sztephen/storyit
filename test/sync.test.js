const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../model.js");
const S = require("../sync.js");

const clone = o => JSON.parse(JSON.stringify(o));

function boardDb() {
  const p = { id: "p1", name: "Board", aspect: "16:9", cols: 2, rows: 2, createdAt: 1, updatedAt: 1, pages: [] };
  const a = Object.assign(M.newShot(), { id: "a", title: "A" });
  const b = Object.assign(M.newShot(), { id: "b", title: "B" });
  M.rechunkItems(p, [Object.assign(M.newScene(1), { id: "sc" }), a, b]);
  p.pages[0].id = "pg1";
  const s = { id: "s1", name: "Script", author: "", createdAt: 1, updatedAt: 1, elements: [{ id: "e1", type: "scene", text: "INT", html: "INT" }] };
  return { projects: [p], scripts: [s], deleted: {} };
}

test("applyOps: newer field wins, older is ignored, ties break on client id", () => {
  const db = boardDb();
  S.applyOps(db, [{ k: "item", pid: "p1", id: "a", f: { title: "new" }, ft: { title: 100 } }], "x");
  assert.equal(db.projects[0].pages[0].items[1].title, "new");
  S.applyOps(db, [{ k: "item", pid: "p1", id: "a", f: { title: "stale" }, ft: { title: 50 } }], "x");
  assert.equal(db.projects[0].pages[0].items[1].title, "new");
  // same t: the higher client id wins
  S.applyOps(db, [{ k: "item", pid: "p1", id: "a", f: { title: "tie-low" }, ft: { title: 100 } }], "a");
  assert.equal(db.projects[0].pages[0].items[1].title, "new"); // "a" < "x"
  S.applyOps(db, [{ k: "item", pid: "p1", id: "a", f: { title: "tie-high" }, ft: { title: 100 } }], "z");
  assert.equal(db.projects[0].pages[0].items[1].title, "tie-high");
});

test("applyOps: a pages op reorders and drops unreferenced items; unknown ids are created from item ops", () => {
  const db = boardDb();
  const r = S.applyOps(db, [
    { k: "item", pid: "p1", id: "c", f: { kind: "shot", title: "C", num: "", note: "", noteRich: "", text: "", rich: "", drawing: null, frameHidden: true }, ft: { title: 5 } },
    { k: "pages", pid: "p1", pages: [{ id: "pg1", items: ["sc", "c", "b"] }], t: 10 },
  ], "x");
  const items = M.allItems(db.projects[0]);
  assert.deepEqual(items.map(x => x.id), ["sc", "c", "b"]);
  assert.equal(items[1].title, "C");
  assert.ok(r.changed.structure.has("p1"));
  // stale pages op is ignored
  S.applyOps(db, [{ k: "pages", pid: "p1", pages: [{ id: "pg1", items: ["b"] }], t: 3 }], "x");
  assert.equal(M.allItems(db.projects[0]).length, 3);
});

test("applyOps: project.del tombstones; later stale ops for it are ignored, newer project op resurrects", () => {
  const db = boardDb();
  S.applyOps(db, [{ k: "project.del", id: "p1", t: 100 }], "x");
  assert.equal(db.projects.length, 0);
  assert.equal(db.deleted.p1, 100);
  S.applyOps(db, [{ k: "project", id: "p1", f: { name: "Board", aspect: "16:9", cols: 2, rows: 2, createdAt: 1, updatedAt: 90 }, ft: { name: 90 } }], "x");
  assert.equal(db.projects.length, 0);
  S.applyOps(db, [{ k: "item", pid: "p1", id: "zz", f: { kind: "shot", title: "late" }, ft: { title: 120 } }], "x");
  assert.equal(db.projects.length, 0); // items for a missing project are dropped
  S.applyOps(db, [{ k: "project", id: "p1", f: { name: "Again", aspect: "16:9", cols: 2, rows: 2, createdAt: 1, updatedAt: 200 }, ft: { name: 200 } }], "x");
  assert.equal(db.projects.length, 1);
  assert.equal(db.projects[0].name, "Again");
  assert.equal(db.deleted.p1, undefined);
});

test("applyOps: scripts — element fields, order, delete", () => {
  const db = boardDb();
  S.applyOps(db, [
    { k: "sel", sid: "s1", id: "e2", f: { type: "action", text: "Go", html: "Go" }, ft: { type: 5, text: 5, html: 5 } },
    { k: "sorder", sid: "s1", ids: ["e2", "e1"], t: 6 },
    { k: "script", id: "s1", f: { name: "Renamed" }, ft: { name: 7 } },
  ], "x");
  assert.deepEqual(db.scripts[0].elements.map(e => e.id), ["e2", "e1"]);
  assert.equal(db.scripts[0].name, "Renamed");
  S.applyOps(db, [{ k: "script.del", id: "s1", t: 8 }], "x");
  assert.equal(db.scripts.length, 0);
});

test("diffDb emits only changed fields, assigns ft, and a pages op when order changes", () => {
  const prev = boardDb();
  const cur = clone(prev);
  const a = M.allItems(cur.projects[0]).find(x => x.id === "a");
  a.title = "A2";
  cur.projects[0].name = "Board 2";
  const now = 1000;
  let ops = S.diffDb(prev, cur, now);
  assert.deepEqual(ops.map(o => o.k).sort(), ["item", "project"]);
  const itemOp = ops.find(o => o.k === "item");
  assert.deepEqual(itemOp.f, { title: "A2" });
  assert.equal(itemOp.ft.title, now);
  assert.equal(a.ft.title, now);
  const projOp = ops.find(o => o.k === "project");
  assert.deepEqual(Object.keys(projOp.f), ["name"]);

  // reorder -> pages op; nothing else
  const prev2 = clone(cur);
  const items = M.allItems(cur.projects[0]);
  [items[1], items[2]] = [items[2], items[1]];
  M.rechunkItems(cur.projects[0], items);
  ops = S.diffDb(prev2, cur, 2000);
  assert.deepEqual(ops.map(o => o.k), ["pages"]);
  assert.deepEqual(ops[0].pages[0].items, ["sc", "b", "a", items[3].id, items[4].id]);
  assert.equal(ops[0].t, 2000);

  // nothing changed -> no ops
  assert.deepEqual(S.diffDb(clone(cur), cur, 3000), []);
});

test("diffDb: new project emits project + every item + pages; deleted project emits project.del", () => {
  const prev = { projects: [], scripts: [], deleted: {} };
  const cur = boardDb();
  const ops = S.diffDb(prev, cur, 10);
  const kinds = ops.map(o => o.k);
  assert.equal(kinds.filter(k => k === "item").length, 5); // scene + a + b + 2 pads (2x2 grid)
  assert.ok(kinds.includes("project") && kinds.includes("pages") && kinds.includes("script") && kinds.includes("sel") && kinds.includes("sorder"));
  assert.ok(kinds.indexOf("item") < kinds.indexOf("pages")); // items arrive before the structure that references them

  const gone = clone(cur);
  gone.projects = [];
  const ops2 = S.diffDb(cur, gone, 20);
  assert.deepEqual(ops2, [{ k: "project.del", id: "p1", t: 20 }]);
  assert.equal(gone.deleted.p1, 20);
});

test("diffDb + applyOps round trip converges two replicas", () => {
  const server = boardDb();
  const A = clone(server), B = clone(server);
  M.allItems(A.projects[0]).find(x => x.id === "a").title = "from A";
  M.allItems(B.projects[0]).find(x => x.id === "a").rich = "from B";
  M.allItems(B.projects[0]).find(x => x.id === "a").text = "from B";
  const opsA = S.diffDb(server, A, 100);
  const opsB = S.diffDb(server, B, 101);
  S.applyOps(B, opsA, "A"); S.applyOps(A, opsB, "B");
  S.applyOps(server, opsA, "A"); S.applyOps(server, opsB, "B");
  const pick = db => { const x = M.allItems(db.projects[0]).find(x => x.id === "a"); return [x.title, x.rich]; };
  assert.deepEqual(pick(A), ["from A", "from B"]);
  assert.deepEqual(pick(B), ["from A", "from B"]);
  assert.deepEqual(pick(server), ["from A", "from B"]);
});

test("drawingSig changes on stroke push, image move and undo", () => {
  const d = { base: null, images: [{ id: "i", src: "x", x: 0, y: 0, w: 10, h: 10 }], strokes: [{ color: "#000", size: 4, opacity: 1, pts: [1, 2, 0.5, 3, 4, 0.5] }] };
  const s0 = S.drawingSig(d);
  d.strokes.push({ color: "#000", size: 4, opacity: 1, pts: [9, 9, 0.5, 8, 8, 0.5] });
  const s1 = S.drawingSig(d);
  assert.notEqual(s0, s1);
  d.images[0].x = 5;
  const s2 = S.drawingSig(d);
  assert.notEqual(s1, s2);
  d.strokes.pop();
  assert.notEqual(S.drawingSig(d), s2);
  assert.equal(S.drawingSig(null), "");
});

test("mergeDrawing appends both sides' new strokes when both extend base; otherwise remote wins", () => {
  const st = n => ({ color: "#000", size: 4, opacity: 1, pts: [n, n, 0.5, n + 1, n + 1, 0.5] });
  const base = { base: null, images: [], strokes: [st(1)] };
  const local = { base: null, images: [], strokes: [st(1), st(2)] };
  const remote = { base: null, images: [{ id: "im", src: "s", x: 0, y: 0, w: 1, h: 1 }], strokes: [st(1), st(3)] };
  const m = S.mergeDrawing(base, local, remote);
  assert.deepEqual(m.strokes.map(s => s.pts[0]), [1, 2, 3]);
  assert.equal(m.images.length, 1);
  // local undid something (no longer extends base) -> remote wins
  const localUndo = { base: null, images: [], strokes: [] };
  assert.deepEqual(S.mergeDrawing(base, localUndo, remote), remote);
  // local unchanged -> remote
  assert.deepEqual(S.mergeDrawing(base, clone(base), remote), remote);
  // remote null (cleared) while local drew -> remote wins (LWW)
  assert.equal(S.mergeDrawing(base, local, null), null);
});
