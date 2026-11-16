# @bedperf/orchestrator

Benchmark engine: config validation and presets, per-step pass criteria, the ramp → bisect search, the run loop and the run recorder. It depends only on `@bedperf/core`. The server, load generator and OS sampler come in through dependency injection, so the engine runs the same against real BDS or the bundled simulation.

## API

```ts
import { loadConfig, presets, runBenchmark, formatStepsTable } from '@bedperf/orchestrator'

const config = await loadConfig('bench.json')    // or loadConfig({...}), or presets.standard
const { result, steps, dir } = await runBenchmark(config, {
  createServer: async repeat => /* fresh, unstarted BdsServer */,
  createLoadGen: repeat => /* LoadGenerator */,
  createSampler: pid => /* Sampler<SysSample> */,
  scenarioSetup: () => scenario.serverSetup?.(config.scenario.params ?? {}) ?? [],
  runsDir: 'runs',                                // the run goes to runs/<runId>/
  // optional: now, sleep, logger, loadGenOptions (overrides for LoadGenerator.start)
}, { /* optional: runId, meta, scaleTimeoutMs, readyTimeoutMs, signal */ })
console.log(formatStepsTable(steps))
```

| export | what it does |
|---|---|
| `loadConfig(path \| URL \| object)` / `parseConfig(raw)` | Validates a `BenchmarkConfig` and fills defaults: `DEFAULT_CRITERIA`; ramp `start 10, step 10, max 500, settleSec 20, holdSec 60, resolution 2`; `repeats 3`; `warmupSec 60`; `bdsVersion 'latest'`; `loadgen {botsPerWorker 50, joinIntervalMs 200}`; `seed 1`. Unknown keys are errors, which catches typos. A `ConfigError` lists every problem with its path. |
| `presets`, `preset(name)` | `quick` (1 repeat, 15 s holds, max 50, for smoke runs), `standard` (3 repeats, 60 s holds, max 300) and `thorough` (5 repeats, 120 s holds, max 500, resolution 1). The JSON files are in `presets/`. All three set view-distance 10, tick-distance 4, max-players 1000 and operator permission level. |
| `evaluateStep(window, criteria)` | A pure function that turns probe, sys and bot samples into a `StepResult` minus its identity fields. See below. |
| `stepOutcome(step)` | Returns `'pass' \| 'fail' \| 'invalid'`. |
| `planNext({ ramp, history })` | The pure search state machine. Returns `{ done: false, players, phase, retry }` or `{ done: true, maxPlayers, capped, loadgenLimited, firstFail? }`. |
| `runBenchmark(config, deps, opts)` | The engine. |
| `RunRecorder` | Writes `runs/<runId>/`. `runBenchmark` uses it; it is exported for tools that replay runs. |
| `SimClock`, `SimServer`, `SimLoadGen`, `SimSampler`, `createSimDeps(model, runsDir)` | A deterministic simulation on a virtual clock. Import it from the `@bedperf/orchestrator/sim` subpath. |
| `formatStepsTable(steps)` | A plain-text steps table. |

## Pass criteria (`evaluateStep`)

| check | fail reason |
|---|---|
| no probe samples | `no probe data in window` |
| mean of window TPS < `minAvgTps` | `avg TPS x < y` |
| sort the windows' TPS, drop the worst `floor(n × worstWindowDiscardPct / 100)` (never all of them), then min < `minWorstWindowTps` | `worst-window TPS ...` |
| pooled tick-interval p99 > `maxTickIntervalP99Ms` | `tick interval p99 ...` |
| `maxMainThreadUtil` set and mean `mainThread.util` above it, or no main-thread data | `main-thread util ...` / `no main-thread utilisation data in window` |
| Δ(joinFailures + unexpectedDisconnects) since the baseline > `maxBotFailures` | `bot failures n > m` |
| last fleet stats have `spawned < players` | `only x/y bots spawned` |
| no bot stats | `no bot stats in window` |
| any fleet stats have `loadgen.saturated` | `loadgen saturated`, always first. `loadgenSaturated = true`, and the step is **invalid** rather than failed |

The failure baseline is the last fleet stats seen **before** the step's `scaleTo`. Failures during scale-up and settle therefore count against the step.

The probe reports a quantile summary per window, not raw intervals, so the step's `tickIntervalMs` is **approximate**. Each window contributes `ticks` points from a piecewise-linear inverse CDF through its p50/p95/p99/max, and the result is summarised. `mean`, `max` and `n` are exact. `rttMs` pools the bots' per-interval summaries in the same way.

## Search (`planNext`)

