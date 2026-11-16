// Test fixtures shared by the unit tests (not part of the public API).
import { strToU8, zipSync } from 'fflate'

export function makeFakeBdsZip (exe = 'bedrock_server'): Uint8Array {
  const big = new Uint8Array(200_000).map((_, i) => i % 7)
  return zipSync({
    [exe]: [strToU8('#!/bin/sh\necho fake\n'), { os: 3, attrs: (0o100755 << 16) >>> 0 }],
    'server.properties': [strToU8('server-name=Dedicated Server\nonline-mode=true\nview-distance=32\n'), { os: 3, attrs: (0o100644 << 16) >>> 0 }],
    'behavior_packs/vanilla/manifest.json': strToU8('{}'),
    'data/big.bin': [big, { level: 9 }],
    'stored.txt': [strToU8('raw'), { level: 0 }],
    'empty/': {}
  })
}
