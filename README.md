# bedperf

A performance benchmark harness for Minecraft Bedrock Edition. Phase 1 targets the **Bedrock Dedicated Server (BDS)** and runs on a stock, unmodded BDS. A LeviLamina-based deep profiler is planned as an optional later layer.

The headline metric is **the largest number of players the server can hold while keeping 20 TPS**. The players are [bedboo](https://github.com/LiteLDev/bedboo) bots running a chosen scenario. Every run also records the scaling curve and secondary metrics. [docs/methodology.md](docs/methodology.md) defines all metrics and the pass criteria.

## Layout

| package | role |
|---|---|
| `packages/core` | shared contracts: types, probe line codec, stats helpers |
| `packages/testkit` | throwaway BDS launcher and bedboo bot helper, for tests and e2e checks |
| `packages/bds-install` | resolve, download, cache and extract BDS; create instances, properties, packs and world snapshots |
| `packages/bds-process` | BDS process control, stdout event parser, console command channel |
| `packages/probe-addon` | Script API behavior pack reporting in-tick TPS, tick intervals and entity counts on stdout |
| `packages/sysmon` | OS sampler: process and per-thread CPU (main-thread utilisation), memory, network |
| `packages/placement` | CPU topology (P/E classes, SMT, VMs), server/bot/harness CPU placement planning, apply and per-thread verification |
| `packages/loadgen` | multi-process bedboo bot fleet with `scaleTo(n)` and bot-side metrics |
| `packages/scenarios` | workloads: idle, walk, explore, build, chat, mobs, entity-stress |
| `packages/orchestrator` | benchmark config, step ramp and bisection, pass criteria, run recorder |
| `packages/report` | run analysis and a self-contained HTML report and comparison |
| `packages/cli` | the `bedperf` command (`run`, `report`, `analyze`, `compare`, `install`, `scenarios`) that wires everything together |
| `vendor/bedboo` | git submodule. bedboo only works inside a pnpm workspace that carries its overrides and patches, so `scripts/sync-bedboo.mjs` generates our `pnpm-workspace.yaml` from its own |

## Setup

Requires Node ≥ 24, x64, and corepack (pnpm 12).

```bash
git submodule update --init
corepack pnpm install
corepack pnpm typecheck
corepack pnpm test
```

After bumping the bedboo submodule, run `node scripts/sync-bedboo.mjs && corepack pnpm install`.

### BDS cache

Tests and e2e checks start BDS from a pristine extracted build in a shared cache:

- Windows: `%LOCALAPPDATA%\bedperf\cache\bds\<version>\`
- Linux: `~/.cache/bedperf/bds/<version>/`
- `BEDPERF_CACHE_DIR` overrides both and uses `<dir>/bds/<version>/`.

Downloading BDS means you accept the [Minecraft EULA](https://www.minecraft.net/eula). To fetch a build by hand (`bds-install` automates this):

```bash
curl -L -A "Mozilla/5.0" -o bds.zip https://www.minecraft.net/bedrockdedicatedserver/bin-win/bedrock-server-1.26.63.1.zip
```

Then extract it into the cache directory above. Real-BDS tests only run when `BEDPERF_E2E=1` is set.

## Running a benchmark

```bash
corepack pnpm bedperf run --scenario walk --set ramp.max=200 --set loadgen.botsPerWorker=15
```

This writes `runs/<id>/` (config, meta, samples.jsonl, steps.json, result.json, bds.log) and `report.html`. See [packages/cli/README.md](packages/cli/README.md) for every option.

Bots are expensive: about 0.16 cores and 60 MB each for `walk`. When the bots share a host with BDS, they saturate before a fast server does, and the result is then flagged `loadgenLimited`. To measure real capacity, run the bots on a separate machine.

## Rigor

A number is only reported when the measurement behind it can be trusted. bedperf follows numbered rules R1–R12 ([docs/methodology.md](docs/methodology.md#rules)): one config, bot source and CPU placement per comparison; one measured run per machine, with an idle gate before each repeat and interference sampling during every measured window; a fresh instance per repeat; no console commands inside measured windows except the probes; TPS from two independent per-tick sources (the BDS tick counter and the in-tick probe) that must agree; failures counted as results; capacity found by search; and comparisons that claim a difference only on complete separation across repeats.

Each repeat ends `ok`, `invalid` (the machine or harness failed; rerun once) or `server_failed` (a result; never rerun), and the headline is the median [min, max] over ok repeats with k/n. `bedperf analyze runs/<id>` recomputes the analysis from the raw files byte for byte, and `bedperf compare` refuses runs with a different benchmark config, machine, BDS version, bot topology, analysis version or placement profile unless `--force`. Runs that differ only in the server (BDS, LeviLamina, LeviLamina + LeviOptimize, Endstone, on Wine or native) compare as an implementation comparison; `bedperf compare a b c ...` gives pairwise verdict matrices and a ranking. [docs/comparison-bedrock-bench.md](docs/comparison-bedrock-bench.md) credits the [bedrock-bench](https://github.com/EndstoneMC/bedrock-bench) ideas this builds on and compares the two harnesses.

## Conventions

- TypeScript ESM, run directly by Node's type stripping with no build step. Imports use explicit `.ts` extensions, and only erasable syntax is allowed: no `enum`, `namespace` or parameter properties.
- `tsc --noEmit` (TypeScript 7) is used for typechecking.
- Tests use `node --test`, with `*.test.ts` files next to the source. Tests that need real BDS are gated by `BEDPERF_E2E=1`.
- Every package exports `./src/index.ts`.
- Packages talk to each other only through the `@bedperf/core` contracts.