- **Ramp**: try `start`, then last pass + `step`, clamped to `max`, until the first fail. If `max` passes, the search stops with `capped: true`.
- **Bisect**: `lo` is the highest pass below the lowest fail and `hi` is the lowest fail. The next probe is `floor((lo + hi) / 2)`, until `hi - lo <= resolution`. `resolution: 0` disables bisection.
- **Fail at the first step**: the search bisects between 0 and `start`. The result can be anything in `[0, start - 1]`, and **0 means even the smallest probed load failed**.
- **Invalid step** (loadgen saturated): the search retries once at the same player count. A second consecutive invalid result stops the search with `loadgenLimited: true` and the highest pass so far, which is then only a lower bound.
- Result: the highest passing player count below the lowest fail.

## Engine flow (per repeat)

1. `createServer(r)`, subscribe to `probe` and `exit`, `start()`, then `send` each `scenarioSetup()` command.
2. `createSampler(pid).start()` and `createLoadGen(r)` → `onStats`, `start(opts)`. The options come from the config: `host 127.0.0.1`, the instance port, `version = botVersion ?? bdsVersion`, the scenario, `usernamePrefix bp<r>_`, `seed + r` and 1 s stats. `deps.loadGenOptions` overrides any of them. Then warm up for `warmupSec`.
3. Loop on `planNext`: `orch.step.start` → `scaleTo(n)` → settle → `scriptevent bedperf:mark step-<i>-start` → hold, collecting the window → `scriptevent bedperf:mark step-<i>-end` → `evaluateStep` → `orch.step.end`, and rewrite `steps.json`. Probe windows that began before the server echoed the start mark are dropped. If the mark is never echoed, every sample received during the hold counts.
4. Always stop the loadgen, sampler and server, in `finally`.

OS samples and fleet stats are trimmed the same way: intervals that began before the hold are dropped, unless that would leave the window empty.

An unexpected server exit fails the current step, or is noticed before the next step starts if it happens during warmup. Either way it ends that repeat (`RepeatOutcome.aborted`) with the highest pass so far. The remaining repeats still run. Any other error stops the whole run: the run dir is still finalised (`orch.run.end` with `ok: false`, `meta.finishedAt`) and the error is rethrown.

`RunResult.maxPlayersMedian` is the median of the per-repeat maxima. With an even repeat count it is the mean of the middle two. `capped` is set if any repeat hit `ramp.max`. `loadgenLimited` follows the core contract: it is set if **any step** was invalidated by saturation, even when the retry passed. `RepeatOutcome.loadgenLimited` tells you whether a repeat's search actually stopped because of saturation.

## Run directory

`<runsDir>/<runId>/` with `runId = <ISO timestamp with - for : and .>_<config name>`. If that directory already exists, `-2`, `-3`, ... is appended.

| file | content |
|---|---|
| `config.json` | the resolved `BenchmarkConfig` |
| `meta.json` | `RunMeta` with host info from `node:os`. It is written at the start and rewritten with `finishedAt` at the end |
| `samples.jsonl` | streamed core `Envelope`s: `probe.sample/mark/pong`, `sys.sample`, `bot.stats`, `bds.event`, `orch.run.start/end`, `orch.repeat.start/end`, `orch.step.start/end` (the latter carries the `StepResult`) and `orch.command` |
| `steps.json` | `StepResult[]` for all repeats, rewritten after every step |
| `result.json` | `RunResult` |

`t` comes from the injected clock. Empty `Summary` fields (NaN) serialise as `null`.

## Simulation

`createSimDeps({ capacity, noise?, tpsDropPerPlayer?, saturateAbove?, maxJoinable?, crashAbove?, seed? }, runsDir)` returns engine deps on a virtual clock, where `sleep` advances time instantly. The model:

- TPS is 20 minus uniform noise while players ≤ C, then drops by 0.5 per extra player.
- Tick intervals derive from TPS.
- Main-thread util is `players / C × 0.9`.
- RSS and network scale with players.

A full 3-repeat search runs in about 100 ms.

## Caveats

- `version` passed to the loadgen defaults to `config.bdsVersion`, which may be `'latest'`. The caller should resolve it to a concrete build, or override it through `deps.loadGenOptions.version`.
- The preset scenario modules (`@bedperf/scenarios/idle`, `@bedperf/scenarios/walk`) assume per-scenario subpath exports in `@bedperf/scenarios`. Adjust them if that package exposes them differently.
- Server properties in presets are only the bench basics. `REQUIRED_BOT_PROPERTIES` from core is expected to be merged in by whoever creates the instance.
