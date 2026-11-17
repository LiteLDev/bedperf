# @bedperf/bds-process

Production controller for one Bedrock Dedicated Server process. It implements the core `BdsServer` contract and adds a pure parser for BDS console lines.

## API

```ts
import { BdsProcess, parseBdsLine } from '@bedperf/bds-process'

const bds = new BdsProcess(instance, {      // instance: core BdsInstance
  logFile: 'runs/<id>/bds.log',             // optional: append every output line
  affinity: [2, 3],                         // optional, best-effort CPU pinning
  priority: 'above_normal'                  // optional, best-effort os.setPriority
})
bds.on('playerJoin', p => {})               // also: line, ready, playerLeave, probe, exit, warning
await bds.start({ readyTimeoutMs: 120_000 })
const lines = await bds.command('list', /players online/, 10_000)
await bds.listPlayers()                     // { online, max, names }
await bds.setGamerule('randomtickspeed', 3) // rejects on syntax error / unknown rule
await bds.say('hi')
await bds.op('name')                        // true = opped, false = "Could not op" (already op)
await bds.opAll()                           // op @a
await bds.stop()                            // `stop`, wait for exit, kill after timeout; idempotent
```

- `start()` spawns the server described by the `launch` option (a core `LaunchSpec`, see below). Without one it uses `vanillaLaunchSpec(instance)`: `bedrock_server.exe` on Windows, or `bedrock_server` with `LD_LIBRARY_PATH=<dir>` on Linux, cwd the instance dir. stdin is piped and the window is hidden. It resolves once the server printed `Server started` (any flavor) and the game process is known (see below). It rejects with `BdsStartError` (`reason`: `timeout` | `exit` | `portInUse` | `spawn` | `stopped`, plus `tail`, the last ~30 lines). On port-in-use it rejects as soon as BDS prints the line, and kills the process instead of waiting about 10 s for BDS to exit by itself. You can call `start()` again after the process has exited.
- `command(cmd, until, timeoutMs)` calls are serialised through a queue. A command is written only after the previous one has finished (matched, timed out or failed). It collects every non-blank, non-probe line printed after the write, until a line matches `until`, and rejects with `BdsCommandError` (`lines`) on timeout or exit.
- The queue has two lanes. A queued `priority` job runs before every queued `normal` job; the job already running is never interrupted. `sendQueued(cmd, { priority?, onSent? })` writes a command in queue order without waiting for output and resolves with the host time taken right before the write (`say()` uses it).
- `exit` reports `{ code, signal, expected }`. `expected` is false unless the exit came from `stop()`/`kill()` or a failed `start()`, so crashes and external kills show up as `expected: false`. `exit` fires on the child's `close`, after stdout has drained, so `Quit correctly` is seen first.
- `line` gets every line (stdout and stderr) with the trailing `\r` stripped, including blank lines. All other events and command collection ignore blank lines.
- `warning` (an extension of `BdsServerEvents`) reports failed affinity/priority/log-file operations. The server keeps running.

### Flavors and launchers (`LaunchSpec`)

```ts
const bds = new BdsProcess(instance, { launch })  // launch: LaunchSpec from @bedperf/bds-install
bds.on('serverPid', pid => {})                     // the game process was identified
await bds.start()
bds.serverPid    // game process (bedrock_server[_mod].exe); undefined until identified
bds.launcherPid  // the spawned process (wine, endstone/python, ...), may equal serverPid
bds.pid          // serverPid once known, launcherPid before; always the game process after start()
await bds.auxPids()  // helpers matching auxProcessPatterns, e.g. wineserver
```

