// `bedperf agent`: run bot workers for a distributed run on this (load-generator) machine. Wraps @bedperf/agent
// `startAgent` with the machine lock (taken while an orchestrator session is active) and optional bots-only CPU
// placement of the workers.
import { AGENT_TOKEN_ENV, DEFAULT_AGENT_PORT, type PlacementPlan } from '@bedperf/core'
import { parseAddress, startAgent, type AgentOptions, type AgentServer, type LockRelease } from '@bedperf/agent'
import { forkWorker, type WorkerFactory } from '@bedperf/loadgen'
import { applyBotWorker, applyToPid, defaultProfile, planPlacement, planUsable, readTopology, verifyBotWorker } from '@bedperf/placement'
import { EnvGateError, type Logger } from '@bedperf/orchestrator'
import { bool, flag, intFlag, UsageError, type ParsedArgs } from './args.ts'
import { acquireMachineLock } from './lock.ts'
import pkg from '../package.json' with { type: 'json' }

export interface AgentCommandOptions {
  agent: AgentOptions
  /** `auto`: plan a bots-only placement and pin every worker to the bot CPUs. Default `off`. */
  placement: 'auto' | 'off'
  /** Take the machine lock while an orchestrator session is active. Default true. */
  lock: boolean
  lockPath?: string
}

function positiveNumber (args: ParsedArgs, key: string): number | undefined {
  const v = flag(args, key)
  if (v === undefined) return undefined
  const n = Number(v)
  if (!Number.isFinite(n) || !(n > 0)) throw new UsageError(`--${key} expects a positive number, got '${v}'`)
  return n
}

/** `bedperf agent` flags → options (token from `env[AGENT_TOKEN_ENV]`). Throws `UsageError` on bad flags. */
export function agentOptionsFromArgs (args: ParsedArgs, env: Record<string, string | undefined> = process.env): AgentCommandOptions {
  let listen: { host: string, port: number }
  try {
    listen = parseAddress(flag(args, 'listen') ?? `0.0.0.0:${DEFAULT_AGENT_PORT}`, DEFAULT_AGENT_PORT)
  } catch (err) {
    throw new UsageError(`--listen: ${(err as Error).message}`)
  }
  const agent: AgentOptions = {
    listen,
    token: env[AGENT_TOKEN_ENV] ?? '',
    insecure: bool(args, 'insecure'),
    allowHarnessMismatch: bool(args, 'allow-harness-mismatch')
  }
  const name = flag(args, 'name')
  if (name !== undefined) agent.name = name
  const maxWorkers = intFlag(args, 'max-workers')
  if (maxWorkers !== undefined) {
    if (maxWorkers < 1) throw new UsageError(`--max-workers must be a positive integer, got ${maxWorkers}`)
    agent.maxWorkers = maxWorkers
  }
  // Saturation thresholds of the agent's telemetry (a run invalidates steps while an agent reports saturation).
  const busy = positiveNumber(args, 'saturation-busy')
  const foreign = positiveNumber(args, 'saturation-foreign')
  if (busy !== undefined || foreign !== undefined) {
    agent.saturation = { ...(busy !== undefined ? { busyFraction: busy } : {}), ...(foreign !== undefined ? { foreignCores: foreign } : {}) }
  }
  const scope = flag(args, 'cpu-scope')
  if (scope !== undefined) {
    if (scope !== 'auto' && scope !== 'machine') throw new UsageError(`--cpu-scope expects auto or machine, got '${scope}'`)
    agent.cpuScope = scope
  }
  const placement = flag(args, 'placement') ?? 'off'
  if (placement !== 'auto' && placement !== 'off') throw new UsageError(`--placement expects auto or off, got '${placement}'`)
  if (!agent.token && !agent.insecure) throw new UsageError(`set ${AGENT_TOKEN_ENV} to the shared secret of the orchestrator and its agents`)
  const lockPath = flag(args, 'lock-path')
  return { agent, placement, lock: !bool(args, 'no-lock'), ...(lockPath !== undefined ? { lockPath } : {}) }
}

