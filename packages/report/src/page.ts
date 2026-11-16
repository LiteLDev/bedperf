import { esc } from './format.ts'

const LIGHT = `
  color-scheme: light;
  --page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --muted: #75736d;
  --grid: #e1e0d9; --axis: #c3c2b7; --border: rgba(11,11,11,0.10);
  --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a; --s4: #eda100; --s5: #e87ba4; --s6: #008300; --s7: #6250d6; --s8: #e34948;
  --good: #0ca30c; --good-ink: #006300; --warn: #fab219; --warn-ink: #8a5a00; --bad: #d03b3b; --bad-ink: #b02a2a;
  --band-pass: rgba(12,163,12,0.09); --band-fail: rgba(208,59,59,0.13); --band-invalid: rgba(250,178,25,0.20); --band-unknown: rgba(137,135,129,0.10);`
const DARK = `
  color-scheme: dark;
  --page: #0d0d0d; --surface: #1a1a19; --ink: #f0efec; --ink-2: #c3c2b7; --muted: #8f8d86;
  --grid: #2c2c2a; --axis: #4a4a46; --border: rgba(255,255,255,0.10);
  --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500; --s5: #d55181; --s6: #0ca30c; --s7: #9085e9; --s8: #e66767;
  --good: #0ca30c; --good-ink: #3fc23f; --warn: #fab219; --warn-ink: #fab219; --bad: #d03b3b; --bad-ink: #ef7a7a;
  --band-pass: rgba(12,163,12,0.14); --band-fail: rgba(208,59,59,0.22); --band-invalid: rgba(250,178,25,0.20); --band-unknown: rgba(137,135,129,0.14);`

