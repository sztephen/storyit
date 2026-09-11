# Storyit

Storyboards and scripts for people who think in shots. Draw frames, write scenes under them, keep a script alongside, and export to PDF when it is time to shoot.

Plain HTML, CSS, and JavaScript. No build step, no accounts. Works on its own in any browser, or syncs live between a Mac and an iPad over your Wi-Fi.

## What it does

- **Storyboards.** Pages of frames with a drawing surface, a shot description, and scene rows. Reorder by dragging.
- **Scripts.** Scene headings, action, character, dialogue. Formatted like a screenplay.
- **Drawing.** Draw directly in a frame with a finger, mouse, or Apple Pencil.
- **Export.** PDF for printing, plain text that re-imports exactly, or a full backup with drawings.
- **Sync.** A small server keeps one shared copy so a Mac and an iPad can edit the same project at once.

## Use it on one device

Open `index.html` in a browser. Everything is saved in that browser's local storage. The status pill reads "Local only".

## Use it on a Mac and an iPad together

1. On the Mac, in this folder:

   ```
   node server.js
   ```

   It prints two addresses. The one that looks like `http://192.168.x.x:8787` is for other devices.

2. On the iPad, on the same Wi-Fi, open that address in Safari. Tap Share, then **Add to Home Screen**. It now opens full screen like an app.

3. Open the same address on the Mac too. Every edit on either device shows up on the other within a moment: typing, drawing (when the pen lifts), reordering, new pages, scene rows, scripts.

The shared copy lives in `data/storyit.json`. The Mac has to be running the server for the iPad to sync. When it is not, each device keeps working on its own copy and catches up on the next connection.

The server has no dependencies. Pass a port to change it: `node server.js 9000`.

## Saving files

Inside a storyboard or script, the export button offers:

- **PDF** for printing.
- **Text (.txt)**, a readable file that re-imports exactly, except drawings, which are not text.
- **Backup (.storyit.json)**, everything including drawings.

The home screen has **Import .txt / backup** and **Back up everything**.

## How sync works

Clients send entity-level operations to the server. The server applies them with a last-writer-wins rule per field, saves the result, and fans the operations out to every connected client over server-sent events. The same rule lives in `sync.js` and runs on both sides, so a device that was offline can replay what it missed and land in the same state.

## Tests

```
node --test
```

Covers the data model, text import and export, the sync rules, and the server. The browser test drives the real app in headless Chrome and is skipped if Chrome is not installed.

## Layout

```
index.html, style.css   the app shell
app.js                  UI, drawing, export
model.js                data model shared by app, server, and tests
textio.js               .txt import and export
sync.js                 merge rules
server.js               LAN sync server, zero dependencies
test/                   node --test suites
```

## License

MIT.
