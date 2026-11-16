// @bedperf/cli: the `bedperf` command (src/main.ts) and its building blocks.
export { runCommand, prepareBuild, REPO_ROOT } from './run.ts'
export type { RunCommandOptions, RunCommandResult } from './run.ts'
export { resolveScenario, instanceProperties, botFamily, makeRunId } from './plan.ts'
export type { ScenarioRef } from './plan.ts'
export { acquireMachineLock, defaultLockPath, pidAlive, LockHeldError, ENV_LOCK } from './lock.ts'
export type { AcquireOptions, LockInfo, MachineLock } from './lock.ts'
export { parseArgs, applySets, parseValue } from './args.ts'
export { configFromArgs, USAGE } from './main.ts'
