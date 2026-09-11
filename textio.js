/* Storyit — external file formats (pure; runs in the browser and in node tests).
   .txt          readable storyboard / script that re-imports losslessly
                 (drawings excepted — they're not text)
   .storyit.json full backup, drawings included
   Rich text travels as marks: **bold**, *italic*, _underline_, \ escapes. */

(function (root) {
  "use strict";

  const M = (typeof require === "function" && typeof module !== "undefined") ? require("./model.js") : root;

  const BOARD_HEADER = "STORYIT STORYBOARD v1";
  const SCRIPT_HEADER = "STORYIT SCRIPT v1";
  const SCRIPT_TYPES = ["scene", "action", "character", "parenthetical", "dialogue", "transition", "shot"];

  /* ---------- rich html <-> marks ---------- */

  const escHtml = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const unescHtml = s => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  const escMarks = s => s.replace(/[\\*_]/g, m => "\\" + m);

  const TAG_MARK = { b: "**", strong: "**", i: "*", em: "*", u: "_" };

  /* html (text + b/i/u/br/div/p only) -> marks text with real newlines */
  function richToMarks(html) {
    let out = "";
    const tokens = String(html || "").split(/(<[^>]+>)/);
    for (const tok of tokens) {
      if (!tok) continue;
      if (tok[0] !== "<") { out += escMarks(unescHtml(tok)); continue; }
      const m = /^<(\/?)([a-zA-Z0-9]+)/.exec(tok);
      if (!m) continue;
      const close = m[1] === "/", tag = m[2].toLowerCase();
      if (tag === "br") { if (!close) out += "\n"; continue; }
      if (tag === "div" || tag === "p") { if (!close && out.length && !out.endsWith("\n")) out += "\n"; continue; }
      const mark = TAG_MARK[tag];
      if (mark) out += mark;
    }
    return out.replace(/\n+$/, "");
  }

  /* marks text -> runs [{t, b, i, u}] / newlines as {nl:true} */
  function parseMarks(text) {
    const runs = [];
    const st = { b: false, i: false, u: false };
    const stack = []; // open marks, innermost last: "b" | "i" | "u"
    const opened = {}; // mark -> index in runs where it was opened (for orphan repair)
    let buf = "";
    const flush = () => { if (buf) { runs.push({ t: buf, b: st.b, i: st.i, u: st.u }); buf = ""; } };
    const toggle = k => {
      flush();
      if (stack.includes(k)) {
        // close k, closing (and re-opening) anything nested inside it
        const inner = [];
        while (stack.length && stack[stack.length - 1] !== k) inner.unshift(stack.pop());
        stack.pop();
        st[k] = false;
        inner.forEach(x => stack.push(x));
        delete opened[k];
      } else {
        stack.push(k);
        st[k] = true;
        opened[k] = runs.length;
      }
    };
    const s = String(text || "");
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === "\\" && i + 1 < s.length) { buf += s[++i]; continue; }
      if (c === "\n") { flush(); runs.push({ nl: true }); continue; }
      if (c === "*") {
        const dbl = s[i + 1] === "*";
        const top = stack[stack.length - 1];
        if (top === "i") { toggle("i"); continue; }               // innermost closes first
        if (top === "b" && dbl) { toggle("b"); i++; continue; }
        if (dbl && !stack.includes("b")) { toggle("b"); i++; continue; }
        toggle("i"); continue;
      }
      if (c === "_") { toggle("u"); continue; }
      buf += c;
    }
    flush();
    // orphaned openers become literal marks again
    for (const k of stack) {
      const at = opened[k];
      const lit = k === "b" ? "**" : k === "i" ? "*" : "_";
      for (let j = at; j < runs.length; j++) if (!runs[j].nl) runs[j][k] = false;
      runs.splice(at, 0, { t: lit, b: false, i: false, u: false, literal: true });
    }
    return runs;
  }

  function runsToHtml(runs) {
    let html = "", open = [];
    const closeAll = () => { while (open.length) html += "</" + open.pop() + ">"; };
    for (const r of runs) {
      if (r.nl) { closeAll(); html += "<br>"; continue; }
      const want = [r.b && "b", r.i && "i", r.u && "u"].filter(Boolean);
      // close what's no longer wanted (and whatever is nested inside it)
      let keep = 0;
      while (keep < open.length && keep < want.length && open[keep] === want[keep]) keep++;
      while (open.length > keep) html += "</" + open.pop() + ">";
      for (let k = keep; k < want.length; k++) { html += "<" + want[k] + ">"; open.push(want[k]); }
      html += escHtml(r.t);
    }
    closeAll();
    return html;
  }
  const runsToPlain = runs => runs.map(r => r.nl ? "\n" : r.t).join("");

  function marksToRich(text) { return runsToHtml(parseMarks(text)); }
  function marksToPlain(text) { return runsToPlain(parseMarks(text)); }

  /* ---------- block helpers ---------- */

  const indent = text => text.split("\n").map(l => (l === "" ? "" : "  " + l)).join("\n");
  function stripLine(l) { return l.endsWith("\r") ? l.slice(0, -1) : l; }

  /* read an indented block starting at lines[i]; returns [text, nextIndex] */
  function readBlock(lines, i) {
    const out = [];
    let j = i;
    while (j < lines.length) {
      const l = lines[j];
      if (l.startsWith("  ")) { out.push(l.slice(2)); j++; continue; }
      if (l === "") {
        // blank lines belong to the block only if more indented lines follow
        let k = j;
        while (k < lines.length && lines[k] === "") k++;
        if (k < lines.length && lines[k].startsWith("  ")) { for (; j < k; j++) out.push(""); continue; }
      }
      break;
    }
    return [out.join("\n"), j];
  }

  /* ---------- storyboard ---------- */

  function boardToTxt(p) {
    const L = [BOARD_HEADER, `Title: ${p.name || ""}`, `Aspect: ${p.aspect || "1:1"}`, `Grid: ${p.cols || 2}x${p.rows || 3}`];
    for (const it of M.allItems(p)) {
      L.push("");
      if (it.kind === "scene") { L.push(`== SCENE ${it.num || ""}: ${it.title || ""} ==`); continue; }
      L.push(it.num ? `--- SHOT ${it.num} ---` : "--- SHOT ---");
      if (it.title) L.push(`Title: ${it.title}`);
      L.push(`Frame: ${it.frameHidden ? "hidden" : "shown"}`);
      const note = richToMarks(it.noteRich || (it.note ? escHtml(it.note).replace(/\n/g, "<br>") : ""));
      if (note) { L.push("Note:"); L.push(indent(note)); }
      const desc = richToMarks(it.rich || (it.text ? escHtml(it.text).replace(/\n/g, "<br>") : ""));
      if (desc) { L.push("Description:"); L.push(indent(desc)); }
    }
    return L.join("\n") + "\n";
  }

  function txtToBoard(txt) {
    const lines = String(txt || "").split("\n").map(stripLine);
    if ((lines[0] || "").trim() !== BOARD_HEADER) throw new Error("Not a Storyit storyboard file");
    const p = { id: M.uid(), name: "", aspect: "16:9", cols: 2, rows: 3, createdAt: Date.now(), updatedAt: Date.now(), pages: [] };
    const items = [];
    let shot = null, i = 1;
    const setRich = (field, marks) => {
      shot[field] = marksToRich(marks);
      shot[field === "rich" ? "text" : "note"] = marksToPlain(marks);
    };
    while (i < lines.length) {
      const l = lines[i];
      let m;
      if (!shot && !items.length && (m = /^Title: ?(.*)$/.exec(l))) { p.name = m[1]; i++; continue; }
      if (!shot && !items.length && (m = /^Aspect: ?(.*)$/.exec(l))) { p.aspect = m[1].trim(); i++; continue; }
      if (!shot && !items.length && (m = /^Grid: ?(\d+)\s*[x×]\s*(\d+)/.exec(l))) { p.cols = +m[1]; p.rows = +m[2]; i++; continue; }
      if ((m = /^== SCENE (.*?): ?(.*?) ==$/.exec(l))) {
        const sc = M.newScene(m[1].trim()); sc.title = m[2]; items.push(sc); shot = null; i++; continue;
      }
      if ((m = /^--- SHOT(?: (.*?))? ---$/.exec(l))) {
        shot = M.newShot(); shot.num = (m[1] || "").trim(); items.push(shot); i++; continue;
      }
      if (shot) {
        if ((m = /^Title: ?(.*)$/.exec(l))) { shot.title = m[1]; i++; continue; }
        if ((m = /^Frame: ?(.*)$/.exec(l))) { shot.frameHidden = m[1].trim() !== "shown"; i++; continue; }
        if (/^Note:\s*$/.test(l)) { const [b, j] = readBlock(lines, i + 1); setRich("noteRich", b); i = j; continue; }
        if (/^Description:\s*$/.test(l)) { const [b, j] = readBlock(lines, i + 1); setRich("rich", b); i = j; continue; }
      }
      i++; // blank or unknown line
    }
    M.rechunkItems(p, items);
    return p;
  }

  /* ---------- script ---------- */

  function scriptToTxt(s) {
    const L = [SCRIPT_HEADER, `Title: ${s.name || ""}`, `Author: ${s.author || ""}`];
    for (const el of s.elements) {
      L.push("");
      const marks = richToMarks(el.html || (el.text ? escHtml(el.text).replace(/\n/g, "<br>") : ""));
      const [first, ...rest] = marks.split("\n");
      L.push(first ? `${el.type}: ${first}` : `${el.type}:`);
      rest.forEach(r => L.push(r === "" ? "" : "  " + r));
    }
    return L.join("\n") + "\n";
  }

  function txtToScript(txt) {
    const lines = String(txt || "").split("\n").map(stripLine);
    if ((lines[0] || "").trim() !== SCRIPT_HEADER) throw new Error("Not a Storyit script file");
    const s = { id: M.uid(), name: "", author: "", createdAt: Date.now(), updatedAt: Date.now(), elements: [] };
    const typeRe = new RegExp("^(" + SCRIPT_TYPES.join("|") + "):(?: (.*))?$");
    let i = 1, seenEl = false;
    while (i < lines.length) {
      const l = lines[i];
      let m;
      if (!seenEl && (m = /^Title: ?(.*)$/.exec(l))) { s.name = m[1]; i++; continue; }
      if (!seenEl && (m = /^Author: ?(.*)$/.exec(l))) { s.author = m[1]; i++; continue; }
      if ((m = typeRe.exec(l))) {
        seenEl = true;
        const [rest, j] = readBlock(lines, i + 1);
        const marks = (m[2] || "") + (rest ? "\n" + rest : "");
        s.elements.push({ id: M.uid(), type: m[1], text: marksToPlain(marks), html: marksToRich(marks) });
        i = j; continue;
      }
      i++;
    }
    if (!s.elements.length) s.elements.push({ id: M.uid(), type: "scene", text: "", html: "" });
    return s;
  }

  /* ---------- backup json ---------- */

  function stripFt(o) {
    if (Array.isArray(o)) return o.map(stripFt);
    if (o && typeof o === "object") {
      const out = {};
      for (const k of Object.keys(o)) if (k !== "ft") out[k] = stripFt(o[k]);
      return out;
    }
    return o;
  }
  function toBackup(obj) {
    let projects = [], scripts = [];
    if (obj && Array.isArray(obj.projects)) { projects = obj.projects; scripts = obj.scripts || []; }
    else if (obj && Array.isArray(obj.pages)) projects = [obj];
    else if (obj && Array.isArray(obj.elements)) scripts = [obj];
    return JSON.stringify({ storyit: 1, exportedAt: new Date().toISOString(), projects: stripFt(projects), scripts: stripFt(scripts) });
  }
  function fromBackup(json) {
    const raw = typeof json === "string" ? JSON.parse(json) : json;
    let projects = [], scripts = [];
    if (raw && Array.isArray(raw.projects)) { projects = raw.projects; scripts = raw.scripts || []; }
    else if (raw && Array.isArray(raw.pages)) projects = [raw];
    else if (raw && Array.isArray(raw.elements)) scripts = [raw];
    else throw new Error("Not a Storyit backup");
    projects = stripFt(projects).map(p => {
      p.id = M.uid();
      M.migrateProject(p);
      M.rechunkItems(p, M.allItems(p)); // partial pages fill out to the grid
      p.pages.forEach(pg => {
        pg.id = M.uid();
        pg.items.forEach(it => {
          it.id = M.uid();
          if (it.drawing && Array.isArray(it.drawing.images)) it.drawing.images.forEach(im => { im.id = M.uid(); });
        });
      });
      return p;
    });
    scripts = stripFt(scripts).map(s => {
      s.id = M.uid();
      if (!Array.isArray(s.elements)) s.elements = [];
      s.elements.forEach(el => { el.id = M.uid(); if (el.html === undefined) el.html = escHtml(el.text || "").replace(/\n/g, "<br>"); });
      return s;
    });
    return { projects, scripts };
  }

  function detectImport(text) {
    const t = String(text || "").trimStart();
    if (t.startsWith(BOARD_HEADER)) return "board";
    if (t.startsWith(SCRIPT_HEADER)) return "script";
    if (t[0] === "{") {
      try {
        const o = JSON.parse(t);
        if (o && (o.storyit || Array.isArray(o.projects) || Array.isArray(o.pages) || Array.isArray(o.elements))) return "backup";
      } catch (e) { /* not json */ }
    }
    return null;
  }

  const api = { boardToTxt, txtToBoard, scriptToTxt, txtToScript, richToMarks, marksToRich, marksToPlain, toBackup, fromBackup, stripFt, detectImport, BOARD_HEADER, SCRIPT_HEADER };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else Object.assign(root, { TextIO: api });
})(typeof globalThis !== "undefined" ? globalThis : this);
