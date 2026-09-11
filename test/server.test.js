const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { start } = require("../server.js");

function request(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers: body ? { "Content-Type": "application/json" } : {} }, res => {
      let data = "";
      res.on("data", c => { data += c; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/* open an SSE stream; resolves with helpers once "hello" arrives */
function openEvents(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/events" }, res => {
      const events = [];
      const waiters = [];
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", chunk => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const raw = buf.slice(0, i); buf = buf.slice(i + 2);
          if (raw.startsWith(":")) continue;
          const ev = { event: "message", data: "" };
          raw.split("\n").forEach(l => {
            if (l.startsWith("event: ")) ev.event = l.slice(7);
            else if (l.startsWith("data: ")) ev.data = l.slice(6);
          });
          ev.data = JSON.parse(ev.data);
          events.push(ev);
          waiters.splice(0).forEach(w => w());
        }
      });
      const next = () => new Promise(r => { if (events.length) return r(events.shift()); waiters.push(() => r(events.shift())); });
      next().then(hello => resolve({ hello, next, close: () => req.destroy() }));
    });
    req.on("error", reject);
  });
}

test("server: static app, ops broadcast to other clients, state + disk match", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "storyit-"));
  const srv = await start({ port: 0, dataDir, quiet: true });
  try {
    const page = await request(srv.port, "GET", "/");
    assert.equal(page.status, 200);
    assert.match(page.body, /<title>Storyit/);
    assert.equal((await request(srv.port, "GET", "/data/storyit.json")).status, 404);
    assert.equal((await request(srv.port, "GET", "/%2e%2e/package.json")).status, 404);
    assert.equal((await request(srv.port, "GET", "/.hidden.js")).status, 404);

    const info = JSON.parse((await request(srv.port, "GET", "/api/info")).body);
    assert.equal(info.hosted, true);
    assert.match(info.url, /^http:\/\/.+:\d+$/);

    const B = await openEvents(srv.port);
    assert.equal(B.hello.event, "hello");
    assert.equal(B.hello.data.rev, 0);

    const ops = [
      { k: "project", id: "p1", f: { name: "Shared", aspect: "16:9", cols: 2, rows: 3, createdAt: 1, updatedAt: 1 }, ft: { name: 10, aspect: 10, cols: 10, rows: 10, createdAt: 10, updatedAt: 10 } },
      { k: "item", pid: "p1", id: "i1", f: { kind: "shot", title: "One" }, ft: { kind: 10, title: 10 } },
      { k: "pages", pid: "p1", pages: [{ id: "pg", items: ["i1"] }], t: 10 },
    ];
    const posted = JSON.parse((await request(srv.port, "POST", "/api/ops", { client: "A", ops })).body);
    assert.equal(posted.rev, 1);

    const msg = await B.next();
    assert.equal(msg.event, "message");
    assert.equal(msg.data.rev, 1);
    assert.equal(msg.data.client, "A");
    assert.equal(msg.data.ops.length, 3);

    const state = JSON.parse((await request(srv.port, "GET", "/api/state")).body);
    assert.equal(state.rev, 1);
    assert.equal(state.db.projects[0].name, "Shared");
    assert.equal(state.db.projects[0].pages[0].items[0].title, "One");

    // a stale op changes nothing but still round-trips a rev
    const stale = JSON.parse((await request(srv.port, "POST", "/api/ops", { client: "B", ops: [{ k: "item", pid: "p1", id: "i1", f: { title: "old" }, ft: { title: 5 } }] })).body);
    assert.equal(stale.rev, 2);
    assert.equal(stale.changed, false);
    await B.next();

    await srv.flush();
    const onDisk = JSON.parse(fs.readFileSync(srv.file, "utf8"));
    assert.deepEqual(onDisk.db, JSON.parse((await request(srv.port, "GET", "/api/state")).body).db);
    assert.equal(onDisk.rev, 2);
    B.close();
  } finally {
    await srv.close();
  }
});

test("server: reloads its state file on start", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "storyit-"));
  fs.writeFileSync(path.join(dataDir, "storyit.json"), JSON.stringify({ rev: 7, db: { projects: [], scripts: [{ id: "s", name: "S", elements: [] }], deleted: {} } }));
  const srv = await start({ port: 0, dataDir, quiet: true });
  try {
    const state = JSON.parse((await request(srv.port, "GET", "/api/state")).body);
    assert.equal(state.rev, 7);
    assert.equal(state.db.scripts[0].name, "S");
  } finally {
    await srv.close();
  }
});
