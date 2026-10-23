'use strict';

function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// Line icons (24px grid, drawn with currentColor).
const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9v11.5h13V9"/><path d="M10 20.5v-6h4v6"/>',
  pin: '<path d="M12 21s-7-6.1-7-11a7 7 0 0 1 14 0c0 4.9-7 11-7 11z"/><circle cx="12" cy="10" r="2.6"/>',
  tag: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  phone: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M11 18h2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  gear: '<path d="M4 7h10"/><path d="M18 7h2"/><path d="M4 17h2"/><path d="M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  out: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
  bell: '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
  route: '<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  nfc: '<path d="M6 8.3a6 6 0 0 1 0 7.4"/><path d="M9.5 6a10 10 0 0 1 0 12"/><path d="M13 3.5a14 14 0 0 1 0 17"/><path d="M16.5 1.5a17.5 17.5 0 0 1 0 21"/>',
  timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/><path d="M10 2h4"/>',
  play: '<path d="M7 4v16l13-8z"/>',
  flag: '<path d="M4 22V4"/><path d="M4 4h13l-2 4 2 4H4"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  dot: '<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>',
  arrowUp: '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>',
  arrowDown: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  guard: '<circle cx="12" cy="7" r="4"/><path d="M5 21v-2a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v2"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
};

