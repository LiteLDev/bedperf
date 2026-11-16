# @bedperf/bds-install

Production BDS provisioning: resolve a version, download and cache it, extract it, create runnable instance dirs (server.properties, behavior packs) and save or restore world snapshots. It needs no mod loader.

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
| `createInstance(opts)` → `BdsInstance` | Copies the pristine build into `opts.dir` or a fresh temp dir. `bedrock_server*`, `behavior_packs`, `resource_packs`, `definitions` and `data` are hard-linked; everything else is copied. Then it writes server.properties, optionally restores a snapshot, and installs packs. |
| `destroyInstance(instance)` | Deletes the dir and retries on EBUSY/EPERM while Windows still holds the files of a server that just exited. It refuses dirs without the `.bedperf-instance.json` marker. |
| `saveWorldSnapshot(instance, id, store?, {overwrite?})` | Copies `worlds/<level>` to `<store>/<id>/world/` and writes `manifest.json` (hash, file list, level name, BDS version). |
| `restoreWorldSnapshot(id, instance, store?, {verify?})` | Checks the stored hash (on by default), then replaces `worlds/<instance.levelName>`. |
| `installBehaviorPack(dir, packDir, levelName)` | Copies the pack to `behavior_packs/bedperf_<uuid8>` and adds `{"pack_id", "version": [x,y,z]}` to `worlds/<level>/world_behavior_packs.json` (deduplicated by uuid). |
| `mergeServerProperties(text, ...layers)` / `parseServerProperties(text)` | Rewrites keys in place, keeping comments and line endings. New keys are appended. |
| `extractZip(pathOrBytes, dest)` | Extracts with fflate one entry at a time. Checks CRC-32, rejects zip-slip paths and keeps Unix exec bits. On Linux `bedrock_server` is always made executable. |

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
