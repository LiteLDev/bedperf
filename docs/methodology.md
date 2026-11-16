# Methodology (phase 1: vanilla BDS, no mod loader)

## Measurement layers

| layer | source | what it gives | needs |
|---|---|---|---|
| L0 OS | `sysmon`: process and per-thread CPU, RSS/private bytes, NIC bytes | **main-thread utilisation** (the headroom proxy), memory per player, bandwidth per player | nothing |
| L0 bots | `loadgen`: bedboo fleet stats | join latency, tick-bound RTT, movement corrections, failures, loadgen self-check | nothing |
| L1 probe | `probe-addon`: Script API pack that logs `BEDPERF|{json}` to stdout | in-tick TPS, tick-interval distribution, ticks over 50/100 ms, players, entity counts | stable `@minecraft/server` only (no experiments) |
| L2 (later) | LeviLamina profiler mod | true MSPT, per-phase breakdown | Windows + matching LeviLamina |

### Why main-thread utilisation

TPS saturates at 20, so on its own it cannot tell 30 % load from 95 % load. BDS sleeps out the remainder of every 50 ms tick, so the CPU share of the tick thread over a window is roughly MSPT / 50 ms. We take the busiest thread over a sliding window as the tick thread. This proxy cannot separate lock waits from sleep, and it does not include work offloaded to other threads (chunk generation, networking). Those are visible as total process CPU.

### Probe TPS

The probe records `Date.now()` at every tick (`system.runInterval(fn, 1)`). Each window of about 1 s reports the tick count over wall time, plus the distribution of intervals between ticks. Script callbacks run inside the tick, so they cost a little. Entity enumeration is sampled only every few windows to keep this small.

## Headline metric: max players at 20 TPS

1. Prepare a fresh instance from the pristine BDS build: fixed version, `server.properties` preset and world (a snapshot, or seed plus level type), with the probe pack installed.
2. Start BDS. Run the scenario's `serverSetup` commands. Warm up.
3. **Ramp.** Begin at `ramp.start` bots. For each step: `scaleTo(n)`, wait `settleSec`, then measure for `holdSec`. Then raise n by `ramp.step`.
4. Evaluate each step against the pass criteria. The first failing step ends the ramp.
5. **Bisect** between the last passing and the first failing player count, down to `ramp.resolution`.
6. Repeat the whole search `repeats` times on fresh instances. Report the median and the spread.

### Default pass criteria (one step)

- mean probe TPS ≥ 19.8
- after discarding the worst 1 % of 1 s windows, the minimum window TPS ≥ 19.0
- p99 tick interval ≤ 60 ms
- zero unexpected bot disconnects or join failures
- optional: mean main-thread utilisation ≤ a configured ceiling

A step measured while the load generator was saturated is **invalid** rather than failed. Saturation means the bot workers' event-loop lag or CPU is beyond their thresholds. The run is flagged `loadgenLimited`.

## Secondary metrics (per step, and as curves against player count)

- TPS and tick-interval distribution, plus counts of ticks over 50 ms and 100 ms
- main-thread utilisation and total process CPU
- RSS and private bytes. Memory per player is the slope; leaks show up as growth at constant load.
- network rx/tx per player
- join latency (connect → spawn) and join failures
- tick-bound RTT: `/scriptevent bedperf:ping` round trip, i.e. client-perceived lag
- movement corrections per second
- entity counts by dimension and type

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

## Reproducibility checklist

The run's `meta.json` records:

- BDS build and bedboo commit
- the full config: properties, seed or snapshot hash, scenario parameters
- host CPU and RAM
- whether the load generator was colocated with BDS

Before a run:

- pin BDS and the loadgen to separate cores, or better, separate hosts
- disable `enable-lan-visibility`
- use fresh instances per repeat
