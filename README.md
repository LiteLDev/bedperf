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
| `packages/loadgen` | multi-process bedboo bot fleet with `scaleTo(n)` and bot-side metrics |
| `packages/scenarios` | workloads: idle, walk, explore, build, chat, mobs, entity-stress |
| `packages/orchestrator` | benchmark config, step ramp and bisection, pass criteria, run recorder |
| `packages/report` | run analysis and a self-contained HTML report and comparison |
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

## Conventions

- TypeScript ESM, run directly by Node's type stripping with no build step. Imports use explicit `.ts` extensions, and only erasable syntax is allowed: no `enum`, `namespace` or parameter properties.
- `tsc --noEmit` (TypeScript 7) is used for typechecking.
- Tests use `node --test`, with `*.test.ts` files next to the source. Tests that need real BDS are gated by `BEDPERF_E2E=1`.
- Every package exports `./src/index.ts`.
- Packages talk to each other only through the `@bedperf/core` contracts.
