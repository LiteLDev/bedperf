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

- `start()` spawns `bedrock_server.exe` on Windows, or `bedrock_server` with `LD_LIBRARY_PATH=<dir>` on Linux. The cwd is the instance dir, stdin is piped and the window is hidden. It resolves on `Server started.`. It rejects with `BdsStartError` (`reason`: `timeout` | `exit` | `portInUse` | `spawn` | `stopped`, plus `tail`, the last ~30 lines). On port-in-use it rejects as soon as BDS prints the line, and kills the process instead of waiting about 10 s for BDS to exit by itself. You can call `start()` again after the process has exited.
- `command(cmd, until, timeoutMs)` calls are serialised through a queue. A command is written only after the previous one has finished (matched, timed out or failed). It collects every non-blank, non-probe line printed after the write, until a line matches `until`, and rejects with `BdsCommandError` (`lines`) on timeout or exit.
- The queue has two lanes. A queued `priority` job runs before every queued `normal` job; the job already running is never interrupted. `sendQueued(cmd, { priority?, onSent? })` writes a command in queue order without waiting for output and resolves with the host time taken right before the write (`say()` uses it).
- `exit` reports `{ code, signal, expected }`. `expected` is false unless the exit came from `stop()`/`kill()` or a failed `start()`, so crashes and external kills show up as `expected: false`. `exit` fires on the child's `close`, after stdout has drained, so `Quit correctly` is seen first.
- `line` gets every line (stdout and stderr) with the trailing `\r` stripped, including blank lines. All other events and command collection ignore blank lines.
- `warning` (an extension of `BdsServerEvents`) reports failed affinity/priority/log-file operations. The server keeps running.

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

`parseBdsLine(line)` returns `{ text, ts?, tsText?, level?, message, kind, ... }` with `kind` one of `ready`, `join`/`leave` (`player: { name, xuid? }`), `probe` (`record`), `portInUse` (`port?`), `error` (level ERROR/FATAL) or `other`. `ts` is epoch ms, parsed as local time. `parseLinePrefix`, `parseListHeader`, `parseListNames` and `parseGametime` (the `Gametime is <n>` reply, with or without the log prefix) are exported too. None of them do any I/O, so they work on saved `bds.log` files.

## Caveats

- BDS console output is not tied to the command that produced it. Unrelated lines that arrive while a command runs (joins, script output other than probe lines, startup ERROR banners) are collected too, so choose specific `until` patterns. `say` prints nothing on the console, so `say()` only writes the line, in queue order.
- The helpers match BDS 1.26 English output (`Game rule X has been updated to`, `Opped:`, `Could not op`, `No targets matched selector`, `Syntax error`, `Unknown command`).
- `opAll()` resolves on the first answer line. With several players, more `Opped:` lines can arrive after it.
- Affinity on Windows runs PowerShell `(Get-Process -Id pid).ProcessorAffinity`. That covers a single processor group only, so CPUs 0..62. On Linux it runs `taskset -a -p -c`, which pins all existing threads, and new threads inherit the setting. Both are applied right after spawn and are best-effort. `high`/`highest` priority may need admin/root.

## Tests

`node --test` runs the unit tests against a fake child process plus line fixtures. `BEDPERF_E2E=1 node --test src/bds-process.e2e.test.ts` runs the real-BDS tests on ports 19220/19221 and 19224/19225 (the gametime test takes about 40 s). It uses `@bedperf/testkit` by relative path.
