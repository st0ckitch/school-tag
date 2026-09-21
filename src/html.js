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
    --bg: #f4f6f8; --card: #ffffff; --text: #1a2330; --muted: #64748b;
    --accent: #2563eb; --ok: #16a34a; --warn: #d97706; --bad: #dc2626;
    --border: #e2e8f0;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans Georgian", sans-serif;
    font-size: 16px; line-height: 1.5;
  }
  .wrap { max-width: 720px; margin: 0 auto; padding: 16px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px; margin-bottom: 16px; }
  h1 { font-size: 1.4rem; margin: 0 0 4px; }
  h2 { font-size: 1.1rem; margin: 0 0 12px; }
  .sub { color: var(--muted); font-size: 0.9rem; margin-bottom: 16px; }
  .big { font-size: 2.4rem; font-weight: 700; }
  .ok { color: var(--ok); } .warn { color: var(--warn); } .bad { color: var(--bad); }
  .pill { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 0.8rem; font-weight: 600; }
  .pill.ok { background: #dcfce7; } .pill.warn { background: #fef3c7; } .pill.bad { background: #fee2e2; }
  ul.plain { list-style: none; padding: 0; margin: 0; }
  ul.plain li { padding: 10px 4px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  ul.plain li:last-child { border-bottom: none; }
  .btn {
    display: inline-block; background: var(--accent); color: #fff; border: none; cursor: pointer;
    padding: 12px 20px; border-radius: 10px; font-size: 1rem; font-weight: 600; text-decoration: none;
  }
  .btn.full { display: block; width: 100%; text-align: center; }
  .btn.secondary { background: #e2e8f0; color: var(--text); }
  .btn.danger { background: var(--bad); }
  .btn.small { padding: 6px 12px; font-size: 0.85rem; }
  input, select {
    width: 100%; padding: 12px; border: 1px solid var(--border); border-radius: 10px;
    font-size: 1rem; margin-bottom: 12px; background: #fff; color: var(--text);
  }
  label { font-size: 0.85rem; color: var(--muted); display: block; margin-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; font-size: 0.8rem; text-transform: uppercase; }
  .progressbar { height: 10px; background: var(--border); border-radius: 999px; overflow: hidden; margin: 12px 0; }
  .progressbar > div { height: 100%; background: var(--ok); transition: width .3s; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; }
  .row > * { flex: 1; }
  .muted { color: var(--muted); }
  .topnav { display: flex; gap: 14px; margin-bottom: 16px; flex-wrap: wrap; }
  .topnav a { color: var(--accent); text-decoration: none; font-weight: 600; }
  .checkmark { font-size: 1.2rem; }
  @media print {
    body { background: #fff; }
    .no-print { display: none; }
    .card { break-inside: avoid; border: 1px solid #ccc; }
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
  <meta name="theme-color" content="#2563eb">
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
