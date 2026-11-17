// Stand-alone agent entry: `node packages/agent/src/main.ts --listen 0.0.0.0:19260 [--name n] [--max-workers n]
// [--insecure] [--allow-harness-mismatch]`. The shared secret comes from BEDPERF_AGENT_TOKEN.
import { realpathSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { AGENT_TOKEN_ENV, DEFAULT_AGENT_PORT } from '@bedperf/core'
import { startAgent, type AgentOptions } from './agent.ts'
import { parseAddress } from './frames.ts'

/** CLI flags → AgentOptions (token from `env[AGENT_TOKEN_ENV]`). Throws on bad flags. */
export function parseAgentArgs (argv: readonly string[], env: Record<string, string | undefined> = process.env): AgentOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      listen: { type: 'string', default: `0.0.0.0:${DEFAULT_AGENT_PORT}` },
      name: { type: 'string' },
      'max-workers': { type: 'string' },
      insecure: { type: 'boolean', default: false },
      'allow-harness-mismatch': { type: 'boolean', default: false }
    },
    strict: true
  })
  const o: AgentOptions = {
    listen: parseAddress(values.listen, DEFAULT_AGENT_PORT),
    token: env[AGENT_TOKEN_ENV] ?? '',
    insecure: values.insecure,
    allowHarnessMismatch: values['allow-harness-mismatch']
  }
  if (values.name !== undefined) o.name = values.name
  if (values['max-workers'] !== undefined) {
    const n = Number(values['max-workers'])
    if (!Number.isInteger(n) || n < 1) throw new Error(`--max-workers must be a positive integer, got ${values['max-workers']}`)
    o.maxWorkers = n
  }
  return o
}

/** Start an agent from CLI flags and run until SIGINT/SIGTERM. */
export async function runAgentMain (argv: readonly string[]): Promise<void> {
  const agent = await startAgent(parseAgentArgs(argv))
  const stop = (): void => { void agent.close().then(() => process.exit(0)) }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

function isEntry (): boolean {
  try { return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
}

if (isEntry()) {
  runAgentMain(process.argv.slice(2)).catch(err => {
    process.stderr.write(`[agent] ${(err as Error)?.message ?? String(err)}\n`)
    process.exit(1)
  })
}
