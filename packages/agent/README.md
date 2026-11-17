# @bedperf/agent

Runs loadgen bot workers on machines other than the server's. The orchestrator stays on the server machine and
drives one `bedperf agent` per load-generator machine over TCP; bots dial the server directly from their machine.

```
server machine                         load-generator machines
┌─────────────────────────┐            ┌──────────────────────────────┐
│ BDS / LeviLamina / ...  │◀── bots ───│ agent ─ fork ─ loadgen worker│
│ orchestrator ── BotFleet│── control ▶│        └ fork ─ loadgen worker│
│   └ AgentPool           │   (TCP)    └──────────────────────────────┘
└─────────────────────────┘
```

## Running an agent

```sh
export BEDPERF_AGENT_TOKEN=<shared secret>
node packages/agent/src/main.ts --listen 0.0.0.0:19260 [--name lg1] [--max-workers 8] [--allow-harness-mismatch]
```

The agent needs the same bedperf checkout (same git commit; checked at connect time unless
`--allow-harness-mismatch`) with `pnpm install` done. An empty token is refused, except with `--insecure` on a
loopback address. The default name is `agent-<first 8 hex of the machine fingerprint>`, never the host name.

## Orchestrator side

```ts
import { connectAgents } from '@bedperf/agent'
import { BotFleet } from '@bedperf/loadgen'

const pool = await connectAgents([{ address: '10.0.0.5:19260', weight: 2 }, { address: '10.0.0.6:19260', maxBots: 40 }], {
  token: process.env.BEDPERF_AGENT_TOKEN!,
  onTelemetry: t => fleet.setExternalSaturation(t.agent, t.saturated ? t.reasons : []),
  onLink: e => console.log(e)
})
const link = await pool.measureLink()            // RTT + clock offset per agent
const idle = await pool.idleCheckAll({ durationSec: 15 })
const fleet = new BotFleet({ spawnWorker: pool.workerFactory() })
pool.startTelemetry(1000)
await fleet.start({ host: '<server address reachable from the agents>', scenarioName: 'walk', ... })
...
await fleet.stop()
await pool.close()
```

- **Placement**: each new worker goes to the live agent with the lowest `(workers + 1) / weight` that has room
  (`floor(maxBots / botsPerWorker)` workers). Worker links carry `agent` and no `pid`, so `BotFleet.pids()` and
  `onWorkerSpawn` only report local workers; stats gain `loadgen.agents` (one `AgentFleetSlice` per agent).
- **Saturation**: agent telemetry reports machine busy/bot/foreign cores (and network rate on Linux) and marks itself
  saturated when busy CPU exceeds 90% of its logical CPUs or foreign load exceeds 1 core; feed it to
  `BotFleet.setExternalSaturation` so such intervals are flagged.
- **Failure**: the pool pings every 2 s and declares an agent lost after 10 s of silence (or on disconnect); every
  worker of a lost agent exits with code `null`, so the fleet counts its bots as unexpected disconnects / join
  failures and keeps running on the other agents. The agent kills all its workers when the control link drops (or
  is silent for 15 s), so no orphan bots stay connected.
- **Scenarios**: `WorkerInit.scenarioModule` names a file on the orchestrator's machine. The agent maps
  `scenarioName` (or a builtin scenario path) to its own copy; a custom module must exist at the same path on the
  agent machine, otherwise the worker reports a `fatal` saying so.
- **Timestamps**: agents never stamp run times; telemetry carries durations only.

## Protocol

Newline-delimited JSON over TCP (`ControllerFrame` / `AgentFrame` in `@bedperf/core` topology.ts), at most 8 MiB per
line; malformed frames close the link. Handshake: agent `challenge{nonce}` → controller
`auth{mac = HMAC-SHA256(token, nonce), protocol, harnessGit}` → agent `hello{info}` or `denied{reason}`. One
controller at a time (`denied: busy` for others). The optional `lock` hook of `startAgent` is taken on
authentication and released when the session ends.

Wire `workerId`s are per-connection link ids chosen by the controller (BotFleet may briefly run a retiring worker
and its replacement under the same fleet worker id); the fleet worker id travels inside the relayed `init`.

The token authenticates the controller to the agent; the link itself is not encrypted, so use it on a trusted
network (or a tunnel).
