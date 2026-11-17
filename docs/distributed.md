# Distributed runs

Bots are expensive: about 0.16–0.2 cores and 60–85 MB each, depending on the scenario. When they share a machine with the server they compete with it for CPU, memory bandwidth and caches, and they saturate before a fast server does (the run is then `loadgenLimited`). A distributed run keeps the server alone on its machine and runs the bots on one or more other machines. The methodology rule for this is R14 ([methodology.md](methodology.md#rules)).

## Architecture

```text
server machine                                   bot machines (one agent each)
┌───────────────────────────────────┐            ┌────────────────────────────────────┐
│ BDS / LeviLamina / Endstone ...   │◀── UDP ────│ bedperf agent ─ fork ─ loadgen worker│
│   (game port, default 19200)      │   (bots)   │               └ fork ─ loadgen worker│
│ bedperf run (orchestrator)        │            └────────────────────────────────────┘
│   BotFleet ── AgentPool ──────────│── TCP ────▶ :19260 (control link, NDJSON)
└───────────────────────────────────┘
```

- **Server machine**: `bedperf run` (the orchestrator) and the server. It installs and starts the server, samples it, runs the search, records everything and writes the run dir. It runs no bots.
- **Bot machines**: one `bedperf agent` each. The orchestrator dials the agents. Each agent forks the same loadgen workers a local run would fork, relays their messages over the control link, and reports its own machine's load. The bots dial the server directly over UDP from their machine.

Every timestamp in the run is taken on the server machine. Agents report durations (telemetry intervals), so there is no clock synchronisation to get right. The one agent clock reading, in the ping replies, only feeds an informational clock-offset estimate.

## Protocol

The control link is newline-delimited JSON over TCP (`ControllerFrame` / `AgentFrame` in `packages/core/src/topology.ts`, protocol version 1), at most 8 MiB per line. A malformed frame closes the link.

1. The agent sends `challenge{nonce}`.
2. The orchestrator answers `auth{mac, protocol, harnessGit}`, where `mac` = HMAC-SHA256(token, nonce). The token is the shared secret in `BEDPERF_AGENT_TOKEN` on both sides.
3. The agent replies `hello{info}` (name, machine, harness, CPUs for bots, placement) or `denied{reason}`. It denies a bad token, another protocol version, another bedperf commit (unless the agent runs with `--allow-harness-mismatch`) and a second orchestrator while a session is active (`busy`).

**Same harness commit.** Both sides must run the same bedperf commit. The commit comes from git. A checkout without git metadata (a container image, an exported tree) reads it from `BEDPERF_HARNESS_GIT`, which the Docker images set from the `BEDPERF_GIT` build argument. The orchestrator pings every agent every 2 s and declares an agent lost after 10 s of silence or on disconnect. An agent kills all its workers when the control link drops, or when the link is silent for 15 s, so no orphan bots stay connected to the server.

Scenarios: a worker's `scenarioModule` names a file on the orchestrator's machine. The agent maps a built-in scenario (`walk`, `@bedperf/scenarios/walk`, ...) to its own copy. A custom scenario module must exist at the same path on the agent machine, or the worker fails with a message saying so.

## Running an agent

```bash
export BEDPERF_AGENT_TOKEN=<shared secret>
corepack pnpm bedperf agent --listen 0.0.0.0:19260 --name lg1 --placement auto
```

The agent machine needs the same checkout (same commit, `git submodule update --init`, `corepack pnpm install`), or the Docker image below. It runs until SIGINT or SIGTERM.

| option | default | meaning |
|---|---|---|
| `--listen <host:port>` | `0.0.0.0:19260` | TCP address of the control link |
| `--name <n>` | `agent-<first 8 hex of the machine fingerprint>` | name reported to the orchestrator; never the host name |
| `--max-workers <n>` | unlimited | most concurrent bot workers; more are refused |
| `--placement auto\|off` | `off` | `auto`: plan a bots-only CPU placement, put the agent on its own CPUs and pin every worker to the bot CPUs (verified per worker) |
| `--saturation-busy <fraction>` | `0.9` | report saturation when machine CPU is above this share of the logical CPUs |
| `--saturation-foreign <cores>` | `1` | report saturation when foreign load (not the agent, not its workers) is above this many cores |
| `--no-lock` | lock taken | do not take the machine lock while a session is active |
| `--allow-harness-mismatch` | refused | accept an orchestrator on another bedperf commit |
| `--insecure` | refused | allow an empty token (loopback `--listen` only) |

An empty `BEDPERF_AGENT_TOKEN` is a usage error unless `--insecure` is given. While an orchestrator is connected, the agent holds the machine lock (`machine.lock` in the cache root, or `$BEDPERF_LOCK`), the same lock `bedperf run` takes. So an agent machine never serves two sessions at once, and a `bedperf run` started on it during a session fails at once. With `--placement auto`, a placement plan that cannot be used stops the agent (use `--placement off`). The bots-only plan gives the workers every allowed CPU except a small set for the agent itself, E-cores included: bots are network and JS bound, and nothing measured runs on an agent.

## Running the orchestrator

```bash
export BEDPERF_AGENT_TOKEN=<shared secret>
corepack pnpm bedperf run --agents 10.0.0.21:19260,10.0.0.22:19260 --bot-target-host 10.0.0.10 --preset standard --scenario walk
```

- `--agents host:port,...` lists the agents. The port defaults to 19260. `--agents` replaces the `agents` of the machine profile. The agents are recorded in `meta.json` `topology`, not in `config.json`, so the benchmark config and its hash do not depend on where the bots run.
- `--bot-target-host <addr>` is the address of the server machine that the agents' bots dial, with the server's `--port` (default 19200; IPv6 port + 1). It is required as soon as one agent is not on a loopback address, and it may not be a loopback address then: `bedperf run` refuses it before starting anything (exit 2). With only loopback agents, it defaults to `127.0.0.1`. `--bot-target-host` without agents is a usage error.
- `BEDPERF_AGENT_TOKEN` must be set (usage error otherwise).

The machine profile (`--machine-profile <file.json>`) can carry the agents next to the placement profile and gates. An entry is `"host:port"` or `{address, name?, weight?, maxBots?}`:

```json
{
  "label": "bench-box",
  "placement": { "priority": "above_normal" },
  "agents": [
    "10.0.0.21:19260",
    { "address": "10.0.0.22:19260", "weight": 2 },
    { "address": "10.0.0.23:19260", "name": "lg3", "maxBots": 100 }
  ]
}
```

A duplicate address or an unknown key is an error. `name` overrides the agent's own name, and duplicates get `-2`, `-3` appended. Each new worker goes to the live agent with the lowest `(workers + 1) / weight` that still has room. An agent has room for `floor(maxBots / botsPerWorker)` workers, or unlimited without `maxBots`. `--max-workers` on the agent side caps it as well.

**Placement on the server machine.** With agents, the orchestrator plans the server machine in `remote-bots` mode: no bot CPU set is reserved, the harness gets a small set of its own (2 logical CPUs, or the slower cores on a hybrid CPU), and the server gets the rest. See [packages/placement/README.md](../packages/placement/README.md).

## Network requirements

| direction | protocol | port | notes |
|---|---|---|---|
| orchestrator → agent | TCP | the agent's `--listen` port (19260) | control link; the orchestrator dials, the agent never connects back |
| bots on the agent → server | UDP (RakNet) | the run's `--port` (19200) and, for IPv6, `--port` + 1 | the server machine's firewall must accept it from every agent machine |

Nothing else needs to be open. NAT on the agent side works for the bots (outbound UDP), but the orchestrator must reach each agent's TCP port.

With remote bots the traffic crosses a real network. The system NIC counters on the server machine now see it, so network rx/tx per player is a real measurement. The network's latency and loss are also part of every client-side metric (RTT, join latency). The run records `network.loopback: false`, and the report says the network is part of the measurement, with the control-link RTT baseline of each agent.

## Telemetry and invalidation

Every agent sends telemetry once per second: machine busy cores, the cores of its bot workers, foreign cores (everything else), logical CPUs and, on Linux, NIC throughput, plus a `saturated` verdict with reasons. The orchestrator records it as `agent.telemetry` envelopes and link lifecycle and RTT measurements as `agent.link` envelopes. Remote workers report the same fleet statistics as local ones, broken down per agent in `loadgen.agents`.

| condition | when | outcome |
|---|---|---|
| an agent cannot be reached, authenticated or is busy | before the first repeat | the run does not start (exit 3, `bot agents not usable`) |
| idle gate on an agent machine | before every repeat, on every agent, alongside the server machine's own idle gate: `gates.idleSec` (15 s), foreign mean ≤ `gates.idleForeignMean` (0.25 cores), 10 s peak ≤ `gates.idleForeignPeak10s` (1.5 cores) | before the first repeat: exit 3; later: the repeat is `invalid` |
| agent saturated | the agent reports `saturated` (busy CPU > `--saturation-busy` of its CPUs, or foreign load > `--saturation-foreign`), or one of its workers is saturated (event-loop lag p99 > 50 ms, JS-thread CPU > 85 %, silent) | the step is invalid (`loadgen saturated`) and the run is `loadgenLimited`; the step log names the saturated agents |
| foreign load on an agent | agent telemetry inside the hold above `gates.foreignMean` (0.25 cores mean) or `gates.foreignPeak10s` (1.5 cores, 10 s peak) | step invalid (`agent_interference: <agent> ...`) |
| agent lost | the control link of an agent drops or is silent for 10 s between the step start and the hold end | step invalid (`agent_lost: <agent> (<reason>)`); the repeat ends `invalid` at once, since its bots are gone |
| agents not reconnectable | before a repeat, after an agent was lost, every agent is reconnected | the repeat is `invalid` (`agent_lost: could not reconnect the agents: ...`) |
| topology changed | the reconnected agents are other machines than the run recorded | the repeat is `invalid` (`agent_topology_changed`) |

**Agents in a CPU allocation.** On a shared machine (a Slurm job, a container with a cpuset) an agent usually owns only some of the CPUs, and other tenants' load on the rest cannot take CPU time from its bots. By default (`--cpu-scope auto`) an agent whose allowed CPUs (Linux `Cpus_allowed_list`) are fewer than the machine's counts only those CPUs. Busy and foreign cores, the `--saturation-busy` share and the agent idle gate all cover the allocation, and `logicalCpus` is its size. The scope is recorded as `cpuScope` on the agent in `meta.topology`. `--cpu-scope machine` restores whole-machine accounting. Memory bandwidth and the NIC stay shared with the other tenants; saturation of the bots still shows up in the worker self-checks.

An invalid repeat is rerun once, as always ([statuses](methodology.md#statuses-and-exit-codes)). A lost agent's bots count as unexpected disconnects and join failures, but the step is invalid, so they never fail it. The report lists saturated and lost agents and unverified bot placement as threats to validity.

## Topology provenance and comparability

`meta.json` `topology` records how the bots ran:

- `mode`: `local` or `remote`.
- `botTargetHost`.
- per agent: `name`, `addressId` (the first 16 hex of sha256 of its address; the address itself is not recorded), `machine` (fingerprint, OS, CPU model, cores, RAM), `harness` (bedperf version and commit), `cpus` (CPUs for bots), `weight`, `maxBots`, `link` (control-link RTT min / median / max and a clock-offset estimate, from 10 pings after each connect) and `placement` (bot CPUs, verified).
- `sha256`: the topology identity, a hash of `mode` and each agent's machine fingerprint, CPUs, weight and `maxBots`. Names and addresses are left out, so renaming an agent or moving it to another address does not change it.

`bedperf compare` refuses runs whose topology hash differs (exit 2 unless `--force`). A local run compares only with local runs, and a remote run only with runs on equivalent agent machines. The local-vs-remote difference is deliberate: moving the bots changes the network path and removes their CPU load from the server machine.

## Docker images

Both images are built from the repository root with `vendor/bedboo` checked out. Pass the commit so the agents and the orchestrator agree:

```bash
git submodule update --init
docker build -f docker/agent.Dockerfile --build-arg BEDPERF_GIT=$(git rev-parse HEAD) -t bedperf-agent .
docker build -f docker/server-linux.Dockerfile --build-arg BEDPERF_GIT=$(git rev-parse HEAD) -t bedperf-server .
```

Build from a clean checkout of that commit: the images cannot tell whether the tree was dirty.

**Agent** (`docker/agent.Dockerfile`, `node:24-bookworm`). The entrypoint is `bedperf agent`, and the default arguments are `--listen 0.0.0.0:19260`. Arguments after the image name replace them:

```bash
docker run --rm -e BEDPERF_AGENT_TOKEN=<secret> -p 19260:19260 bedperf-agent
docker run --rm --network host -e BEDPERF_AGENT_TOKEN=<secret> bedperf-agent --listen 0.0.0.0:19260 --name lg1 --placement auto
```

Outbound UDP from the bots works through Docker's default bridge NAT, and `--network host` avoids the NAT hop. The machine lock lives in the container's cache dir, so it does not see other containers or the host. `--placement auto` plans only the container's CPUs (`--cpuset-cpus`; a `--cpus` quota is not visible).

**Server machine on Linux** (`docker/server-linux.Dockerfile`). It runs `bedperf` with any Linux server flavor (`bds`, `endstone`, `levilamina-wine`, `levilamina-levioptimize-wine`). For a distributed run, publish the server's UDP port. The orchestrator dials the agents, so nothing else needs publishing:

```bash
docker run --rm -it -e BEDPERF_AGENT_TOKEN=<secret> -p 19200:19200/udp \
  -v bedperf-cache:/root/.cache -v bedperf-lip:/root/.local/share/lip -v "$PWD/runs:/bedperf/runs" \
  bedperf-server run --preset standard --server endstone --accept-eula \
  --agents 10.0.0.21:19260,10.0.0.22:19260 --bot-target-host 10.0.0.10
```

[docker/README.md](../docker/README.md) describes the volumes, CPU placement in the container (`taskset`, and `--cap-add SYS_NICE` for `above_normal` priority) and stopping.

## Worked example: one server, three agents

Machines: the server at `10.0.0.10` (Windows, LeviLamina), and three bot machines `10.0.0.21`, `10.0.0.22` (twice the cores) and `10.0.0.23`, all on one switch.

1. On every machine, check out the same commit and install. Or, on the bot machines, build the agent image from that commit.
2. On each bot machine:

   ```bash
   export BEDPERF_AGENT_TOKEN=s3cret-shared-by-all
   corepack pnpm bedperf agent --placement auto --name lg1     # lg2, lg3 on the others
   ```

   Open TCP 19260 on each bot machine to the server machine.
3. On the server machine, open UDP 19200–19201 to the three bot machines, write `box.json`:

   ```json
   {
     "label": "bench-box",
     "agents": ["10.0.0.21:19260", { "address": "10.0.0.22:19260", "weight": 2 }, "10.0.0.23:19260"]
   }
   ```

   and run (PowerShell: `$env:BEDPERF_AGENT_TOKEN = '...'`):

   ```bash
   export BEDPERF_AGENT_TOKEN=s3cret-shared-by-all
   corepack pnpm bedperf install --server levilamina-levioptimize --accept-eula
   corepack pnpm bedperf run --preset standard --scenario walk --server levilamina-levioptimize \
     --machine-profile box.json --bot-target-host 10.0.0.10 --set ramp.max=400
   ```

4. The run connects to the three agents and logs each one's CPU model, CPUs and weight. Then it runs the idle gate on all four machines, and starts the search. `lg2` gets half of the workers. Steps where an agent saturates or sees foreign load are invalid and retried. The report has a topology section with each agent's link RTT, telemetry and per-step load.
5. A later run with the same flags on the same four machines, but with `--server bds --bds-version 1.26.60.6`, records the same topology hash. `bedperf compare` then treats the two runs as an implementation comparison.

## Security

The token proves the orchestrator to the agent: whoever holds it can make the agent spawn bots against any address. Treat it as a secret. The token never crosses the wire (challenge-response). The link itself is **not encrypted**, and the agent does not authenticate itself to the orchestrator. Keep the control link on a trusted network, or tunnel it (SSH, WireGuard). An agent serves one orchestrator at a time.

## Caveats

- **Agents on the server machine.** An agent on a loopback address works, and needs no `--bot-target-host`, but it measures nothing useful. To the agent, the server is foreign load, so it needs a high `--saturation-foreign` to stop reporting saturation. Its telemetry also trips `agent_interference` unless `gates.foreignMean` / `gates.foreignPeak10s` are relaxed, which relaxes the server machine's own interference gate too. To the server machine's interference sampler, the agent and its workers are foreign load. The agent also needs `--no-lock`, because `bedperf run` already holds the machine lock. Use it to test the plumbing, not for numbers. For bots on the server machine, run without `--agents`.
- **A dead agent's sessions linger.** When an agent dies, its bots stop without disconnecting, and BDS keeps their sessions for about 10 s until they time out. The repeat is already invalid by then, and the next repeat runs on a fresh server instance.
- **One agent machine is a bottleneck too.** An agent that saturates only invalidates steps; it does not raise capacity. Add agents or weight them by their cores until no step is invalid for saturation.
- **Bots on different machines see different networks.** A long or lossy path to one agent affects the bots there. The link RTT baseline in the report shows it, but bedperf does not equalise it.
