'use strict';

// Server-rendered SVG charts for the dashboard: one smooth area chart with a
// hover/keyboard crosshair, and sparklines for stat tiles. Colors come from
// the --series tokens in html.js; text always uses text tokens.

const { esc } = require('./html');

// Monotone cubic (Fritsch–Carlson) path: smooth, and never overshoots the
// data — a day with 0 scans never dips below the baseline.
function smoothPath(pts) {
  const n = pts.length;
  if (n === 0) return '';
  if (n === 1) return `M${pts[0][0]},${pts[0][1]}`;
  const dx = [];
  const slope = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1][0] - pts[i][0]);
    slope.push((pts[i + 1][1] - pts[i][1]) / dx[i]);
  }
  const m = [slope[0]];
  for (let i = 1; i < n - 1; i++) m.push(slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2);
  m.push(slope[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / slope[i];
    const b = m[i + 1] / slope[i];
    const h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      m[i] = t * a * slope[i];
      m[i + 1] = t * b * slope[i];
    }
  }
  const f = (v) => v.toFixed(1);
  let d = `M${f(pts[0][0])},${f(pts[0][1])}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += ` C${f(pts[i][0] + h)},${f(pts[i][1] + m[i] * h)} ${f(pts[i + 1][0] - h)},${f(pts[i + 1][1] - m[i + 1] * h)} ${f(pts[i + 1][0])},${f(pts[i + 1][1])}`;
  }
  return d;
}

// A clean tick step so the axis reads 0 / 10 / 20 …, never 0 / 13 / 26.
function niceStep(raw) {
  if (raw <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

const compact = (v) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1).replace(/\.0$/, '')}K` : String(v));

