# @bedperf/report

Reads a run directory (`runs/<runId>/`), analyses it and renders a self-contained HTML report or an A/B comparison. Depends on `@bedperf/core` only. Charts are hand-written inline SVG, with no chart library, scripts or external resources.

Example output: [`examples/report.html`](examples/report.html), [`examples/compare.html`](examples/compare.html). Both come from synthetic fixture runs; regenerate them with `corepack pnpm --filter @bedperf/report examples` (`node src/examples.ts`).

## API

```ts
import { loadRun, analyze, renderHtml, compareRuns, renderCompareHtml, writeReport, writeCompare, generateRun } from '@bedperf/report'

const run = await loadRun('runs/20260101-120000')  // RunData
const a = analyze(run)                                 // Analysis
const html = renderHtml(a)                             // string

await writeReport('runs/A')                            // writes runs/A/report.html
await writeCompare('runs/A', 'runs/B', 'out/compare.html')  // B relative to baseline A
await writeCompare('runs/A', 'runs/B', 'out/compare.html', { force: true })  // even if not comparable

const c = compareRuns(analyze(await loadRun('runs/A')), analyze(await loadRun('runs/B')))  // may throw IncomparableRunsError
renderCompareHtml(c)
```

- `loadRun(dir)` requires `config.json` and `meta.json`. It tolerates a missing `result.json` (aborted run) and a missing `steps.json`, in which case it uses `orch.step.end` envelopes that carry a full `StepResult`. `samples.jsonl` is streamed line by line. Unknown envelope kinds are counted and skipped, and malformed lines are counted.
- `loadRun` also reads `orch.repeat.start` / `orch.repeat.end` envelopes into `repeatStarts` / `repeatEnds` (see Repeat status).
- `generateRun(dir, opts)` synthesizes a realistic run dir for tests and demos. It produces 3 repeats of ramp + bisect at ~1 Hz probe, sys and bot envelopes with noise, capacity ~40 by default, and options for an aborted run, no sysmon, loadgen saturation, junk lines, exact per-repeat capacities, per-repeat `orch.repeat.end` outcomes (status, reasons, aborted, never ended, null outcome) and extra meta.json fields.

## Analysis (`Analysis`)

| field | contents |
|---|---|
| `analysisVersion` | `ANALYSIS_VERSION` of the code that produced it |
| `headline` | median max players over the **ok** repeats with min/max/spread, `kOk` / `n`, `statusCounts`, every repeat with status, reasons and value (`repeats`), `capped`, `loadgenLimited`, `aborted`. Per-repeat values come from `orch.repeat.end`, `result.json` or the steps, in that order. |
| `steps` | per step: players, pass/invalid, fail reasons, TPS mean/min, tick p99, ticks over 50/100 ms, util mean, CPU, RSS, RTT p95, net rx/tx, bot failures |
| `curves`, `meanCurve` | players → mean of each metric (`tps`, `util`, `cpu`, `rss`, `rssPerPlayer`, `rttP95`, `netTx`, `tickP99`), per repeat (every repeat) and across the ok repeats. Passing and failing steps are both included; invalid ones are not. |
| `derived` | least-squares slopes over the ok repeats' step means: memory per player (RSS), net tx/rx per player, util per player, and the extrapolated players at util = 1.0 |
| `repeatDerived`, `okRepeats` | the same fits per ok repeat, used by the comparison |
| `timeline` | TPS (bucket minimum), util and players over time, downsampled to ≤ 600 points per repeat, with step bands from `orch.step.*` envelopes |

## Report sections

1. Headline card: max players @ 20 TPS (median of ok repeats), k/n ok, range, per-repeat values with statuses and reasons, flags, and per-player cost tiles
2. Run metadata: versions, host, scenario, ramp and criteria, comparability fields (config hash, machine fingerprint, BDS build hash, analysis version, placement profile hash), key server properties (all of them under a disclosure)
3. Scaling charts against players: TPS (with a 20 TPS line), main-thread util (with a util 1.0 line and the linear fit), RSS per player above baseline, RTT p95
4. Timeline per repeat: TPS, util and players as stacked panels sharing the time axis, with step bands shaded pass/fail/invalid
5. Steps table
6. Methodology footnote and data-quality notes

