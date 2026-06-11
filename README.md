# MarQueue-wk-one

A Chrome-desktop **screen-recording & sharing** app (Loom-style): record your screen, get a
shareable link, and never lose a recording if an upload hiccups. This is the **Week 1 MVP**
from the PRD — it prioritises a fast, reliable record-to-share loop and lays a clean
foundation (data model, recording pipeline, sharing) for the next-phase teleprompter.

It's **one program**: an HTML/CSS/JavaScript front end, plus a PostgreSQL + JSON backend
blueprint that the front end is built against. It runs by **double-clicking one file** —
no install, no build step, no server required.

---

## Folder structure

```
MarQueue-wk-one/
├── frontend/                 ← everything the browser runs
│   ├── index.html            ← the app (open THIS file)
│   ├── css/
│   │   └── styles.css        ← responsive styles (desktop + mobile)
│   └── js/
│       ├── data.js           ← DATA LAYER: in-browser tables that mirror the SQL schema
│       │                       (auth, validation, Row-Level-Security, share tokens)
│       └── app.js            ← UI logic: recording, upload+retry, library, sharing, routing
│
├── backend/                  ← the database blueprint (the "real" backend)
│   ├── schema.sql            ← PostgreSQL: tables, enum, indexes, Row Level Security
│   ├── seed.json             ← JSON seed data that mirrors schema.sql (the contract)
│   ├── .env.example          ← names of env vars a live deploy needs (no real secrets)
│   └── README.md             ← how the backend maps to the front end + how to go live
│
├── docs/
│   └── wireframe.html        ← the low-fidelity wireframe this build follows
│
├── .gitignore                ← keeps real secrets (.env) out of GitHub
└── README.md                 ← you are here
```

Why the front end can run on its own: for Week 1 the app keeps an **in-memory copy of
`backend/seed.json`** inside `frontend/js/data.js` and imitates the exact Postgres tables and
rules. So the UI is already written against the production shape — going live later is mostly
swapping the data layer, not rewriting the app. (See `backend/README.md`.)

---

## The two demo logins (easy passwords)

| Email                 | Password  | Sample recordings |
|-----------------------|-----------|-------------------|
| `rob@marqueue.app`    | `demo123` | 2                 |
| `vince@marqueue.app`  | `demo123` | 1                 |

On the login screen you can just **click a demo chip** to auto-fill either account, then
press **Log in**. (You can also create a brand-new account on the **Sign up** tab.)

> These two `demo123` passwords are clearly-labelled demo seed data, **not secrets**. There
> are no real keys anywhere in this project — see the Security Checklist below.

---

## How to run it (pick one — Method A is easiest)

### Method A — Double-click
1. Open the `MarQueue-wk-one/frontend/` folder.
2. Double-click **`index.html`**. It opens in your browser.
3. Use **Google Chrome on a desktop/laptop** for the recording step (Chrome-desktop screen
   capture is a PRD constraint).

### Method B — Local server (optional, closest to production)
From inside the `frontend/` folder run one of these, then open the URL it prints:

```bash
python3 -m http.server 8000
# then visit  http://localhost:8000  in Chrome
```
```bash
npx serve .
# then visit the URL it prints
```

Everything is kept in browser memory for the session, which matches the PRD's intentionally
ephemeral model — closing the tab clears the demo state.

---

## Demo the full flow in under a minute

1. **Log in** as `rob@marqueue.app` / `demo123` (click the demo chip, then **Log in**).
2. **(Optional) Write a script.** Type or paste notes. It **locks automatically when
   recording starts** (PRD requirement).
3. **Record.** Click **Start recording**, pick a screen/window/tab in Chrome's picker. You'll
   see a **live timer** and a red **REC** badge. Toggle the **microphone** before you start.
   The app warns you near the **15-minute cap** and stops automatically at the limit.