export const CSS = `
:root {${LIGHT}}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {${DARK}} }
:root[data-theme="dark"] {${DARK}}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--page); color: var(--ink); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 1160px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 1.5rem; margin: 0 0 4px; overflow-wrap: anywhere; }
h2 { font-size: 1.15rem; margin: 0 0 12px; }
h3 { font-size: 0.95rem; margin: 0 0 6px; font-weight: 600; }
.sub { color: var(--ink-2); margin: 0 0 20px; overflow-wrap: anywhere; }
section { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 18px; margin: 0 0 18px; min-width: 0; }
.headline { display: flex; flex-wrap: wrap; gap: 18px 32px; align-items: flex-end; }
.hero .label { color: var(--ink-2); font-size: 0.95rem; }
.hero .value { font-size: 3.2rem; font-weight: 700; line-height: 1.05; font-variant-numeric: tabular-nums; }
.hero .detail { color: var(--ink-2); font-size: 0.9rem; }
.hero .value.delta { font-size: 2rem; }
.flags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.flag { display: inline-flex; gap: 6px; align-items: center; border: 1px solid var(--border); border-radius: 999px; padding: 2px 10px; font-size: 0.82rem; }
.flag::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
.flag.ok::before { background: var(--good); } .flag.warn::before { background: var(--warn); } .flag.bad::before { background: var(--bad); }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; flex: 1 1 420px; }
.tile { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; }
.tile .k { color: var(--ink-2); font-size: 0.8rem; }
.tile .v { font-size: 1.25rem; font-weight: 600; font-variant-numeric: tabular-nums; }
.tile .n { color: var(--muted); font-size: 0.75rem; }
dl.meta { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 8px 20px; margin: 0; }
dl.meta div { min-width: 0; }
dl.meta dt { color: var(--ink-2); font-size: 0.8rem; }
dl.meta dd { margin: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
details { margin-top: 12px; } summary { cursor: pointer; color: var(--ink-2); }
code { font: 0.85em ui-monospace, "Cascadia Mono", Consolas, monospace; overflow-wrap: anywhere; }
.charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 440px), 1fr)); gap: 20px; }
figure { margin: 0; min-width: 0; }
.chart { display: block; width: 100%; height: auto; }
.chart text { font-size: 13px; }
.chart .plot-bg { fill: none; }
.chart .grid line { stroke: var(--grid); stroke-width: 1; }
.chart .tick text { fill: var(--muted); }
.chart .tick-mark, .chart .axis { stroke: var(--axis); stroke-width: 1; }
.chart .axis-label { fill: var(--ink-2); }
.chart .empty { fill: var(--muted); }
.chart .ref { stroke: var(--ink-2); stroke-width: 1.25; stroke-dasharray: 5 4; }
.chart .ref-label { fill: var(--ink-2); font-size: 12px; }
.chart path.series { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.chart path.series.dash { stroke-dasharray: 6 4; stroke-width: 1.5; }
.chart .markers circle { stroke: var(--surface); stroke-width: 2; }
.chart .band { stroke: none; }
.band-pass { fill: var(--band-pass); background: var(--band-pass); }
.band-fail { fill: var(--band-fail); background: var(--band-fail); }
.band-invalid { fill: var(--band-invalid); background: var(--band-invalid); }
.band-unknown { fill: var(--band-unknown); background: var(--band-unknown); }
${[1, 2, 3, 4, 5, 6, 7, 8].map((i) => `.s${i} { stroke: var(--s${i}); fill: var(--s${i}); color: var(--s${i}); }`).join('\n')}
.sm { stroke: var(--muted); fill: var(--muted); color: var(--muted); }
path.sm, path.s1, path.s2, path.s3, path.s4, path.s5, path.s6, path.s7, path.s8 { fill: none; }
.legend { list-style: none; display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 0 0 6px; padding: 0; font-size: 0.82rem; color: var(--ink-2); }
.legend li { display: inline-flex; align-items: center; gap: 6px; }
.sw.line { width: 18px; height: 0; border-top: 2px solid currentColor; }
.sw.line.dash { border-top-style: dashed; }
.sw.box { width: 14px; height: 12px; border-radius: 3px; border: 1px solid var(--border); }
.repeat + .repeat { margin-top: 22px; padding-top: 16px; border-top: 1px solid var(--grid); }
.panels { display: grid; gap: 4px; }
.panels .chart { min-width: 560px; }
.scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
table { border-collapse: collapse; width: 100%; font-size: 0.85rem; font-variant-numeric: tabular-nums; }
th, td { padding: 6px 8px; border-bottom: 1px solid var(--grid); text-align: right; white-space: nowrap; }
th { color: var(--ink-2); font-weight: 600; position: sticky; top: 0; background: var(--surface); }
td.l, th.l { text-align: left; }
td.reasons { white-space: normal; min-width: 220px; text-align: left; color: var(--ink-2); }
.st { display: inline-flex; align-items: center; gap: 5px; font-weight: 600; }
.st::before { content: ""; width: 8px; height: 8px; border-radius: 50%; }
.st.pass { color: var(--good-ink); } .st.pass::before { background: var(--good); }
.st.fail { color: var(--bad-ink); } .st.fail::before { background: var(--bad); }
.st.invalid { color: var(--warn-ink); } .st.invalid::before { background: var(--warn); }
.better { color: var(--good-ink); font-weight: 600; } .worse { color: var(--bad-ink); font-weight: 600; } .same { color: var(--ink-2); }
.vn, .rng { color: var(--muted); font-weight: 400; font-size: 0.8rem; }
.rs { font-weight: 600; } .rs.server_failed { color: var(--bad-ink); } .rs.invalid { color: var(--warn-ink); }
.hero .detail.verdict { max-width: 34ch; }
details.repeats { margin-top: 10px; }
details.repeats table { margin-top: 6px; }
.banner { border: 2px solid var(--bad); background: var(--band-fail); color: var(--ink); border-radius: 12px; padding: 14px 18px; margin: 0 0 18px; overflow-wrap: anywhere; }
.banner b { color: var(--bad-ink); }
.foot { color: var(--ink-2); font-size: 0.85rem; }
.foot ul { padding-left: 18px; }
.vs { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); gap: 14px; align-items: end; }
@media (max-width: 520px) {
  main { padding: 16px 16px 32px; }
  section { padding: 14px 12px; border-radius: 10px; }
  .hero .value { font-size: 2.6rem; }
  .chart text { font-size: 15px; }
  .chart .ref-label { font-size: 14px; }
}
`

export function page (title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`
}
