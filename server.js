#!/usr/bin/env node
/* Storyit server — serves the app on your network and keeps one shared copy
   of every storyboard + script so a Mac and an iPad can work on the same
   project at once.

     node server.js            # http://<this-mac>:8787
     node server.js 9000       # another port

   Zero dependencies. State lives in data/storyit.json (written atomically,
   debounced). Clients POST entity-level ops; the server applies them with
   the same last-writer-wins rule the clients use (sync.js) and fans them
   out over Server-Sent Events. */

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { applyOps } = require("./sync.js");

const ROOT = __dirname;
const BODY_LIMIT = 64 * 1024 * 1024;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};
const BLOCKED = new Set(["data", "test", "docs", "node_modules", ".git"]);

function lanIp() {
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const i of ifs[name]) {
      if (i.family === "IPv4" && !i.internal) return i.address;
    }
  }
  return "localhost";
}

function start({ port = 8787, dataDir = path.join(ROOT, "data"), quiet = false } = {}) {
  const FILE = path.join(dataDir, "storyit.json");
  let state = { rev: 0, db: { projects: [], scripts: [], deleted: {} } };
  try {
    const raw = fs.readFileSync(FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.db && Array.isArray(parsed.db.projects)) state = parsed;
    if (!state.db.deleted) state.db.deleted = {};
    if (!Array.isArray(state.db.scripts)) state.db.scripts = [];
  } catch (e) { /* first run */ }

  const streams = new Set();
  let writeTimer = null, writing = false, dirty = false;

  function persist() {
    dirty = true;
    clearTimeout(writeTimer);
    writeTimer = setTimeout(flushToDisk, 300);
  }
  function flushToDisk() {
    if (writing) { persist(); return; }
    dirty = false;
    writing = true;
    const tmp = FILE + ".tmp";
    fs.mkdir(dataDir, { recursive: true }, err => {
      if (err) { writing = false; return; }
      fs.writeFile(tmp, JSON.stringify(state), err2 => {
        if (err2) { writing = false; return; }
        fs.rename(tmp, FILE, () => { writing = false; if (dirty) persist(); });
      });
    });
  }

  function send(res, code, body, type = "application/json; charset=utf-8") {
    const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(data);
  }
  function broadcast(msg) {
    const line = "data: " + JSON.stringify(msg) + "\n\n";
    for (const res of streams) { try { res.write(line); } catch (e) { streams.delete(res); } }
  }
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", c => {
        size += c.length;
        if (size > BODY_LIMIT) { reject(new Error("too large")); req.destroy(); return; }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;

    if (p === "/api/info" && req.method === "GET") {
      const addr = server.address();
      return send(res, 200, { hosted: true, url: `http://${lanIp()}:${addr.port}`, rev: state.rev });
    }
    if (p === "/api/state" && req.method === "GET") return send(res, 200, state);
    if (p === "/api/ops" && req.method === "POST") {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: "bad json" }); }
      const ops = Array.isArray(body.ops) ? body.ops : [];
      const client = String(body.client || "");
      const { changed } = applyOps(state.db, ops, client);
      if (ops.length) {
        state.rev++;
        persist();
        broadcast({ rev: state.rev, client, ops });
      }
      return send(res, 200, { rev: state.rev, changed: changed.any });
    }
    if (p === "/api/events" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ rev: state.rev })}\n\n`);
      streams.add(res);
      const beat = setInterval(() => { try { res.write(": ping\n\n"); } catch (e) { /* closed */ } }, 20000);
      req.on("close", () => { clearInterval(beat); streams.delete(res); });
      return;
    }
    if (p.startsWith("/api/")) return send(res, 404, { error: "not found" });

    // static files
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "method not allowed", "text/plain");
    let rel = decodeURIComponent(p);
    if (rel === "/" || rel === "") rel = "/index.html";
    const segs = rel.split("/").filter(Boolean);
    if (segs.some(s => s === ".." || s.startsWith(".")) || BLOCKED.has(segs[0])) return send(res, 404, "not found", "text/plain");
    const file = path.join(ROOT, ...segs);
    const ext = path.extname(file).toLowerCase();
    if (!TYPES[ext]) return send(res, 404, "not found", "text/plain");
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, "not found", "text/plain");
      send(res, 200, data, TYPES[ext]);
    });
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "0.0.0.0", () => {
      const actual = server.address().port;
      if (!quiet) {
        console.log(`\n  Storyit is running.\n`);
        console.log(`  This Mac:   http://localhost:${actual}`);
        console.log(`  iPad/other: http://${lanIp()}:${actual}   (same Wi-Fi; then Share → Add to Home Screen)\n`);
        console.log(`  Shared state: ${FILE}\n`);
      }
      resolve({
        server, port: actual, file: FILE,
        state: () => state,
        close: () => new Promise(r => {
          clearTimeout(writeTimer);
          for (const s of streams) { try { s.end(); } catch (e) { /* */ } }
          streams.clear();
          server.close(() => r());
        }),
        flush: () => new Promise(r => { clearTimeout(writeTimer); if (!dirty) return r(); flushToDisk(); const t = setInterval(() => { if (!writing && !dirty) { clearInterval(t); r(); } }, 20); }),
      });
    });
  });
}

module.exports = { start, lanIp };

if (require.main === module) {
  const port = +process.argv[2] || +process.env.PORT || 8787;
  start({ port }).catch(err => {
    if (err.code === "EADDRINUSE") console.error(`Port ${port} is already in use — try: node server.js ${port + 1}`);
    else console.error(err);
    process.exit(1);
  });
}
