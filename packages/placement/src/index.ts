// @bedperf/placement: CPU topology, placement planning (server / bots / harness CPU sets and
// priority), applying a plan to a process, and verifying a running process against it.
export { cpusToMask, formatCpuList, maskToCpus, normalizeCpus, parseCpuList, sameCpus } from './cpus.ts'
export { addTypeStatement, createNodeRunner, runPowerShellJson, WIN_NATIVE_CS } from './runner.ts'
export type { ExecResult, PlacementRunner } from './runner.ts'
export {
  buildCpuSetBuffer, capacityClasses, coresOf, cpusAllowedFromStatus, hypervisorFromStrings, linuxVirtualization, parseCpuSetBuffer,
  readLinuxTopology, readTopology, windowsTopologyFromRaw, windowsTopologyScript
} from './topology.ts'
export type { Core, CpuRecord, CpuSetEntry, CpuTopology, WindowsTopologyRaw } from './topology.ts'
export { canonicalJson, defaultProfile, parseProfile, profileSha256 } from './profile.ts'
export { autoSplit, MIN_BOT_CPUS, placementChecks, planPlacement, planUsable } from './plan.ts'
export { applyToPid, NICE, WIN_PRIORITY_CLASS, windowsApplyScript, wrapSpawn } from './apply.ts'
export type { ApplyMethod, ApplyResult, WrappedSpawn } from './apply.ts'
export { judgePlacement, niceFromStat, observedFromWindows, observeLinux, observeProcess, priorityFromNice, verifyPlacement, windowsVerifyScript } from './verify.ts'
export type { ObservedProcess } from './verify.ts'
