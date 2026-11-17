# Methodology

This document defines what bedperf measures, how a run proceeds, when a number is trusted, and how two runs are compared. The server is vanilla BDS or one of the modded flavors built on it ([server-flavors.md](server-flavors.md)). The bots run on the server machine or on remote agents ([distributed.md](distributed.md)). The rules (R1–R14) are numbered so that reports, issues and code comments can cite them. Several of the rigor mechanisms (interference sampling, placement verification, a tick-counter TPS source, repeat statuses, the complete-separation decision rule) are adapted from [EndstoneMC/bedrock-bench](https://github.com/EndstoneMC/bedrock-bench); see [comparison-bedrock-bench.md](comparison-bedrock-bench.md).

## Rules

| rule | statement | enforced by |
|---|---|---|
| **R1** | One workload config per session and per comparison. Nothing in it changes between the runs being compared. | `configSha256` and `benchConfigSha256` (the config without `server`) in `meta.json`; `bedperf compare` refuses a `benchConfigSha256` mismatch, and a different server only as an implementation comparison (R13) |
| **R2** | One bot source with the same options for every run being compared. | the bedboo commit and `botVersion` in `meta.json`; compare refuses a `botVersion` mismatch |
| **R3** | The same CPU placement and priority for every run being compared: server, bot and harness CPU sets come from one placement profile. | `placement.profileSha256`; placement is verified at ready and at the start and end of every hold (see Gates) |
| **R4** | One measured run per machine at a time, with continuous interference sampling. | the machine lock, the idle gate before each repeat, the per-hold interference gate |
| **R5** | A fresh instance and a fresh world for every repeat. Nothing is edited in place. | the CLI creates a new instance from the pristine BDS build per repeat |
| **R6** | Every value the harness sets or changes is recorded. | the resolved `config.json` (server properties, world, scenario parameters, criteria), console commands as `orch.command` envelopes, the placement plan and provenance in `meta.json` |
| **R7** | No interventions inside measured windows: no console commands other than the probes. | the engine sends scenario setup before warmup and only probe commands (`scriptevent bedperf:*`, `time query gametime`) inside a hold |
| **R8** | TPS comes from per-tick counters only: the BDS tick counter (`time query gametime`) and the in-tick Script API probe, used as two independent sources that must agree. World time and day time are never used. | counter TPS gates, and the `tps_sources_disagree` gate |
| **R9** | Failures are results. A server crash or a server that cannot take the load is recorded and counted, never dropped or silently rerun. | repeat status `server_failed`, which is never rerun |
| **R10** | Every number in a report is recomputable from the run's raw files by the same code. | `bedperf analyze` rebuilds the analysis byte for byte from `samples.jsonl` and the run files; `analysisVersion` is recorded and compared |
| **R11** | Capacity is searched (ramp, then bisect), not assumed from one fixed load. A saturated load generator invalidates a step; it never fails it. | `planNext`; `loadgen.saturated` makes a step invalid and the run `loadgenLimited` |
| **R12** | A comparison claims a difference only on complete separation across repeats. | the decision rule below; otherwise the verdict is `not separated` |
| **R13** | The server implementation is part of what is measured, never a hidden variable. An implementation comparison changes only the server: the same benchmark, BDS build, machine, bot topology and placement profile. Everything that comes with a server (loader, mods, runtime, allocator, loader config) is pinned, recorded and disclosed. | `meta.server` (spec, pinned versions, artifact hashes, `buildSha256`, allocator, effective loader config, notes); `benchConfigSha256`; `compare` refuses a different benchmark, BDS version, machine, topology or placement, and warns about allocator, Wine and loader-config differences ([server-flavors.md](server-flavors.md)) |
| **R14** | Where the bots run is recorded and held fixed across a comparison. Remote bot machines are held to the same standard as the server machine: idle before every repeat, watched during every hold, and a lost or saturated agent invalidates the measurement, never fails it. | `meta.topology` and its `sha256`; the idle gate on every agent; the `agent_interference`, `agent_lost` and `agent_topology_changed` gates and agent saturation ([distributed.md](distributed.md)) |

## Measurement layers

| layer | source | what it gives | needs |
|---|---|---|---|
| L0 OS | `sysmon` process sampler: process and per-thread CPU, RSS / private bytes, NIC bytes | tick thread found by name (`MC_SERVER`), **main-thread utilisation** (the headroom proxy), **tick-thread CPU per tick** (with L1'), memory per player, bandwidth per player | nothing |
| L0 OS | `sysmon` machine sampler and `idleCheck` | **interference**: CPU taken by processes outside the server, bot and harness groups, machine-wide and on the server's CPUs | nothing |
| L0 OS | `placement` | CPU topology, the planned CPU sets and priority, per-thread verification | nothing (Linux `above_normal` needs CAP_SYS_NICE) |
| L0 agents | `bedperf agent` telemetry, once per second per agent | machine busy, bot and foreign cores, NIC throughput (Linux), saturation verdict; control-link RTT | remote bots only |
| L0 bots | `loadgen`: bedboo fleet stats (per agent in `loadgen.agents`) | join latency, tick-bound RTT, movement corrections, failures, **view metrics** (in-view columns, view T90 / TN, chunks per second), packet counts, loadgen self-check | nothing |
| L1 probe | `probe-addon`: Script API pack that logs `BEDPERF|{json}` to stdout | in-tick TPS, tick-interval distribution, ticks over 50/100 ms, players, entity counts | stable `@minecraft/server` only (no experiments) |
| L1' counter | `bds-process` `GametimeSampler`: `time query gametime` on the console's priority lane, every `sampling.gametimeIntervalSec` (5 s; 1 s in `quick`) | **counter TPS**, a script-free second TPS source, plus its reply latency | nothing |
| L2 (later) | LeviLamina profiler mod | true MSPT, per-phase breakdown | a LeviLamina flavor |

### Why main-thread utilisation

TPS saturates at 20, so on its own it cannot tell 30 % load from 95 % load. BDS sleeps out the remainder of every 50 ms tick, so the CPU share of the tick thread over a window is roughly MSPT / 50 ms. The tick thread is the lowest-tid thread named `MC_SERVER`; only when no thread matches by name does sysmon fall back to the busiest thread over a sliding window (the sample then says `source: 'busiest'`). This proxy cannot separate lock waits from sleep, and it does not include work offloaded to other threads (chunk generation, networking). Those are visible as total process CPU.

### Probe TPS

The probe records `Date.now()` at every tick (`system.runInterval(fn, 1)`). Each window of about 1 s reports the tick count over wall time, plus the distribution of intervals between ticks. Script callbacks run inside the tick, so they cost a little. Entity enumeration is sampled only every few windows to keep this small.

### Counter TPS

`time query gametime` prints a counter the server advances once per executed tick, independent of `doDaylightCycle`. The sampler sends it every 5 s on the console's priority lane and pairs replies with sends. Counter TPS over a window is (g_b − g_a) / (t_b − t_a) over the first and last reply inside it, using host receive times. It needs no script engine, so it cross-checks the probe: if both agree, neither a broken pack nor a stalled script scheduler is hiding a problem.

## Headline metric: max players at 20 TPS

1. Prepare a fresh instance from the pristine server build (vanilla BDS or a modded flavor): fixed version, `server.properties` preset and world (a snapshot, or seed plus level type), with the probe pack installed.
2. Start the server under the placement plan. Run the scenario's `serverSetup` commands. Warm up.
3. **Ramp.** Begin at `ramp.start` bots. For each step: `scaleTo(n)`, settle, then measure for `ramp.holdSec`. Then raise n by `ramp.step`.
4. Evaluate each step against the pass criteria and the gates. The first failing step ends the ramp.
5. **Bisect** between the last passing and the first failing player count, down to `ramp.resolution`.
6. Repeat the whole search `repeats` times on fresh instances. Report the median and [min, max] over the `ok` repeats, with k/n ok.

### Default pass criteria (one step)

- mean probe TPS ≥ 19.8 (`criteria.minAvgTps`)
- after discarding the worst 1 % of 1 s windows (`criteria.worstWindowDiscardPct`), the minimum window TPS ≥ 19.0 (`criteria.minWorstWindowTps`)
- p99 tick interval ≤ 80 ms (`criteria.maxTickIntervalP99Ms`). On Windows, BDS sleeps out each tick in ~15.6 ms timer quanta, so a healthy server alternates ~47 ms and ~63 ms intervals (mean 50 ms) and its p99 sits near 63 ms; 80 ms leaves room for that while still catching real stalls. TPS and the worst-window rule do the rest.
- counter TPS over the hold ≥ `criteria.minCounterTps`
- zero unexpected bot disconnects or join failures (`criteria.maxBotFailures`)
- optional: mean main-thread utilisation ≤ `criteria.maxMainThreadUtil`

A pass criterion that is not met **fails** the step: that is a finding about the server. A gate that is not met **invalidates** the step: the measurement cannot be trusted, so it says nothing about the server (R11).

## Gates

| gate | source | threshold (default) | outcome | config key |
|---|---|---|---|---|
| machine lock | CLI lock file | another `bedperf run` holds it | env-gate (exit 3) | `$BEDPERF_LOCK`, `--no-lock` |
| agents usable | orchestrator connects every `--agents` agent | an agent unreachable, denied (token, protocol, harness commit) or busy | env-gate (exit 3) | `--agents`, machine profile `agents`, `$BEDPERF_AGENT_TOKEN` |
| idle gate | `sysmon` `idleCheck`, 15 s before each repeat, no server or bots running; on the server machine and on every agent | foreign mean ≤ 0.25 cores, 10 s peak ≤ 1.5 cores, foreign on server CPUs ≤ 0.25 cores (server machine only) | env-gate (exit 3) before the first repeat, repeat `invalid` later | `gates.idleSec`, `gates.idleForeignMean`, `gates.idleForeignPeak10s`, `gates.idleServerSetForeignMean`; `--skip-idle-check` |
| placement plan | `placement` `planPlacement` | any `fail` check (`bot_cpus`, `server_cpus`, `too_few_cores`, `unknown_cpus`, `processor_group`) | env-gate (exit 3) | placement profile |
| placement verify | `verifyPlacement` at ready, hold start and hold end | any violation (`process_affinity`, `thread_outside`, `priority`) | step invalid | placement profile |
| interference | `sysmon` machine sampler over the hold | foreign mean > 0.25 cores, 10 s peak > 1.5 cores, or server-set foreign mean > 0.25 cores | step invalid | `gates.foreignMean`, `gates.foreignPeak10s`, `gates.serverSetForeignMean` (reason `interference`) |
| loadgen saturation | fleet stats `loadgen.saturated` | worker event-loop lag p99 > 50 ms, JS-thread CPU > 85 %, or a silent worker; or an agent reporting itself saturated (machine CPU > 90 % of its CPUs, or foreign load > 1 core) | step invalid, run `loadgenLimited` | `loadgen.botsPerWorker` (indirectly); agent `--saturation-busy`, `--saturation-foreign` |
| agent interference | agent telemetry over the hold | an agent's foreign mean > 0.25 cores or 10 s peak > 1.5 cores | step invalid (`agent_interference`) | `gates.foreignMean`, `gates.foreignPeak10s` |
| agent lost | the agent control link | dropped, or silent for 10 s, between the step start and the hold end | step invalid (`agent_lost`), repeat `invalid` | — |
| agents reconnect | before a repeat after an agent was lost | an agent cannot be reconnected; or the reconnected agents are other machines (topology hash) | repeat `invalid` (`agent_lost`, `agent_topology_changed`) | — |
| counter reply gap | `GametimeSampler` | no reply for > 60 s | step invalid | `gates.gametimeMaxGapSec` (reason `gametime_gap`) |
| counter latency | `GametimeSampler` | reply latency p99 > 30 s | step invalid | `gates.gametimeLatencyP99Sec` (reason `gametime_latency`) |
| counter monotonic | `GametimeSampler` | gametime decreases | step invalid | — (reason `gametime_non_monotonic`) |
| counter alive | `GametimeSampler` during warmup | gametime does not advance | invalid | — (repeat reason `gametime_probe_dead`) |
| TPS sources agree | probe TPS vs counter TPS over the hold | \|difference\| > 0.5 TPS | step invalid (`tps_sources_disagree`) | `criteria.maxProbeCounterTpsDivergence` |
| unexpected server exit | `bds-process` `exit` with `expected: false` | any | repeat `server_failed` | none |

"Engine default" means the threshold is fixed in this harness version and recorded with the run. Gates never change a step from fail to pass; they only decide whether its result is admissible.

Two flags are recorded without changing any status: `settleCapped` (the settle phase reached its maximum before the view converged) and `viewsIncomplete` (bots were still missing part of their view when the hold began). Read numbers from flagged steps with care.

## Timeline of a run

1. **Lock.** Take the machine lock before resolving or downloading BDS (R4). With remote bots, connect every agent; each holds its own machine's lock for the session.
2. **Placement plan.** Read the topology and plan server, bot and harness CPU sets from the placement profile. An unusable plan stops the run (exit 3).
3. For each repeat:
   1. **Idle gate.** Sample the machine, and every agent machine, for 15 s with nothing of ours running. Failure before the first repeat stops the run (exit 3); before a later repeat it makes that repeat `invalid`. With remote bots, a lost agent is reconnected first.
   2. **Instance.** Create a fresh instance and world from the pristine build, install the probe pack (R5).
   3. **Start and place.** Start the server (through its launcher for a modded flavor), find the game process, apply the server CPU set and priority, wait for `Server started.`, then **verify** placement (mismatch → the repeat is invalid).
   4. **Setup.** Send the scenario's `serverSetup` commands. These are the last non-probe commands of the repeat (R7).
   5. **Warmup.** Run for `warmupSec`. Start the gametime sampler; the counter must advance.
   6. **Ramp steps**, each:
      - `scaleTo(n)`;
      - **settle until converged**: at least `ramp.settle.minSec` and at most `ramp.settle.maxSec`, until over a `ramp.settle.windowSec` (60 s) window the bots gain ≤ `ramp.settle.ratePerBot` (0.1) new unique chunks per bot per second, with bot data no older than `ramp.settle.maxDataAgeSec` (5 s). Hitting the maximum sets `settleCapped`; `ramp.settle.mode = "fixed"` restores a fixed `ramp.settleSec`;
      - **hold** for `ramp.holdSec`: verify placement at the start, mark `step-<i>-start`, sample everything, mark `step-<i>-end`, verify placement at the end;
      - evaluate pass criteria, then gates.
   7. **Bisect** between the last pass and the first fail, with the same step procedure.
   8. **Teardown.** Stop the bots, samplers and server; delete the instance unless `--keep-instances`.
   9. **Cooldown** (`cooldownSec`: 60 s; 5 s in `quick`, 120 s in `thorough`) before the next repeat, so heat and background work from this repeat do not leak into the next.
4. **Rerun policy.** An `invalid` repeat is rerun once on a fresh instance. A `server_failed` repeat is never rerun (R9).
5. **Finalise.** Write `result.json`, the `files` manifest in `meta.json`, release the lock, and set the exit code.

Inside a step, an invalid result is retried once at the same player count. A second invalid result ends the search. When the cause was loadgen saturation, the repeat's value is the highest pass so far, a lower bound flagged `loadgenLimited`.

## Statuses and exit codes

| repeat status | meaning | in the headline? | rerun? |
|---|---|---|---|
| `ok` | the search finished and every counted step was admissible | yes | no |
| `server_failed` | the server crashed, stopped or could not take the load | no, but listed with its value and reason and counted in k/n | never |
| `invalid` | the machine or harness failed: interference, placement, lost or disagreeing TPS source, a lost or changed bot agent, a repeat that never ended | no | once |

| exit code | meaning |
|---|---|
| 0 | at least one repeat `ok`: there is a headline (k/n tells how many) |
| 1 | any other error |
| 2 | usage or config error, or a comparison refused as incomparable |
| 3 | an environment gate refused to start: machine lock, idle gate before the first repeat, unusable placement plan, unusable bot agents |
| 4 | no `ok` repeat, and every repeat `server_failed` |
| 5 | no `ok` repeat, and at least one `invalid` after its rerun |
| 130 | interrupted (second Ctrl+C, or SIGTERM) |

A session (`--configs`) exits 0 when every run exits 0, else 5 when any run exits 5, else 4.

## Comparing runs

`bedperf compare runs/<a> runs/<b>` compares B against baseline A. An A/B session runs both variants on the same machine, with the repeat order set by `--order rotate|sequential|seeded:N` so that drift over time (thermals, background updates) does not line up with one variant.

### Decision rule (R12)

Each cell is the median [min, max] over the `ok` repeats, with k/n ok. For the headline, every curve metric at matched player counts, and every per-player slope, B is `better` or `worse` than A only when every ok repeat of B beats every ok repeat of A in the metric's good direction (complete separation). Otherwise the verdict is `not separated`, which does **not** mean equal. With fewer than 2 ok repeats on a side the verdict is `insufficient repeats`.

If there is no real difference, all orderings of the m + n values are equally likely, so complete separation in a given direction happens by chance with probability 1 / C(m + n, m):

| repeats (m vs n) | chance of separation in a given direction | in either direction |
|---|---|---|
| 2 vs 2 | 1/6 | 1/3 |
| 3 vs 3 | 1/20 | 1/10 |
| 4 vs 4 | 1/70 | 1/35 |
| 5 vs 5 | 1/252 | 1/126 |

Use at least 3 repeats per side for any claim, and 5 for small effects.

### Comparability

`compare` refuses (exit 2) when a field is present in both runs and differs, unless `--force`, which renders the comparison under a prominent warning:

- benchmark config (`benchConfigSha256`: the config without its `server` section; older runs: `configSha256`)
- server (label and `server.specSha256`), server build (`server.buildSha256`) and effective loader config (hash of `server.loaderConfig`)
- bot topology (`topology.sha256`; local runs compare with local runs only)
- machine (`machine.fingerprint`)
- BDS version and build (`bdsVersion`, BDS zip sha256)
- analysis version (`analysisVersion`)
- placement profile (`placement.profileSha256`)
- bot protocol (`botVersion`)

A field missing from either run is "cannot verify": noted, not refused, so older runs still compare.

**Implementation comparisons (R13).** When the server label or spec hash differs, the runs form an implementation comparison. The server, server build, loader config and BDS zip fields may then differ (shown as `differs`). The benchmark config, BDS version, machine, topology and placement profile must still match, and a value that only one of the runs records refuses as well. `bedperf compare a b c ...` with three or more runs renders pairwise verdict matrices and a headline ranking, and refuses if any pair is incomparable. Comparisons also warn, without refusing, about a different allocator, Wine against native, different loader-config overrides, different harness or bedboo commits, different agent machines, troubled agents and unpublishable runs. See [server-flavors.md](server-flavors.md#running-an-implementation-comparison).

## Metric definitions

| metric | definition |
|---|---|
| probe TPS | per ~1 s probe window, ticks / wall time; per step, total ticks / total time (time-weighted) |
| counter TPS | (Δ gametime) / (Δ host receive time) between the first and last reply in the window; undefined below 90 % reply coverage. Not clamped, so short windows can read slightly above 20 |
| low5 | the lowest counter TPS over any stretch of at least 4.5 s ("lowest 5 s" at a 5 s interval), `lowTps` |
| worst-window TPS | the minimum probe window TPS after discarding the worst `worstWindowDiscardPct` % of windows (never all) |
| tick interval p99 | pooled p99 of intervals between ticks over the hold. The probe reports per-window quantiles, so the pooled p99 is approximate; mean, max and counts over 50 / 100 ms are exact |
| main-thread utilisation | tick-thread CPU / wall time over the window, clamped to [0, 1]. Approximates MSPT / 50 ms while TPS holds 20 |
| tick CPU per tick | (CPU(t_b) − CPU(t_a)) / (g_b − g_a): ms of tick-thread CPU per executed tick, with CPU interpolated to the gametime reply times. **This is not MSPT.** It excludes time blocked on locks or I/O and time runnable but not scheduled, so it is a lower bound on the work per tick, not the tick's duration. Use windows of many seconds (Windows CPU times are quantized to ~15.6 ms) |
| view T90 | per bot, time from the view origin (latest server teleport, else `start_game`) to the arrival of 90 % of the columns now in view; nearest-rank p50 / p90 / max over bots |
| view TN | per bot, time to the 80th in-view column; bots with fewer are right-censored |
| chunks per second | chunk column loads across all bots per second, re-loads included |
| interference | foreign cores = total machine busy cores − cores used by the server, bot and harness process groups; reported as mean, highest 10 s mean, and the mean on the server's CPUs |

## Secondary metrics (per step, and as curves against player count)

- TPS (probe and counter) and tick-interval distribution, plus counts of ticks over 50 ms and 100 ms
- main-thread utilisation, tick CPU per tick and total process CPU
- RSS and private bytes. Memory per player is the slope; leaks show up as growth at constant load.
- network rx/tx per player
- join latency (connect → spawn) and join failures
- tick-bound RTT: `/scriptevent bedperf:ping` round trip, i.e. client-perceived lag
- movement corrections per second
- view metrics: in-view columns, view T90 / TN, chunks per second
- entity counts by dimension and type
- interference over each hold

## Scenarios

| scenario | what it stresses |
|---|---|
| `idle` | bots stand still; the per-connection baseline |
| `walk` | random walk within radius R of spawn; movement and entity tracking |
| `explore` | bots move outward; chunk generation and loading |
| `build` | place and break blocks in private plots; block updates |
| `chat` | periodic chat; network fan-out |
| `mobs` | mobs summoned around bots, which fight them; AI and combat |
| `entity-stress` | fixed players, ramp of mob count; entity ticking |

## Provenance and privacy

The run's `meta.json` records:

- BDS build and bedboo commit, the BDS zip sha256 and the probe pack hash
- the server build (`server`): spec with pinned versions, every artifact with its sha256, `buildSha256`, allocator, effective loader config and notes ([server-flavors.md](server-flavors.md#provenance))
- the full config: properties, seed or snapshot hash, scenario parameters, and its `configSha256`, plus `benchConfigSha256` (the same without `server`)
- host CPU and RAM, and a machine fingerprint (OS family, CPU model, core counts, RAM) to tell whether two runs ran on the same hardware
- the placement plan and its profile hash
- the bedperf commit, whether the checkout was dirty, and the analysis version
- whether the load generator was colocated with the server, whether the bots dialled a loopback address (`network.loopback`), and the bot topology (`topology`: each agent's machine, harness, CPUs, weight, link RTT and placement, with addresses only as hashes; [distributed.md](distributed.md#topology-provenance-and-comparability))
- sha256 and size of every file in the run dir (`files`), so a shared run can be checked for tampering or truncation

`meta.json` and `config.json` are scrubbed: the run dir, cache, repo, temp and home paths become placeholders such as `<run>` and `<home>`, other private absolute paths keep only their file name, and user and host names become `<user>` and `<host>`. They can be shared. Raw logs (`samples.jsonl`, `bds*.log`) are **not** scrubbed: share them with care.

Before a run:

- pin the server and the loadgen to separate cores, or better, run the bots on other machines ([distributed.md](distributed.md))
- disable `enable-lan-visibility`
- close everything else on the machine; the idle gate will tell you if you did not

## Threats to validity

- **One machine.** A result describes this hardware, OS and power plan. Runs on different machines are not comparable (the fingerprint check refuses them).
- **Colocated load generator.** Bots on the same host compete for memory bandwidth, caches and the scheduler even on disjoint CPUs. Placement and the saturation gate limit this; they do not remove it. Use remote bot agents for headline numbers ([distributed.md](distributed.md)).
- **Bots are not players.** bedboo bots run scripted scenarios with `viewDistance: 'tiny'` and no rendering. They do not reproduce real player behaviour, resource-pack downloads or client-side chunk caching (full chunk payloads are sent).
- **Loopback.** With bots on `127.0.0.1` there is no real network: no latency, loss or MTU effects, and system NIC counters miss the traffic entirely.
- **Remote network.** With bots on agents, the network between them and the server is part of every client-side metric. The topology check refuses different agent machines, but it cannot see the switch or the cabling.
- **Server implementation.** A modded flavor is the whole stack: loader, mods, runtime and allocator. Endstone on Linux preloads mimalloc, and a Wine flavor includes Wine's translation cost. Differences between flavors are differences between these stacks, not between their loaders alone ([server-flavors.md](server-flavors.md#known-confounds)).
- **Windows timer quantum.** BDS sleeps in ~15.6 ms quanta and thread CPU times are quantized to the same clock, which shapes the tick-interval distribution and the resolution of CPU metrics.
- **vCPUs.** On VMs and WSL2 (`placementKind: vcpu`) core and SMT facts are unreliable and steal time counts as busy. Do not compare vCPU runs with physical ones.
- **Server defaults.** Results depend on the `server.properties` preset (view distance, tick distance, max threads) and the world. They are recorded, not normalised.
- **Script API probe overhead.** The probe runs inside the tick. Its cost is small but non-zero, and a stalled script scheduler could distort it, which is why counter TPS cross-checks it.
- **bedboo cost.** About 0.16–0.2 cores and 60–85 MB per bot. A fleet that is too small for its host saturates before the server does; such steps are invalid, and the result is then only a lower bound (`loadgenLimited`).
