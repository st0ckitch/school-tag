# School Tag — NFC guard-tour system

A small self-hosted system for school security walkthroughs:

- 30–35 NFC tags are placed around the school (entrances, stairwells, labs, yard, …).
- During a walkthrough the guard taps each tag with their phone — no app needed,
  the phone opens a page that records the scan and shows what's left.
- The dashboard shows live progress: which checkpoints are scanned, which are pending.
- If the walkthrough time limit expires (or the guard finishes early) with tags
  left unscanned, an **alert** is raised: it appears on the dashboard and is
  **pushed to phones** via [ntfy](https://ntfy.sh) and/or a webhook.

No native app, no cloud dependency (except optional ntfy push). One Node.js
process, SQLite database, two small dependencies.

## Quick start

```bash
npm install
npm run seed     # optional: adds 15 example checkpoints
npm start        # listens on port 3000 (PORT=... to change)
```

- **Admin dashboard:** `http://<server>/admin` — default PIN `1234`
  (**change it immediately** in Settings).
- **Guard page:** `http://<server>/walk`
- Run tests with `npm test`.

Node.js **22.5+** is required (uses the built-in SQLite; the
"SQLite is an experimental feature" warning on startup is harmless).

## Setting it up for your school

### 1. Create your checkpoints

Admin → **Checkpoints** → add one entry per place a tag will hang
("Main entrance", "Gym", "Stairwell B — 3rd floor", …). Each checkpoint gets a
unique URL like `https://your-server/t/a1b2c3d4`.

### 2. Program the NFC tags

The circle chips you have are almost certainly **NTAG213/215/216** NFC stickers
— exactly right for this.

1. Set the **public base URL** of your server in Admin → Settings
   (e.g. `https://security.myschool.ge`).
2. Open Admin → **Tag sheet**. It lists every checkpoint with its full URL and
   a QR code.
3. On any phone, install a free app such as **NFC Tools** (Android/iPhone).
   For each tag: *Write → Add a record → URL → paste the checkpoint URL → Write*,
   holding the phone on the chip.
4. Recommended: use the app's **lock** function afterwards so students can't
   rewrite the tags.
5. Optionally print the tag sheet and stick each QR code next to its tag as a
   fallback for phones without NFC.

After that, tapping a tag with any modern iPhone or Android phone pops up the
checkpoint URL — no app needed for the guards.

### 3. Set up alerts to a device

Admin → **Settings**:

- **Time limit** — how long one walkthrough may take (default 60 min). If not
  every tag is scanned within this time, the walkthrough is closed as
  *incomplete* and an alert is sent listing exactly which checkpoints were missed.
- **ntfy topic** — the simplest way to get push notifications: install the free
  **ntfy** app on the phones that should receive alerts (director, head of
  security, …), subscribe them to a hard-to-guess topic name like
  `myschool-security-x7k2`, and enter the same topic here.
- **Webhook URL** — optionally POST alerts as JSON to anything else
  (Slack, Telegram bot relay, an in-house system).

### 4. The guard's daily flow

1. Tap the first tag (any of them). The phone shows "No walkthrough is running —
   start one?". Enter name, press start — the first scan is recorded.
2. Walk the route, tapping every tag. Each tap shows progress (e.g. **17 / 35**)
   and the list of remaining checkpoints.
3. When all tags are scanned the page says the walkthrough is complete —
   press **Finish**.
4. If the guard finishes early or time runs out with tags missing → alert.

Duplicate taps are ignored; tag order doesn't matter.

## Deployment notes

- The server must be reachable from the guards' phones — host it on any small
  VPS, or on a school server exposed via HTTPS. HTTPS is strongly recommended
  (put it behind Caddy/nginx or a Cloudflare tunnel).
- Data lives in `data/school-tag.db` (SQLite). Back up that one file.
  Set `DATA_DIR=/path` to move it.
- Set `TZ` (e.g. `TZ=Asia/Tbilisi`) so dashboard timestamps are local
  (defaults to Asia/Tbilisi for display).
- Run it under a process manager, e.g. `systemd` or `pm2 start server.js`.

## How it decides something was missed

- A **walkthrough** starts when a guard scans any tag (or presses Start on `/walk`).
- Its deadline = start time + configured time limit.
- A background check runs every 30 seconds. When the deadline passes:
  - all tags scanned → marked **completed** automatically;
  - tags missing → marked **incomplete**, an alert is created with the exact
    list of missed checkpoints, and it is pushed via ntfy/webhook.
- Finishing early with missing tags triggers the same alert immediately.
