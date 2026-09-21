'use strict';

function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const CSS = `
  :root {
    --bg: #eef2f9;
    --glow-1: rgba(99, 102, 241, 0.16);
    --glow-2: rgba(56, 189, 248, 0.14);
    --glow-3: rgba(167, 139, 250, 0.13);
    --text: #17223b; --muted: #5b6b85;
    --accent: #2563eb; --ok: #15803d; --warn: #b45309; --bad: #dc2626;
    --card-bg: rgba(255, 255, 255, 0.55);
    --card-border: rgba(255, 255, 255, 0.72);
    --card-shadow: 0 8px 32px rgba(23, 37, 84, 0.10);
    --input-bg: rgba(255, 255, 255, 0.65);
    --input-border: rgba(100, 116, 139, 0.28);
    --track: rgba(100, 116, 139, 0.16);
    --divider: rgba(100, 116, 139, 0.16);
    --active-tab: rgba(37, 99, 235, 0.12);
    --pill-ok: rgba(34, 197, 94, 0.18); --pill-warn: rgba(245, 158, 11, 0.20); --pill-bad: rgba(239, 68, 68, 0.16);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0b1220;
      --glow-1: rgba(99, 102, 241, 0.28);
      --glow-2: rgba(14, 165, 233, 0.18);
      --glow-3: rgba(139, 92, 246, 0.18);
      --text: #e6ecf7; --muted: #93a4bf;
      --accent: #60a5fa; --ok: #4ade80; --warn: #fbbf24; --bad: #f87171;
      --card-bg: rgba(24, 33, 56, 0.55);
      --card-border: rgba(148, 163, 184, 0.18);
      --card-shadow: 0 8px 32px rgba(0, 0, 0, 0.38);
      --input-bg: rgba(11, 18, 32, 0.55);
      --input-border: rgba(148, 163, 184, 0.28);
      --track: rgba(148, 163, 184, 0.20);
      --divider: rgba(148, 163, 184, 0.14);
      --active-tab: rgba(96, 165, 250, 0.16);
      --pill-ok: rgba(34, 197, 94, 0.20); --pill-warn: rgba(245, 158, 11, 0.20); --pill-bad: rgba(239, 68, 68, 0.22);
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans Georgian", sans-serif;
    font-size: 16px; line-height: 1.55; min-height: 100vh;
  }
  /* fixed, softly glowing backdrop the glass sits on */
  body::before {
    content: ""; position: fixed; inset: 0; z-index: -1; pointer-events: none;
    background:
      radial-gradient(620px 440px at 10% -6%, var(--glow-1), transparent 62%),
      radial-gradient(540px 400px at 106% 14%, var(--glow-2), transparent 62%),
      radial-gradient(720px 540px at 50% 116%, var(--glow-3), transparent 62%);
  }
  .wrap { max-width: 720px; margin: 0 auto; padding: 18px 16px 32px; }
  .card {
    background: var(--card-bg);
    -webkit-backdrop-filter: blur(22px) saturate(160%);
    backdrop-filter: blur(22px) saturate(160%);
    border: 1px solid var(--card-border);
    border-radius: 20px; padding: 22px; margin-bottom: 16px;
    box-shadow: var(--card-shadow);
  }
  h1 { font-size: 1.45rem; font-weight: 700; letter-spacing: -0.02em; margin: 0 0 4px; }
  h2 { font-size: 1.08rem; font-weight: 700; letter-spacing: -0.01em; margin: 0 0 12px; }
  .sub { color: var(--muted); font-size: 0.9rem; margin-bottom: 16px; }
  .big { font-size: 2.6rem; font-weight: 800; letter-spacing: -0.03em; }
  .ok { color: var(--ok); } .warn { color: var(--warn); } .bad { color: var(--bad); }
  a { color: var(--accent); }
  code { background: var(--track); padding: 2px 6px; border-radius: 6px; font-size: 0.85em; word-break: break-all; }
  .pill { display: inline-block; padding: 3px 12px; border-radius: 999px; font-size: 0.78rem; font-weight: 700; letter-spacing: 0.01em; }
  .pill.ok { background: var(--pill-ok); color: var(--ok); }
  .pill.warn { background: var(--pill-warn); color: var(--warn); }
  .pill.bad { background: var(--pill-bad); color: var(--bad); }
  ul.plain { list-style: none; padding: 0; margin: 0; }
  ul.plain li { padding: 12px 4px; border-bottom: 1px solid var(--divider); display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  ul.plain li:last-child { border-bottom: none; }
  .btn {
    display: inline-block; border: none; cursor: pointer;
    background: linear-gradient(135deg, #3b82f6, #6366f1); color: #fff;
    padding: 13px 22px; border-radius: 14px; font-size: 1rem; font-weight: 650; text-decoration: none;
    box-shadow: 0 6px 18px rgba(59, 130, 246, 0.35);
    transition: transform 0.15s ease, box-shadow 0.15s ease, filter 0.15s ease;
  }
  .btn:hover { filter: brightness(1.06); }
  .btn:active { transform: scale(0.97); box-shadow: 0 3px 10px rgba(59, 130, 246, 0.3); }
  .btn.full { display: block; width: 100%; text-align: center; }
  .btn.secondary {
    background: var(--card-bg); color: var(--text); border: 1px solid var(--card-border);
    -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px); box-shadow: none;
  }
  .btn.danger { background: linear-gradient(135deg, #f87171, #dc2626); box-shadow: 0 6px 18px rgba(239, 68, 68, 0.30); }
  .btn.small { padding: 7px 14px; font-size: 0.85rem; border-radius: 10px; }
  input, select {
    width: 100%; padding: 12px 14px; border: 1px solid var(--input-border); border-radius: 12px;
    font-size: 1rem; margin-bottom: 12px; background: var(--input-bg); color: var(--text);
    -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
  }
  input:focus, select:focus { outline: 2px solid var(--accent); outline-offset: 1px; border-color: transparent; }
  label { font-size: 0.85rem; color: var(--muted); display: block; margin-bottom: 5px; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th, td { text-align: left; padding: 10px 6px; border-bottom: 1px solid var(--divider); vertical-align: top; }
  th { color: var(--muted); font-weight: 650; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.06em; }
  tr:last-child td { border-bottom: none; }
  .progressbar {
    height: 12px; background: var(--track); border-radius: 999px; overflow: hidden; margin: 14px 0;
    box-shadow: inset 0 1px 3px rgba(15, 23, 42, 0.12);
  }
  .progressbar > div { height: 100%; background: linear-gradient(90deg, #4ade80, #16a34a); border-radius: 999px; transition: width 0.3s; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; }
  .row > * { flex: 1; }
  .muted { color: var(--muted); }
  .topnav {
    display: flex; gap: 2px; align-items: center; flex-wrap: wrap;
    background: var(--card-bg);
    -webkit-backdrop-filter: blur(22px) saturate(160%); backdrop-filter: blur(22px) saturate(160%);
    border: 1px solid var(--card-border); border-radius: 16px;
    padding: 8px; margin-bottom: 18px; box-shadow: var(--card-shadow);
  }
  .topnav a, .topnav > span { padding: 8px 12px; border-radius: 10px; text-decoration: none; color: var(--muted); font-weight: 650; font-size: 0.9rem; }
  .topnav a:hover { color: var(--text); }
  .topnav > span { background: var(--active-tab); color: var(--accent); }
  .checkmark { font-size: 1.2rem; }
  @media print {
    body { background: #fff; }
    body::before { display: none; }
    .no-print { display: none; }
    .card { break-inside: avoid; border: 1px solid #ccc; background: #fff; -webkit-backdrop-filter: none; backdrop-filter: none; box-shadow: none; }
  }
`;

function page(title, body, opts = {}) {
  const refresh = opts.refreshSeconds
    ? `<meta http-equiv="refresh" content="${opts.refreshSeconds}">`
    : '';
  return `<!DOCTYPE html>
<html lang="${opts.lang || 'en'}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" media="(prefers-color-scheme: light)" content="#eef2f9">
  <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0b1220">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <meta name="apple-mobile-web-app-title" content="School Tag">
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="apple-touch-icon" href="/icons/icon-180.png">
  <link rel="icon" type="image/png" sizes="192x192" href="/icons/icon-192.png">
  ${refresh}
  <title>${esc(title)}</title>
  <style>${CSS}</style>
</head>
<body>
  <div class="wrap">
    ${body}
  </div>
  <script>
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(function () {});
  </script>
</body>
</html>`;
}

module.exports = { esc, page };
