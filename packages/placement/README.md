# @bedperf/placement

CPU placement for a benchmark run: read the machine's CPU topology, plan which logical CPUs the server, the bot fleet and the harness get, apply the plan to a process, and verify that a running process (and every one of its threads) stays inside it. No native addons: Windows goes through PowerShell with a small `Add-Type` P/Invoke helper, Linux through `/proc`, `/sys` and `taskset`.

```ts
import { readTopology, parseProfile, planPlacement, planUsable, applyToPid, wrapSpawn, verifyPlacement } from '@bedperf/placement'

const topology = await readTopology()
const plan = planPlacement(topology, parseProfile(JSON.parse(profileJson)))
if (!planUsable(plan)) throw new Error(plan.checks.filter(c => c.level === 'fail').map(c => c.summary).join('; '))

// Linux: start the server already placed. Windows: unchanged command, apply after spawn.
const w = wrapSpawn(exe, args, plan)              // { command, args, method: 'preexec' | 'post-spawn', postSpawnApplyRequired }
const child = spawn(w.command, w.args)
if (w.postSpawnApplyRequired) await applyToPid(child.pid!, plan.serverCpus, plan.priority)

const v = await verifyPlacement(child.pid!, plan)  // { verified, checks, violations, narrowed, ... }
```

Every OS access goes through a `PlacementRunner` (`exec`, `readFile`, `readDir`, `setPriority`). `createNodeRunner()` is the default; tests pass fakes.

## Topology (`readTopology`)

Only the CPUs the harness itself may use are listed.

