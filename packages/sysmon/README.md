# @bedperf/sysmon

OS-level sampler for the BDS process. It implements the core `Sampler<SysSample>` contract and needs no native addons and no mod loader.

```ts
import { createProcessSampler } from '@bedperf/sysmon'

const sampler = createProcessSampler({
  pid: bds.pid,
  intervalMs: 1000,      // default
  topThreads: 5,         // default; 0 omits `threads`
  mainThreadWindow: 10,  // default; samples in the busiest-thread window
  tickThreadRule: 'lowest_tid_name:MC_SERVER', // default; see "Tick thread"
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
| `mainThread` | `{tid, name?, cpuPct, util, source, cpuMs}`: the tick thread (see "Tick thread"). `util = cpuPct/100`, clamped to [0, 1]. `source` is `'name'` when it was found by name, `'busiest'` when the heuristic picked it. `cpuMs` is the thread's cumulative CPU (user + kernel) at `t`, only comparable between samples with the same `tid` |
| `threads` | the top N threads by CPU in this interval |
| `threadCount`, `rssBytes`, `privateBytes`, `handles` | Windows: thread count, WorkingSet64, PrivateMemorySize64, HandleCount. Linux: Threads, VmRSS, RssAnon, and the number of open fds |
| `net` | NIC byte rates, always `scope: 'system'` (see caveats) |
| `systemCpuPct` | whole-machine busy %, from `os.cpus()` deltas |

Per-thread deltas are capped at the interval length. A thread that appears during an interval is credited with all of its cumulative CPU. NIC counters are kept per interface, and only interfaces present in both readings contribute, so an adapter that comes up does not add its lifetime byte count to one interval.

## Tick thread

`mainThread` is chosen by `tickThreadRule`:

- `lowest_tid_name:<N>` (default `lowest_tid_name:MC_SERVER`): the lowest tid among threads named `N`. BDS names its tick thread `MC_SERVER`. On Linux, threads created by a named thread inherit its name, so several threads can be called `MC_SERVER`, and the tick thread is the first one.
- `name:<N>`: the one thread named `N`. If there are none or several, there is no match.
- `busiest`: never match by name.

A thread once found by name stays selected for as long as it lives, even if one reading lacks its name, so a failed name lookup does not flip the series to another thread. When the rule finds no thread, for example because names are unavailable, the busiest-thread heuristic decides and the sample says `source: 'busiest'`. The heuristic picks the thread with the highest summed CPU over the last `mainThreadWindow` samples. It is sticky: a challenger replaces the incumbent only if its window sum is more than `switchFactor` (1.25) times the incumbent's, or if the incumbent thread is gone. The heuristic keeps running while the name rule matches, so a fallback has history.

### Tick-thread CPU per tick

`tickCpuMsPerTick(cpu, ticks, t0, t1)` combines the `cpuMs` series (`mainThreadCpuSeries(samples)` builds it) with tick-counter observations `{t, tick}`, for example from a probe:

```
(CPU(t_b) - CPU(t_a)) / (g_b - g_a)    ms of tick-thread CPU per executed tick
```

`t_a` and `t_b` are the first and last tick observations in `[t0, t1]`, and `g` is the tick counter there. CPU is linearly interpolated between the CPU samples around each of those times and is never extrapolated. The result is undefined with fewer than two tick observations in the window, when no tick advanced, when the CPU series does not cover the span, when CPU decreases, or when the thread (`tid`) changes within the span.

**This is not MSPT.** It counts only time the tick thread spent on a CPU. Time it spent blocked on locks or I/O, waiting for workers, or runnable but not scheduled is excluded, so it is a lower bound on the work per tick, not the tick's wall-clock duration. On Windows, thread CPU times are quantized to the about 15.6 ms clock tick, so use windows of many seconds.

## Backends

- **Windows**: one long-lived `powershell.exe -NoProfile -NonInteractive -Command -` child for the whole run. Node writes `bp <seq>` to the child's stdin once per interval, and the child answers with one `BPSM {json}` line. Replies are matched by `seq`, so a late reply to a timed-out request is dropped. The line carries the reading's own timestamp, process CPU, memory, handles, `[tid, cpuMs]` per thread, per-adapter NIC totals, and the helper's own CPU. Driving the child from stdin means it exits as soon as Node closes stdin or dies, so it cannot be orphaned. Thread names come from `kernel32!GetThreadDescription`. At start-up the helper compiles a small P/Invoke class with `Add-Type`, which adds about a second to the first reply. It opens each thread with `THREAD_QUERY_LIMITED_INFORMATION` and frees the returned string with `LocalFree`. Names are cached per tid and all re-read every `nameRefreshMs` (10 s by default), not on every sample. A thread that has no name yet is re-tried on its first 5 sightings after each refresh, because a thread can be named just after it starts. They are sent as `[tid, cpuMs, "name"]`, escaped to ASCII. If the API is missing (Windows before 10 1607) or `Add-Type` fails, threads simply have no names and the busiest-thread fallback applies. `threadNames: false` turns names off.
- **Linux**: reads `/proc/<pid>/{stat,status,fd}`, `/proc/<pid>/task/*/stat` (comm, and utime+stime), `/proc/<pid>/task/*/schedstat` and `/proc/<pid>/net/dev`. Per-thread CPU comes from the first `schedstat` field (on-CPU time in ns, not quantized to clock ticks) when the kernel provides it, otherwise from utime+stime. The choice is made once at the first read (`schedstat: false` forces utime+stime), so a thread's CPU never switches units mid-run. `CLK_TCK` defaults to 100 and can be overridden with `clkTck`. A zombie process or ENOENT counts as exited.

`computeSample(prev, cur, state)`, `tickCpuMsPerTick`, the tick-thread rule helpers (`parseTickThreadRule`, `applyTickThreadRule`) and all of the parsers (`parseProcStat`, `parseProcStatus`, `parseSchedstat`, `parseNetDev`, `parseHelperLine`) are pure and unit-tested.

## Overhead (Windows, measured)

The helper costs about 0.3 s of CPU to start. In steady state at 1 Hz it uses about **1 % of one core**, around 10 ms of CPU per sample. Of that, about 2 ms per sample is the NIC query, which `net: false` skips. In the e2e run against BDS, with the host already heavily loaded, it used 1.8 %. `overhead()` reports the helper's cumulative CPU so a run can record it.

## Caveats

- **Windows CPU times are quantized** to the scheduler clock tick of about 15.6 ms. A single 1 s sample therefore moves in steps of about 1.56 %, and a lightly loaded main thread alternates between 0 % and roughly 10 to 25 %. Read `util` as a mean over many samples, as a ramp step does, not per sample.
- **The busiest-thread fallback is a heuristic.** It is only used when no thread matches `tickThreadRule`. On an idle or lightly loaded server, short bursts from worker threads, such as chunk generation when bots join, can briefly win the window. Under real load the tick thread dominates and stays selected. The util proxy also counts neither time spent waiting on locks nor work offloaded to other threads (see `docs/methodology.md`).
- **`net` is system scope** and excludes loopback. On Windows, traffic to bots on `127.0.0.1` does not appear in the NIC counters at all, so a colocated loadgen shows roughly 0 bot traffic. Use a separate loadgen host to measure bandwidth. On Linux, `/proc/<pid>/net/dev` covers the whole network namespace, and `lo` is excluded.
- **Thread-name caveats.** Linux truncates `comm` to 15 bytes, so a `name:` rule longer than that never matches there and falls back to `busiest`. `lowest_tid_name` relies on the tick thread having the lowest tid among its namesakes. That holds for BDS on Linux, where the workers that inherit `MC_SERVER` are created after it, unless tids wrap around. On Windows tids are not allocated in order, but BDS names only one thread `MC_SERVER`.
- **Linux thread vs process CPU.** With schedstat, thread CPU has ns resolution while process CPU (`cpuPct`) still comes from tick-quantized utime+stime, so in a single sample a thread's `cpuPct` can slightly exceed the process's.
- macOS is not supported (`createProcessSampler` throws).

## Tests

```
corepack pnpm --filter @bedperf/sysmon test   # unit tests (+ a quick self-sampling test on Windows)
BEDPERF_E2E=1 node --test src/e2e.test.ts      # real BDS: idle vs 5 bots, tick thread by name + CPU/tick, overhead, helper cleanup, target exit
```

The e2e test imports `@bedperf/testkit` by relative path, because testkit is not a declared dependency of this package.
