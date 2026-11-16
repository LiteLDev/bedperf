// CPU placement contracts: which logical CPUs the server, the bot fleet and the harness may use,
// at what priority, and how a running process measured against that plan. Implemented by
// @bedperf/placement.

/** A CPU set in a profile: `auto`, a kernel-style list (`"0-15,20"`) or explicit indices. */
export type CpuSpec = 'auto' | string | number[]

/** Server process priority. Linux maps `above_normal` to nice -5 (needs CAP_SYS_NICE). */
export type PlacementPriority = 'normal' | 'above_normal'

/** `vcpu` when the machine is virtualized (including WSL2): core/SMT facts are then unreliable. */
export type PlacementKind = 'physical' | 'vcpu'

/** A placement profile, usually loaded from JSON. Everything but `label` feeds `profileSha256`. */
export interface PlacementProfile {
  label?: string
  placement: {
    serverCpus: CpuSpec
    botCpus: CpuSpec
    /** CPUs for the harness itself; `bot` shares the bot set. */
    harnessCpus: 'bot' | string | number[]
    priority: PlacementPriority
  }
  /** Free-form numeric gates (thresholds) that travel with the profile. */
  gates?: Record<string, number>
}

/** One finding about a plan or a verification. `fail` makes the plan unusable for a valid run. */
export interface PlacementCheck {
  id: string
  level: 'ok' | 'info' | 'warn' | 'fail'
  summary: string
  detail?: Record<string, unknown>
}

/** A profile resolved against a machine's topology. CPU lists are sorted and de-duplicated. */
export interface PlacementPlan {
  serverCpus: number[]
  botCpus: number[]
  harnessCpus: number[]
  priority: PlacementPriority
  kind: PlacementKind
  checks: PlacementCheck[]
  /** sha256 of the canonical profile (label excluded), when planned from a profile. */
  profileSha256?: string
  label?: string
}

/** One way a running process escapes its plan. */
export interface PlacementViolation {
  kind: 'process_gone' | 'process_affinity' | 'thread_outside' | 'priority'
  message: string
  tid?: number
  cpus?: number[]
}

/** A running process measured against its planned CPU set and priority. */
export interface PlacementVerification {
  verified: boolean
  pid: number
  expectedCpus: number[]
  /** Process-level affinity, or null when the process is gone or unreadable. */
  processCpus: number[] | null
  /** Observed priority (`normal`, `above_normal`, or e.g. `high` / `nice_3`), null if unknown. */
  priority: string | null
  /** Threads the process narrowed to a strict subset of the plan; recorded, not a violation. */
  narrowed: Array<{ tid: number, cpus: number[] }>
  threadCount: number
  checks: PlacementCheck[]
  violations: PlacementViolation[]
}