| | Windows | Linux |
|---|---|---|
| CPUs and cores | `GetSystemCpuSetInformation`: Group, LogicalProcessorIndex, CoreIndex, LastLevelCacheIndex, NumaNodeIndex, EfficiencyClass. CPU = group*64 + logical index. SMT siblings share (group, CoreIndex) | `/sys/devices/system/cpu/online` and `cpu*/topology`: the core key is (physical_package_id, die_id, core_id) |
| efficiency class (higher is faster) | EfficiencyClass | `/sys/devices/cpu_core/cpus` (1) and `cpu_atom/cpus` (0); else the distinct `cpu*/cpu_capacity` values, ranked (values within 10% share a class, so favored-core boosts don't count); else one class |
| allowed CPUs | the harness's process affinity mask | `Cpus_allowed_list` of `/proc/self/status` |
| virtualization | BIOS `SystemManufacturer` / `SystemProductName` in the registry | `wsl2` if `/proc/sys/kernel/osrelease` mentions microsoft/wsl; DMI `sys_vendor` / `product_name`; the `hypervisor` cpuinfo flag |

`placementKind` is `vcpu` on a virtualized host (including WSL2) and `physical` otherwise.

## Profiles

```json
{
  "label": "desktop-default",
  "placement": { "serverCpus": "auto", "botCpus": "auto", "harnessCpus": "bot", "priority": "normal" },
  "gates": { "minTps": 19.5 }
}
```

CPU sets are `"auto"`, a kernel-style list (`"0-15,20"`) or an array of indices. `harnessCpus` may be `"bot"` (share the bot set). `priority` is `normal` or `above_normal`. `parseProfile` validates and fills these defaults. `profileSha256(profile)` is the sha256 of the canonical JSON (sorted keys, no whitespace) of `{placement, gates}`: the label is left out, missing gates hash like `{}`, and explicit CPU sets are hashed in canonical list form (`"3,2,1,0"`, `[0,1,2,3]` and `"0-3"` hash alike). Two runs with the same hash used the same placement rules.

## Planning (`planPlacement`)

With both sets `auto`:

- **hybrid CPUs** (more than one efficiency class): the server gets the fastest class and the bots the rest, if that gives the bots at least 4 logical CPUs;
- **otherwise** cores are sorted by (efficiency, highest first CPU first) and the bots take whole cores until they hold half the cores, or both a quarter of them (rounded up) and at least 4 logical CPUs. The server gets the rest.

Whole cores always move together, so `auto` never splits SMT siblings. Explicit sets, including an explicit harness set, are reserved first. When only one of server and bots is `auto`, it gets every remaining allowed CPU.

| check | level | when |
|---|---|---|
| `bot_cpus` | fail | the bots get fewer than 4 logical CPUs |
| `server_cpus` | fail | the server gets none |
| `too_few_cores` | fail | `auto` with fewer than two physical cores |
| `unknown_cpus` | fail | an explicit CPU does not exist or is not allowed for the harness |
| `processor_group` | fail | Windows and a CPU ≥ 64 (affinity masks only reach group 0) |
| `smt_split` | warn | a bot or harness CPU is an SMT sibling of a server CPU |
| `server_classes` | warn | the server set mixes efficiency classes |
| `overlap` | warn | the server shares CPUs with the bots or harness |
| `vcpu` | info | virtualized host |

### Distributed runs

`planPlacement(topology, profile, opts)` takes `{ bots: 'local' | 'remote', role: 'server' | 'bots-only' }`. The plan records which kind it is in `mode` (`local`, `remote-bots`, `bots-only`; plans from before this field are `local`).

**Server machine, bots on agents** (`{ bots: 'remote' }`, `mode: 'remote-bots'`): no bot set is reserved (`botCpus` is empty) and the harness gets a set of its own. With `auto`:

- **hybrid CPUs**: the server gets every core of the fastest class and the harness every slower core, if the fastest class holds at least a quarter of the cores (rounded up), so a single "prime" core never becomes the whole server;
- **otherwise** the harness takes the slowest, highest-numbered whole cores until it holds `HARNESS_CPUS` (2) logical CPUs or a quarter of the cores (rounded up), whichever comes first, and the server gets every other core. Two logical CPUs cover the orchestrator event loop plus sysmon sampling and log/probe parsing, which stay well under two busy CPUs.

An explicit `botCpus` is ignored with a `bot_cpus_ignored` warning, and `harnessCpus: "bot"` (the default) means auto. With an explicit `serverCpus` the harness gets the whole cores the server does not touch (else every remaining CPU); with only an explicit `harnessCpus` the server gets the fastest class of what is left. The `bot_cpus` check does not apply; `bots_remote` (info) says why, and `harness_cpus` fails when the harness gets nothing. On a single core the server still runs and the harness shares its CPUs (`harness_shared` and `overlap`, both warnings).

**Agent machine** (`{ role: 'bots-only' }`, `mode: 'bots-only'`): `serverCpus` is empty and the bot workers get every allowed CPU except the agent's own set (the same `HARNESS_CPUS` rule). E-cores are used too: bots are network and JS bound, nothing measured runs on an agent, and an agent that runs short of CPU reports itself saturated. On a single core the agent shares the bot CPUs (`harness_shared`, info). An explicit `serverCpus` is ignored with a warning. With explicit `botCpus` the agent gets the whole cores the bots do not touch (else every remaining CPU, else it shares the bot set); explicit bot and agent sets that partly overlap are warned (`overlap`). In a container, only the CPUs in the harness's own affinity (`--cpuset-cpus`) are planned; a CFS quota (`--cpus`) does not show up in affinity and is not seen. The agent places each worker with `applyBotWorker(pid, plan)` (`applyToPid(pid, plan.botCpus, 'normal')`) and checks it with `verifyBotWorker(pid, plan)`.

## Applying

`applyToPid(pid, cpus, priority)` returns `{ok, affinityError?, priorityError?, method: 'post-spawn'}` and never throws for an OS refusal:

- Windows: `ProcessorAffinity` mask and `PriorityClass` (`Normal` / `AboveNormal`) through PowerShell. Setting the process mask also resets every thread's mask.
- Linux: `taskset -a -p -c <cpus> <pid>` (all threads), then the renice equivalent, `setpriority` on every thread (`above_normal` = nice -5, which needs root or CAP_SYS_NICE; a refusal is reported in `priorityError`).

`wrapSpawn(cmd, args, plan, {role})` returns `taskset -c <cpus> [nice -n <n>] cmd args` on Linux (`method: 'preexec'`). Both tools exec in place, so the pid is the server's and every thread it ever starts inherits the mask. Note that `nice -n` is relative to the harness's own nice. Without CAP_SYS_NICE, GNU `nice` only warns and runs the command anyway, so `priorityUnconfirmed` is true whenever a negative nice is requested: call `verifyPlacement` after the spawn. On Windows the command comes back unchanged with `postSpawnApplyRequired: true` (`method: 'post-spawn'`). `role` is `server` (the default), `bot` or `harness`. Only the server gets the plan's priority.

### Launchers (lip, wine, Endstone)

A server may be started through a launcher (`LaunchSpec.command` is lip, wine or Python for Endstone) whose descendant is the game process, plus helpers that are not descendants (`auxProcessPatterns`, e.g. `wineserver`).

- **Linux**: wrap the launcher with `wrapSpawn`. The `taskset` mask and `nice` carry over fork and exec, so the game child, Wine's helper `.exe` processes and a wineserver that wine forks (it daemonizes, but keeps the mask) are all covered from creation (`coversDescendants: true`). A wineserver that was already running for the prefix was not started under the wrapper: place it with `applyToServerTree(plan, { auxPids })`.
- **Windows**: a child takes its parent's affinity mask when it is created, and an above-normal priority class is not inherited. Call `applyToServerTree(plan, { launcherPid })` right after the spawn so children the launcher creates later inherit the mask, then `applyToServerTree(plan, { serverPid, auxPids })` on the resolved game pid as soon as it is found and before the server is reported ready. A game process created before the launcher was placed (the race between spawn and the first apply) runs unplaced until the second call; setting its process mask then resets every existing thread's mask, so the gap stays inside startup. Endstone's `bedrock_server.exe`, which Python starts with an injected DLL, is handled this way.

`applyToServerTree` gives every listed process the server's CPUs and priority (a wineserver serves the game's Wine calls, so it sits on the game's critical path), in parallel, applying a pid listed twice once. It is `ok` when the game got its CPUs and priority and every launcher or helper got its CPUs or had already exited (`ApplyResult.gone`, also set on Windows when the process exits between lookup and apply).

## Verifying (`verifyPlacement`)

`verifyPlacement(pid, plan, {cpus?, priority?})` reads the process affinity, every thread's affinity (Windows `GetThreadGroupAffinity` after `OpenThread`; Linux `/proc/<pid>/task/<tid>/status` `Cpus_allowed_list`) and the priority (Windows priority class; Linux nice from `/proc/<pid>/stat`). It reports these violations:

- `process_affinity`: the process mask differs from the plan;
- `thread_outside`: a thread may run on a CPU outside the plan;
- `priority`: the observed priority is not the planned one (pass `priority: null` to skip this check);
- `process_gone`: the process has exited.

A thread narrowed to a strict subset of the plan is listed in `narrowed` and is not a violation. `verified` is true when there are no violations. It defaults to the server set and priority. To check a bot worker, pass `{cpus: plan.botCpus, priority: 'normal'}` (or use `verifyBotWorker`).

`verifyServerProcesses(plan, { serverPid, launcherPid?, auxPids? })` verifies a launched server as a set (`PlacementSetVerification`): the game process fully (process mask, every thread, priority), and the launcher and helpers for process and thread affinity only. A launcher or helper that has exited is recorded as info (`launcher_gone` / `aux_gone`), not a failure. A game running under Wine on Linux is an ordinary Linux process whose threads are in `/proc/<pid>/task`, and Wine maps `SetThreadAffinityMask` to `sched_setaffinity`, so a game thread that widens its own mask shows up as `thread_outside`.

## Tests

`node --test src/placement.test.ts src/remote.test.ts` runs on fakes, with topology fixtures for a 14700F-like hybrid (8P with HT + 12E, on both Windows and Linux), a plain 8c/16t, a 4-core part without SMT, and WSL2; `remote.test.ts` covers remote-bots and bots-only plans and launched servers (Wine on Linux and Endstone on Windows, as fake `/proc` and PowerShell data). `BEDPERF_E2E=1 node --test src/placement.e2e.test.ts` reads the real topology, starts a real BDS, applies a 2-CPU set taken from the plan's server CPUs, verifies it, then changes the affinity out of band and checks that verification fails.
