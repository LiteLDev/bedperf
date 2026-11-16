import type { BenchmarkConfig } from '@bedperf/core'
import { parseConfig } from './config.ts'
import quickJson from '../presets/quick.json' with { type: 'json' }
import standardJson from '../presets/standard.json' with { type: 'json' }
import thoroughJson from '../presets/thorough.json' with { type: 'json' }

export type PresetName = 'quick' | 'standard' | 'thorough'

/** Built-in presets, validated and with defaults filled. Treat as read-only; clone before mutating. */
export const presets: Readonly<Record<PresetName, BenchmarkConfig>> = Object.freeze({
  quick: parseConfig(quickJson, 'presets/quick.json'),
  standard: parseConfig(standardJson, 'presets/standard.json'),
  thorough: parseConfig(thoroughJson, 'presets/thorough.json')
})

export const PRESET_NAMES: readonly PresetName[] = ['quick', 'standard', 'thorough']

/** A fresh, mutable copy of a preset. */
export function preset (name: PresetName): BenchmarkConfig {
  const p = presets[name]
  if (p === undefined) throw new Error(`unknown preset '${String(name)}' (expected one of: ${PRESET_NAMES.join(', ')})`)
  return structuredClone(p)
}