const icon = (name, cls = '') =>
  `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;

const CSS = `
  /* One family from two variable fonts: Plus Jakarta Sans draws Latin and
     digits, Noto Sans Georgian draws Georgian (both SIL OFL, self-hosted). */
  @font-face { font-family: 'ST Sans'; src: url('/fonts/PlusJakartaSans.woff2') format('woff2'); font-weight: 200 800; font-style: normal; font-display: swap;
    unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD; }
  @font-face { font-family: 'ST Sans'; src: url('/fonts/NotoSansGeorgian.woff2') format('woff2'); font-weight: 100 900; font-style: normal; font-display: swap;
    unicode-range: U+0589, U+10A0-10FF, U+1C90-1CBA, U+1CBD-1CBF, U+205A, U+2D00-2D2F, U+2E31; }

  /* --- tokens ------------------------------------------------------------ */
  :root {
    color-scheme: light;
    --bg: #eef0f7;
    --blob-1: #d8cdff; --blob-2: #ffd9cc; --blob-3: #cfe6ff; --blob-4: #ffd3e6;
    --surface: rgba(255, 255, 255, 0.58);
    --surface-strong: rgba(255, 255, 255, 0.86);
    --surface-sunk: rgba(15, 23, 42, 0.04);
    --surface-border: rgba(255, 255, 255, 0.78);
    --hairline: rgba(15, 23, 42, 0.08);
    --shadow: 0 1px 2px rgba(15, 23, 42, 0.04), 0 12px 32px rgba(36, 44, 92, 0.07);
    --shadow-lift: 0 2px 4px rgba(15, 23, 42, 0.05), 0 10px 24px rgba(36, 44, 92, 0.10);
    --text: #0f1324; --text-2: #454c63; --muted: #6a7088;
    --accent: #6a5af9; --accent-ink: #5443e6; --accent-soft: rgba(106, 90, 249, 0.12);
    --ok: #12813a; --ok-soft: rgba(22, 163, 74, 0.13);
    --warn: #9a5b00; --warn-soft: rgba(245, 158, 11, 0.18);
    --bad: #c42b2b; --bad-soft: rgba(239, 68, 68, 0.12);
    --neutral-soft: rgba(100, 116, 139, 0.14);
    --input-bg: rgba(255, 255, 255, 0.72);
    --input-border: rgba(15, 23, 42, 0.12);
    --track: rgba(15, 23, 42, 0.08);
    --grid: rgba(15, 23, 42, 0.07);
    --series: #6a5af9; --series-wash: rgba(106, 90, 249, 0.14); --series-quiet: #b4b9cc;
    --ring-surface: #f7f7fb;
    --r-lg: 24px; --r-md: 16px; --r-sm: 12px;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      color-scheme: dark;
      --bg: #0b0d18;
      --blob-1: #2a2160; --blob-2: #3a2131; --blob-3: #12294a; --blob-4: #2e1a40;
      --surface: rgba(26, 29, 48, 0.62);
      --surface-strong: rgba(44, 48, 76, 0.9);
      --surface-sunk: rgba(255, 255, 255, 0.04);
      --surface-border: rgba(255, 255, 255, 0.08);
      --hairline: rgba(255, 255, 255, 0.08);
      --shadow: 0 1px 2px rgba(0, 0, 0, 0.3), 0 12px 32px rgba(0, 0, 0, 0.35);
      --shadow-lift: 0 2px 4px rgba(0, 0, 0, 0.35), 0 10px 24px rgba(0, 0, 0, 0.4);
      --text: #eef0fa; --text-2: #c3c7dc; --muted: #959bb5;
      --accent: #8f82ff; --accent-ink: #b1a8ff; --accent-soft: rgba(143, 130, 255, 0.16);
      --ok: #4ade80; --ok-soft: rgba(74, 222, 128, 0.14);
      --warn: #fbbf24; --warn-soft: rgba(251, 191, 36, 0.14);
      --bad: #f87171; --bad-soft: rgba(248, 113, 113, 0.15);
      --neutral-soft: rgba(148, 163, 184, 0.16);
      --input-bg: rgba(12, 14, 26, 0.55);
      --input-border: rgba(255, 255, 255, 0.12);
      --track: rgba(255, 255, 255, 0.09);
      --grid: rgba(255, 255, 255, 0.07);
      --series: #8a7cff; --series-wash: rgba(138, 124, 255, 0.18); --series-quiet: #5a6080;
      --ring-surface: #1c1f33;
    }
  }

  /* --- base -------------------------------------------------------------- */
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font-family: 'ST Sans', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans Georgian", sans-serif;
    font-size: 15px; line-height: 1.55; min-height: 100vh; min-height: 100dvh;
    -webkit-tap-highlight-color: transparent; -webkit-font-smoothing: antialiased;
  }
  /* the soft pastel field the glass sits on */
  body::before {
    content: ""; position: fixed; inset: -10%; z-index: -1; pointer-events: none;
    background:
      radial-gradient(38% 42% at 8% 4%, var(--blob-1), transparent 70%),
      radial-gradient(34% 40% at 96% 8%, var(--blob-4), transparent 70%),
      radial-gradient(40% 46% at 4% 92%, var(--blob-2), transparent 70%),
      radial-gradient(42% 48% at 70% 70%, var(--blob-3), transparent 72%);
    filter: saturate(115%);
  }
  a { color: var(--accent-ink); text-decoration: none; }
  a:hover { text-decoration: underline; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 8px; }
  h1 { font-size: 1.6rem; font-weight: 750; letter-spacing: -0.025em; line-height: 1.2; margin: 0 0 4px; }
  h2 { font-size: 1.02rem; font-weight: 700; letter-spacing: -0.01em; margin: 0 0 14px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  h3 { font-size: 0.92rem; font-weight: 700; margin: 0 0 8px; }
  p { margin: 0 0 10px; }
  .sub { color: var(--muted); font-size: 0.9rem; margin-bottom: 18px; }
  .muted { color: var(--muted); }
  .ok { color: var(--ok); } .warn { color: var(--warn); } .bad { color: var(--bad); }
  .big { font-size: 2.4rem; font-weight: 800; letter-spacing: -0.035em; line-height: 1.1; }
  code { background: var(--surface-sunk); border: 1px solid var(--hairline); padding: 1px 6px; border-radius: 7px; font-size: 0.84em; word-break: break-all; }
  .ic { width: 20px; height: 20px; flex: none; }
  .num { font-variant-numeric: tabular-nums; }

  /* --- surfaces ---------------------------------------------------------- */
  .card {
    background: var(--surface);
    -webkit-backdrop-filter: blur(24px) saturate(170%); backdrop-filter: blur(24px) saturate(170%);
    border: 1px solid var(--surface-border); border-radius: var(--r-lg);
    padding: 22px; margin-bottom: 16px; box-shadow: var(--shadow);
    min-width: 0;
  }
  .card > :last-child { margin-bottom: 0; }
  .card.flush { padding: 0; overflow: hidden; }
  .card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
  .card-head h2 { margin: 0; }

  /* --- pills, buttons, forms --------------------------------------------- */
  .pill {
    display: inline-flex; align-items: center; gap: 5px; padding: 3px 10px 3px 8px; border-radius: 999px;
    font-size: 0.76rem; font-weight: 700; letter-spacing: 0.005em; line-height: 1.5; white-space: nowrap;
    background: var(--neutral-soft); color: var(--text-2);
  }
  .pill .ic { width: 13px; height: 13px; stroke-width: 2.6; }
  .pill.ok { background: var(--ok-soft); color: var(--ok); }
  .pill.warn { background: var(--warn-soft); color: var(--warn); }
  .pill.bad { background: var(--bad-soft); color: var(--bad); }
  .pill.info { background: var(--accent-soft); color: var(--accent-ink); }
  .pill.wrap { white-space: normal; }
  .badge { min-width: 22px; height: 22px; padding: 0 7px; border-radius: 999px; display: inline-grid; place-items: center; font-size: 0.72rem; font-weight: 800; background: var(--surface-strong); color: var(--text-2); }
  .badge.bad { background: var(--bad); color: #fff; }

  .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    border: 1px solid transparent; cursor: pointer; font-family: inherit;
    background: linear-gradient(135deg, #8577ff, #6a5af9 55%, #5b4be8); color: #fff;
    padding: 12px 20px; min-height: 46px; border-radius: 14px; font-size: 0.95rem; font-weight: 700; text-decoration: none; white-space: nowrap;
    box-shadow: 0 1px 1px rgba(15, 23, 42, 0.08), 0 8px 20px rgba(106, 90, 249, 0.32);
    transition: transform 0.15s ease, box-shadow 0.15s ease, filter 0.15s ease;
  }
  .btn:hover { filter: brightness(1.05); text-decoration: none; }
  .btn:active { transform: scale(0.98); }
  .btn .ic { width: 18px; height: 18px; }
  .btn.full { display: flex; width: 100%; }
  .btn.secondary {
    background: var(--surface-strong); color: var(--text); border-color: var(--hairline);
    box-shadow: 0 1px 2px rgba(15, 23, 42, 0.05);
  }
  .btn.danger { background: linear-gradient(135deg, #f87171, #dc2626); box-shadow: 0 8px 20px rgba(220, 38, 38, 0.26); }
  .btn.ghost { background: transparent; color: var(--text-2); box-shadow: none; }
  .btn.small { padding: 7px 13px; min-height: 36px; font-size: 0.84rem; border-radius: 11px; }
  .btn.big { min-height: 58px; font-size: 1.05rem; border-radius: 18px; }
  .btn.two { flex-direction: column; gap: 1px; line-height: 1.25; padding-top: 10px; padding-bottom: 10px; white-space: normal; }
  .btn.two .en { font-size: 0.78em; font-weight: 600; opacity: 0.82; }
  details.card > summary { list-style: none; display: flex; align-items: center; justify-content: space-between; }
  details.card > summary::-webkit-details-marker { display: none; }
  details.card > summary::after { content: "▾"; color: var(--muted); transition: transform 0.15s; }
  details.card[open] > summary::after { transform: rotate(180deg); }

  input, select, textarea {
    width: 100%; padding: 12px 14px; border: 1px solid var(--input-border); border-radius: var(--r-sm);
    font: inherit; font-size: 0.95rem; margin-bottom: 14px; background: var(--input-bg); color: var(--text);
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }
  input:focus, select:focus, textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 4px var(--accent-soft); }
  input[type="checkbox"] { width: auto; margin: 0 8px 0 0; accent-color: var(--accent); }
  label { font-size: 0.84rem; font-weight: 600; color: var(--text-2); display: block; margin-bottom: 6px; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; }
  .row > * { flex: 1; }

  /* --- lists & tables ---------------------------------------------------- */
  ul.plain { list-style: none; padding: 0; margin: 0; }
  ul.plain li { padding: 12px 2px; border-bottom: 1px solid var(--hairline); display: flex; justify-content: space-between; align-items: center; gap: 10px; }
  ul.plain li:last-child { border-bottom: none; }
  ul.plain li.wrap { flex-wrap: wrap; }
  .table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; margin: 0 -4px; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th, td { text-align: left; padding: 12px 8px; border-bottom: 1px solid var(--hairline); vertical-align: middle; }
  th { color: var(--muted); font-weight: 700; font-size: 0.74rem; letter-spacing: 0.02em; }
  tbody tr:last-child td, tr:last-child td { border-bottom: none; }
  tbody tr:hover td { background: var(--surface-sunk); }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }

  .progressbar { height: 10px; background: var(--track); border-radius: 999px; overflow: hidden; margin: 14px 0; }
  .progressbar > div { height: 100%; background: linear-gradient(90deg, #8f82ff, #6a5af9); border-radius: 999px; transition: width 0.3s; }
  .progressbar.ok > div { background: linear-gradient(90deg, #4ade80, #16a34a); }
  .checkmark { font-size: 1.1rem; }

  /* --- stat tiles & layout grids ----------------------------------------- */
  .grid { display: grid; gap: 16px; margin-bottom: 16px; }
  .grid > .card { margin-bottom: 0; }
  .kpis { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .split { grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); }
  .halves { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .stack { display: grid; gap: 16px; }
  .stat { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
  .stat-label { font-size: 0.86rem; font-weight: 600; color: var(--text-2); }
  .stat-value { font-size: 1.9rem; font-weight: 800; letter-spacing: -0.03em; line-height: 1.15; margin: 4px 0 8px; }
  .stat-value small { font-size: 1rem; font-weight: 700; color: var(--muted); letter-spacing: 0; }
  .delta { display: inline-flex; align-items: center; gap: 3px; font-size: 0.8rem; font-weight: 700; }
  .delta .ic { width: 14px; height: 14px; stroke-width: 2.6; }
  .delta.good { color: var(--ok); } .delta.bad { color: var(--bad); } .delta.flat { color: var(--muted); }
  .delta-note { font-size: 0.8rem; color: var(--muted); font-weight: 500; margin-left: 4px; }
  .tile {
    width: 48px; height: 48px; border-radius: 15px; display: grid; place-items: center; flex: none; color: #fff;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.35), 0 8px 18px var(--tile-shadow, rgba(106, 90, 249, 0.3));
  }
  .tile .ic { width: 23px; height: 23px; stroke-width: 2.1; }
  .tile.violet { background: linear-gradient(140deg, #a196ff, #6a5af9); --tile-shadow: rgba(106, 90, 249, 0.32); }
  .tile.green { background: linear-gradient(140deg, #4ade80, #16a34a); --tile-shadow: rgba(22, 163, 74, 0.28); }
  .tile.blue { background: linear-gradient(140deg, #7cc0ff, #2f7cf6); --tile-shadow: rgba(47, 124, 246, 0.28); }
  .tile.pink { background: linear-gradient(140deg, #ff8fc8, #e64598); --tile-shadow: rgba(230, 69, 152, 0.28); }
  .tile.amber { background: linear-gradient(140deg, #ffd166, #f59e0b); --tile-shadow: rgba(245, 158, 11, 0.28); }
  .tile.sm { width: 38px; height: 38px; border-radius: 12px; }
  .tile.sm .ic { width: 19px; height: 19px; }
  .mini { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .mini .stat-value { font-size: 1.55rem; margin: 2px 0 0; }
  .spark { width: 120px; height: 44px; flex: none; }

  /* --- charts ------------------------------------------------------------ */
  .chart { position: relative; }
  .chart svg { display: block; width: 100%; height: auto; overflow: visible; }
  .chart .gridline { stroke: var(--grid); stroke-width: 1; vector-effect: non-scaling-stroke; }
  .chart .axis-label { fill: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
  .chart .series-line { fill: none; stroke: var(--series); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; vector-effect: non-scaling-stroke; }
  .chart .crosshair { stroke: var(--muted); stroke-width: 1; opacity: 0; vector-effect: non-scaling-stroke; }
  .chart .hover-dot { fill: var(--series); stroke: var(--ring-surface); stroke-width: 2; opacity: 0; }
  .chart.hovering .crosshair, .chart.hovering .hover-dot { opacity: 1; }
  .chart-tip {
    position: absolute; top: 0; left: 0; pointer-events: none; opacity: 0; transform: translate(-50%, -100%);
    background: #12142a; color: #fff; border-radius: 12px; padding: 8px 11px; font-size: 0.78rem; line-height: 1.4;
    box-shadow: 0 10px 24px rgba(15, 23, 42, 0.25); white-space: nowrap; transition: opacity 0.1s;
  }
  .chart.hovering .chart-tip { opacity: 1; }
  .chart-tip strong { display: block; font-size: 0.95rem; }
  .chart-tip .k { display: inline-block; width: 10px; height: 2px; background: var(--series); vertical-align: middle; margin-right: 5px; border-radius: 2px; }
  details.table-view summary { cursor: pointer; color: var(--muted); font-size: 0.82rem; margin-top: 10px; }
  .bar-track { height: 8px; background: var(--track); border-radius: 999px; overflow: hidden; min-width: 60px; }
  .bar-track > div { height: 100%; background: var(--series); border-radius: 999px; }

  /* --- checkpoint list ----------------------------------------------------- */
  .cp-row { align-items: flex-start !important; gap: 14px !important; }
  .cp-num { width: 30px; height: 30px; border-radius: 10px; flex: none; display: grid; place-items: center; font-size: 0.8rem; font-weight: 800; color: var(--accent-ink); background: var(--accent-soft); margin-top: 2px; }
  .cp-main { flex: 1; min-width: 0; }
  .cp-title { font-weight: 650; }
  .cp-meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 6px; }
  .cp-edit > summary { cursor: pointer; color: var(--accent-ink); font-size: 0.84rem; font-weight: 650; margin-top: 8px; width: fit-content; }
  .cp-actions { display: flex; gap: 6px; flex: none; align-items: center; }
  @media (max-width: 560px) {
    .cp-row { flex-wrap: wrap; }
    .cp-actions { flex-basis: 100%; padding-left: 44px; }
  }

  /* --- tag sheet ---------------------------------------------------------- */
  .tag-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 16px; }
  .tag-grid .card { margin: 0; }
  .tag-card { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 10px; }
  .tag-head { display: flex; gap: 10px; align-items: flex-start; align-self: stretch; text-align: left; }
  .tag-head h2 { margin: 2px 0 0; display: block; }
  .tag-card img { border-radius: 12px; background: #fff; padding: 6px; }
  .tag-card code { font-size: 0.74rem; }
  @media print {
    .tag-grid { grid-template-columns: repeat(2, 1fr); gap: 12px; }
    .tag-card { break-inside: avoid; }
  }

  /* --- admin shell -------------------------------------------------------- */
  .shell { min-height: 100vh; }
  .sidebar {
    position: fixed; top: 16px; bottom: 16px; left: 16px; width: 248px; z-index: 40;
    display: flex; flex-direction: column; gap: 4px; padding: 18px 14px;
    background: var(--surface);
    -webkit-backdrop-filter: blur(28px) saturate(170%); backdrop-filter: blur(28px) saturate(170%);
    border: 1px solid var(--surface-border); border-radius: 28px; box-shadow: var(--shadow);
    overflow-y: auto;
  }
  .brand { display: flex; align-items: center; gap: 12px; padding: 4px 8px 18px; color: var(--text); text-decoration: none; }
  .brand:hover { text-decoration: none; }
  .brand-name { font-weight: 800; font-size: 1.02rem; letter-spacing: -0.02em; line-height: 1.2; }
  .brand-sub { font-size: 0.74rem; color: var(--muted); font-weight: 600; }
  .nav-item {
    display: flex; align-items: center; gap: 12px; padding: 11px 12px; border-radius: 14px;
    color: var(--text-2); font-weight: 650; font-size: 0.92rem; text-decoration: none;
    border: 1px solid transparent; background: none; width: 100%; cursor: pointer; font-family: inherit; text-align: left;
  }
  .nav-item:hover { background: var(--surface-sunk); text-decoration: none; color: var(--text); }
  .nav-item.active { background: var(--surface-strong); color: var(--text); border-color: var(--surface-border); box-shadow: var(--shadow-lift); }
  .nav-item.active .ic { color: var(--accent); }
  .nav-item .badge { margin-left: auto; }
  .nav-section { font-size: 0.7rem; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); padding: 18px 12px 6px; }
  .sidebar-foot { margin-top: auto; padding-top: 12px; border-top: 1px solid var(--hairline); }
  .main { margin-left: 280px; padding: 16px 24px 40px 0; }
  .topbar { display: flex; align-items: center; gap: 12px; margin-bottom: 22px; position: sticky; top: 12px; z-index: 30; }
  .search {
    flex: 1; max-width: 520px; display: flex; align-items: center; gap: 10px; padding: 0 16px; height: 50px;
    background: var(--surface); border: 1px solid var(--surface-border); border-radius: 18px; box-shadow: var(--shadow);
    -webkit-backdrop-filter: blur(24px) saturate(170%); backdrop-filter: blur(24px) saturate(170%); color: var(--muted);
  }
  .search input { border: none; background: transparent; margin: 0; padding: 0; height: 100%; box-shadow: none; }
  .search input:focus { box-shadow: none; }
  .search:focus-within { border-color: var(--accent); box-shadow: 0 0 0 4px var(--accent-soft); }
  .kbd { font-size: 0.72rem; font-weight: 700; color: var(--muted); border: 1px solid var(--hairline); border-radius: 7px; padding: 1px 6px; }
  .top-actions { margin-left: auto; display: flex; align-items: center; gap: 10px; }
  .iconbtn {
    position: relative; width: 50px; height: 50px; border-radius: 16px; display: grid; place-items: center; color: var(--text-2);
    background: var(--surface); border: 1px solid var(--surface-border); box-shadow: var(--shadow); cursor: pointer; font: inherit;
    -webkit-backdrop-filter: blur(24px); backdrop-filter: blur(24px);
  }
  .iconbtn:hover { color: var(--text); text-decoration: none; }
  .iconbtn .dot { position: absolute; top: 11px; right: 12px; width: 9px; height: 9px; border-radius: 50%; background: var(--bad); box-shadow: 0 0 0 2px var(--ring-surface); }
  .profile {
    display: flex; align-items: center; gap: 10px; height: 50px; padding: 0 16px 0 6px; border-radius: 18px; color: var(--text);
    background: var(--surface); border: 1px solid var(--surface-border); box-shadow: var(--shadow); font-weight: 700; font-size: 0.9rem;
    -webkit-backdrop-filter: blur(24px); backdrop-filter: blur(24px);
  }
  .profile:hover { text-decoration: none; }
  .avatar { width: 38px; height: 38px; border-radius: 13px; display: grid; place-items: center; color: #fff; font-weight: 800; background: linear-gradient(140deg, #ff9a8b, #a196ff 60%, #6a5af9); }
  .page-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 18px; }
  .page-head .sub { margin-bottom: 0; }
  .m-only { display: none; }
  .tabbar { display: none; }

  @media (max-width: 1180px) {
    .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .split { grid-template-columns: minmax(0, 1fr); }
  }
  @media (max-width: 980px) {
    .sidebar { display: none; }
    .main { margin: 0; padding: 12px 16px calc(104px + env(safe-area-inset-bottom)); }
    .topbar { top: 8px; margin-bottom: 16px; }
    .search { display: none; }
    .m-only { display: flex; }
    .profile .who { display: none; }
    .profile { padding: 0 6px; }
    .iconbtn, .profile { height: 46px; }
    .iconbtn { width: 46px; }
    .tabbar {
      display: flex; position: fixed; left: 12px; right: 12px; bottom: calc(12px + env(safe-area-inset-bottom)); z-index: 50;
      justify-content: space-around; padding: 6px; gap: 2px;
      background: var(--surface-strong); border: 1px solid var(--surface-border); border-radius: 24px; box-shadow: var(--shadow-lift);
      -webkit-backdrop-filter: blur(28px) saturate(170%); backdrop-filter: blur(28px) saturate(170%);
    }
    .tab {
      flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 7px 2px 6px; border-radius: 17px;
      color: var(--muted); font-size: 10.5px; font-weight: 700; text-decoration: none; position: relative;
    }
    .tab:hover { text-decoration: none; }
    .tab .ic { width: 23px; height: 23px; }
    .tab.active { color: var(--accent-ink); background: var(--accent-soft); }
    .tab .dot { position: absolute; top: 6px; right: calc(50% - 16px); width: 8px; height: 8px; border-radius: 50%; background: var(--bad); }
    .halves { grid-template-columns: minmax(0, 1fr); }
    h1 { font-size: 1.4rem; }
  }
  @media (max-width: 560px) {
    .card { padding: 18px; border-radius: 22px; }
    .kpis { gap: 12px; }
    .stat { flex-direction: column-reverse; justify-content: flex-end; gap: 10px; }
    .stat-value { font-size: 1.55rem; }
    .tile { width: 40px; height: 40px; border-radius: 13px; }
    .tile .ic { width: 20px; height: 20px; }
    .delta-note { display: block; margin: 2px 0 0; }
    .chart .axis-label { font-size: 22px; }
    .chart .axis-label.minor { display: none; }
    .hide-sm { display: none; }
    ul.plain li.wrap > form { flex-basis: 100%; }
  }

  /* --- guard app ---------------------------------------------------------- */
  .guard { max-width: 560px; margin: 0 auto; padding: 14px 16px calc(28px + env(safe-area-inset-bottom)); }
  .guard-top { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; }
  .guard-top .brand { padding: 0; }
  .ring-card { display: flex; align-items: center; gap: 20px; }
  .ring { width: 132px; height: 132px; flex: none; position: relative; }
  .ring svg { width: 100%; height: 100%; transform: rotate(-90deg); }
  .ring .track { stroke: var(--track); }
  .ring .fill { stroke: url(#ringGrad); stroke-linecap: round; transition: stroke-dashoffset 0.4s; }
  .ring-label { position: absolute; inset: 0; display: grid; place-items: center; text-align: center; }
  .ring-label b { font-size: 2rem; font-weight: 800; letter-spacing: -0.04em; line-height: 1; }
  .ring-label span { font-size: 0.78rem; color: var(--muted); font-weight: 600; }
  .scan-hero { text-align: center; padding: 26px 22px; }
  .scan-hero .tile { width: 64px; height: 64px; border-radius: 20px; margin: 0 auto 14px; }
  .scan-hero .tile .ic { width: 32px; height: 32px; }
  .scan-hero h1 { font-size: 1.45rem; }
  .cp-list li { padding: 13px 2px; }
  .cp-name { font-weight: 600; }
  .cp-state { display: inline-flex; align-items: center; gap: 6px; font-size: 0.82rem; font-weight: 700; color: var(--muted); white-space: nowrap; }
  .cp-state .ic { width: 16px; height: 16px; }
  .cp-state.done { color: var(--ok); }
  .guard-top { justify-content: space-between; }
  .nfc-btn {
    display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--surface-border); cursor: pointer; font: inherit;
    padding: 8px 12px; border-radius: 999px; font-size: 0.8rem; font-weight: 700; white-space: nowrap;
    background: var(--accent-soft); color: var(--accent-ink);
  }
  .nfc-btn .ic { width: 17px; height: 17px; }
  .nfc-btn.on { background: var(--ok-soft); color: var(--ok); }
  .toast {
    position: fixed; left: 50%; bottom: calc(20px + env(safe-area-inset-bottom)); transform: translateX(-50%); z-index: 60;
    max-width: calc(100% - 32px); padding: 12px 16px; border-radius: 16px; background: #12142a; color: #fff;
    font-size: 0.88rem; font-weight: 600; box-shadow: 0 12px 30px rgba(15, 23, 42, 0.3);
  }
  @media (max-width: 420px) {
    .ring-card { gap: 14px; }
    .ring { width: 108px; height: 108px; }
    .ring-label b { font-size: 1.65rem; }
  }

  /* --- centred auth / message pages ------------------------------------- */
  .center { max-width: 440px; margin: 0 auto; padding: 8vh 16px 32px; }
  .center .brand { justify-content: center; padding-bottom: 22px; }

  @media print {
    body { background: #fff; }
    body::before, .sidebar, .topbar, .tabbar, .no-print { display: none !important; }
    .main { margin: 0; padding: 0; }
    .card { break-inside: avoid; border: 1px solid #ccc; background: #fff; -webkit-backdrop-filter: none; backdrop-filter: none; box-shadow: none; }
  }
`;

const LOGO = `<span class="tile violet sm" aria-hidden="true">${icon('shield')}</span>`;

function brand(sub) {
  return `${LOGO}<span><span class="brand-name">School Tag</span><br><span class="brand-sub">${esc(sub)}</span></span>`;
}

const ADMIN_NAV = [
  ['/admin', 'Dashboard', 'Home', 'home'],
  ['/admin/checkpoints', 'Checkpoints', 'Points', 'pin'],
  ['/admin/tags', 'Tag sheet', 'Tags', 'tag'],
  ['/admin/history', 'History', 'History', 'clock'],
  ['/admin/devices', 'Devices', 'Devices', 'phone'],
  ['/admin/settings', 'Settings', 'Settings', 'gear'],
];

// Sidebar (desktop), top bar and bottom tab bar (phones) around an admin page.
function adminShell(body, { active, alerts = 0, query = '' }) {
  const link = ([href, label, , ic]) => {
    const isActive = href === active;
    const badge = href === '/admin' && alerts ? `<span class="badge bad" aria-label="${alerts} new alerts">${alerts}</span>` : '';
    return `<a class="nav-item${isActive ? ' active' : ''}" href="${href}"${isActive ? ' aria-current="page"' : ''}>${icon(ic)}<span>${label}</span>${badge}</a>`;
  };
  const tab = ([href, , short, ic]) => {
    const isActive = href === active;
    const dot = href === '/admin' && alerts ? '<span class="dot" aria-hidden="true"></span>' : '';
    return `<a class="tab${isActive ? ' active' : ''}" href="${href}"${isActive ? ' aria-current="page"' : ''}>${icon(ic)}<span>${short}</span>${dot}</a>`;
  };
  return `
  <div class="shell">
    <aside class="sidebar no-print" aria-label="Main navigation">
      <a class="brand" href="/admin">${brand('Security rounds')}</a>
      ${ADMIN_NAV.slice(0, 5).map(link).join('')}
      <div class="nav-section">Guards</div>
      <a class="nav-item" href="/walk">${icon('route')}<span>Guard app</span></a>
      <div class="sidebar-foot">
        ${link(ADMIN_NAV[5])}
        <form method="post" action="/admin/logout"><button class="nav-item" type="submit">${icon('out')}<span>Log out</span></button></form>
      </div>
    </aside>
    <div class="main">
      <header class="topbar no-print">
        <a class="brand m-only" href="/admin">${LOGO}<span class="brand-name">School Tag</span></a>
        <form class="search" method="get" action="/admin/checkpoints" role="search">
          ${icon('search')}
          <input type="search" name="q" value="${esc(query)}" placeholder="Search checkpoints…" aria-label="Search checkpoints" autocomplete="off">
          <span class="kbd" aria-hidden="true">/</span>
        </form>
        <div class="top-actions">
          <a class="iconbtn" href="/admin#alerts" aria-label="${alerts ? `${alerts} new alerts` : 'Alerts'}">${icon('bell')}${alerts ? '<span class="dot"></span>' : ''}</a>
          <a class="profile" href="/admin/settings" aria-label="Settings"><span class="avatar">A</span><span class="who">Admin</span></a>
          <form method="post" action="/admin/logout" class="m-only"><button class="iconbtn" type="submit" aria-label="Log out">${icon('out')}</button></form>
        </div>
      </header>
      ${body}
    </div>
    <nav class="tabbar no-print" aria-label="Main navigation">${ADMIN_NAV.map(tab).join('')}</nav>
  </div>
  <script>
    document.addEventListener('keydown', function (e) {
      var s = document.querySelector('.search input');
      var t = document.activeElement && document.activeElement.tagName;
      if (e.key === '/' && s && t !== 'INPUT' && t !== 'TEXTAREA' && t !== 'SELECT') { e.preventDefault(); s.focus(); }
    });
  </script>`;
}

function guardShell(body) {
  return `<div class="guard">
    <header class="guard-top">
      <a class="brand" href="/walk">${brand('დაცვის შემოვლა · Guard rounds')}</a>
      <button class="nfc-btn no-print" id="st-nfc" type="button" hidden>${icon('nfc')}<span>NFC · Scan here</span></button>
    </header>
    <div class="toast" id="st-toast" role="status" aria-live="polite" hidden></div>
    ${body}
  </div>
  <script>${GUARD_SCRIPT}</script>`;
}

// Keeps chip taps in one tab.
//  1. Chrome on Android can read chips from inside the page (Web NFC). Once
//     the guard allows it, every guard page listens, and a tapped chip opens
//     in this same tab — Android no longer launches a new tab per tap.
//  2. Where that isn't available, a tap opens a fresh tab: that tab hands the
//     tap to the guard tab that is already open (which opens the same chip
//     page — recording a scan twice is harmless) and closes itself.
const GUARD_SCRIPT = `
(function () {
  var btn = document.getElementById('st-nfc');
  var toast = document.getElementById('st-toast');
  function say(text, ms) {
    toast.textContent = text; toast.hidden = false;
    clearTimeout(say.t); say.t = setTimeout(function () { toast.hidden = true; }, ms || 3000);
  }
  function chipCode(text) {
    var m = String(text).match(/\\/t\\/([0-9a-fA-F]{6,16})(?=[\\/?#]|$)/);
    return m ? m[1].toLowerCase() : null;
  }
  async function listen(fromClick) {
    try {
      if (!fromClick) {
        var perm = await navigator.permissions.query({ name: 'nfc' });
        if (perm.state !== 'granted') return;
      }
      var reader = new NDEFReader();
      await reader.scan();
      btn.classList.add('on');
      btn.lastChild.textContent = 'NFC ჩართულია · On';
      if (fromClick) say('შეეხეთ ტეგს · Tap a chip — it opens right here.');
      reader.onreading = function (e) {
        for (var i = 0; i < e.message.records.length; i++) {
          var r = e.message.records[i];
          if (r.recordType !== 'url' && r.recordType !== 'absolute-url') continue;
          var code = chipCode(new TextDecoder().decode(r.data));
          // The chip this page is about is usually still in range when the
          // page starts listening; reading it again must not reload the page.
          if (code && location.pathname === '/t/' + code) { say('✓ უკვე ჩაწერილია · Already recorded.'); return; }
          if (code) { location.href = '/t/' + code; return; }
        }
        say('ეს ტეგი სისტემის არ არის · Not a School Tag chip.');
      };
      reader.onreadingerror = function () { say('ვერ წავიკითხე, სცადეთ ისევ · Could not read the chip, try again.'); };
    } catch (err) {
      if (fromClick) say('NFC მიუწვდომელია · NFC is off or not allowed: ' + (err && err.message ? err.message : err), 5000);
    }
  }
  if ('NDEFReader' in window && btn) {
    btn.hidden = false;
    btn.addEventListener('click', function () { listen(true); });
    listen(false);
  }

  if (!('BroadcastChannel' in window)) return;
  var channel = new BroadcastChannel('school-tag-guard');
  // A tab whose first page is a chip URL was opened by the tap itself.
  var fresh = false;
  try { fresh = !sessionStorage.getItem('st-tab'); sessionStorage.setItem('st-tab', '1'); } catch (err) {}
  var isTap = fresh && /^\\/t\\/[^/]+$/.test(location.pathname);
  channel.onmessage = function (e) {
    var d = e.data || {};
    if (d.type === 'tap' && d.path && !isTap) {
      channel.postMessage({ type: 'taken', id: d.id });
      location.href = d.path;
    }
    if (d.type === 'taken' && isTap && d.id === tapId) {
      say('✓ ჩაიწერა ღია ფანჯარაში · Recorded in your open tab — you can close this one.', 8000);
      setTimeout(function () { window.close(); }, 600);
    }
  };
  var tapId = String(Date.now()) + Math.random();
  if (isTap) channel.postMessage({ type: 'tap', path: location.pathname, id: tapId });
})();
`;

function page(title, body, opts = {}) {
  const refresh = opts.refreshSeconds
    ? `<meta http-equiv="refresh" content="${opts.refreshSeconds}">`
    : '';
  let content;
  if (opts.shell) content = adminShell(body, opts.shell);
  else if (opts.center) content = `<div class="center"><div class="brand">${brand(opts.admin ? 'Admin' : 'დაცვის შემოვლა · Guard rounds')}</div>${body}</div>`;
  else content = guardShell(body);
  return `<!DOCTYPE html>
<html lang="${opts.lang || 'en'}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" media="(prefers-color-scheme: light)" content="#eef0f7">
  <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0b0d18">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <meta name="apple-mobile-web-app-title" content="${opts.admin ? 'ST Admin' : 'School Tag'}">
  <link rel="manifest" href="${opts.admin ? '/manifest-admin.webmanifest' : '/manifest.webmanifest'}">
  <link rel="apple-touch-icon" href="${opts.admin ? '/icons/admin-180.png' : '/icons/icon-180.png'}">
  <link rel="icon" type="image/png" sizes="192x192" href="${opts.admin ? '/icons/admin-192.png' : '/icons/icon-192.png'}">
  <link rel="preload" href="/fonts/NotoSansGeorgian.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="preload" href="/fonts/PlusJakartaSans.woff2" as="font" type="font/woff2" crossorigin>
  ${refresh}
  <title>${esc(title)}</title>
  <style>${CSS}</style>
</head>
<body>
  ${content}
  <svg width="0" height="0" style="position:absolute" aria-hidden="true">
    <defs>
      <linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a196ff"/><stop offset="1" stop-color="#6a5af9"/></linearGradient>
    </defs>
  </svg>
  <script>
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(function () {});
    async function stEnablePush(btn) {
      try {
        if (!('PushManager' in window) || !('serviceWorker' in navigator)) {
          btn.textContent = 'მხარდაუჭერელია / Not supported'; return;
        }
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') { btn.textContent = '⛔ ' + btn.dataset.denied; return; }
        const reg = await navigator.serviceWorker.ready;
        const keyRes = await fetch('/push/key');
        const { key } = await keyRes.json();
        const raw = atob(key.replace(/-/g, '+').replace(/_/g, '/'));
        const appKey = new Uint8Array([...raw].map((c) => c.charCodeAt(0)));
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey });
        const res = await fetch('/push/subscribe', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subscription: sub.toJSON(), label: btn.dataset.label || '' }),
        });
        btn.textContent = res.ok ? '✓ ' + btn.dataset.done : '✕ Error';
      } catch (e) { btn.textContent = '✕ Error'; }
    }
  </script>
</body>
</html>`;
}

// A checkpoint's name, plus its location when that adds something (many
// schools enter the name again as the location).
function place(name, location) {
  const loc = String(location || '').trim();
  return loc && loc !== String(name || '').trim()
    ? `${esc(name)} <span class="muted">— ${esc(loc)}</span>`
    : esc(name);
}

// Progress ring for the guard app: how many of the checkpoints are scanned.
function ring(done, total, caption) {
  const r = 56;
  const c = 2 * Math.PI * r;
  const frac = total ? Math.min(1, done / total) : 1;
  return `<div class="ring" role="img" aria-label="${done} / ${total}">
    <svg viewBox="0 0 132 132"><circle class="track" cx="66" cy="66" r="${r}" fill="none" stroke-width="12"/>
      <circle class="fill" cx="66" cy="66" r="${r}" fill="none" stroke-width="12" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - frac)).toFixed(1)}"/></svg>
    <div class="ring-label"><div><b>${done}<span style="font-size:1rem;color:var(--muted)">/${total}</span></b><br><span>${esc(caption)}</span></div></div>
  </div>`;
}

module.exports = { esc, page, icon, ring, place };