// points: [{ label, short, value, note }]; `unit` names the value (e.g. "scans").
function areaChart({ id, points, unit, caption }) {
  const W = 720;
  const H = 270;
  const padL = 40;
  const padR = 14;
  const padT = 14;
  const padB = 30;
  const n = points.length;
  const max = Math.max(0, ...points.map((p) => p.value));
  const step = niceStep(Math.max(max, 4) / 4);
  const top = step * 4;
  const x = (i) => padL + (n === 1 ? 0 : (i * (W - padL - padR)) / (n - 1));
  const y = (v) => padT + (1 - v / top) * (H - padT - padB);
  const pts = points.map((p, i) => [x(i), y(p.value)]);
  const line = smoothPath(pts);
  const base = y(0);
  const area = n ? `${line} L${pts[n - 1][0].toFixed(1)},${base} L${pts[0][0].toFixed(1)},${base} Z` : '';
  const grid = [0, 1, 2, 3, 4]
    .map((k) => {
      const v = step * k;
      return `<line class="gridline" x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/>
        <text class="axis-label" x="${padL - 8}" y="${y(v) + 4}" text-anchor="end">${compact(v)}</text>`;
    })
    .join('');
  const every = n > 10 ? 2 : 1;
  const xlabels = points
    .map((p, i) =>
      (n - 1 - i) % every === 0
        ? `<text class="axis-label${(n - 1 - i) % (every * 2) ? ' minor' : ''}" x="${x(i)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}">${esc(p.short)}</text>`
        : ''
    )
    .join('');
  const data = points.map((p, i) => ({ x: x(i) / W, y: y(p.value) / H, v: p.value, l: p.label, n: p.note || '' }));
  const total = points.reduce((s, p) => s + p.value, 0);
  return `<figure class="chart" id="${id}" tabindex="0" style="margin:0"
      aria-label="${esc(caption)}: ${total} ${esc(unit)} in total. Use the arrow keys to read each day."
      data-points="${esc(JSON.stringify(data))}" data-unit="${esc(unit)}">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-hidden="true">
      <defs>
        <linearGradient id="${id}-wash" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style="stop-color:var(--series);stop-opacity:.22"/>
          <stop offset="1" style="stop-color:var(--series);stop-opacity:0"/>
        </linearGradient>
      </defs>
      ${grid}
      <path d="${area}" fill="url(#${id}-wash)"/>
      <path class="series-line" d="${line}"/>
      <line class="crosshair" x1="0" x2="0" y1="${padT}" y2="${base}"/>
      <circle class="hover-dot" r="5" cx="0" cy="0"/>
      ${xlabels}
    </svg>
    <div class="chart-tip" role="status" aria-live="polite"></div>
  </figure>
  <script>
  (function () {
    var fig = document.getElementById(${JSON.stringify(id)});
    var pts = JSON.parse(fig.dataset.points), unit = fig.dataset.unit;
    var svg = fig.querySelector('svg'), cross = fig.querySelector('.crosshair'), dot = fig.querySelector('.hover-dot'), tip = fig.querySelector('.chart-tip');
    var W = ${W}, H = ${H}, cur = pts.length - 1;
    function show(i) {
      cur = Math.max(0, Math.min(pts.length - 1, i));
      var p = pts[cur], r = svg.getBoundingClientRect(), f = fig.getBoundingClientRect();
      cross.setAttribute('x1', p.x * W); cross.setAttribute('x2', p.x * W);
      dot.setAttribute('cx', p.x * W); dot.setAttribute('cy', p.y * H);
      tip.textContent = '';
      var strong = document.createElement('strong'); strong.textContent = p.v + ' ' + unit; tip.appendChild(strong);
      var k = document.createElement('span'); k.className = 'k'; tip.appendChild(k);
      tip.appendChild(document.createTextNode(p.l + (p.n ? ' · ' + p.n : '')));
      var left = r.left - f.left + p.x * r.width, half = tip.offsetWidth / 2 + 4;
      tip.style.left = Math.max(half, Math.min(f.width - half, left)) + 'px';
      tip.style.top = (r.top - f.top + p.y * r.height - 12) + 'px';
      fig.classList.add('hovering');
    }
    function nearest(clientX) {
      var r = svg.getBoundingClientRect(), fx = (clientX - r.left) / r.width, best = 0;
      for (var i = 1; i < pts.length; i++) if (Math.abs(pts[i].x - fx) < Math.abs(pts[best].x - fx)) best = i;
      return best;
    }
    fig.addEventListener('pointermove', function (e) { show(nearest(e.clientX)); });
    fig.addEventListener('pointerleave', function () { if (document.activeElement !== fig) fig.classList.remove('hovering'); });
    fig.addEventListener('focus', function () { show(cur); });
    fig.addEventListener('blur', function () { fig.classList.remove('hovering'); });
    fig.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft') { e.preventDefault(); show(cur - 1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); show(cur + 1); }
    });
  })();
  </script>
  <details class="table-view no-print"><summary>Show as table</summary>
    <div class="table-wrap"><table><thead><tr><th>Day</th><th class="num">${esc(unit[0].toUpperCase() + unit.slice(1))}</th><th>Rounds</th></tr></thead><tbody>
      ${points.map((p) => `<tr><td>${esc(p.label)}</td><td class="num">${p.value}</td><td class="muted">${esc(p.note || '—')}</td></tr>`).join('')}
    </tbody></table></div>
  </details>`;
}

// Stat-tile trend: the whole run in the quiet gray, the current period (the
// last `current` points) in the accent. Days without data are skipped.
function sparkline(values, current = 7) {
  const W = 120;
  const H = 44;
  const pad = 5;
  const defined = values.map((v, i) => [i, v]).filter(([, v]) => v !== null && v !== undefined);
  if (defined.length < 2) return `<svg class="spark" viewBox="0 0 ${W} ${H}" aria-hidden="true"></svg>`;
  const vals = defined.map(([, v]) => v);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = hi - lo || 1;
  const x = (i) => pad + (i * (W - 2 * pad)) / Math.max(1, values.length - 1);
  const y = (v) => H - pad - ((v - lo) / span) * (H - 2 * pad);
  const pts = defined.map(([i, v]) => [x(i), y(v)]);
  const cut = values.length - current;
  const recent = defined.map(([i], k) => [i, pts[k]]).filter(([i]) => i >= cut - 1).map(([, p]) => p);
  const last = pts[pts.length - 1];
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" aria-hidden="true">
    <path d="${smoothPath(pts)}" fill="none" stroke="var(--series-quiet)" stroke-width="2" stroke-linecap="round"/>
    ${recent.length > 1 ? `<path d="${smoothPath(recent)}" fill="none" stroke="var(--series)" stroke-width="2" stroke-linecap="round"/>` : ''}
    <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="4" fill="var(--series)" stroke="var(--ring-surface)" stroke-width="2"/>
  </svg>`;
}

module.exports = { areaChart, sparkline, smoothPath };
