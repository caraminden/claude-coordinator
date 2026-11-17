# Big uploads (`ui/upload.js`)

Part of `citadel:contraption-ui` (its SKILL.md has the file list, tokens and rules). The server side,
`/apps/_citadel/uploads/<name>` and your `/app-api/uploaded`: [api.md, "Big uploads"](api.md#big-uploads-apps_citadeluploadsname).

For files past the proxy's 20 MiB, or many at once: videos, a folder of trip photos. The page sends each
file to Citadel in 8 MiB chunks; Citadel puts it in `DATA_DIR/uploads/<login>/<folder>/` and POSTs your
`/app-api/uploaded`, whose answer comes back to the page. Never build your own big-file upload through
the proxy: it caps bodies at 20 MiB.

```js
import { mountUpload } from '/apps/_citadel/ui/upload.js';

const zone = mountUpload(document.getElementById('import'), {
  endpoint: '/apps/_citadel/uploads/trip-presenter',  // your app's name
  folder: 'Japan 2026',                // under uploads/<login>/; a picked folder keeps its own folders below it
  accept: 'image/*,video/*,.heic',     // as <input accept>; the rest goes on the "left out" line
  onDone: (result, file) => showImported(result.app.answer),  // result: { path, name, size, app: { status, answer } }
});
addEventListener('beforeunload', (e) => zone.busy && e.preventDefault());
```

It draws (base.css's `cui-upload`):

- a dashed drop zone with **Choose files** and **Choose a folder** (`folders: false` hides it); dropped
  folders are walked, their folders kept;
- a row per file: its name, `40% · 1.2 GB of 3.0 GB`, **Pause** / **Resume**, ✕ to cancel, and its bar;
  `data-state` is `waiting`, `sending`, `paused`, `done` or `cancelled`;
- a total over the batch with **Pause all** / **Resume all**;
- one line naming what it left out: hidden files and folders (a dot first, `.DS_Store`), and kinds
  `accept` doesn't take.

Files go one at a time. A dropped connection or a server error retries on its own with backoff from the
server's offset; after 8 failures in a row, or a refusal (507: the server is near its disk floor), the
row pauses with the reason under it and **Resume** carries on. A reload loses the queue, but the same
file picked again within 3 days resumes where it got to.

One file without the zone, with your own progress UI:

```js
import { startUpload, formatBytes } from '/apps/_citadel/ui/upload.js';

const up = startUpload('/apps/_citadel/uploads/trip-presenter', file, {
  folder: 'Japan 2026',
  onChange: (u) => (label.textContent = `${u.state} ${formatBytes(u.sent)} of ${formatBytes(u.size)}`),
});
up.pause(); up.resume(); up.cancel();
const result = await up.done;  // the finished file, or null if cancelled; never rejects
```

`droppedFiles(e.dataTransfer)` gives your own drop target the same folder walk (call it before any
`await` in the drop handler). Citadel's own Files view uploads into the shared folder with
`startUpload()`.
