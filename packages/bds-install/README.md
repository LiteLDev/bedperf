# @bedperf/bds-install

Production BDS provisioning: resolve a version, download and cache it, extract it, create runnable instance dirs (server.properties, behavior packs) and save or restore world snapshots. `ensureServer` also installs the modded flavors (LeviLamina with mods, natively or under Wine, and Endstone) and says how to launch them.

## API

```ts
import { resolveVersion, ensureBds, createInstance, destroyInstance, saveWorldSnapshot, restoreWorldSnapshot } from '@bedperf/bds-install'

const r = await resolveVersion('latest')            // or 'preview' or '1.26.63.1'; platform defaults to the host
await ensureBds(r, { acceptEula: true })            // or ensureBds('1.26.63.1', { acceptEula: true })
const inst = await createInstance({
  version: r.version, port: 19132, levelName: 'bench',
  presets: ['bench-default'], properties: { 'level-seed': '1' },
  behaviorPacks: ['/path/to/probe-pack'],
  worldSnapshot: { id: 'my-world' }                 // optional
})
// ... run BDS in inst.dir (see @bedperf/bds-process), stop it ...
await saveWorldSnapshot(inst, 'my-world-2')
await destroyInstance(inst)
```

| function | notes |
|---|---|
| `resolveVersion(channel, platform?, {fetch?, timeoutMs?, preview?})` | `latest`/`preview` query `net-secondary.web.minecraft-services.net/api/v1.0/download/links` with a browser User-Agent (without one the request hangs) and a 15 s timeout. An explicit `x.y.z.w` builds the URL from the `bin-win`, `bin-linux`, `bin-win-preview` or `bin-linux-preview` pattern without touching the network. Returns `{version, url, platform, preview}`. |
| `ensureBds(version \| ResolvedBds, {acceptEula: true, cacheRoot?, platform?, fetch?, idleTimeoutMs?, keepZip?, onProgress?})` | Throws unless `acceptEula === true`. If `<cacheRoot>/<version>/bedrock_server[.exe]` exists it returns at once (`cached: true`), with no network access and no writes. Otherwise it downloads to a temp file, checks the size against content-length, renames the file to `bedrock-server-<version>.zip` and writes `<version>.json` (url, size, sha256). It then extracts with fflate into a temp dir and renames that to `<version>/`. A zip that matches the sidecar's sha256 is reused instead of downloaded again. |
| `bdsZipSha256(version, {cacheRoot?, platform?})` | The verified zip sha256 from the `<version>.json` sidecar (for run provenance), or undefined when the build was not downloaded by bds-install. |
| `createInstance(opts)` → `BdsInstance` | Copies the pristine build into `opts.dir` or a fresh temp dir. `bedrock_server*`, `behavior_packs`, `resource_packs`, `definitions` and `data` are hard-linked; everything else is copied. Then it writes server.properties, optionally restores a snapshot, and installs packs. |
| `destroyInstance(instance)` | Deletes the dir and retries on EBUSY/EPERM while Windows still holds the files of a server that just exited. It refuses dirs without the `.bedperf-instance.json` marker. |
| `saveWorldSnapshot(instance, id, store?, {overwrite?})` | Copies `worlds/<level>` to `<store>/<id>/world/` and writes `manifest.json` (hash, file list, level name, BDS version). |
| `restoreWorldSnapshot(id, instance, store?, {verify?})` | Checks the stored hash (on by default), then replaces `worlds/<instance.levelName>`. |
| `installBehaviorPack(dir, packDir, levelName)` | Copies the pack to `behavior_packs/bedperf_<uuid8>` and adds `{"pack_id", "version": [x,y,z]}` to `worlds/<level>/world_behavior_packs.json` (deduplicated by uuid). |
| `mergeServerProperties(text, ...layers)` / `parseServerProperties(text)` | Rewrites keys in place, keeping comments and line endings. New keys are appended. |
| `extractZip(pathOrBytes, dest)` | Extracts with fflate one entry at a time. Checks CRC-32, rejects zip-slip paths and keeps Unix exec bits. On Linux `bedrock_server` is always made executable. |

## Server flavors (`ensureServer`)

```ts
import { ensureServer, createInstance } from '@bedperf/bds-install'
import { SERVER_PRESETS } from '@bedperf/core'

const srv = await ensureServer(SERVER_PRESETS['levilamina-levioptimize'], { acceptEula: true })
const inst = await createInstance({ server: srv, port: 19132, presets: ['bench-default'] })
const launch = srv.launch(inst.dir)   // LaunchSpec for @bedperf/bds-process
// srv.build: ServerBuildInfo (artifacts with sha256, buildSha256, exeName, notes, loaderConfig) → meta.server
```

