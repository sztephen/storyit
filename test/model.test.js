const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../model.js");

const shots = n => Array.from({ length: n }, (_, i) => Object.assign(M.newShot(), { title: "S" + (i + 1) }));

test("rechunkItems: 2x3 grid, scene row travels with the shot after it", () => {
  const p = { cols: 2, rows: 3, pages: [] };
  const s = shots(7);
  const scene = M.newScene(2);
  const items = [...s.slice(0, 6), scene, s[6]];
  M.rechunkItems(p, items);
  assert.equal(p.pages.length, 2);
  assert.deepEqual(p.pages[0].items.map(x => x.title), ["S1", "S2", "S3", "S4", "S5", "S6"]);
  const pg2 = p.pages[1].items;
  assert.equal(pg2[0], scene);
  assert.equal(pg2[1].title, "S7");
  assert.equal(pg2.length, 7); // scene + 6 shots (5 blank pads)
  assert.ok(pg2.slice(2).every(x => x.kind === "shot" && !x.title));
});

test("rechunkItems: trailing scene row stays on the last page, page ids are kept", () => {
  const p = { cols: 1, rows: 2, pages: [{ id: "pgA", items: [] }, { id: "pgB", items: [] }] };
  const s = shots(2);
  const scene = M.newScene(1);
  M.rechunkItems(p, [...s, scene]);
  assert.equal(p.pages.length, 1);
  assert.equal(p.pages[0].id, "pgA");
  assert.equal(p.pages[0].items[2], scene);
});

test("rechunkItems: empty list gives one blank page", () => {
  const p = { cols: 2, rows: 2, pages: [] };
  M.rechunkItems(p, []);
  assert.equal(p.pages.length, 1);
  assert.equal(p.pages[0].items.length, 4);
});

test("migrateProject: legacy panels + scene numbers become items with scene rows", () => {
  const p = {
    id: "p1", name: "Old", pages: [{ id: "pg", panels: [
      { id: "a", title: "A", text: "t", scene: 1 },
      { id: "b", title: "B", scene: 1 },
      { id: "c", title: "C", scene: 2 },
    ] }],
  };
  M.migrateProject(p);
  assert.equal(p.cols, 2); assert.equal(p.rows, 3);
  const items = M.allItems(p);
  assert.deepEqual(items.map(x => x.kind), ["scene", "shot", "shot", "scene", "shot", "shot", "shot", "shot"]);
  assert.equal(items[0].num, "1");
  assert.equal(items[3].num, "2");
  assert.equal(items[1].num, "");
  assert.equal(items[1].note, "");
  assert.equal(items[1].noteRich, "");
  assert.equal(items[1].rich, "t");
  assert.equal("scene" in items[1], false);
  assert.equal("panels" in p.pages[0], false);
});

test("migrateProject: already-migrated project is left alone", () => {
  const p = { id: "p", cols: 3, rows: 3, pages: [{ id: "x", items: [M.newScene(1), ...shots(9)] }] };
  const before = JSON.stringify(p);
  M.migrateProject(p);
  assert.equal(JSON.stringify(p), before);
});

test("nextSceneNum: integer after the previous scene row, else count + 1", () => {
  const p = { cols: 2, rows: 3, pages: [] };
  const s = shots(4);
  M.rechunkItems(p, [M.newScene(2), s[0], s[1], M.newScene("2A"), s[2], s[3]]);
  assert.equal(M.nextSceneNum(p, s[1].id), 3);
  assert.equal(M.nextSceneNum(p, s[3].id), 3); // "2A" is not an integer -> 2 scene rows + 1
  assert.equal(M.nextSceneNum(p, null), 3);
});

test("allPanels returns shots only; capacity is cols*rows", () => {
  const p = { cols: 3, rows: 4, pages: [] };
  M.rechunkItems(p, [M.newScene(1), ...shots(2)]);
  assert.equal(M.capacity(p), 12);
  assert.equal(M.allPanels(p).length, 12);
  assert.equal(M.allItems(p).length, 13);
});
