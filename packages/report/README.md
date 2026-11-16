# @bedperf/report

Reads a run directory (`runs/<runId>/`), analyses it and renders a self-contained HTML report or an A/B comparison. Depends on `@bedperf/core` only. Charts are hand-written inline SVG, with no chart library, scripts or external resources.

Example output: [`examples/report.html`](examples/report.html), [`examples/compare.html`](examples/compare.html). Both come from synthetic fixture runs.

## API

```ts
import { loadRun, analyze, renderHtml, compareRuns, renderCompareHtml, writeReport, writeCompare, generateRun } from '@bedperf/report'

const run = await loadRun('runs/20260101-120000')  // RunData
const a = analyze(run)                                 // Analysis
const html = renderHtml(a)                             // string

await writeReport('runs/A')                            // writes runs/A/report.html
await writeCompare('runs/A', 'runs/B', 'out/compare.html')  // B relative to baseline A

const c = compareRuns(analyze(await loadRun('runs/A')), analyze(await loadRun('runs/B')))
renderCompareHtml(c)
```

- `loadRun(dir)` requires `config.json` and `meta.json`. It tolerates a missing `result.json` (aborted run) and a missing `steps.json`, in which case it uses `orch.step.end` envelopes that carry a full `StepResult`. `samples.jsonl` is streamed line by line. Unknown envelope kinds are counted and skipped, and malformed lines are counted.
- `generateRun(dir, opts)` synthesizes a realistic run dir for tests and demos. It produces 3 repeats of ramp + bisect at ~1 Hz probe, sys and bot envelopes with noise, capacity ~40 by default, and options for an aborted run, no sysmon, loadgen saturation and junk lines.

## Analysis (`Analysis`)

| field | contents |
|---|---|
| `headline` | median max players, per-repeat values, min/max/spread, `capped`, `loadgenLimited`, `aborted`. Comes from `result.json`, or is recomputed from steps when that is missing. |
| `steps` | per step: players, pass/invalid, fail reasons, TPS mean/min, tick p99, ticks over 50/100 ms, util mean, CPU, RSS, RTT p95, net rx/tx, bot failures |
| `curves`, `meanCurve` | players → mean of each metric (`tps`, `util`, `cpu`, `rss`, `rssPerPlayer`, `rttP95`, `netTx`, `tickP99`), per repeat and across repeats. Passing and failing steps are both included; invalid ones are not. |
| `derived` | least-squares slopes over the step means: memory per player (RSS), net tx/rx per player, util per player, and the extrapolated players at util = 1.0 |
| `timeline` | TPS (bucket minimum), util and players over time, downsampled to ≤ 600 points per repeat, with step bands from `orch.step.*` envelopes |

## Report sections

1. Headline card: max players @ 20 TPS, repeat spread, flags, and per-player cost tiles
2. Run metadata: versions, host, scenario, ramp and criteria, key server properties (all of them under a disclosure)
3. Scaling charts against players: TPS (with a 20 TPS line), main-thread util (with a util 1.0 line and the linear fit), RSS per player above baseline, RTT p95
4. Timeline per repeat: TPS, util and players as stacked panels sharing the time axis, with step bands shaded pass/fail/invalid
5. Steps table
6. Methodology footnote and data-quality notes

Light and dark themes follow `prefers-color-scheme`. The layout works at 375 px: the long timelines and the table scroll horizontally inside their card, not the page.

The comparison shows both headlines and their delta, per-player costs, overlaid TPS and util curves, and a metric table at matched player counts. Matched counts are round numbers inside both runs' ranges, linearly interpolated on each mean curve. It also gives the percent change and colours each change as better or worse; changes under 1 % count as the same.

## Caveats

- Core does not define `orch.step.start` / `orch.step.end` payloads. The report reads `repeat`, `index`, `players`, `phase`, `pass` and `loadgenSaturated` from them, all optional (see `StepMarkData`). Step status comes from `steps.json` when it has a matching (repeat, index).
- The util slope is fitted on passing steps when there are at least two, because util flattens near 1.0 past saturation. The extrapolation is therefore a linear projection of below-capacity behaviour.
- The scaling curves average steps at equal player counts. Bisection probes different counts per repeat, so the mean curve can be jagged near capacity.
- Steps invalidated by loadgen saturation are left out of the curves and fits, because the bot count is not the load the server saw. They are still listed, marked invalid, in the table and timeline.
- Without `result.json`, a repeat whose search did not finish (judged from its steps against `ramp`) is left out of the headline and listed in `headline.incompleteRepeats`. Unparseable optional files count as missing and appear as notes.
