# bedperf and bedrock-bench

[EndstoneMC/bedrock-bench](https://github.com/EndstoneMC/bedrock-bench) (Apache-2.0) benchmarks many Bedrock server implementations (BDS, Endstone, LeviLamina, PocketMine-MP, Nukkit forks, Allay, Dragonfly, ...) under one fixed workload on one machine. bedperf measures how many players a BDS server holds at 20 TPS under several workloads. The two answer different questions, and bedperf borrowed a good part of bedrock-bench's measurement discipline. Only ideas were adopted; no code was copied.

This page compares the two as of bedrock-bench's published methodology and bedperf's [methodology](methodology.md). Corrections are welcome.

## Side by side

| | bedrock-bench | bedperf |
|---|---|---|
| question | how do server implementations compare at a fixed load? | how many players does this server hold at 20 TPS, and what does each player cost? |
| servers | about ten implementations, BDS as the vanilla reference | BDS (phase 1); LeviLamina as an optional profiler layer later |
| bots | Go headless bot with per-protocol frontends | [bedboo](https://github.com/LiteLDev/bedboo) bots in a multi-process fleet |
| load | fixed: e.g. 100 bots walking circles in separate grid cells | searched: ramp, then bisect to `ramp.resolution` |
| workloads | one spread/walk workload with size variants | 7 scenarios: idle, walk, explore, build, chat, mobs, entity-stress |
| TPS | tick counter via a console command every 5 s | the same kind of tick counter (`time query gametime`) **and** an in-tick Script API probe, cross-checked |
| tick timing | none beyond counter TPS | per-tick interval distribution: p50/p95/p99/max, ticks over 50/100 ms, worst-window TPS |
| tick-thread CPU | CPU ms per executed tick, explicitly not MSPT | the same (`tickCpuMsPerTick`), plus main-thread utilisation as a headroom curve |
| process CPU and memory | process cores, private memory | process CPU, RSS and private bytes, memory per player as a slope |
| view and chunks | view T90 per player, chunks per second, chunks per bot | in-view columns, view T90 / TN, chunks per second, unique chunks |
| client experience | not measured | tick-bound RTT, join latency, movement corrections, join failures, unexpected disconnects |
| world state | not measured | entity counts by dimension and type |
| network | not measured | rx/tx per player (system NIC counters; bot-side bytes received) |
| interference | machine lock, 15 s idle gate, per-window foreign-load gates | the same mechanisms and default thresholds |
| placement | fixed CPU sets per profile; on Windows the server starts suspended, gets its affinity, then resumes; checked at three points | CPU sets per profile with automatic planning on hybrid and SMT CPUs; on Windows applied right after spawn; every thread verified at ready and at each hold's start and end |
| statuses | ok / server_failed / invalid; invalid rerun once, server_failed never | the same |
| report cell | median [min, max] over ok runs | the same, plus k/n ok |
| comparison | complete separation across runs; refuses mixed configs, machines, profiles and analysis versions | the same rule with its chance probability shown; also refuses mismatched BDS builds and bot protocols |
| recomputation | `bbench analyze` rebuilds metrics byte for byte | `bedperf analyze` does the same |
| publishing gate | `--publish` requires ≥ 3 ok runs, no unpublished artifacts, a clean harness | no publish gate; `meta.json` records `dirty` and the comparison shows k/n |
| world freshness and config read-back | explicit `world_fresh` and `config_readback` gates | fresh instance per repeat by construction; the resolved config is recorded, not read back from the server |

## Adopted from bedrock-bench

With thanks to the bedrock-bench authors:

- **Numbered rules.** R1–R10 in [methodology.md](methodology.md#rules) adapt bedrock-bench's R1–R10 (one config, one bot source, same placement, one measured run with interference sampling, fresh instance and world, everything recorded, no interventions in measured windows, counter TPS, failures are results, recomputable numbers).
- **Machine interference.** A machine-wide sampler that attributes CPU to the server, bot and harness process groups, a 15 s idle gate before each repeat, and per-window foreign-load gates with the same default thresholds (0.25 cores mean, 1.5 cores 10 s peak, 0.25 cores on the server's CPUs).
- **Tick thread by name, and CPU per tick.** Finding the tick thread by name rather than as the busiest thread, and reporting tick-thread CPU per executed tick, stated plainly as not MSPT.
- **Tick-counter TPS.** A console tick counter on a priority lane every 5 s, with gates on reply gaps and monotonicity, and the rule that world time is not a TPS source.
- **Placement profiles and verification.** Fixed server, bot and harness CPU sets with a hashed profile, verified during the run, and `physical` / `vcpu` recorded.
- **View metrics.** View T90 and chunks per second, and convergence-based settling before a measured window.
- **Repeat statuses and rerun policy.** `ok` / `server_failed` / `invalid`, invalid rerun once, server failures counted and never rerun.
- **Decision rule and comparability.** Median [min, max] over ok repeats, a verdict only on complete separation, and refusal to compare across configs, machines, profiles and analysis versions.
- **Provenance.** File hashes, scrubbed metadata, a machine lock, `analyze` recomputation and the exit-code scheme.

## What bedperf adds

- **Capacity search.** A ramp and bisection find the largest player count that holds 20 TPS, instead of measuring one fixed load. A saturated load generator invalidates a step rather than failing it (R11).
- **Seven scenarios** that stress different subsystems: connections, movement, chunk generation, block updates, chat fan-out, mob AI and entity ticking.
- **Tick-interval distribution.** Per-tick timing from inside the tick shows stutter that a 5 s counter average cannot: p99 interval, ticks over 50/100 ms, worst-window TPS.
- **Client-side experience.** Tick-bound RTT, join latency, movement corrections, join failures and unexpected disconnects.
- **Entity counts** by dimension and type, so entity growth is visible next to TPS.
- **Per-player costs.** Memory, network and main-thread utilisation per player as fitted slopes, with an extrapolated capacity at full utilisation.
- **Cross-run regression comparison** of the headline, of every curve at matched player counts and of every per-player slope, all under the same decision rule.
- **Two independent TPS sources with a cross-check.** The tick counter and the in-tick probe must agree within 0.5 TPS, or the step is invalid (`tps_sources_disagree`).

## Where bedrock-bench goes further

- It compares many server implementations under one methodology, which bedperf does not attempt.
- On Windows it applies affinity before the server's first instruction runs (suspended start); bedperf applies it just after spawn and relies on per-thread verification to catch escapes.
- It reads server configuration back and gates on world freshness explicitly, and it has a publishing gate for shared results.