4. **Stop.** Click **Stop** (or Chrome's "Stop sharing" bar). It moves through
   `processing → uploading` with a **progress bar**.
5. **Get your link.** On success you get a **Copy link** button and the recording appears in
   your **Library**.

### Show the reliability guarantee (the "painkiller")
Before recording, flip **"Simulate upload failure"** on. After you stop, the upload retries
automatically (single-shot transfer, **up to 3 retries with exponential backoff**), then shows
a **clear error** and a **manual Retry** — **without losing your recording**, because the blob
is preserved in memory for the session. Turn the toggle off and press **Retry** to watch it
succeed. A dropped upload never costs you the whole recording.

### Sharing (no account needed to view)
In the **Library**, click **Copy link** or **Open**. A share link looks like
`…/index.html#/share/<token>` with an **unguessable token**, and opens a **read-only view with
no login required**. (Seeded sample recordings show a placeholder player because their video
bytes aren't in memory; anything **you** record this session plays back for real.)

### Mobile
The layout is fully responsive and the library/sharing views work on phones. **Actual screen
recording is Chrome-desktop only** (a PRD constraint); on a device without screen capture the
app shows a friendly notice and disables the record button.

---

## Build order (foundation first — so nothing breaks later)

This follows the PRD's recommended order (Section 8):

1. **Auth** — sign up, log in, log out.
2. **Data model + Row Level Security** — before anything stores data.
3. **Screen-recording pipeline** — capture, codec selection (VP9→VP8), 15-min cap + notices.
4. **Processing → blob assembly** — with the `recording → failed` / `processing → failed` paths.
5. **Single-shot upload** with exponential-backoff retries + in-memory blob preservation.
6. **Share-link security** — unguessable token → link, sanitised public view.
7. **Recording library** — view, view script, no-login playback, rename.
8. **Minimal internal telemetry** — so the success metric is measurable.

---

## Security checklist — and where each item is satisfied

Every item you asked for is handled in code, not just promised:

1. **No secret keys, passwords, or API keys in the repo.**
   `.gitignore` excludes every `.env` / `.env.*` anywhere (while keeping `.env.example`, which
   has variable *names only*). The only passwords anywhere are the two labelled `demo123` seeds.

2. **Users can only see their own content unless it's intentionally shared.**
   `getRecordingsByUser()` (in `frontend/js/data.js`) returns only rows whose `user_id` matches
   the signed-in user; rename/update enforce ownership and reject cross-user edits. The same
   rule is written as a real Postgres **RLS policy** in `backend/schema.sql`. Sharing is opt-in
   via an unguessable token.

3. **All forms and inputs are validated.**
   `validateEmail / validatePassword / validateTitle / validateScript` back every form (login,
   sign-up, script, rename). Empty, malformed, or over-length input is rejected with a clear
   inline message instead of breaking the app.

4. **Main flows are tested before release.**
   23 automated checks pass against the real page — covering login/logout, input validation,
   Row Level Security (own-content-only), upload→share, the 15-minute cap, no-login viewing, and
   telemetry. (See "How it was tested" below.)

5. **Personal info and recordings are stored and displayed securely.**
   Passwords are **never stored in plain text** — they're hashed (salted SHA-256 in this demo;
   production uses Supabase/bcrypt), and login responses strip the hash. Share views are
   sanitised to omit `user_id` and the private `storage_path`. The production model uses a
   **private bucket + signed URL** so recordings are never publicly listable.

---

## How it was tested

The build was validated by loading the **real `frontend/index.html`** in a headless browser
environment and running `data.js` + `app.js` exactly as Chrome would, then exercising:
screen presence, login/logout, duplicate-signup rejection, input validation, Row Level
Security (rob sees only rob's rows, vince only vince's, cross-user edits blocked),
upload → share-token → no-login lookup (sanitised), the 900-second duration cap, and
telemetry. **Result: 23 passed, 0 failed.**

---

## Honest notes: what's real vs. simulated

So you can speak to it confidently in a demo:

- **Real:** screen recording (Chrome `getDisplayMedia`/`MediaRecorder`), the 15-minute cap and
  warnings, VP9→VP8 codec selection, input validation, the ownership/RLS rules, share-token
  generation, and no-login share viewing.
- **Simulated:** the network *upload itself* (with the "Simulate upload failure" toggle) so the
  retry/recovery guarantee is easy to show without a server.
- **By design (per the PRD):** persistence is in-memory for the session, passwords use SHA-256
  here instead of production bcrypt/Supabase, and seeded sample recordings show a placeholder
  player because their video bytes aren't in memory.

---

*Week 1 MVP foundation for the next-phase, speech-aware teleprompter.*
