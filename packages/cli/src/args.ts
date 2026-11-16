// Tiny argv parser: positionals, `--flag`, `--key value`, `--key=value`, repeatable `--set a.b=c`.

export interface ParsedArgs {
  positionals: string[]
  flags: Map<string, string[]>
}

/** Flags that never take a value. */
const BOOLEAN_FLAGS = new Set(['accept-eula', 'keep-instances', 'no-report', 'help', 'h', 'dry-run', 'preview'])

export function parseArgs (argv: readonly string[]): ParsedArgs {
  const positionals: string[] = []
  const flags = new Map<string, string[]>()
  const add = (k: string, v: string): void => { flags.set(k, [...(flags.get(k) ?? []), v]) }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--') { positionals.push(...argv.slice(i + 1)); break }
    const m = /^--?([A-Za-z][\w-]*)(?:=(.*))?$/s.exec(a)
    if (m === null) { positionals.push(a); continue }
    const key = m[1]!
    if (m[2] !== undefined) add(key, m[2])
    else if (BOOLEAN_FLAGS.has(key)) add(key, 'true')
    else {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) throw new Error(`--${key} needs a value`)
      add(key, next)
      i++
    }
  }
  return { positionals, flags }
}

export function flag (args: ParsedArgs, key: string): string | undefined {
  const v = args.flags.get(key)
  return v === undefined ? undefined : v[v.length - 1]
}

export function bool (args: ParsedArgs, key: string): boolean {
  const v = flag(args, key)
  return v !== undefined && v !== 'false' && v !== '0'
}

export function intFlag (args: ParsedArgs, key: string): number | undefined {
  const v = flag(args, key)
  if (v === undefined) return undefined
  const n = Number(v)
  if (!Number.isInteger(n)) throw new Error(`--${key} expects an integer, got '${v}'`)
  return n
}

/** Parse a `--set` value literal: JSON when it parses (numbers, booleans, objects), else the raw string. */
export function parseValue (raw: string): unknown {
  try { return JSON.parse(raw) } catch { return raw }
}

/**
 * Apply `path=value` overrides to a plain object (mutates and returns it). Path segments are split on
 * `.`; `serverProperties.<key>` keeps the rest of the path as one key, since property names contain dots.
 */
export function applySets (obj: Record<string, unknown>, sets: readonly string[]): Record<string, unknown> {
  for (const s of sets) {
    const eq = s.indexOf('=')
    if (eq <= 0) throw new Error(`--set expects path=value, got '${s}'`)
    const path = s.slice(0, eq)
    const value = parseValue(s.slice(eq + 1))
    let parts = path.split('.')
    if (parts[0] === 'serverProperties' && parts.length > 2) parts = ['serverProperties', parts.slice(1).join('.')]
    let cur: Record<string, unknown> = obj
    for (const p of parts.slice(0, -1)) {
      const next = cur[p]
      if (next === null || typeof next !== 'object' || Array.isArray(next)) cur[p] = {}
      cur = cur[p] as Record<string, unknown>
    }
    cur[parts[parts.length - 1]!] = value
  }
  return obj
}
