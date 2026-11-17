// @bedperf/agent: run loadgen bot workers on other machines. `startAgent` is the server on a load-generator
// machine; `connectAgents` is the orchestrator side and yields a loadgen WorkerFactory.
export { startAgent } from './agent.ts'
export type { AgentOptions, AgentServer, LockRelease } from './agent.ts'
export { connectAgents } from './client.ts'
export type { AgentHandle, AgentPool, ConnectAgentsOptions } from './client.ts'
export { MAX_FRAME_BYTES, authMac, frameLink, isLoopbackHost, macMatches, parseAddress } from './frames.ts'
export type { FrameLink, FrameLinkOptions } from './frames.ts'
export { builtinScenarioName, isLoadgenIdle, resolveScenarioModule } from './scenario.ts'
export type { ScenarioResolverDeps } from './scenario.ts'
export { DEFAULT_AGENT_SATURATION, defaultNetCounters, telemetryFromSample } from './telemetry.ts'
export type { AgentSaturationThresholds, NetCounterReader } from './telemetry.ts'
export { parseAgentArgs, runAgentMain } from './main.ts'
