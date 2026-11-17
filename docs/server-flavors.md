# Server flavors

bedperf runs the same benchmark against six server implementations. They are all built on Bedrock Dedicated Server, so a comparison between them measures what the loader, its mods and the runtime add to or take from the same game binary. This page covers what each preset installs, how it is installed and started, what is recorded about it, what confounds a comparison, and how to run a fair implementation comparison. The methodology rule for this is R13 ([methodology.md](methodology.md#rules)).

## Presets

`--server <preset>` (on `bedperf run` and `bedperf install`) picks one of core's `SERVER_PRESETS` (`packages/core/src/server.ts`). It sets the config's `server` section; without it the section is absent, which means vanilla BDS.

| preset | flavor | mods | runtime | host | label in reports |
|---|---|---|---|---|---|
| `bds` | `bds` | — | `native` | Windows, Linux | `bds` |
| `levilamina` | `levilamina` | — | `native` | Windows | `levilamina` |
| `levilamina-levioptimize` | `levilamina` | `levioptimize` | `native` | Windows | `levilamina+levioptimize` |
| `endstone` | `endstone` | — | `native` | Windows, Linux | `endstone` |
| `levilamina-wine` | `levilamina` | — | `wine` | Linux | `levilamina (wine)` |
| `levilamina-levioptimize-wine` | `levilamina` | `levioptimize` | `wine` | Linux | `levilamina+levioptimize (wine)` |

On the wrong host, `bedperf run` refuses a preset with a usage error (exit 2) that names the preset to use instead (`install` fails as well): LeviLamina is a Windows build, so on Linux it runs only under Wine, and `wine` on a Windows host is refused.

### Pinned versions

| component | default (`DEFAULT_SERVER_VERSIONS`) | override |
|---|---|---|
| BDS for modded flavors (`FLAVOR_BDS_VERSION`) | 1.26.60.6 | `--bds-version x.y.z.w` (an exact version only) |
| LeviLamina | 26.60.7 | `--set server.versions.levilamina=<v>` |
| LeviOptimize | 0.18.0 | `--set server.versions.levioptimize=<v>` |
| Endstone | 0.11.15 | `--set server.versions.endstone=<v>` |

BDS 1.26.60.6 is the only build every flavor supports: LeviLamina 26.60.x pins BDS 1.26.60, and Endstone 0.11.15 added 1.26.60. A modded flavor ignores `bdsVersion: latest` or `preview` and runs its pinned build (`bdsVersionFor`); vanilla BDS still resolves `latest`. The bots use protocol family 1.26.60 for all of them. `--set server.versions.*` values stay strings (`0.20` is not turned into the number 0.2). A version that does not belong to the flavor or one of its mods is a config error.

## Installing

```bash
corepack pnpm bedperf install --server levilamina-levioptimize --accept-eula
corepack pnpm bedperf install --server endstone --accept-eula
corepack pnpm bedperf install --server levilamina-wine --accept-eula      # Linux
```

`bedperf install --server <preset> [latest|preview|x.y.z.w]` installs a flavor into the cache ahead of a run and prints the build and its artifacts with their hashes. `bedperf run` installs it too when it is missing. Downloading anything means accepting the [Minecraft EULA](https://www.minecraft.net/eula), so both need `--accept-eula` unless the build is already cached. A modded build already installed (it has its completion marker) needs no flag.

Everything is installed by `ensureServer` in `@bedperf/bds-install` (`packages/bds-install/src/flavors.ts`). Every external command (lip, python, pip, wine, tar) goes through one injectable runner.

### Cache layout and markers

| what | where |
|---|---|
| vanilla BDS | `<cache>/bds/<version>/`, plus `bedrock-server-<version>.zip` and its `<version>.json` sidecar (url, size, sha256) |
| modded builds | `<cache>/servers/<slug>-<hash12>/`, where `slug` is the label (`levilamina-levioptimize-wine`) and `hash12` = `sha256Json({spec: serverSpecSha256(spec), bdsVersion})` |
| lip downloaded by bedperf (Linux) | `<cache>/tools/lip-0.41.0/` |

`<cache>` is `%LOCALAPPDATA%\bedperf\cache` on Windows, `$XDG_CACHE_HOME/bedperf` or `~/.cache/bedperf` on Linux, or `$BEDPERF_CACHE_DIR`. A modded install writes `.bedperf-complete.json` (the build info, and the Wine paths for a Wine build) last. A directory without it is wiped and installed again from scratch, so an interrupted install never passes for a complete one. A cached build runs no commands at all. Installs of the same spec are not safe to run concurrently. The loader config is written per instance (see below), so it is not part of the cache key.

### LeviLamina (lip)

LeviLamina is installed with [lip](https://github.com/LiteLDev/lip), its package manager, in `<root>/server`:

```text
lip setup --game 1.26.60 --loader levilamina@26.60.7 --accept-eula
lip install github.com/LiteLDev/LeviOptimize@0.18.0          # levioptimize presets only
```

- **Finding lip.** `lip` on PATH. On Windows a missing lip is an error that points to the MSI on lip's release page. On Linux bedperf downloads `lip-0.41.0-linux-x64.tar.xz` from GitHub, checks it against the release's `SHA256SUMS` and extracts it with `tar -xJf` (needs `xz`).
- **Retries.** Each lip operation is atomic, so a failed one (usually a GitHub timeout) is retried up to 3 times.
- **Checks.** The install fails if `bedrock_server_mod.exe` is missing afterwards, if the BDS zip lip installed (read from `.lip/state.json`) is not exactly the requested version, or if a requested mod was not installed.
- **Wine (Linux).** The same lip commands set up the Windows build. lip installs its own Wine (a Kron4ek build, 11.21 wow64 with lip 0.41) under `$XDG_DATA_HOME/lip/wine/` (default `~/.local/share/lip/wine/`) and the VC++ runtime into the workspace prefix `<root>/server/.lip/wine`. bedperf uses that Wine directly, not `lip run`, and records its version.

### Endstone (pip)

Endstone is a Python package whose `endstone` CLI starts BDS with its runtime injected. The install in `<root>`:

1. Find a Python ≥ 3.11 (`python`, then `py -3` on Windows; `python3`, then `python` on Linux).
2. `python -m venv <root>/venv`.
3. `pip download --no-deps --only-binary=:all: endstone==0.11.15` into `<root>/wheels` (the wheel is kept so its sha256 can be recorded), then `pip install <wheel>`, which resolves the dependencies from PyPI.
4. Read `endstone.__minecraft_version__` and check that it matches the requested BDS version.
5. Linux only: check that the venv's Python has its shared libpython (`libpython3.X.so.1.0`). Endstone's `bedrock_server` links against it and finds it through `LD_LIBRARY_PATH`. Debian's `python3` package does not include it: install `libpython3.11` (the install fails with that hint).
6. Copy the vanilla BDS build from the bedperf cache into `<root>/server` and write `version.txt`, so Endstone does not download its own.
7. Record `pip freeze --all` of the venv in `<root>/pip-freeze.txt`.

## Instances and launch

Every repeat runs on a fresh instance created from the pristine build (R5). Server binaries and loader files are hard-linked, and `mods/` and `plugins/` are real directories in the instance. LeviLamina's `.lip/` is copied except the Wine prefix, which stays shared in the pristine dir through `WINEPREFIX`.

| flavor | spawned command | game process | tree kill |
|---|---|---|---|
| `bds` | `<instance>/bedrock_server[.exe]` (Linux: `LD_LIBRARY_PATH=<instance>`) | the spawned process | no |
| `levilamina` native | `<instance>/bedrock_server_mod.exe` (PeEditor-patched) | the spawned process | yes (LeviLamina's CrashLogger runs as a child) |
| `levilamina` wine | lip's `wine <instance>/bedrock_server_mod.exe`, with `WINEPREFIX=<pristine>/.lip/wine` and `WINEDEBUG=-all` | Wine execs into the game, so the spawned process (`comm` truncated to `bedrock_server_`) | yes, plus `wineserver -k` |
| `endstone`, Linux | `<venv>/bin/endstone -y -s <instance> --no-interactive` | the descendant named `bedrock_server` | yes |
| `endstone`, Windows | `<venv>\Scripts\python.exe -c <launcher> -y -s <instance> --no-interactive` | the descendant named `bedrock_server.exe` | yes |

On Windows, Endstone may run an elevated `CheckNetIsolation LoopbackExempt -a` (a UAC prompt) before it starts the server. No flag turns that off, so bedperf's launcher runs Endstone's CLI with that step replaced by a no-op. The exemption only lets the Microsoft Store client reach a server on localhost; the bots do not need it.

**Game-process resolution.** Everything that measures the server uses the game process, never the launcher: the OS sampler, the tick-thread lookup (`MC_SERVER`) and placement verification. If the spawned command matches the flavor's name pattern, it is the game process. Otherwise bds-process polls the process table every 250 ms for the first matching process in the launcher's tree: one CIM query on Windows, `/proc/*/stat` plus the basename of argv[0] on Linux, because Wine truncates `comm` to 15 characters. If the server prints `Server started` but no game process turns up within 10 s, the start fails (`noServerProcess`). The interference sampler's `server` group also holds the launcher and helpers outside the tree, such as `wineserver` and Wine's service processes. They are matched by name and, on Linux, by the `WINEPREFIX` in their environment, and refreshed before every hold.

**Exit and kill.** The run ends when the spawned process exits. If the launcher exits while the game is still alive, the game is killed. If the game exits while the launcher keeps running for 5 s, the launcher is killed, so a crash shows up as an unexpected exit (`server_failed`). With tree kill, `kill()` and a stop timeout run `taskkill /PID <launcher> /T /F` on Windows. On Linux the launcher is spawned in its own process group, and bedperf sends SIGKILL to the group and to the game pid. For Wine, `wineserver -k` with the instance's `WINEPREFIX` runs after every run, graceful or not, because wineserver and Wine's helpers are reparented to PID 1 and escape the group kill. A launcher-started server on Linux never sees the terminal's Ctrl+C, so a second Ctrl+C or a SIGTERM to `bedperf run` stops every running server explicitly before exiting (exit 130).

**Placement.** On Linux the launcher starts under `taskset` (and `nice`), so every descendant inherits the CPU set: Wine's game process and wineserver, and Endstone's Python and its `bedrock_server`. On Windows the plan is applied to the launcher right after the spawn and again to the game process as soon as it is identified, before `start()` resolves.

### Console formats

The parser (`parseBdsLine` in `@bedperf/bds-process`) recognises three prefixes and strips ANSI colors first. Readiness is `Server started` at the start of the message in every format (LeviLamina rewrites the line).

| format | example |
|---|---|
| `bds` | `[2026-11-16 16:15:28:495 INFO] Server started.` |
| `levilamina` | `10:34:37.034 IFO [Server] Server started in (1.6s)! For help, type "help" or "?"` (levels `TRC DBG IFO WRN ERR FTL`; no date) |
| `endstone` | `[10:36:53 INFO]: Server started.` |

Joins, leaves, `list` output and the `Gametime is <n>` reply are parsed in all three formats, so counter TPS and the probe work the same on every flavor.

## Loader configuration

LeviLamina writes `mods/LeviLamina/config/Config.json` only on its first start, and merges a partial file with its defaults. So bedperf starts no server during the install. It writes a partial config into every instance before the first start: `NEUTRAL_LOADER_CONFIG.levilamina` deep-merged with `server.loaderConfig` from the config. These benchmark-neutral overrides keep the loader from phoning home or throttling the bots (keys of config version 43, LeviLamina 26.60.7):

| key | value | why |
|---|---|---|
| `modules.crashLogger.uploadToSentry` | `false` | no crash uploads |
| `targeted.enableStatistics` | `false` | no telemetry |
| `targeted.vulnerabilityFixes.limitIPFrequency` | `false` | no per-IP connection throttling; every bot of a machine or agent shares one IP |

To change them, or to set other LeviLamina keys, use `server.loaderConfig` in the config file or on the command line:

```bash
corepack pnpm bedperf run --server levilamina --set server.loaderConfig.targeted.vulnerabilityFixes.limitIPFrequency=true
```

Objects are deep-merged and scalars and arrays replace. `loaderConfig` is accepted only for the `levilamina` flavor. LeviOptimize keeps its own defaults (`mods/LeviOptimize/config/config.json`, written on first start). BDS and Endstone get no loader config. Endstone writes `endstone.toml`, `plugins/` and a rate limit for packet 115 (`NetworkStackLatencyPacket`) in `packetlimitconfig.json` into the instance on every start, with its own defaults.

## Provenance

`meta.json` records the build as `meta.server` (core `ServerBuildInfo`), and its artifacts again under `artifacts.server`:

- `spec` (flavor, mods, runtime, pinned versions), `label`, `specSha256` (the resolved spec without the loader config), `bdsVersion`, `binaryPlatform` (`win` for a Wine build) and `exeName`.
- `artifacts`, each with name, version, sha256 and source:
  - `bds`: the zip sha256 (the bds-install sidecar, or lip's cached download for LeviLamina).
  - LeviLamina, its lip dependencies (`preloader`, `crashlogger`, `peeditor`, `bedrock-runtime-data`, `levilamina-loc`) and mods: the hash of the files lip placed, with source `<id>@<version>#<commit>`.
  - `lip`: the version and the binary's sha256.
  - `wine`: the version and a tree hash of the Wine build.
  - `endstone`: the wheel's sha256.
  - `python`: the version.
  - `python-deps`: the sha256 of the sorted `pip freeze --all`.
- `buildSha256`: a hash over the artifacts, sorted by name, which is the build identity used for comparability.
- `allocator`: `mimalloc-preload` for Endstone on Linux, and absent when the binary runs its own allocator.
- `loaderConfig`: the effective loader config written into the instances.
- `notes`: things a reader must know, for example that Endstone preloads mimalloc, that LeviLamina runs under Wine with a shared prefix, or that Endstone adds the packet 115 rate limit.

`config.json` holds the resolved `server` section with the pinned versions filled in. `meta.json` also records `benchConfigSha256`, the hash of the config without its `server` section, which is equal for one benchmark run on different servers. The report shows the server block, and lists the allocator, Wine and loader-config differences from upstream defaults as threats to validity.

## Known confounds

A difference between two flavors is the difference between two complete stacks. Read it with these in mind:

- **Allocator.** On Linux, Endstone `LD_PRELOAD`s its bundled mimalloc and `libendstone_runtime.so` into `bedrock_server`. The game then runs a different memory allocator than vanilla BDS, and part of any difference in tick time or memory may come from the allocator, not from Endstone. The report and the comparison flag it (`allocator`). On Windows, Endstone injects its runtime through detours and no allocator change is recorded.
- **Wine.** A `*-wine` preset measures Wine plus LeviLamina: syscall translation, wineserver round trips and Wine's own threads are part of every number. It is not a measurement of LeviLamina on Linux, and it is not comparable with native LeviLamina on Windows: those runs are on different OSes, which the machine fingerprint tells apart (see below).
- **Loader configuration.** The neutral overrides above are applied to every LeviLamina run, and LeviOptimize runs with its defaults. Any further `server.loaderConfig` is recorded, shown as a warning, and refuses a comparison of two runs of the same server that set it differently.
- **Per-IP throttling.** All bots of a machine share one IP. A loader that throttles connections per IP would measure the throttle, so LeviLamina's `limitIPFrequency` is off by default. Endstone's packet 115 rate limit stays as Endstone sets it.
- **Plugins and mods.** bedperf installs only the listed mods: LeviLamina runs with its own lip dependencies plus LeviOptimize where named, and Endstone with no plugins added by bedperf.
- **Build pinning.** Endstone's Python dependencies resolve from PyPI at install time. Two installs of the same Endstone version can differ, and `python-deps` in the artifacts shows when they do.

## Running an implementation comparison

An implementation comparison is runs of the same benchmark that differ only in the server. To make one fair:

1. **One machine and OS.** On Windows you can compare `bds`, `levilamina`, `levilamina-levioptimize` and `endstone`. On Linux you can compare `bds`, `endstone`, `levilamina-wine` and `levilamina-levioptimize-wine`. The same hardware under another OS has a different machine fingerprint and is refused.
2. **One BDS build.** Pin vanilla BDS to the modded flavors' build: `bdsVersion: "1.26.60.6"` (`--bds-version 1.26.60.6`). With `latest`, vanilla runs a newer build and `compare` refuses the BDS-version mismatch.
3. **One benchmark config.** Everything but `server` must be identical, including `name`: `benchConfigSha256` must match. Use the same `--machine-profile` (placement profile) and the same bot topology (local, or the same agents).
4. **Interleave the repeats.** Use a session, so drift over time (heat, background updates) does not line up with one server. Put the `server` section in each config file and do not pass `--server`, which would apply to every config:

   ```bash
   # bds.json, ll.json, llo.json, es.json: identical except "server", e.g.
   #   "server": { "flavor": "levilamina", "mods": ["levioptimize"] }
   corepack pnpm bedperf install --server levilamina --accept-eula
   corepack pnpm bedperf install --server levilamina-levioptimize --accept-eula
   corepack pnpm bedperf install --server endstone --accept-eula
   corepack pnpm bedperf run --configs bds.json,ll.json,llo.json,es.json --order rotate --accept-eula
   ```

   Each config gets its own run dir under `runs/<session>/`, named `<YYYYMMDD-HHMMSS>-<name>-<server>` after the config's `name` (vanilla leaves out `-<server>`). `--order rotate` runs repeat k of every config in block k, starting at config k mod n.
5. **Compare.** `bedperf compare runs/<session>/<a> runs/<session>/<b> [<c> ...] -o matrix.html`. With two runs you get the A/B page; with three or more you get pairwise verdict matrices for the headline and every metric, plus a headline ranking. When the setup matches and only the servers differ, the page says it is an implementation comparison (with three or more runs, the console says so too).

**Comparability rules.** `compare` treats two runs as an implementation comparison when their server label or `specSha256` differ. Then:

- These fields must match, and a field recorded by only one of the runs also refuses: `benchConfigSha256`, `bdsVersion`, `machine.fingerprint`, `topology.sha256` and `placement.profileSha256`. `analysisVersion` and `botVersion` must match too when both runs record them. A mismatch exits 2 unless `--force`.
- These may differ and are shown as `differs`: the server spec, `server.buildSha256`, the loader-config hash and the BDS zip hash. The BDS zip differs, for example, between bds-install's download and lip's.
- These are listed as warnings: a different allocator, a different runtime (Wine), different loader-config overrides, different harness or bedboo commits, and runs that are not publishable.

Between two runs of the **same** server, the build hash and loader-config hash must match too. A rebuilt Endstone venv with different dependencies, or a different `server.loaderConfig`, refuses the comparison.

The decision rule is the usual one (R12): a server ranks above another on a metric only when every ok repeat of one beats every ok repeat of the other. Use at least 3 repeats per server, and 5 for small effects.