`ensureServer(spec, { acceptEula: true, cacheRoot?, bdsCacheRoot?, bdsVersion?, hostPlatform?, exec?, fetch?, log?, lipCommand?, python? })` returns `{ build, pristineDir, launch(instanceDir), instanceFiles? }`. `cacheRoot` is the bedperf cache root (parent of `bds/`); `bdsVersion` (default `latest`) goes through core's `bdsVersionFor`, so modded flavors use `FLAVOR_BDS_VERSION` (1.26.60.6) unless an exact version is requested. Every external command (lip, python, pip, wine, tar) runs through the injectable `exec`.

| flavor / runtime | install | pristine dir | LaunchSpec |
|---|---|---|---|
| `bds` native | `ensureBds` (vanilla cache untouched) | `<cache>/bds/<version>` | `<instance>/bedrock_server[.exe]`; Linux env `LD_LIBRARY_PATH=<instance>:$LD_LIBRARY_PATH`; `killTree: false` |
| `levilamina` (+mods) native, Windows only | in `<ws>`: `lip setup --game 1.26.60 --loader levilamina@<v> --accept-eula`, then `lip install github.com/LiteLDev/LeviOptimize@<v>` per mod | `<cache>/servers/<slug>-<hash12>/server` | `<instance>/bedrock_server_mod.exe` (PeEditor-patched); `killTree: true` (CrashLogger child) |
| `levilamina` (+mods) `wine`, Linux only | the same lip commands (lip's default `windows` build; lip installs its Kron4ek Wine into `$XDG_DATA_HOME/lip/wine/` and the VC++ runtime into the prefix) | same | command = lip's `wine`, args = `[<instance>/bedrock_server_mod.exe]`, env `WINEPREFIX=<pristine>/.lip/wine`, `WINEDEBUG=-all`; `wine: {prefix, wineBin, wineserverBin, version}`; process pattern `^bedrock_server_(mod(\.exe)?)?$` (comm is truncated to `bedrock_server_`); aux patterns for `wineserver` and Wine's service exes; `killTree: true` |
| `endstone` native | `python -m venv <root>/venv`, `pip download --no-deps endstone==<v>` (wheel kept for its sha256), `pip install <wheel>`; vanilla BDS (`ensureBds`) copied into `server/` with `version.txt` = Endstone's Minecraft version so Endstone does not download its own | `<cache>/servers/endstone-<hash12>/server` | Linux: `<venv>/bin/endstone -y -s <instance> --no-interactive`; Windows: `<venv>\Scripts\python.exe -c <launcher> -y -s <instance> --no-interactive` (see below); process pattern `^bedrock_server(\.exe)?$`; `killTree: true` |

- **Cache key and markers.** Modded builds live in `<cache>/servers/<slug>-<hash12>/` (never inside `bds/`), with `hash12` = `sha256Json({spec: serverSpecSha256(spec), bdsVersion})`. `.bedperf-complete.json` (the build info and Wine paths) is written last; without it the dir is wiped and installed again. A cached build runs no commands at all. Installs are not safe to run concurrently for the same spec. For LeviLamina the BDS version lip actually installed (from the zip URL in `.lip/state.json`) must equal the requested one, else the install fails.
- **Artifacts.** `bds`: zip sha256 (vanilla: the sidecar; LeviLamina: the zip in lip's cache, `http-<sha256(url)>`, else the hash of the files lip placed). LeviLamina and every lip dependency (`preloader`, `crashlogger`, `peeditor`, `bedrock-runtime-data`, `levilamina-loc`) and mods: `hashTree` of the files lip recorded for the package in `.lip/state.json`, `source` = `<id>@<version>#<commit>`. `lip`: version + sha256 of the binary. `wine`: version + `hashTree` of the Wine build. `endstone`: wheel sha256; `python`: version; `python-deps`: sha256 of the sorted `pip freeze --all` of the venv (also kept as `pip-freeze.txt`), since Endstone's dependencies resolve from PyPI at install time.
- **LeviLamina config.** The real keys (config version 43) are `modules.crashLogger.uploadToSentry`, `targeted.enableStatistics`, `targeted.vulnerabilityFixes.limitIPFrequency`. LeviLamina only writes `mods/LeviLamina/config/Config.json` on first start, and it merges a partial file with its defaults (keeping the given values). So no server is started during install: `instanceFiles` carries `NEUTRAL_LOADER_CONFIG.levilamina` deep-merged with `spec.loaderConfig`, `createInstance` writes it into each instance, and the same object is `build.loaderConfig`. The loader config is therefore per instance and not part of the build key. LeviOptimize keeps its defaults (`mods/LeviOptimize/config/config.json`, written on first start).
- **Endstone.** Linux: Endstone LD_PRELOADs its bundled mimalloc and `libendstone_runtime.so` (`build.allocator = 'mimalloc-preload'`). Windows: it starts `bedrock_server.exe` with the runtime injected through detours, and before that may run an elevated `CheckNetIsolation LoopbackExempt -a` (a UAC prompt) when the Minecraft UWP app is not loopback-exempt. No flag or variable turns that off, so the Windows LaunchSpec runs Endstone's CLI through the venv's Python with `WindowsBootstrap._add_loopback_exemption` replaced by a no-op (the exemption only matters for the Store client connecting to localhost). On every start Endstone also writes `endstone.toml`, `plugins/` and a rate limit for packet 115 into `packetlimitconfig.json` of the instance.
- **Endstone on Linux** needs the shared libpython of the venv's Python: `bedrock_server` links against `libpython3.X.so.1.0`, which Endstone finds through `LD_LIBRARY_PATH=<LIBDIR>`. Debian's `python3` does not include it (`apt-get install libpython3.11`), so the install checks for it and fails with that hint.
- **Wine.** The game runs with lip's `wine` directly (not `lip run`), sharing the workspace's prefix. Instances on one host share one `wineserver`, so killing `wineserver` by name stops every Wine instance of that prefix.
- **lip.** Each lip operation is atomic, so a failed one (usually a GitHub timeout) is retried up to 3 times. Uses `lip` on PATH (`lipCommand` to override). On Linux without lip, `lip-0.41.0-linux-x64.tar.xz` is downloaded from GitHub, checked against the release's `SHA256SUMS` and extracted (`tar -xJf`, needs xz) into `<cache>/tools/lip-0.41.0/`.

`createInstance({ server, port, ... })` accepts an `InstalledServer` (or `pristineDir` + `exeName`): it checks `build.exeName`, takes the version from the build and sets `BdsInstance.platform` to the platform the server runs on (`linux` for a Wine build), writes `instanceFiles`, and copies loader files: `bedrock_server_mod.exe`, `bedrock_server.exe.bak`, `PreLoader.dll`, `PeEditor.exe` and `bedrock_runtime_data` are hard-linked; `mods/` and `plugins/` are real directories whose binaries (`.dll`, `.pdb`, `.exe`, `.so`, `.pyd`, `.whl`) are linked and other files copied; `.lip/` is copied except `.lip/wine`, the Wine prefix, which stays shared in the pristine dir through `WINEPREFIX` (Wine updates it at run time).

### server.properties layering

Layers apply in this order, and later layers win: pristine file < `REQUIRED_BOT_PROPERTIES` (core) < `presets` (in the given order) < `properties` < `server-port`/`server-portv6`/`level-name` from the instance options. Overrides can therefore replace a required property, such as `online-mode=true`, on purpose. Doing so may stop bots from joining.

### Presets (`PRESETS`)

| name | properties |
|---|---|
| `vanilla-default` | none: stock server plus the required bot properties |
| `bench-default` | `view-distance=10`, `tick-distance=4`, `max-players=1000`, `max-threads=0` (use all cores), `player-idle-timeout=0`, `default-player-permission-level=operator` (lets bots run the commands used for RTT) |
| `bench-flat` | `bench-default` + `level-type=FLAT` |

### Cache layout

The default cache root matches `bdsCacheRoot()` in `@bedperf/testkit`: `%LOCALAPPDATA%\bedperf\cache\bds` on Windows, `~/.cache/bedperf/bds` on Linux, or `$BEDPERF_CACHE_DIR/bds`. It holds the following.

```
<root>/<version>/                      pristine extracted build (never modified)
<root>/bedrock-server-<version>.zip
<root>/<version>.json                  sidecar: url, size, sha256, timestamps
```

A build for a platform other than the host's gets a `-win` or `-linux` suffix. Snapshots default to the sibling `snapshots/` dir.

### Snapshot hash

The hash is sha256 over each file in sorted relative-path order (`/` separators), computed as `path NUL size NUL bytes`. It does not depend on mtimes, on the absolute location, or on the order in which files were created.

## Caveats

- Downloading BDS means you accept the [Minecraft EULA](https://www.minecraft.net/eula). That is why `acceptEula: true` is mandatory.
- Never write into the pristine dir, or into hard-linked files in an instance. Unlink a file before replacing it (`createInstance` does this).
- **Snapshot only a stopped server.** BDS flushes chunks to LevelDB only every 5–10 s, and `save hold` does not flush, so a snapshot of a running server can be stale or torn.
- Zip64 archives are not supported. BDS zips are about 90 MB.
- `ensureBds` with a channel (`latest`/`preview`) always asks the links API first. Pass an explicit version to stay offline.
