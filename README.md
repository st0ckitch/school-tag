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

Node.js **20+** is required.

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

### 5. Install it as an app on the phones (PWA)

There are **two separate installable apps** on the same server — no app store
needed:

- **Guard app** (blue check icon): install from `/walk` — opens straight into
  the walkthrough flow.
- **Admin app** (dark gear icon): install from `/admin` — opens straight into
  the dashboard.

Installing: **Android (Chrome):** open the page → browser menu → **Install
app / Add to Home screen**. **iPhone (Safari):** open the page → Share →
**Add to Home Screen** (iOS allows no direct APK-style installs, so this is
the direct path there).

### 5a. Push notifications

Alerts are pushed natively (Web Push) to every device that pressed the
**🔔 Enable notifications** button — it's on the guard walkthrough page and
on the admin dashboard. Works in the installed app on Android (and inside
the APK below), on desktop Chrome/Edge/Firefox, and on iPhone when the app
is installed to the home screen (iOS 16.4+). With device enforcement on,
only enrolled phones and logged-in admins can subscribe. No third-party
account is needed; ntfy/webhook remain as optional extra channels.

### 5b. Real Android APK (optional)

The repo ships an Android **Trusted Web Activity** project plus a GitHub
Actions workflow that builds an installable, signed APK:

1. On GitHub: **Actions → Build Android APK → Run workflow**, enter your
   deployed HTTPS URL. Wait ~3–4 minutes.
2. Download the **school-tag-apk** artifact from the run page; copy
   `school-tag.apk` to the phone and open it (allow "install unknown apps").
3. First build only: also download **signing-keystore-SAVE-THIS** and add
   repo secrets `ANDROID_KEYSTORE_B64` (the file base64-encoded) and
   `ANDROID_KEYSTORE_PASSWORD` (`schooltag123` for a generated keystore) —
   future builds must be signed with the same key or Android refuses the
   update.
4. The run summary prints the **package id** and **SHA-256 fingerprint**:
   paste both into Admin → Settings → *Android APK* (served back at
   `/.well-known/assetlinks.json`) to verify the app and hide the browser
   bar inside it.

The APK wraps the same app, so push notifications, device enrollment, and
updates to the server all work in it without rebuilding; rebuild only to
change the URL or icon.

### 6. Limit access to specific phones (device enrollment)

Guard pages can be restricted to a fixed number of enrolled phones
(default 2) in Admin → **Devices**:

1. Press **Generate enrollment link** — a one-time link/QR valid for
   30 minutes appears.
2. Open it on the phone you want to allow and press **Enroll**. The phone
   receives a long-lived secret cookie; only its hash is stored server-side.
3. Repeat for the second phone, then tick **Only enrolled devices can scan
   tags and run walkthroughs** and save.

Enrolled devices are listed with last-seen times and can be removed at any
time (access is revoked immediately). If a phone's browser data is cleared,
just enroll it again with a fresh link. The admin dashboard itself is
protected by the PIN, not by device enrollment.

## Deployment notes

The server must be reachable from the guards' phones. There are two ways to
host it:

### Option A — Vercel (serverless)

1. Import the repository in [Vercel](https://vercel.com). It deploys as a
   serverless function (see `api/index.js` and `vercel.json`).
2. Add a **Turso** database for persistent storage: either through the Vercel
   Marketplace (Storage → Turso) or with a free account at
   [turso.tech](https://turso.tech). This provides the `TURSO_DATABASE_URL`
   and `TURSO_AUTH_TOKEN` environment variables — make sure both are set on
   the Vercel project. Without them the app falls back to an ephemeral `/tmp`
   database and **data will not persist** between invocations.
3. Set a `CRON_SECRET` environment variable (any long random string). It
   protects the `GET /api/cron/tick` endpoint that closes expired walkthroughs.
4. **Alert timing.** Expired walkthroughs are also closed lazily whenever
   someone opens a guard or admin page, but with no traffic an alert only
   fires when the cron endpoint is hit. The bundled `vercel.json` schedule is
   once per day (`0 6 * * *`) so Hobby-plan deploys don't fail. For timely
   alerts either:
   - upgrade to **Pro** and change the schedule in `vercel.json` to
     `*/5 * * * *`, or
   - on the Hobby plan, point a free external pinger (e.g.
     [cron-job.org](https://cron-job.org)) at
     `https://<your-app>.vercel.app/api/cron/tick?secret=<CRON_SECRET>`
     every 5 minutes.

### Option B — your own server / VPS

- Host it on any small VPS, or on a school server exposed via HTTPS. HTTPS is
  strongly recommended (put it behind Caddy/nginx or a Cloudflare tunnel).
- Run `npm start` under a process manager, e.g. `systemd` or
  `pm2 start server.js`.
- Data lives in `data/school-tag.db` (SQLite). Back up that one file.
  Set `DATA_DIR=/path` to move it.
- Set `TZ` (e.g. `TZ=Asia/Tbilisi`) so dashboard timestamps are local
  (defaults to Asia/Tbilisi for display).
- The built-in scheduler checks deadlines every 30 seconds — no external cron
  needed.

## How it decides something was missed

- A **walkthrough** starts when a guard scans any tag (or presses Start on `/walk`).
- Its deadline = start time + configured time limit.
- A background check runs every 30 seconds. When the deadline passes:
  - all tags scanned → marked **completed** automatically;
  - tags missing → marked **incomplete**, an alert is created with the exact
    list of missed checkpoints, and it is pushed via ntfy/webhook.
- Finishing early with missing tags triggers the same alert immediately.
