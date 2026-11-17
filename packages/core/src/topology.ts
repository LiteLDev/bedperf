import type { HarnessInfo, MachineInfo } from './run.ts'
import type { ForeignProcess, InterferenceCheck, InterferenceSample, InterferenceSummary } from './sys.ts'
import { sha256Json } from './provenance.ts'

/**
 * Distributed load generation: the orchestrator (on the server machine) drives bot workers that run
 * on other machines through `bedperf agent` processes. Wire format: newline-delimited JSON over TCP,
 * one `AgentFrame` per line. Every timestamp the run records is stamped by the orchestrator; agents
 * only report durations.
 */
export const AGENT_PROTOCOL_VERSION = 1

/** Default TCP port of `bedperf agent`. */
export const DEFAULT_AGENT_PORT = 19260

/** Environment variable holding the shared agent secret (both sides). */
export const AGENT_TOKEN_ENV = 'BEDPERF_AGENT_TOKEN'

/** One agent the orchestrator should use (`--agents host:port,...` or machine profile `agents`). */
export interface AgentSpec {
  /** `host:port`. */
  address: string
  /** Display name; defaults to the agent's self-reported name. */
  name?: string
  /** Relative share of workers (default 1). */
  weight?: number
  /** Most bots this agent may run (default: unlimited). */
  maxBots?: number
}

/** What an agent says about itself after authentication. */
export interface AgentInfo {
  /** Agent-chosen name (not the host name; scrubbed-safe), e.g. `agent-<fingerprint8>`. */
  name: string
  protocol: number
  machine: MachineInfo
  harness: HarnessInfo
  /** Logical CPUs the agent may use for workers (after its own placement). */
  cpus: number
  /** Agent-side placement of workers, when it pinned them. */
  placement?: { botCpus: number[], verified: boolean }
  /**
   * CPUs its saturation and interference verdicts are restricted to (the agent runs inside a CPU
   * allocation on a shared machine). Absent: the whole machine.
   */
  cpuScope?: number[]
}

/** Idle-check outcome an agent reports for its own machine (sysmon `IdleCheckResult` without raw samples). */
export interface AgentIdleCheckResult extends InterferenceCheck {
  summary: InterferenceSummary
  top: ForeignProcess[]
}

/** Link-quality measurement between orchestrator and one agent. */
export interface AgentLinkStats {
  /** Round-trip of the control channel, ms. */
  rttMs: { min: number, median: number, max: number, n: number }
  /** Agent clock minus orchestrator clock, ms (midpoint estimate); informational only. */
  clockOffsetMs: number
}

/** Periodic machine telemetry from an agent (`agent.telemetry` envelope data, `agent` set by the orchestrator). */
export interface AgentTelemetry {
  agent: string
  /** Interval this sample covers, ms (agent-measured). */
  intervalMs: number
  /** Whole-machine busy CPU, cores. */
  busyCores: number
  /** CPU used by this agent's bot workers, cores. */
  botCores: number
  /** Load not from the agent or its workers, cores. */
  foreignCores: number
  logicalCpus: number
  /** Network throughput of the machine, bytes/s, when readable. */
  netRxBytesPerSec?: number
  netTxBytesPerSec?: number
  /** Agent judged itself saturated (CPU, event loop or network); see `reasons`. */
  saturated: boolean
  reasons: string[]
  /** Raw interference sample from the agent's machine sampler, when available. */
  interference?: InterferenceSample
}

/** `agent.link` envelope data: connection lifecycle and link quality. */
export interface AgentLinkEvent {
  agent: string
  event: 'connected' | 'lost' | 'closed' | 'stats'
  reason?: string
  stats?: AgentLinkStats
}

/** Per-agent slice of `BotFleetStats.loadgen.agents`. */
export interface AgentFleetSlice {
  agent: string
  workers: number
  bots: number
  /** Sum over this agent's workers of whole-process CPU, cores. */
  totalCores: number
  eventLoopLagP99Ms: number
  maxWorkerCpuPct: number
  saturated: boolean
}

/** meta.json `topology`. */
export interface TopologyMeta {
  mode: 'local' | 'remote'
  /** Address bots dial to reach the server (scrubbed when it names this host). */
  botTargetHost?: string
  agents: Array<{
    name: string
    /** sha256(address) prefix; the address itself is not recorded. */
    addressId: string
    machine: MachineInfo
    harness: HarnessInfo
    cpus: number
    weight: number
    maxBots?: number
    link?: AgentLinkStats
    placement?: { botCpus: number[], verified: boolean }
    /** `AgentInfo.cpuScope`: the CPUs its saturation and interference verdicts covered. */
    cpuScope?: number[]
  }>
  /** `topologySha256(...)`: identity used for comparability. */
  sha256: string
}

/** Identity of a topology for comparability: mode + each agent's machine fingerprint, cpus and weight. */
export function topologySha256 (t: Pick<TopologyMeta, 'mode' | 'agents'>): string {
  const agents = t.agents
    .map(a => ({ fp: a.machine.fingerprint, cpus: a.cpus, weight: a.weight, maxBots: a.maxBots ?? null }))
    .sort((a, b) => a.fp < b.fp ? -1 : a.fp > b.fp ? 1 : a.cpus - b.cpus)
  return sha256Json({ mode: t.mode, agents })
}

// ---------------------------------------------------------------------------------------------------------------
// Wire frames
// ---------------------------------------------------------------------------------------------------------------

/** Orchestrator → agent. */
export type ControllerFrame =
  | { type: 'auth', mac: string, protocol: number, harnessGit?: string }
  | { type: 'ping', id: number }
  | { type: 'spawn', workerId: number }
  /** A loadgen ControllerMessage for one worker, relayed verbatim. */
  | { type: 'worker', workerId: number, msg: unknown }
  | { type: 'kill', workerId: number }
  | { type: 'idleCheck', id: number, durationSec: number, thresholds: Record<string, number> }
  | { type: 'telemetry', intervalMs: number }
  | { type: 'bye' }

/** Agent → orchestrator. */
export type AgentFrame =
  | { type: 'challenge', nonce: string, protocol: number }
  | { type: 'hello', info: AgentInfo }
  | { type: 'denied', reason: string }
  | { type: 'pong', id: number, agentTime: number }
  | { type: 'spawned', workerId: number }
  /** A loadgen WorkerMessage from one worker, relayed verbatim. */
  | { type: 'worker', workerId: number, msg: unknown }
  | { type: 'exit', workerId: number, code: number | null }
  | { type: 'log', workerId?: number, line: string }
  | { type: 'idleCheck', id: number, result: AgentIdleCheckResult }
  | { type: 'telemetry', sample: Omit<AgentTelemetry, 'agent'> }
