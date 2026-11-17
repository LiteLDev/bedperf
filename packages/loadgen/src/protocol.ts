// IPC messages between the BotFleet controller (src/index.ts) and its worker processes (src/worker.ts).
// Every message is a plain JSON-serialisable object sent over the child_process IPC channel.
import type { BotViewSample } from './view.ts'

/** Per-bot RTT probe settings. */
export interface RttOptions {
  /** Fraction of bots (by index) that run the probe, 0..1. 0 disables. Default 0.1 (at least bot 0). */
  sampleRatio: number
  /** Period between probes of one bot, ms. Default 5000. */
  intervalMs: number
  /** Probe timeout, ms. Default 5000. */
  timeoutMs: number
}

/** Everything a worker needs to run its bots; sent once as the first message. */
export interface WorkerInit {
  workerId: number
  host: string
  port: number
  version: string
  scenarioModule: string
  /**
   * Registry name of the scenario (`@bedperf/scenarios`), when it is a builtin. A remote agent resolves it to its
   * own copy of the module and rewrites `scenarioModule`, which names a file on the controller's machine.
   */
  scenarioName?: string
  scenarioParams: Record<string, unknown>
  usernamePrefix: string
  seed: number
  statsIntervalMs: number
  /** createBot → spawn deadline, ms. */
  joinTimeoutMs: number
  /** After `leave`, report the bot as left even if bedboo never emits `end`, ms. */
  leaveTimeoutMs: number
  rtt: RttOptions
  /**
   * Answer every chunk blob hash the server sends with `client_cache_blob_status { missing: all }` and keep the
   * client blob cache reported as disabled, so the server always has to send full chunk payloads.
   */
  forceFullChunks?: boolean
}

export type ControllerMessage =
  | { type: 'init', init: WorkerInit }
  /** Create bot `index`. `seq` identifies this join attempt; it is echoed in every event of that bot. */
  | { type: 'join', index: number, seq: number }
  /** Gracefully end bot `index` (joining or spawned). Always answered with `left` (or another final event). */
  | { type: 'leave', index: number, seq: number }
  /** End all bots, report `stopped`, exit. */
  | { type: 'stop', graceMs: number }

/** Final events end a bot's life in the worker: after one of them the index is free again. */
export type BotEvent =
  | { type: 'bot', event: 'connect', index: number, seq: number }
  | { type: 'bot', event: 'spawn', index: number, seq: number, joinLatencyMs: number }
  /** Final: no spawn (error, kick, timeout or end before spawn). */
  | { type: 'bot', event: 'fail', index: number, seq: number, reason: string }
  /** Final: ended after spawn without being asked to (kick, error, server close, scenario threw). */
  | { type: 'bot', event: 'disconnect', index: number, seq: number, reason: string }
  /** Final: ended because the controller asked (`leave`/`stop`); also the answer to a leave for an unknown bot. */
  | { type: 'bot', event: 'left', index: number, seq: number }

/** Interval report of one worker. Counters are deltas since the previous report. */
export interface WorkerStats {
  type: 'stats'
  workerId: number
  /** Wall time covered by this report, ms. */
  intervalMs: number
  /** Bots alive in this worker (joining or spawned). */
  bots: number
  /** createBot → spawn latencies of joins completed in the interval. */
  joinLatencyMs: number[]
  /** RTT probe samples completed in the interval. */
  rttMs: number[]
  /** Server movement corrections seen in the interval (sum over bots). */
  corrections: number
  /** Game-layer bytes received from the server in the interval (sum over bots). */
  rxBytes: number
  /** perf_hooks.monitorEventLoopDelay p99 over the interval, ms. */
  eventLoopP99Ms: number
  /**
   * CPU of the worker's JS (event-loop) thread over the interval, % of one core (process.threadCpuUsage()).
   * This is what saturates first: bots are single-threaded JS.
   */
  mainThreadCpuPct: number
  /** CPU of the whole worker process (incl. V8 GC helper threads) over the interval, % of one core. */
  cpuPct: number
  rssBytes: number
  /** Chunk columns loaded by bedboo in the interval (sum over bots, re-loads included). */
  chunkLoads?: number
  /** Packets received in the interval by name (sum over bots). */
  packets?: Record<string, number>
  /** View-load state of every spawned bot at the end of the interval. */
  view?: BotViewSample[]
  /** Any bot of this worker has seen a level_chunk/subchunk with `cache_enabled` or blob hashes (ever). */
  chunkCacheSeen?: boolean
  /** client_cache_blob_status replies sent in the interval (forceFullChunks). */
  blobMissReplies?: number
}

export type WorkerMessage =
  | { type: 'ready', workerId: number }
  /** Unrecoverable (e.g. scenario module failed to load); the worker exits right after. */
  | { type: 'fatal', workerId: number, error: string }
  | { type: 'log', workerId: number, msg: string }
  | { type: 'stopped', workerId: number }
  | BotEvent
  | WorkerStats
