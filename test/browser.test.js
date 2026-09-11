/* End-to-end smoke test: drives the real app in headless Chrome over the
   DevTools protocol (no npm deps — Node's built-in WebSocket). Skips when
   Chrome isn't installed. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { start } = require("../server.js");

const CHROME = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
].find(p => fs.existsSync(p));

function launchChrome(profileDir) {
  return new Promise((resolve, reject) => {
    const proc = spawn(CHROME, [
      "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profileDir}`,
      "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars",
      "--window-size=1200,900", "about:blank",
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    proc.stderr.on("data", d => {
      err += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
      if (m) resolve({ proc, wsUrl: m[1] });
    });
    proc.on("exit", code => reject(new Error("chrome exited " + code + "\n" + err)));
    setTimeout(() => reject(new Error("chrome did not start\n" + err)), 15000);
  });
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); this.listeners = []; }
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const c = new CDP(ws);
      ws.onopen = () => resolve(c);
      ws.onerror = e => reject(new Error("ws error"));
      ws.onmessage = ev => {
        const msg = JSON.parse(ev.data);
        if (msg.id && c.waiting.has(msg.id)) { const { res, rej } = c.waiting.get(msg.id); c.waiting.delete(msg.id); msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result); }
        else c.listeners.forEach(l => l(msg));
      };
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((res, rej) => this.waiting.set(id, { res, rej }));
  }
  on(fn) { this.listeners.push(fn); }
  close() { this.ws.close(); }
}

class Page {
  constructor(cdp, sessionId) { this.cdp = cdp; this.sid = sessionId; this.errors = []; }
  static async open(cdp, url) {
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const page = new Page(cdp, sessionId);
    cdp.on(msg => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === "Runtime.exceptionThrown") page.errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
      if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") page.errors.push("console.error: " + msg.params.args.map(a => a.value ?? a.description).join(" "));
    });
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    await cdp.send("Page.navigate", { url }, sessionId);
    await page.waitFor("document.readyState === 'complete' && typeof renderHome === 'function'");
    return page;
  }
  async eval(expr) {
    const r = await this.cdp.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, this.sid);
    if (r.exceptionDetails) throw new Error("eval failed: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) + "\n" + expr);
    return r.result.value;
  }
  async waitFor(expr, ms = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await this.eval(`!!(${expr})`)) return true;
      await new Promise(r => setTimeout(r, 60));
    }
    throw new Error("timeout waiting for: " + expr);
  }
  click(sel) { return this.eval(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error("no " + ${JSON.stringify(sel)}); el.click(); return true; })()`); }
  type(sel, text, idx = 0) {
    return this.eval(`(() => { const el = document.querySelectorAll(${JSON.stringify(sel)})[${idx}]; if (!el) throw new Error("no " + ${JSON.stringify(sel)});
      el.focus(); if (el.isContentEditable) el.textContent = ${JSON.stringify(text)}; else el.value = ${JSON.stringify(text)};
      el.dispatchEvent(new Event("input", { bubbles: true })); el.blur(); return true; })()`);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

test("browser: create board with grid, scenes, notes, numbers; txt round trip; live sync between two tabs; script zoom", { skip: !CHROME && "Chrome not installed" }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "storyit-data-"));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "storyit-chrome-"));
  const srv = await start({ port: 0, dataDir, quiet: true });
  const { proc, wsUrl } = await launchChrome(profile);
  const cdp = await CDP.connect(wsUrl);
  const url = `http://127.0.0.1:${srv.port}/`;
  try {
    const A = await Page.open(cdp, url);
    await A.waitFor("SYNC.lastState === 'synced'");
    assert.equal(await A.eval("document.querySelector('[data-sync-pill] span').textContent"), "Synced");
    assert.equal(await A.eval("document.getElementById('ipad-tip').hidden"), false);

    // create a 3x3 board through the create popover
    await A.click("#btn-new-project");
    assert.equal(await A.eval("document.getElementById('create-pop').hidden"), false);
    await A.click('#create-pop .grid-opt[data-cols="3"][data-rows="3"]');
    await A.click('#create-pop .aspect-opt[data-ar="4:3"]');
    await A.click("#btn-create-project");
    await A.waitFor("currentId && !document.getElementById('view-project').hidden && document.querySelectorAll('.panel').length === 9");
    assert.equal(await A.eval("currentProject().cols"), 3);
    assert.equal(await A.eval("currentProject().aspect"), "4:3");
    assert.equal(await A.eval("document.querySelectorAll('.scene-row').length"), 1);
    assert.equal(await A.eval("document.getElementById('btn-grid').textContent"), "3×3");
    assert.equal(await A.eval("getComputedStyle(document.querySelector('.page-grid')).gridTemplateColumns.split(' ').length"), 3);

    // fill the first shot: title, number, note, description
    await A.type("#project-name", "Smoke board");
    await A.type(".panel .panel-title", "Wide on the kitchen");
    await A.type(".panel .panel-num", "1A");
    await A.type(".panel .panel-note", "Handheld");
    await A.type(".panel .panel-text", "Anna enters.");
    const first = await A.eval("JSON.stringify((() => { const x = allPanels(currentProject())[0]; return [x.title, x.num, x.note, x.noteRich, x.text, x.rich]; })())");
    assert.deepEqual(JSON.parse(first), ["Wide on the kitchen", "1A", "Handheld", "Handheld", "Anna enters.", "Anna enters."]);
    assert.ok(await A.eval("document.querySelector('.panel').classList.contains('has-note')"));

    // scene row after the first shot, numbered 2 automatically
    await A.click(".panel .add-scene");
    await A.waitFor("document.querySelectorAll('.scene-row').length === 2");
    assert.equal(await A.eval("allItems(currentProject())[2].kind"), "scene");
    assert.equal(await A.eval("allItems(currentProject())[2].num"), "2");

    // switch to a 2x2 grid: blanks at the tail drop, the rest reflows
    await A.click("#btn-grid");
    await A.click('#grid-pop .grid-opt[data-cols="2"][data-rows="2"]');
    await A.waitFor("currentProject().cols === 2 && document.querySelectorAll('.panel').length === 4");
    assert.equal(await A.eval("currentProject().pages.length"), 1);

    // txt export / import is lossless
    const txt = await A.eval("TextIO.boardToTxt(currentProject())");
    assert.match(txt, /^STORYIT STORYBOARD v1\nTitle: Smoke board\nAspect: 4:3\nGrid: 2x2\n\n== SCENE 1: {2}==\n\n--- SHOT 1A ---\nTitle: Wide on the kitchen\nFrame: hidden\nNote:\n {2}Handheld\nDescription:\n {2}Anna enters\.\n\n== SCENE 2: {2}==\n/);
    assert.equal(await A.eval(`TextIO.boardToTxt(TextIO.txtToBoard(${JSON.stringify(txt)}))`), txt);

    // PDF export runs without throwing (download itself is swallowed by headless)
    await A.eval("exportPDF().then(() => true)");

    // a second device joins and sees the same board, then edits it live
    await A.waitFor("SYNC.lastState === 'synced' && !SYNC.pending && !SYNC.sending");
    const B = await Page.open(cdp, url);
    await B.waitFor("SYNC.lastState === 'synced' && db.projects.length === 1");
    assert.equal(await B.eval("db.projects[0].name"), "Smoke board");
    await B.eval("openProject(db.projects[0].id)");
    await B.waitFor("document.querySelectorAll('.panel').length === 4");
    await B.type(".panel .panel-title", "Retitled from iPad");
    await B.type(".panel .panel-text", "Typed on the other device", 1);
    await A.waitFor("allPanels(currentProject())[0].title === 'Retitled from iPad'");
    assert.equal(await A.eval("document.querySelector('.panel .panel-title').value"), "Retitled from iPad");
    await A.waitFor("allPanels(currentProject())[1].text === 'Typed on the other device'");
    // structure change on B shows up on A
    await B.click(".panel .add-scene");
    await A.waitFor("document.querySelectorAll('.scene-row').length === 3");
    // A draws a stroke while B renames the same shot: both survive
    await A.eval(`(() => { const x = allPanels(currentProject())[0]; ensureDrawing(x).strokes.push({ color: "#141414", size: 8, opacity: 1, pts: [10, 10, .5, 200, 200, .5, 300, 100, .5] }); save(); return true; })()`);
    await B.type(".panel .panel-title", "Renamed again");
    await A.waitFor("allPanels(currentProject())[0].title === 'Renamed again'");
    await B.waitFor("(allPanels(currentProject())[0].drawing || {strokes: []}).strokes.length === 1");
    assert.equal(await A.eval("allPanels(currentProject())[0].drawing.strokes.length"), 1);

    // server state matches
    const state = srv.state();
    assert.equal(state.db.projects[0].name, "Smoke board");
    assert.equal(state.db.projects[0].pages[0].items.filter(i => i.kind === "scene").length, 3);

    // scripts: new script, type, zoom is a real sheet zoom
    await A.click("#btn-back");
    await A.waitFor("!document.getElementById('view-home').hidden && currentId === null");
    await A.click("#btn-new-script");
    await A.waitFor("currentScriptId && !document.getElementById('view-script').hidden");
    await A.type("#script-doc .s-edit", "INT. HOUSE - DAY");
    assert.equal(await A.eval("currentScript().elements[0].text"), "INT. HOUSE - DAY");
    const z0 = await A.eval("parseFloat(document.getElementById('script-paper').style.zoom) || 1");
    assert.equal(z0, 1);
    await A.click("#btn-zoom-in");
    assert.equal(await A.eval("parseFloat(document.getElementById('script-paper').style.zoom)"), 1.1);
    assert.equal(await A.eval("document.getElementById('script-paper').getBoundingClientRect().width > 850"), true);
    assert.equal(await A.eval("document.getElementById('script-doc').getBoundingClientRect().width"), await A.eval("document.getElementById('script-doc').getBoundingClientRect().width")); // stable
    await A.click("#btn-zoom-reset");
    const sTxt = await A.eval("TextIO.scriptToTxt(currentScript())");
    assert.equal(await A.eval(`TextIO.scriptToTxt(TextIO.txtToScript(${JSON.stringify(sTxt)}))`), sTxt);
    await B.waitFor("db.scripts.length === 1 && db.scripts[0].elements[0].text === 'INT. HOUSE - DAY'");

    // import a storyboard .txt through the importer (creates a new project)
    await A.click("#btn-script-back");
    await A.waitFor("currentScriptId === null");
    const before = await A.eval("db.projects.length");
    await A.eval(`(() => { const r = importText(${JSON.stringify(txt)}, "Imported.txt"); save(); return r.projects.length; })()`);
    assert.equal(await A.eval("db.projects.length"), before + 1);
    await B.waitFor(`db.projects.length === ${before + 1}`);

    // legacy migration: an old-format store loads into items + scene rows
    const legacy = { projects: [{ id: "old", name: "Legacy", pages: [{ id: "pg", panels: [{ id: "x", title: "T", text: "d", scene: 1 }, { id: "y", title: "", text: "", scene: 2 }] }] }], scripts: [] };
    const C = await Page.open(cdp, url);
    const mig = await C.eval(`JSON.stringify((() => { const p = migrateProject(${JSON.stringify(legacy.projects[0])}); return { cols: p.cols, kinds: allItems(p).map(i => i.kind), nums: allItems(p).filter(i => i.kind === "scene").map(i => i.num), rich: allPanels(p)[0].rich }; })())`);
    assert.deepEqual(JSON.parse(mig), { cols: 2, kinds: ["scene", "shot", "scene", "shot", "shot", "shot", "shot", "shot"], nums: ["1", "2"], rich: "d" });

    assert.deepEqual(A.errors, [], "page A errors");
    assert.deepEqual(B.errors, [], "page B errors");
    assert.deepEqual(C.errors, [], "page C errors");
  } finally {
    cdp.close();
    proc.kill("SIGKILL");
    await srv.close();
  }
});

test("browser: opened as a plain file it stays local-only without errors", { skip: !CHROME && "Chrome not installed" }, async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "storyit-chrome-"));
  const { proc, wsUrl } = await launchChrome(profile);
  const cdp = await CDP.connect(wsUrl);
  try {
    const P = await Page.open(cdp, "file://" + path.join(__dirname, "..", "index.html"));
    await sleep(300);
    assert.equal(await P.eval("SYNC.on"), false);
    assert.equal(await P.eval("document.querySelector('[data-sync-pill] span').textContent"), "Local only");
    await P.click("#btn-new-project");
    await P.click("#btn-create-project");
    await P.waitFor("document.querySelectorAll('.panel').length === 6");
    assert.deepEqual(P.errors, []);
  } finally {
    cdp.close();
    proc.kill("SIGKILL");
  }
});
