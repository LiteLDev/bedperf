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
- `exit` reports `{ code, signal, expected }`. `expected` is false unless the exit came from `stop()`/`kill()` or a failed `start()`, so crashes and external kills show up as `expected: false`. `exit` fires on the child's `close`, after stdout has drained, so `Quit correctly` is seen first.
- `line` gets every line (stdout and stderr) with the trailing `\r` stripped, including blank lines. All other events and command collection ignore blank lines.
- `warning` (an extension of `BdsServerEvents`) reports failed affinity/priority/log-file operations. The server keeps running.

### Parser

`parseBdsLine(line)` returns `{ text, ts?, tsText?, level?, message, kind, ... }` with `kind` one of `ready`, `join`/`leave` (`player: { name, xuid? }`), `probe` (`record`), `portInUse` (`port?`), `error` (level ERROR/FATAL) or `other`. `ts` is epoch ms, parsed as local time. `parseLinePrefix`, `parseListHeader` and `parseListNames` are exported too. None of them do any I/O, so they work on saved `bds.log` files.

## Caveats

- BDS console output is not tied to the command that produced it. Unrelated lines that arrive while a command runs (joins, script output other than probe lines, startup ERROR banners) are collected too, so choose specific `until` patterns. `say` prints nothing on the console, so `say()` only writes the line, in queue order.
- The helpers match BDS 1.26 English output (`Game rule X has been updated to`, `Opped:`, `Could not op`, `No targets matched selector`, `Syntax error`, `Unknown command`).
- `opAll()` resolves on the first answer line. With several players, more `Opped:` lines can arrive after it.
- Affinity on Windows runs PowerShell `(Get-Process -Id pid).ProcessorAffinity`. That covers a single processor group only, so CPUs 0..62. On Linux it runs `taskset -a -p -c`, which pins all existing threads, and new threads inherit the setting. Both are applied right after spawn and are best-effort. `high`/`highest` priority may need admin/root.

## Tests

`node --test` runs the unit tests against a fake child process plus line fixtures. `BEDPERF_E2E=1 node --test src/bds-process.e2e.test.ts` runs the real-BDS test on ports 19220/19221. It uses `@bedperf/testkit` by relative path.