/** Bots-only placement: the agent on its own CPUs, each worker pinned to the bot CPUs and verified. */
async function botsOnlyPlacement (log: Logger): Promise<{ plan: PlacementPlan, harnessOk: boolean }> {
  const plan = planPlacement(await readTopology(), defaultProfile(), { role: 'bots-only' })
  for (const c of plan.checks) if (c.level === 'warn' || c.level === 'fail') log.warn(`placement: ${c.summary}`)
  if (!planUsable(plan)) {
    const fails = plan.checks.filter(c => c.level === 'fail').map(c => c.summary)
    throw new EnvGateError(`bots-only placement is not usable: ${fails.join('; ')} (use --placement off)`, fails)
  }
  let harnessOk = false
  try {
    const r = await applyToPid(process.pid, plan.harnessCpus, 'normal')
    harnessOk = r.ok
    if (!r.ok) log.warn(`placement: agent not placed: ${[r.affinityError, r.priorityError].filter(Boolean).join('; ')}`)
  } catch (err) {
    log.warn(`placement: agent not placed: ${String(err)}`)
  }
  log.info(`placement (${plan.kind}, bots-only): bots ${plan.botCpus.join(',')}, agent ${plan.harnessCpus.join(',')}`)
  return { plan, harnessOk }
}

/** Start the agent; resolves once it listens. `close()` stops it. */
export async function startAgentCommand (o: AgentCommandOptions, log: Logger): Promise<AgentServer> {
  const agent: AgentOptions = { ...o.agent, log: line => { log.info(line) } }
  if (o.lock) {
    agent.lock = async (): Promise<LockRelease> => {
      const l = await acquireMachineLock({ bedperfVersion: pkg.version, ...(o.lockPath !== undefined ? { path: o.lockPath } : {}) })
      l.setRunId('agent-session')
      return () => { l.release() }
    }
  }
  let placed: { plan: PlacementPlan, harnessOk: boolean } | undefined
  let server: AgentServer | undefined
  if (o.placement === 'auto') {
    placed = await botsOnlyPlacement(log)
    const plan = placed.plan
    const base: WorkerFactory = o.agent.workerFactory ?? forkWorker
    agent.workerFactory = (id, fo) => {
      const link = base(id, fo)
      const pid = link.pid
      if (pid !== undefined) {
        void (async () => {
          const a = await applyBotWorker(pid, plan)
          const v = a.ok ? await verifyBotWorker(pid, plan) : undefined
          if (v?.verified !== true) {
            const why = !a.ok ? [a.affinityError, a.priorityError].filter(Boolean).join('; ') : (v?.violations.map(x => x.message).join('; ') ?? '')
            log.warn(`worker ${id} (pid ${pid}): bot placement not verified: ${why}`)
            // later sessions see it in AgentInfo.placement
            if (server?.info.placement !== undefined) server.info.placement.verified = false
          }
        })().catch((err: unknown) => { log.warn(`worker ${id}: bot placement failed: ${String(err)}`) })
      }
      return link
    }
  }
  server = await startAgent(agent)
  if (placed !== undefined) {
    // set before any controller can authenticate (the hello frame carries this object)
    server.info.cpus = placed.plan.botCpus.length
    server.info.placement = { botCpus: [...placed.plan.botCpus], verified: placed.harnessOk }
  }
  return server
}

/** `bedperf agent`: serve until SIGINT / SIGTERM. Resolves with the exit code. */
export async function agentCommand (args: ParsedArgs, log: Logger): Promise<number> {
  const o = agentOptionsFromArgs(args)
  const server = await startAgentCommand(o, log)
  const { host, port } = server.address
  const shown = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`
  console.log(`bedperf agent ${server.info.name} listening on ${shown} (${server.info.cpus} CPUs for bots${o.lock ? ', machine lock per session' : ''})`)
  return await new Promise<number>(resolve => {
    const stop = (): void => {
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
      log.info('stopping')
      server.close().then(() => { resolve(0) }, (err: unknown) => { log.error(`close failed: ${String(err)}`); resolve(1) })
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  })
}
