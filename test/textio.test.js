const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../model.js");
const T = require("../textio.js");

const SAMPLE_BOARD = `STORYIT STORYBOARD v1
Title: Kitchen fight
Aspect: 16:9
Grid: 2x3

== SCENE 1: Morning ==

--- SHOT 1A ---
Title: Wide on the kitchen
Frame: shown
Note:
  Handheld, **slow push in**
Description:
  Anna enters. The kettle screams.

--- SHOT ---
Frame: hidden
Description:
  Cut to black.
`;

test("txtToBoard parses the spec sample", () => {
  const p = T.txtToBoard(SAMPLE_BOARD);
  assert.equal(p.name, "Kitchen fight");
  assert.equal(p.aspect, "16:9");
  assert.equal(p.cols, 2); assert.equal(p.rows, 3);
  const items = M.allItems(p);
  assert.equal(items[0].kind, "scene");
  assert.equal(items[0].num, "1");
  assert.equal(items[0].title, "Morning");
  const s1 = items[1];
  assert.equal(s1.num, "1A");
  assert.equal(s1.title, "Wide on the kitchen");
  assert.equal(s1.frameHidden, false);
  assert.equal(s1.note, "Handheld, slow push in");
  assert.equal(s1.noteRich, "Handheld, <b>slow push in</b>");
  assert.equal(s1.text, "Anna enters. The kettle screams.");
  assert.equal(s1.rich, "Anna enters. The kettle screams.");
  assert.equal(s1.drawing, null);
  const s2 = items[2];
  assert.equal(s2.num, "");
  assert.equal(s2.title, "");
  assert.equal(s2.frameHidden, true);
  assert.equal(s2.text, "Cut to black.");
  assert.equal(M.allPanels(p).length, 6); // padded to a full 2x3 page
});

test("board txt round-trips byte-for-byte", () => {
  const p = T.txtToBoard(SAMPLE_BOARD);
  // the export writes every shot, including the 4 blank pads
  const out = T.boardToTxt(p);
  assert.equal(T.boardToTxt(T.txtToBoard(out)), out);
  assert.ok(out.startsWith(SAMPLE_BOARD.trimEnd()));
});

test("board txt keeps interior blank lines, multi-line rich text, html-escaped chars and a scene with no title", () => {
  const p = { id: "x", name: "Edge <case> & co", aspect: "9:16", cols: 1, rows: 2, pages: [] };
  const a = M.newShot();
  a.title = "First"; a.num = "2";
  a.rich = "line one<br><br>line <b>three</b> &amp; &lt;tag&gt;"; a.text = "line one\n\nline three & <tag>";
  a.noteRich = "<div>top</div><div>bottom</div>"; a.note = "top\nbottom";
  a.frameHidden = false;
  const sc = M.newScene("2A");
  M.rechunkItems(p, [M.newScene(1), a, sc, M.newShot()]);
  const txt = T.boardToTxt(p);
  const back = T.txtToBoard(txt);
  assert.equal(back.name, "Edge <case> & co");
  const items = M.allItems(back);
  assert.equal(items[1].text, "line one\n\nline three & <tag>");
  assert.equal(items[1].rich, "line one<br><br>line <b>three</b> &amp; &lt;tag&gt;");
  assert.equal(items[1].note, "top\nbottom");
  assert.equal(items[1].noteRich, "top<br>bottom");
  assert.equal(items[2].kind, "scene");
  assert.equal(items[2].num, "2A");
  assert.equal(items[2].title, "");
  assert.equal(T.boardToTxt(back), txt);
});

test("txtToBoard rejects non-storyboard text", () => {
  assert.throws(() => T.txtToBoard("hello"), /Not a Storyit storyboard file/);
});

const SAMPLE_SCRIPT = `STORYIT SCRIPT v1
Title: Untitled script
Author: Me

scene: INT. HOUSE - DAY

action: Bob walks in, soaked.
  Second hard line of the same action.

character: BOB

dialogue: It's *raining*.
`;

test("script txt parses and round-trips", () => {
  const s = T.txtToScript(SAMPLE_SCRIPT);
  assert.equal(s.name, "Untitled script");
  assert.equal(s.author, "Me");
  assert.deepEqual(s.elements.map(e => e.type), ["scene", "action", "character", "dialogue"]);
  assert.equal(s.elements[1].text, "Bob walks in, soaked.\nSecond hard line of the same action.");
  assert.equal(s.elements[1].html, "Bob walks in, soaked.<br>Second hard line of the same action.");
  assert.equal(s.elements[3].html, "It's <i>raining</i>.");
  assert.equal(T.scriptToTxt(s), SAMPLE_SCRIPT);
});

test("script txt: empty elements, bold+underline, and a 'type:' looking line inside text survive", () => {
  const s = { id: "s", name: "", author: "", elements: [
    { id: "1", type: "scene", text: "", html: "" },
    { id: "2", type: "dialogue", text: "note: not a type\nsecond", html: "note: not a type<br>second" },
    { id: "3", type: "action", text: "b u", html: "<b>b</b> <u>u</u>" },
  ] };
  const txt = T.scriptToTxt(s);
  const back = T.txtToScript(txt);
  assert.deepEqual(back.elements.map(e => [e.type, e.html]), [["scene", ""], ["dialogue", "note: not a type<br>second"], ["action", "<b>b</b> <u>u</u>"]]);
  assert.equal(T.scriptToTxt(back), txt);
});

test("marks <-> rich", () => {
  assert.equal(T.marksToRich("a **b** c"), "a <b>b</b> c");
  assert.equal(T.richToMarks("a <b>b</b> c"), "a **b** c");
  assert.equal(T.richToMarks("x<br>y"), "x\ny");
  assert.equal(T.marksToRich("x\ny"), "x<br>y");
  assert.equal(T.richToMarks("5 &lt; 6 &amp; 7"), "5 < 6 & 7");
  assert.equal(T.marksToRich("5 < 6 & 7"), "5 &lt; 6 &amp; 7");
  // literal asterisks that are not markup are escaped and come back intact
  const lit = "2 * 3 * 4";
  assert.equal(T.marksToRich(T.richToMarks(lit)), lit);
  assert.equal(T.marksToRich(T.richToMarks("**")), "**");
  assert.equal(T.marksToRich("a *b"), "a *b"); // an unclosed mark stays literal
  assert.equal(T.marksToRich("***x***"), "<b><i>x</i></b>");
});

test("backup: regenerates ids, strips ft, accepts a single project", () => {
  const p = { id: "p1", name: "B", aspect: "1:1", cols: 2, rows: 2, ft: { name: 5 }, pages: [{ id: "pg", items: [Object.assign(M.newShot(), { id: "a", ft: { title: 1 } })] }] };
  const json = T.toBackup(p);
  const parsed = JSON.parse(json);
  assert.equal(parsed.storyit, 1);
  assert.equal("ft" in parsed.projects[0], false);
  const { projects, scripts } = T.fromBackup(json);
  assert.equal(projects.length, 1); assert.equal(scripts.length, 0);
  assert.notEqual(projects[0].id, "p1");
  assert.notEqual(projects[0].pages[0].items[0].id, "a");
  assert.equal("ft" in projects[0].pages[0].items[0], false);
  assert.equal(M.allPanels(projects[0]).length, 4);
});

test("detectImport", () => {
  assert.equal(T.detectImport(SAMPLE_BOARD), "board");
  assert.equal(T.detectImport(SAMPLE_SCRIPT), "script");
  assert.equal(T.detectImport('{"storyit":1,"projects":[]}'), "backup");
  assert.equal(T.detectImport("nope"), null);
});
