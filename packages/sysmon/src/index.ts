// @bedperf/sysmon: OS-level sampler for the BDS process: CPU, per-thread CPU (main-thread
// utilisation), memory, network.
export { createProcessSampler, createPlatformBackend, readSysCpu } from './sampler.ts'
export type { ProcessSampler, ProcessSamplerOptions, SamplerOverhead } from './sampler.ts'
export { computeSample, createComputeState } from './compute.ts'
export type { ComputeOptions, ComputeState } from './compute.ts'
export {
  DEFAULT_TICK_THREAD_RULE, applyTickThreadRule, mainThreadCpuSeries, parseTickThreadRule, tickCpuMsPerTick
} from './tickthread.ts'
export type { ThreadCpuPoint, TickPoint, TickThreadRule } from './tickthread.ts'
export { createLinuxBackend, parseNetDev, parseProcStat, parseProcStatus, parseSchedstat } from './linux.ts'
export type { LinuxBackendOptions, ProcStat, ProcStatus } from './linux.ts'
export { createWindowsBackend, parseHelperLine, windowsHelperScript } from './windows.ts'
export type { HelperMessage, HelperScriptOptions, WindowsBackendOptions } from './windows.ts'
export type { Backend, BackendResult, RawReading, RawThread } from './types.ts'
// Machine-level interference: per-CPU busy, own process groups, foreign load, idle gate.
export {
  assignGroups, busyFractions, checkInterference, cpuTimesFromOs, createMachineSampler, DEFAULT_INTERFERENCE_THRESHOLDS,
  GROUPS, idleCheck, parseProcStatCpus, peakMean, readCpuTimes, summarizeInterference, topForeign
} from './machine.ts'
export type {
  CpuTimes, CpuTimesReader, GroupRoots, IdleCheckOptions, IdleCheckResult, MachineSampler, MachineSamplerOptions
} from './machine.ts'
export { createPlatformProcTable } from './proctable.ts'
export type { ProcEntry, ProcTable } from './proctable.ts'
export { createLinuxProcTable, parsePidStat } from './proctable-linux.ts'
export type { LinuxProcTableOptions, PidStat } from './proctable-linux.ts'
export { createWindowsProcTable, parseProcTableLine, windowsProcTableScript } from './proctable-windows.ts'
export type { ProcTableReply, WindowsProcTableOptions } from './proctable-windows.ts'