- The spawn is `command args` in `cwd` with `process.env + options.env + spec.env`. The injectable `spawn` (used by the CLI's placement wrapper) gets that command line unchanged.
- **Game process.** If the basename of `command` matches `serverProcess.namePattern` (case-insensitive), the spawned process is the game (vanilla, LeviLamina's `bedrock_server_mod.exe` launched directly). Otherwise the process table is polled every 250 ms for the first process in the launcher's tree (the launcher itself included, breadth first) whose image name matches: Windows reads `Win32_Process` through one PowerShell/CIM call (pid, parent, name, creation time); Linux scans `/proc/*/stat` (ppid, comm) and also matches the basename of argv[0] from `/proc/<pid>/cmdline`, because Wine truncates `comm` to 15 characters (`bedrock_server_`) and puts the Windows image name in argv[0]. A parent link is followed only when the child is not older than the parent, so a reused pid cannot adopt strangers. If the server prints `Server started` but no game process turns up within `serverPidGraceMs` (10 s), `start()` fails with reason `noServerProcess`. Affinity/priority (`affinity`, `priority`) are applied to the game process.
- **Exit.** The run ends when the spawned process exits (Endstone's Python and wine exit with the game). If the launcher exits while the game process is still alive, the game is killed and a `warning` is emitted (the exit is unexpected unless a stop was requested). If the game process disappears while the launcher keeps running (for `orphanLauncherMs`, 5 s, with no stop in progress), the launcher is killed so the crash shows up as `exit { expected: false }`.
- **Kill.** `kill()` and the stop timeout kill the whole tree when `killTree` is set: Windows `taskkill /PID <launcher> /T /F`, then the game pid if still alive; Linux spawns the launcher `detached` (its own process group) and sends SIGKILL to the group and to the game pid. With `wine` set, `<wineserver> -k` (next to `wineBin` unless `wineserverBin` is given) runs with `WINEPREFIX` after every run, graceful or not, so no wineserver or Wine helper (services.exe, winedevice.exe, ...) outlives the server.
- `stop()` writes `stopCommand` (default `stop`).
- `auxPids()` matches `auxProcessPatterns` anywhere in the process table (wineserver is reparented, not a descendant). On Linux only processes of the current uid count and, for Wine, only those whose `/proc/<pid>/environ` has the spec's `WINEPREFIX` (a process whose environment cannot be read is kept). On Windows the match is by name only.
- The process-table helpers (`processTree`, `findServerProcess`, `findAuxProcesses`, `createProcessHost`, ...) are exported from `proctree.ts`; all OS calls go through a `ProcessHost`, which tests replace (`processHost` option).

Verified (e2e, Windows, BDS 1.26.60.6): LeviLamina 26.60.7 and LeviLamina + LeviOptimize 0.18.0 launched directly (`bedrock_server_mod.exe` is the game process, with `conhost.exe` and LeviLamina's `CrashLogger.exe` as children), Endstone 0.11.15 (`endstone.exe` → `python.exe` → `python.exe` → `bedrock_server.exe`, plus `crashpad_handler.exe`): ready, game pid, gametime at ~20 TPS, the `MC_SERVER` thread visible to sysmon, `stop()` in ~0.4–1.6 s with no process of the tree left, and a bot joining/leaving plus `listPlayers()` in each log format.

Verified on Linux (Debian bookworm container, lip 0.41 with its bundled Wine 11.21 wow64): LeviLamina 26.60.7 started as `wine bedrock_server_mod.exe` with `WINEPREFIX=<instance>/.lip/wine`. Wine execs into the game, so the spawned pid is the game process (`comm` `bedrock_server_`, argv[0] `bedrock_server_mod.exe`); thread names are truncated to 15 characters too, but `MC_SERVER` fits and is visible. wineserver and the Wine helpers (services.exe, winedevice.exe ×2, plugplay.exe, svchost.exe, lsass.exe, explorer.exe, rpcss.exe) run in sessions of their own with parent 1, so the process-group kill does not reach them; `auxPids()` finds all 8 through `WINEPREFIX`, and `wineserver -k` removes them. LeviLamina's CrashLogger.exe stays in the launcher's process group. `stop()` took ~5.5 s, nothing was left afterwards.

### Tick counter (gametime)

A script-free TPS source, used to cross-check the Script API probe TPS. `time query gametime` prints `Gametime is <n>`, a counter the server advances once per executed tick.

```ts
import { GametimeSampler, hostNow } from '@bedperf/bds-process'
import { counterTps, lowTps, maxGap, latencySummary, monotonic, Kinds } from '@bedperf/core'

const r = await bds.queryGametime({ priority: true }) // { gametime, sentAt, recvAt }

const sampler = new GametimeSampler(bds, { intervalMs: 5000, timeoutMs: 60_000 })
sampler.on('sample', s => record(Kinds.bdsGametime, s))  // { t, sentAt, gametime, latencyMs }
sampler.on('lost', ({ sentAt }) => {})                    // no reply within timeoutMs
sampler.start()
// ...
await sampler.stop({ drainMs: 2000 })
counterTps(sampler.samples, t0, t1)                      // undefined below 90 % reply coverage
```

- Times are host epoch ms from `hostNow()` (`performance.timeOrigin + performance.now()`): sub-ms and monotonic within the process. Pass window bounds on the same clock.
- `queryGametime()` goes through the command queue like `command()` and waits for the reply. `sentAt` is taken right before the bytes are written, `recvAt` when the reply line is read. It rejects with `BdsCommandError` on timeout or a command error.
- `GametimeSampler` sends on the priority lane every `intervalMs` without waiting for the reply, and pairs `Gametime is` lines with its sends first in, first out. A send without a reply within `timeoutMs` counts as `lost` and is dropped, so one swallowed command cannot shift later pairings. A reply with no send outstanding counts in `unmatched`. If a send is still queued behind a long-running normal command when the next interval comes, that interval is skipped instead of stacking sends. Write failures (BDS not running) emit `sendError` and sampling continues. Don't run `queryGametime()` concurrently with a sampler on the same server: replies are not tied to commands, so the two could swap replies. Other commands (`command()`, `listPlayers()`, ...) don't collect `Gametime is` lines, so the sampler's replies never leak into their output. A priority send still waits for a normal command that is already running (up to its timeout). The sampler keeps at most one send queued, so it cannot starve the normal lane. After a stall longer than `timeoutMs`, the late replies to sends that were dropped as lost get paired with newer sends. With the 60 s default, that only happens when the server has been unresponsive for a minute.
- Core helpers (`@bedperf/core`, `tickcounter.ts`): `counterTps(samples, t0, t1)` = (g_b − g_a)/(t_b − t_a) over the first and last reply inside the window, undefined below 90 % coverage. `lowTps(samples, 4.5)` is the slowest stretch of at least 4.5 s ("lowest 5 s" at a 5 s interval). `maxGap(samples, t0, t1)` is the longest reply-free stretch. `latencySummary` and `monotonic` cover the rest. Values are never clamped, so short windows can read slightly above 20.
- Verified on BDS 1.26.63.1 (e2e test): with `doDaylightCycle false` the time of day freezes, but gametime keeps advancing at about 20 per second, so the presets' gamerules don't affect this source. At a 1 s interval over 30 s the counter read 19.98–19.99 TPS with no losses. Reply latency was about 45 ms at p50 and under 80 ms at max on an idle server, so the reply is not instant: BDS handles console input on its own schedule. Latency is reported alongside, and rates use receive times.

### Parser

`parseBdsLine(line)` returns `{ text, ts?, tsText?, level?, logger?, format?, message, kind, ... }` with `kind` one of `ready`, `join`/`leave` (`player: { name, xuid? }`), `probe` (`record`), `portInUse` (`port?`), `error` (level ERROR/FATAL in any format) or `other`. ANSI escape sequences (CSI colors, OSC) are stripped first, also from `text` (and so from the `line` event and the log file). Three prefixes are recognised (`format`):

| format | example | notes |
|---|---|---|
| `bds` | `[2026-11-16 16:15:28:495 INFO] Server started.` | `ts` is epoch ms, parsed as local time |
| `levilamina` | `10:34:37.034 IFO [Server] Server started in (1.6s)! For help, type "help" or "?"` | colored; levels `TRC DBG IFO WRN ERR FTL` (the PreLoader prints `INFO`); `logger` = `Server`, `LeviLamina`, `PreLoader`, mod names; no date, so no `ts` |
| `endstone` | `[10:36:53 INFO]: Server started.` | levels `INFO WARNING ERROR CRITICAL ...`; the server logger has no name, other loggers keep `[name]` in `message` |

Ready is `/^Server started\b/` on the message (LeviLamina rewrites the line). `normalizeLevel` maps any printed level to `TRACE | DEBUG | INFO | WARN | ERROR | FATAL`; `stripAnsi` is exported. `src/fixtures/` holds real console captures of each flavor (raw bytes, colors included) that the tests parse. `parseLinePrefix`, `parseListHeader`, `parseListNames` and `parseGametime` (the `Gametime is <n>` reply, with or without the log prefix) are exported too. None of them do any I/O, so they work on saved `bds.log` files.

## Caveats

- BDS console output is not tied to the command that produced it. Unrelated lines that arrive while a command runs (joins, script output other than probe lines, startup ERROR banners) are collected too, so choose specific `until` patterns. `say` prints nothing on the console, so `say()` only writes the line, in queue order.
- The helpers match BDS 1.26 English output (`Game rule X has been updated to`, `Opped:`, `Could not op`, `No targets matched selector`, `Syntax error`, `Unknown command`).
- `opAll()` resolves on the first answer line. With several players, more `Opped:` lines can arrive after it.
- Affinity on Windows runs PowerShell `(Get-Process -Id pid).ProcessorAffinity`. That covers a single processor group only, so CPUs 0..62. On Linux it runs `taskset -a -p -c`, which pins all existing threads, and new threads inherit the setting. Both are applied right after spawn and are best-effort. `high`/`highest` priority may need admin/root.

## Tests

`node --test` runs the unit tests against a fake child process plus line fixtures. `BEDPERF_E2E=1 node --test src/bds-process.e2e.test.ts` runs the real-BDS tests on ports 19220/19221 and 19224/19225 (the gametime test takes about 40 s). It uses `@bedperf/testkit` by relative path. `src/flavors.e2e.test.ts` runs installed modded flavors (variables listed at its top: `BEDPERF_E2E_LEVILAMINA`, `BEDPERF_E2E_LEVIOPTIMIZE`, `BEDPERF_E2E_ENDSTONE_BIN`/`_DIR`, `BEDPERF_E2E_WINE_DIR`/`_BIN`/`_PREFIX`); it uses `@bedperf/sysmon` by relative path to check the `MC_SERVER` thread.
