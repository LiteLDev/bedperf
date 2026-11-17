# @bedperf/report

Reads a run directory (`runs/<runId>/`), analyses it and renders a self-contained HTML report or an A/B comparison. Depends on `@bedperf/core` only. Charts are hand-written inline SVG, with no chart library, scripts or external resources.

Example output: [`examples/report.html`](examples/report.html), [`examples/compare.html`](examples/compare.html), [`examples/remote.html`](examples/remote.html) (LeviLamina with bots on two remote agents) and [`examples/matrix.html`](examples/matrix.html) (implementation comparison of four server flavors). All come from synthetic fixture runs; regenerate them with `corepack pnpm --filter @bedperf/report examples` (`node src/examples.ts`).

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

// N >= 2 runs: pairwise verdict matrices and a headline ranking (may throw IncomparableRunsError)
const m = compareMatrix([a, b, c])
renderMatrixHtml(m)
await writeCompareMatrix(['runs/bds', 'runs/levilamina', 'runs/endstone'], 'out/matrix.html')
```

- `loadRun(dir)` requires `config.json` and `meta.json`. It tolerates a missing `result.json` (aborted run) and a missing `steps.json`, in which case it uses `orch.step.end` envelopes that carry a full `StepResult`. `samples.jsonl` is streamed line by line. Unknown envelope kinds are counted and skipped, and malformed lines are counted.
- `loadRun` also reads `orch.repeat.start` / `orch.repeat.end` envelopes into `repeatStarts` / `repeatEnds` (see Repeat status).
- `generateRun(dir, opts)` synthesizes a realistic run dir for tests and demos. It produces 3 repeats of ramp + bisect at ~1 Hz probe, sys and bot envelopes with noise, capacity ~40 by default, and options for an aborted run, no sysmon, loadgen saturation, junk lines, exact per-repeat capacities, per-repeat `orch.repeat.end` outcomes (status, reasons, aborted, never ended, null outcome) and extra meta.json fields. `extended: true` adds the newer measurements (see below) with options for a vcpu placement, a dirty harness, an interference spike that invalidates one step and a tick-CPU scale.
- `loadRun` also reads `sys.interference` and `bds.gametime` envelopes into `interference` / `gametime`, and `agent.telemetry` / `agent.link` envelopes from remote bot agents into `agentTelemetry` / `agentLink`.
- `generateRun` with `extended: true` also takes `server` (one of the six server presets: `meta.server` with artifacts, build hash, allocator, effective loader config and notes, plus `benchConfigSha256`; Wine presets and `os: 'linux'` run on a Linux host, where Endstone preloads mimalloc) and `topology` (remote bot agents: `meta.topology`, agent telemetry, per-agent `loadgen.agents` slices, link events; `remoteTopologyFixture()` gives two agents, one saturating in repeat 2 and one losing its connection after repeat 1).

## Newer measurements (all optional)

Every field below is read defensively; a run without them renders as before, with the panels, charts and columns left out.

- StepResult: `counterTps`, `counterTpsLow5`, `gametimeMaxGapMs`, `gametimeLatencyMs` (Summary), `tickCpuMsPerTick`, `tickThreadSource`, `interference` (`foreignMean`, `foreignPeak10s`, `serverSetForeignMean`), `placementVerified`, `settleSec`, `settleCapped`, `viewsIncomplete`, `inViewMedian`, `viewT90MsP50`, `chunksPerSec`, `uniqChunksPerBot`, `invalidReasons`. A step is invalid when `invalidReasons` is non-empty (older runs: `loadgenSaturated`); invalid steps stay out of curves and fits.
- meta.json: `configSha256`, `machine`, `harness` (`git`, `dirty`, ...), `artifacts` (`bdsZipSha256`, `probePackSha256`, `bedbooCommit`), `placement` (`profileSha256`, `kind`, `method`, `serverCpus`, `botCpus`, `priority`, `verified`, `checks`), `gates`. Read into `Analysis.provenance`.
- result.json: `repeats[]` (`index`, `status`, `statusReasons`, `maxPlayers`) gives repeat statuses when there is no `orch.repeat.end`; `invalidLimited` is flagged.
- samples.jsonl: tick-counter TPS between consecutive `bds.gametime` replies, foreign load from `sys.interference`, and tick CPU per tick from consecutive `mainThread.cpuMs` of the same thread divided by the TPS at that time.

## Analysis (`Analysis`)

| field | contents |
|---|---|
| `analysisVersion` | `ANALYSIS_VERSION` of the code that produced it |
| `headline` | median max players over the **ok** repeats with min/max/spread, `kOk` / `n`, `statusCounts`, every repeat with status, reasons and value (`repeats`), `capped`, `loadgenLimited`, `aborted`. Per-repeat values come from `orch.repeat.end`, `result.json` or the steps, in that order. |
| `steps` | per step: players, pass/invalid, invalid and fail reasons, TPS mean/min, tick p99, ticks over 50/100 ms, util mean, CPU, RSS, RTT p95, net rx/tx, bot failures, and the newer fields above when recorded |
| `curves`, `meanCurve` | players → mean of each metric (`tps`, `util`, `cpu`, `rss`, `rssPerPlayer`, `rttP95`, `netTx`, `tickP99`, `counterTps`, `tickCpuMsPerTick`, `foreignMean`, `inViewMedian`, `viewT90`, `chunksPerSec`), per repeat (every repeat) and across the ok repeats. Passing and failing steps are both included; invalid ones are not. |
| `derived` | least-squares slopes over the ok repeats' step means: memory per player (RSS), net tx/rx per player, util per player, the extrapolated players at util = 1.0, and tick CPU ms/tick per player (`tickCpuPerPlayer`, fitted on passing steps: a capacity cost that does not saturate and compares across machines) |
| `repeatDerived`, `okRepeats` | the same fits per ok repeat, used by the comparison |
| `server` | meta.json `server` (`ServerView`): label, flavor, mods, runtime, component versions, binary, artifacts, spec and build hashes, allocator, effective loader config, the loader keys that differ from upstream defaults (bedperf's neutral defaults and config overrides) and notes. Runs without it are vanilla BDS (`recorded: false`). |
| `topology` | meta.json `topology` plus agent envelopes (`TopologyView`): mode, bot target host, topology hash, each agent (machine, fingerprint, cpus, weight, max bots, link RTT and clock offset, placement), per-agent telemetry series (busy, bot and foreign cores) with merged saturated intervals, link events (lost, reconnected) and the per-step per-agent load from `bot.stats` `loadgen.agents` in the hold window. Runs without it are local. |
| `provenance`, `threats`, `publishable` | provenance read from meta.json; threats to validity (`bad` / `warn` / `info`); `publishable` is false when any threat is `bad`: fewer than 3 ok repeats, a dirty harness, an aborted run or an unverified placement |
| `timeline` | TPS (bucket minimum), tick-counter TPS, util, players, foreign load and tick CPU per tick over time, downsampled to ≤ 600 points per repeat, with step bands from `orch.step.*` envelopes |

## Report sections

1. Headline card: max players @ 20 TPS on the server label (median of ok repeats; the page title and heading name the server too), k/n ok, range, per-repeat values with statuses and reasons, flags (including "unofficial" for a dirty harness, vcpu and "not publishable"), and per-player cost tiles (with tick CPU per player)
2. Threats to validity: colocated loadgen and loopback network (local bots only), remote bots (the network is part of the measurement, with each agent's link RTT baseline), an agent saturated or lost during the run, an agent's placement not verified, a replaced allocator (Endstone's mimalloc preload: a confound against other flavors), Wine (measures Wine + LeviLamina, not native), loader config keys that differ from upstream defaults (bedperf's neutral overrides listed; config overrides raise it to a warning), vcpu, dirty harness, unverified placement, invalid steps and their reasons, settle capped, views incomplete, fewer than 3 ok repeats ("not publishable"), incomplete provenance
3. Server: label, flavor, mods, runtime, component versions, binary, allocator, build and spec hashes, artifacts (name, version, short sha256), loader config overrides, the effective loader config (collapsed) and notes. Older runs say vanilla BDS is assumed.
4. Topology: local, or remote with the bot target host, topology hash and a table of agents (machine, fingerprint, cpus, weight, max bots, link RTT median [min, max] and clock offset, placement, saturated / lost state); per agent a time series of machine busy, bot-worker and foreign cores with saturated intervals and connection-lost markers shaded; the link events; and per step the bots and peak bot-worker cores of each agent with saturation.
5. Provenance and environment: config hash, machine fingerprint, harness version + git (dirty → "unofficial"), BDS zip hash, probe pack hash, bedboo commit, CPU placement plan (kind, method, CPU sets, priority, verified, checks) and gate thresholds
6. Run metadata: versions, host, scenario, ramp and criteria, key server properties (all of them under a disclosure)
7. Scaling charts against players: TPS (with a 20 TPS line), main-thread util (with a util 1.0 line and the linear fit), RSS per player above baseline, RTT p95; when recorded, tick CPU per tick (with its fit), tick-counter TPS (with probe TPS), view load t90, chunks per second, in-view columns and foreign load
8. Timeline per repeat: TPS (probe and tick counter), util and players as stacked panels sharing the time axis, plus tick CPU per tick and foreign load when recorded, with step bands shaded pass/fail/invalid
9. Steps table, with columns for the newer measurements when recorded, per-step flags (settle capped, views incomplete, placement mismatch, tick thread found as busiest) and invalid reasons
10. Methodology footnote and data-quality notes

Light and dark themes follow `prefers-color-scheme`. The layout works at 375 px: the long timelines and the table scroll horizontally inside their card, not the page.

The comparison shows both headlines and their delta, a comparability table, per-player costs, overlaid TPS and util curves (and tick CPU per tick / tick-counter TPS when recorded), a metric table at matched player counts and the decision rule. Matched counts are round numbers inside the range every ok repeat of both runs measured (falling back to the mean curves' common range when the repeats share none); each repeat's curve is linearly interpolated there, and a repeat that did not measure a count is left out of that row.

With three or more runs (`compareMatrix`, `bedperf compare a b c ...`) the page shows a card per run, a headline ranking (median [min, max], k/n ok, and which runs each one is completely separated above or below), the comparability fields per run, and an N×N matrix per metric (headline, per-player slopes, and curve metrics at one player count every run measured, at or below the lowest headline when possible). Cell (row, column) is the complete-separation verdict of the row run against the column run as the baseline, with the change of the medians, m v n and the chance 1 / C(m + n, m). When the runs differ only by server, they are labelled by server label. Two runs keep the A/B page.

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

`compareRuns(a, b, { force })` checks these meta.json fields: the benchmark config hash (`benchConfigSha256`, the config without its `server` section; for older runs without `server`, `configSha256`, which is the same hash; else both runs' `configSha256`), the server (label and `server.specSha256`; runs without `server` are vanilla BDS), the server build hash (`server.buildSha256`), the loader config hash (sha256 of `server.loaderConfig`, `none` without one: the spec hash leaves loader settings out), the topology (`topology.sha256`; runs without a topology or with a local one are `local`, so local vs remote is a mismatch), `machine.fingerprint`, `bdsVersion`, the BDS build hash (`bdsBuildSha256`, `artifacts.bdsBuildSha256` or `artifacts.bds.sha256`), `analysisVersion`, `placement.profileSha256` and `botVersion`. A field present in both runs with different values is a mismatch: `compareRuns` throws `IncomparableRunsError` (with `mismatches`) unless `force: true`, in which case the page carries a prominent warning banner. A field missing from either run is "cannot verify": noted on the page, not a refusal, so older runs still compare.

**Implementation comparisons.** When the server differs (label or spec hash: flavor, mods, runtime or component versions), the comparison is an implementation comparison: allowed and labelled as such on the page (`Comparison.implementation`), with the server, server build hash, loader config hash and BDS build hash rows shown as `differs`. It still requires the same benchmark config hash, BDS version, machine fingerprint, topology and placement profile; a mismatch refuses (unless `force`), and so does one of these recorded by only one run. When the server is the same, a different server build hash (same declared versions, different bytes) or a different effective loader config is a mismatch. A forced comparison is never labelled an implementation comparison.

`Comparison.warnings` lists differences that weaken but do not refuse a comparison: a vcpu placement (or physical vs vcpu), a dirty harness, different harness commits, probe pack or bedboo commit, an unverified placement, fewer than 3 ok repeats, different allocators (e.g. Endstone's mimalloc preload against another flavor), a different runtime (Wine against native), different loader config overrides, different agent machines and an agent that was saturated or lost. They are shown as `warning` rows in the comparability table and in a warning box.

The metric table includes tick-counter TPS (higher is better), tick CPU per tick (lower) and view load t90 (lower) at matched player counts, and the per-player costs include tick CPU per player (lower).

On the command line, `bedperf compare A B` exits 2 and lists the mismatches when the runs are not comparable; `--force` writes the page anyway. `bedperf compare A B C ...` writes the matrix page (every pair must be comparable) and prints the headline ranking.

## Analysis version

`ANALYSIS_VERSION` (currently 3; 3 added the server and topology views, their threats and the implementation-comparison rules) is stored in every `Analysis` and printed on both pages. Bump it whenever a change can move a number or a verdict computed from the same raw data (headline aggregation, repeat statuses, curve and fit inputs, the decision rule). Pure presentation changes do not bump it. Runs that record a different `analysisVersion` are not comparable.

## Caveats

- Core does not define `orch.step.start` / `orch.step.end` payloads. The report reads `repeat`, `index`, `players`, `phase`, `pass` and `loadgenSaturated` from them, all optional (see `StepMarkData`). Step status comes from `steps.json` when it has a matching (repeat, index).
- The util slope is fitted on passing steps when there are at least two, because util flattens near 1.0 past saturation. The extrapolation is therefore a linear projection of below-capacity behaviour.
- The scaling curves average steps at equal player counts. Bisection probes different counts per repeat, so the mean curve can be jagged near capacity.
- Steps invalidated by loadgen saturation are left out of the curves and fits, because the bot count is not the load the server saw. They are still listed, marked invalid, in the table and timeline.
- A repeat that never ended, or (older runs without `result.json`) whose search did not finish judged from its steps against `ramp`, is `invalid`, left out of the headline and listed in `headline.incompleteRepeats`. Unparseable optional files count as missing and appear as notes.
