# @bedperf/orchestrator

Benchmark engine: config validation and presets, per-step pass criteria and validity gates, the ramp → bisect search, convergence settle, the run loop, A/B sessions, the run recorder and recomputation of a run from its raw samples. It depends on `@bedperf/core` and the pure window functions of `@bedperf/sysmon`. The server, load generator, OS / interference / tick-counter samplers, placement and the idle gate come in through dependency injection, so the engine runs the same against real BDS or the bundled simulation.

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
  // optional: now, sleep, logger, loadGenOptions (overrides for LoadGenerator.start),
  // placement { plan, method, verifyServer(pid), applyWorker?(pid) }, idleCheck(opts),
  // createMachineSampler({ serverCpus }), createGametimeSampler(server, intervalMs), onHold(open)
}, { /* optional: runId, meta, scaleTimeoutMs, readyTimeoutMs, signal */ })
console.log(formatStepsTable(steps))
```

| export | what it does |
|---|---|
| `loadConfig(path \| URL \| object)` / `parseConfig(raw)` | Validates a `BenchmarkConfig` and fills defaults: `DEFAULT_CRITERIA`; ramp `start 10, step 10, max 500, settleSec 20, holdSec 60, resolution 2`; `repeats 3`; `warmupSec 60`; `bdsVersion 'latest'`; `loadgen {botsPerWorker 50, joinIntervalMs 200}`; `seed 1`. Unknown keys are errors, which catches typos. A `ConfigError` lists every problem with its path. The optional `server` section (`{ flavor, mods?, runtime?, versions?, loaderConfig? }`, core `ServerSpec`) is checked and resolved (`resolveServerSpec`: pinned versions filled, mods sorted): flavor `bds`/`levilamina`/`endstone`; mods (`levioptimize`), runtime `wine` and `loaderConfig` are LeviLamina-only; a version must belong to the flavor (or a listed mod). Absent means vanilla BDS. |
| `presets`, `preset(name)` | `quick` (1 repeat, 15 s holds, max 50, settle 5–60 s over a 10 s window, tick counter every 1 s, 5 s cooldown, for smoke runs), `standard` (3 repeats, 60 s holds, max 300, settle 20–300 s, 60 s cooldown) and `thorough` (5 repeats, 120 s holds, max 500, resolution 1, settle 60–900 s, 120 s cooldown). The JSON files are in `presets/`. All three set view-distance 10, tick-distance 4, max-players 1000 and operator permission level. |
| `evaluateStep(window, criteria)` | A pure function that turns probe, sys and bot samples into a `StepResult` minus its identity fields. See below. |
| `stepOutcome(step)` | Returns `'pass' \| 'fail' \| 'invalid'`. |
| `planNext({ ramp, history })` | The pure search state machine. Returns `{ done: false, players, phase, retry }` or `{ done: true, maxPlayers, capped, loadgenLimited, firstFail? }`. |
| `runBenchmark(config, deps, opts)` | The engine. Throws `EnvGateError` (before creating the run dir) when the idle gate fails before the first repeat. |
| `BenchmarkRun` | One run driven slot by slot (`open`, `runSlot`, `finish`, `fail`); what `runBenchmark` and `runSession` use. |
| `runSession(entries, { sessionId, dir, order })`, `parseOrder`, `sessionSchedule` | A/B sessions (below). |
| `settle`, `settleCheck`, `viewsIncomplete` | The convergence settle rule. |
| `stepFromEnvelopes`, `recomputeSteps`, `recomputeRun(runDir)`, `canonicalJson`, `verifyManifest` | Step results as a pure function of the recorded envelopes (below). |
| `exitCodeOf(result)`, `ExitCodes` | `0` ok, `4` every repeat `server_failed`, `5` no ok repeat. |
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
| tick-counter TPS (`counterTps`) < `minCounterTps` (default `minAvgTps`) | `counter TPS x < y` |

### Validity gates (`invalidReasons`)

A step whose `invalidReasons` is non-empty is **invalid**: it says nothing about the server and is retried (see Search). `pass` is then false.

| gate | reason |
|---|---|
| loadgen saturated | `loadgen saturated` |
| server placement not verified at hold start or end | `placement_mismatch: <violations>` |
| interference over the hold (`summarizeInterference` / `checkInterference`) above `gates.foreignMean` (0.25 cores), `gates.foreignPeak10s` (1.5), `gates.serverSetForeignMean` (0.25), or no samples | `interference: <reasons>` |
| fewer than 2 tick-counter replies in the hold | `gametime_missing: ...` |
| longest stretch without a reply > `gates.gametimeMaxGapSec` (60) | `gametime_gap: ...` |
| reply latency p99 > `gates.gametimeLatencyP99Sec` (30) | `gametime_latency: ...` |
| counter went backwards | `gametime_non_monotonic` |
| tick-counter rate and probe tick counter (interpolated at the first and last reply) differ by more than `criteria.maxProbeCounterTpsDivergence` (0.5 TPS) over the same stretch | `tps_sources_disagree: probe x vs counter y TPS` |

Measured per step besides the pass criteria: `counterTps` (first to last reply in the hold, which must span at least `1 - 2·interval/hold` of it, clamped to 50–90%), `counterTpsLow5` (lowest ≥ 4.5 s stretch), `gametimeMaxGapMs`, `gametimeLatencyMs`, `tickCpuMsPerTick` (tick-thread CPU between the first and last tick observation, from `mainThread.cpuMs` and the tick counter, falling back to the probe tick counter; a lower bound on tick cost, not MSPT) with `tickThreadSource`, `interference`, `placementVerified`, `settleSec` / `settleCapped` / `viewsIncomplete`, and the view-load metrics `inViewMedian`, `viewT90MsP50` (last fleet stats of the hold), `chunksPerSec` (mean) and `uniqChunksPerBot`.

The failure baseline is the last fleet stats seen **before** the step's `scaleTo`. Failures during scale-up and settle therefore count against the step.

The probe reports a quantile summary per window, not raw intervals, so the step's `tickIntervalMs` is **approximate**. Each window contributes `ticks` points from a piecewise-linear inverse CDF through its p50/p95/p99/max, and the result is summarised. `mean`, `max` and `n` are exact. `rttMs` pools the bots' per-interval summaries in the same way.

## Search (`planNext`)

- **Ramp**: try `start`, then last pass + `step`, clamped to `max`, until the first fail. If `max` passes, the search stops with `capped: true`.
- **Bisect**: `lo` is the highest pass below the lowest fail and `hi` is the lowest fail. The next probe is `floor((lo + hi) / 2)`, until `hi - lo <= resolution`. `resolution: 0` disables bisection.
- **Fail at the first step**: the search bisects between 0 and `start`. The result can be anything in `[0, start - 1]`, and **0 means even the smallest probed load failed**.
- **Invalid step** (any `invalidReasons`): the search retries once at the same player count. A second consecutive invalid result stops the search with `invalidLimited: true` (plus `loadgenLimited: true` when both were loadgen saturation) and the highest pass so far, which is then only a lower bound.
- Result: the highest passing player count below the lowest fail.

## Engine flow

Before the first repeat, and before any run dir exists, the idle gate (`deps.idleCheck`, `gates.idleSec` s on the plan's server CPUs, limits `gates.idleForeignMean` / `idleForeignPeak10s` / `idleServerSetForeignMean`) must pass, else `EnvGateError`. Every later repeat is preceded by `cooldownSec` (default 60) and the idle gate again; a busy machine then makes that repeat `invalid` without starting a server.

Per repeat:

1. `createServer(r)`, subscribe to `probe` and `exit`, `start()`. From here `server.pid` is the game process (for a launcher-started flavor, not the launcher); `bds.event ready` records it, plus `launcherPid` when different. Start the interference sampler (`createMachineSampler`, groups: server = the game pid, the optional `launcherPid` and `auxPids()` (e.g. wineserver; refreshed before every hold), bots = worker pids, harness = this process) for the whole repeat. `verifyServer(pid, server)` gets the server too, so it can check the launcher and helpers. Verify the server placement (a violation makes the repeat `invalid`). `send` each `scenarioSetup()` command.
2. `createSampler(pid).start()`, the tick-counter sampler (`createGametimeSampler`, every `sampling.gametimeIntervalSec`) and `createLoadGen(r)` → `onStats`, `onWorkerSpawn` (worker placement), `start(opts)`. The options come from the config: `host 127.0.0.1`, the instance port, `version = botVersion ?? bdsVersion`, the scenario, `usernamePrefix bp<r>_`, `seed + r` and 1 s stats. `deps.loadGenOptions` overrides any of them. Warm up for `warmupSec`; the tick counter must answer and advance during it (else `invalid`, `gametime_probe_dead`).
3. Loop on `planNext`: `orch.step.start` → `scaleTo(n)` → **settle** → verify placement → open the hold (`onHold(true)`) → `scriptevent bedperf:mark step-<i>-start` → hold → close the hold → `scriptevent bedperf:mark step-<i>-end` → verify placement → `orch.step.facts` → `stepFromEnvelopes` → `orch.step.end`, and rewrite `steps.json`.
4. Always stop the loadgen, samplers and server, in `finally`, and write `orch.repeat.end` with `outcome.status` / `statusReasons`.

**R7**: while a hold is open the engine sends no console command but probe marks (`scriptevent bedperf:*`); anything else throws (the simulation enforces the same through `onHold`). The tick-counter queries go through the bds-process priority lane and are part of the measurement.

**Settle** (`ramp.settle`): `mode: 'converge'` (default) waits at least `minSec`, then every `evalSec` checks the fleet's new unique chunk columns per bot per second over the last `windowSec` (from `BotFleetStats.uniqChunks`, on stats at most `maxDataAgeSec` old) and stops once it is ≤ `ratePerBot` (0.1); at `maxSec` it stops with `settleCapped`. `viewsIncomplete` is set when fewer than 95% of the bots have at least half the median in-view count. `mode: 'fixed'` sleeps `ramp.settleSec`. Configs without `ramp.settle` get the defaults (20 / 300 / 60 / 0.1 / 5 / 5).

**Repeat status.** Every repeat ends `ok`, `server_failed` or `invalid` (`RepeatOutcome.status`, `statusReasons`):

- `server_failed`: the server crashed, did not start, or not all bots could join at the first measured step. It is a result about the server: never rerun.
- `invalid`: idle gate failed, placement violated at ready, tick counter dead, or the search stopped on two invalid steps for an environment reason (or without any pass). The slot is rerun once on a fresh instance with a fresh index (so log names, usernames and seeds do not collide).
- `ok`: otherwise, including a search stopped by loadgen saturation after passes (`loadgenLimited`, a lower bound).

`RunResult.maxPlayers` lists every repeat by index; `maxPlayersMedian` is the median over the `ok` repeats only (mean of the middle two for an even count, 0 when none). `repeats: [{ index, status, statusReasons, maxPlayers, rerunOf? }]`, `kOk`, `n`, `invalidLimited` describe them. `capped` is set if an ok repeat hit `ramp.max`. `loadgenLimited` is set if **any step** was invalidated by saturation. Any other error stops the whole run: the run dir is still finalised (`orch.run.end` with `ok: false`, `meta.finishedAt`) and the error is rethrown.

## Sessions

`runSession(entries, { sessionId, dir, order })` measures several configs in one session, each in its own run dir under `dir`, and writes `dir/session.json` (configs, run ids, the schedule as it ran, exit code). `order` is `sequential` (all repeats of one config, then the next), `rotate` (block k runs slot k of every config, starting at config k mod n) or `seeded:N` (each block shuffled with seed N). Cooldown and the idle gate run between any two consecutive repeats.

## Recompute

Every step result is a pure function of the envelopes written before its `orch.step.facts` envelope (`stepFromEnvelopes`): probe samples and marks, `sys.sample`, `bot.stats`, `bds.gametime`, `sys.interference`, plus the facts (hold bounds, settle outcome, placement verification, crash). The engine computes steps through exactly that function on a parsed copy of what it wrote, so `recomputeRun(runDir)` re-derives `steps.json` byte for byte (`canonicalJson`: sorted keys, numbers rounded to 4 decimals, LF), and checks the `meta.files` manifest. Runs that predate step facts are recomputed from approximate facts (`legacySteps`).

## Run directory

`<runsDir>/<runId>/` with `runId = <ISO timestamp with - for : and .>_<config name>`. If that directory already exists, `-2`, `-3`, ... is appended.

| file | content |
|---|---|
| `config.json` | the resolved `BenchmarkConfig`, scrubbed (see below) |
| `meta.json` | `RunMeta` with host info from `node:os` and provenance (below). It is written at the start and rewritten with `finishedAt` and the `files` manifest at the end |
| `samples.jsonl` | streamed core `Envelope`s: `probe.sample/mark/pong`, `sys.sample`, `sys.interference`, `bot.stats`, `bds.event`, `bds.gametime`, `orch.run.start/end`, `orch.repeat.start/end`, `orch.step.start/facts/end` (the latter carries the `StepResult`), `orch.settle`, `orch.placement.verify/apply`, `orch.idle` and `orch.command` |
| `steps.json` | `StepResult[]` for all repeats in `canonicalJson` form, rewritten after every step |
| `result.json` | `RunResult` |

`t` comes from the injected clock. Empty `Summary` fields (NaN) serialise as `null`.

### Provenance

`meta.json` also records (core `provenance.ts`):

- `configSha256`: `sha256Json` (sorted-key compact JSON) of config.json's content, so `sha256Json(JSON.parse(config.json))` must match. `benchConfigSha256`: the same without the `server` section (equal for one benchmark on different servers).
- `server`: `deps.serverBuild` (core `ServerBuildInfo`), with its artifacts also under `artifacts.server`.
- `machine`: `fingerprint` (16 hex digits over OS family, CPU model, logical and physical cores and whole GiB of RAM; no user or host name), plus `os`, `cpuModel`, `logical`, `physical` (best effort: PowerShell `Win32_Processor` on Windows, `/proc/cpuinfo` on Linux) and `ramGiB`.
- `harness`: bedperf `version`, `git` commit of the checkout, `dirty` (tracked files under `packages/` or `scripts/` changed) and `node`.
- `artifacts`: whatever the caller passes in `meta` (the CLI sets the BDS zip sha256, the probe pack tree hash and the bedboo commit).
- `files`: `{ sha256, bytes }` of every file in the run dir at `close()`, except `meta.json` and `report.html`.
- `placement`: `{ profileSha256, label?, kind, mode?, method, serverCpus, botCpus, harnessCpus, priority, verified, verifications, checks }`; `verified` is false as soon as one server verification failed.
- `gates`: the resolved gates and validity thresholds (`gates.*`, `minCounterTps`, `maxProbeCounterTpsDivergence`, `gametimeIntervalSec`) and which checks ran.
- `network`: `{ loopback }`, true when the bots connect to a loopback address.

The machine and harness blocks are computed once per process; `RunRecorder.create` takes `provenance` and `scrubber` for tests.

meta.json and config.json go through a `Scrubber`: the run dir, cache, repo, temp, home and (Windows) `%LOCALAPPDATA%` become `<run>`, `<cache>`, `<repo>`, `<tmp>`, `<home>`, `<localappdata>` (most specific wins, forward slashes after); any other private absolute path becomes `<abs>/<file name>`; the user and host names become `<user>` and `<host>`. `host.hostname` is no longer written. Raw logs (`samples.jsonl`, `bds*.log`) are **not** scrubbed: share them with care.

## Simulation

`createSimDeps({ capacity, noise?, tpsDropPerPlayer?, saturateAbove?, maxJoinable?, crashAbove?, seed?, foreignLoad?, idleForeign?, gametimeLatencyMs?, gametimeRateOffset?, gametimeDead?, viewChunks?, viewTauSec?, viewDriftPerBot?, placementFailAt? }, runsDir, { features?, server? })` returns engine deps on a virtual clock, where `sleep` advances time instantly, with simulated placement, idle gate, interference and tick-counter samplers (each can be switched off through `features`). `server` (a `ServerSpec`) makes the run record `meta.server` as `simServerBuild(spec)` (pinned BDS of a modded flavor, synthetic artifact hashes), so report and compare flows can be exercised without real servers. Knobs may be functions of `{ t, holds, holding, players }`. The model:

- TPS is 20 minus uniform noise while players ≤ C, then drops by 0.5 per extra player.
- Tick intervals derive from TPS.
- Main-thread util is `players / C × 0.9`.
- RSS and network scale with players.
- The tick counter advances with the probe ticks (plus `gametimeRateOffset` per second); `mainThread.cpuMs` accumulates util × 1 s.
- Each bot loads `viewChunks` columns as `U (1 - e^(-t/τ))` after joining, plus `viewDriftPerBot` per second.

A full 3-repeat search runs in about 100 ms.

## Caveats

- `version` passed to the loadgen defaults to `config.bdsVersion`, which may be `'latest'`. The caller should resolve it to a concrete build, or override it through `deps.loadGenOptions.version`.
- The preset scenario modules (`@bedperf/scenarios/idle`, `@bedperf/scenarios/walk`) assume per-scenario subpath exports in `@bedperf/scenarios`. Adjust them if that package exposes them differently.
- Server properties in presets are only the bench basics. `REQUIRED_BOT_PROPERTIES` from core is expected to be merged in by whoever creates the instance.