Light and dark themes follow `prefers-color-scheme`. The layout works at 375 px: the long timelines and the table scroll horizontally inside their card, not the page.

The comparison shows both headlines and their delta, a comparability table, per-player costs, overlaid TPS and util curves, a metric table at matched player counts and the decision rule. Matched counts are round numbers inside the range every ok repeat of both runs measured (falling back to the mean curves' common range when the repeats share none); each repeat's curve is linearly interpolated there, and a repeat that did not measure a count is left out of that row.

## Repeat status

Each repeat is `ok`, `server_failed` or `invalid`. The status comes from the `orch.repeat.end` payload `{ repeat, outcome }`:

- `outcome.status` (`'ok' | 'invalid' | 'server_failed'`) and `outcome.statusReasons: string[]` when present;
- otherwise `outcome.aborted` set → `server_failed` (reason: the aborted text), else `ok`;
- `outcome: null` (the repeat threw) → `invalid`;
- a repeat that started (or has steps) but has no `orch.repeat.end` in a run that records repeat envelopes → `invalid` (never ended).

Older runs without repeat envelopes keep the previous rule: every repeat in `result.json` is ok; without `result.json`, a repeat whose search did not finish is `invalid`.

Only ok repeats enter the headline median, the mean curve and the fits. Server-failed repeats are results about the server: they are listed with their value and reason, counted in k/n ok and flagged, never dropped silently.

## Comparison decision rule

For the headline, every curve metric at each matched player count and every per-player slope, the comparison keeps the per-repeat values of the ok repeats of each run (curves and slopes are recomputed per repeat from that repeat's steps). B is `better` or `worse` than A only when every ok repeat of B beats every ok repeat of A in the metric's good direction (complete separation, `dominance` / `mannWhitneyU` in `math.ts`). Otherwise the verdict is `not separated`, which does not mean equal. With no real difference all orderings are equally likely, so complete separation in a given direction happens by chance with probability 1 / C(m + n, m) (`separationChance`): 1/20 for 3 vs 3, 1/252 for 5 vs 5. With fewer than 2 ok repeats on a side the verdict is `insufficient repeats`; the median delta and ranges are still shown. Values are shown as median [min, max].

## Comparability

`compareRuns(a, b, { force })` checks these meta.json fields: `configSha256`, `machine.fingerprint`, `bdsVersion`, the BDS build hash (`bdsBuildSha256`, `artifacts.bdsBuildSha256` or `artifacts.bds.sha256`), `analysisVersion`, `placement.profileSha256` and `botVersion`. A field present in both runs with different values is a mismatch: `compareRuns` throws `IncomparableRunsError` (with `mismatches`) unless `force: true`, in which case the page carries a prominent warning banner. A field missing from either run is "cannot verify": noted on the page, not a refusal, so older runs still compare.

## Analysis version

`ANALYSIS_VERSION` (currently 1) is stored in every `Analysis` and printed on both pages. Bump it whenever a change can move a number or a verdict computed from the same raw data (headline aggregation, repeat statuses, curve and fit inputs, the decision rule). Pure presentation changes do not bump it. Runs that record a different `analysisVersion` are not comparable.

## Caveats

- Core does not define `orch.step.start` / `orch.step.end` payloads. The report reads `repeat`, `index`, `players`, `phase`, `pass` and `loadgenSaturated` from them, all optional (see `StepMarkData`). Step status comes from `steps.json` when it has a matching (repeat, index).
- The util slope is fitted on passing steps when there are at least two, because util flattens near 1.0 past saturation. The extrapolation is therefore a linear projection of below-capacity behaviour.
- The scaling curves average steps at equal player counts. Bisection probes different counts per repeat, so the mean curve can be jagged near capacity.
- Steps invalidated by loadgen saturation are left out of the curves and fits, because the bot count is not the load the server saw. They are still listed, marked invalid, in the table and timeline.
- A repeat that never ended, or (older runs without `result.json`) whose search did not finish judged from its steps against `ramp`, is `invalid`, left out of the headline and listed in `headline.incompleteRepeats`. Unparseable optional files count as missing and appear as notes.
