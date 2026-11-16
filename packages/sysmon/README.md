# @bedperf/sysmon

OS-level sampler for the BDS process. It implements the core `Sampler<SysSample>` contract and needs no native addons and no mod loader.

```ts
import { createProcessSampler } from '@bedperf/sysmon'

const sampler = createProcessSampler({
  pid: bds.pid,
  intervalMs: 1000,      // default
  topThreads: 5,         // default; 0 omits `threads`
  mainThreadWindow: 10,  // default; samples in the main-thread window
  net: true,             // default; system NIC counters
  onEnd: (reason, err) => {} // 'exited' | 'error'; not called for stop()
})
await sampler.start(s => console.log(s))
// ...
await sampler.stop()
sampler.overhead() // { helperPid?, helperCpuMs?, wallMs, samples }
```

The first raw reading is only a baseline, so the first `SysSample` arrives after one interval. When the target exits, the sampler stops by itself, calls `onEnd('exited')` and emits nothing further. Up to `maxConsecutiveErrors` (3 by default) read errors in a row are tolerated, and the next one ends sampling with `onEnd('error', err)`. Samplers are single-use. Main-thread stickiness can be tuned with `switchFactor` (1.25 by default).

## Outputs (`SysSample`)

| field | meaning |
|---|---|
| `cpuPct` | whole-process CPU over the interval, in % of one core (can exceed 100) |
| `mainThread` | `{tid, cpuPct, util}`: the thread with the highest summed CPU over the last `mainThreadWindow` samples. It is sticky: a challenger replaces it only if its window sum is more than 1.25x the incumbent's, or if the incumbent thread is gone. `util = cpuPct/100`, clamped to [0, 1] |
| `threads` | the top N threads by CPU in this interval |
| `threadCount`, `rssBytes`, `privateBytes`, `handles` | Windows: thread count, WorkingSet64, PrivateMemorySize64, HandleCount. Linux: Threads, VmRSS, RssAnon, and the number of open fds |
| `net` | NIC byte rates, always `scope: 'system'` (see caveats) |
| `systemCpuPct` | whole-machine busy %, from `os.cpus()` deltas |

Per-thread deltas are capped at the interval length. A thread that appears during an interval is credited with all of its cumulative CPU. NIC counters are kept per interface, and only interfaces present in both readings contribute, so an adapter that comes up does not add its lifetime byte count to one interval.

## Backends

- **Windows**: one long-lived `powershell.exe -NoProfile -NonInteractive -Command -` child for the whole run. Node writes `bp <seq>` to the child's stdin once per interval, and the child answers with one `BPSM {json}` line. Replies are matched by `seq`, so a late reply to a timed-out request is dropped. The line carries the reading's own timestamp, process CPU, memory, handles, `[tid, cpuMs]` per thread, per-adapter NIC totals, and the helper's own CPU. Driving the child from stdin means it exits as soon as Node closes stdin or dies, so it cannot be orphaned. Thread names are not collected, because `GetThreadDescription` would need an `Add-Type` compile.
- **Linux**: reads `/proc/<pid>/{stat,status,fd}`, `/proc/<pid>/task/*/stat` (utime+stime and comm), and `/proc/<pid>/net/dev`. `CLK_TCK` defaults to 100 and can be overridden with `clkTck`. A zombie process or ENOENT counts as exited.

`computeSample(prev, cur, state)` and all of the parsers (`parseProcStat`, `parseProcStatus`, `parseNetDev`, `parseHelperLine`) are pure and unit-tested.

## Overhead (Windows, measured)

The helper costs about 0.3 s of CPU to start. In steady state at 1 Hz it uses about **1 % of one core**, around 10 ms of CPU per sample. Of that, about 2 ms per sample is the NIC query, which `net: false` skips. In the e2e run against BDS, with the host already heavily loaded, it used 1.8 %. `overhead()` reports the helper's cumulative CPU so a run can record it.

## Caveats

- **Windows CPU times are quantized** to the scheduler clock tick of about 15.6 ms. A single 1 s sample therefore moves in steps of about 1.56 %, and a lightly loaded main thread alternates between 0 % and roughly 10 to 25 %. Read `util` as a mean over many samples, as a ramp step does, not per sample.
- **Main-thread detection is a heuristic.** On an idle or lightly loaded server, short bursts from worker threads, such as chunk generation when bots join, can briefly win the window. Under real load the tick thread dominates and stays selected. The util proxy also counts neither time spent waiting on locks nor work offloaded to other threads (see `docs/methodology.md`).
- **`net` is system scope** and excludes loopback. On Windows, traffic to bots on `127.0.0.1` does not appear in the NIC counters at all, so a colocated loadgen shows roughly 0 bot traffic. Use a separate loadgen host to measure bandwidth. On Linux, `/proc/<pid>/net/dev` covers the whole network namespace, and `lo` is excluded.
- macOS is not supported (`createProcessSampler` throws).

## Tests

```
corepack pnpm --filter @bedperf/sysmon test   # unit tests (+ a quick self-sampling test on Windows)
BEDPERF_E2E=1 node --test src/e2e.test.ts      # real BDS: idle vs 5 bots, overhead, helper cleanup, target exit
```

The e2e test imports `@bedperf/testkit` by relative path, because testkit is not a declared dependency of this package.
