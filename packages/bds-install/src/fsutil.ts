import { rename } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'

/** Unique suffix for temp files/dirs that are renamed into place. */
export function tmpSuffix (): string {
  return `.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
}

/**
 * rename with retries: on Windows, AV scanners and indexers briefly lock fresh files (EPERM /
 * EBUSY / EACCES). `stopIf` is checked before each retry; when it returns true the original
 * error is rethrown immediately (e.g. the target already exists because another process won).
 */
export async function renameRetry (from: string, to: string, stopIf?: () => boolean): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await rename(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (i >= 20 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') || stopIf?.()) throw err
      await new Promise(r => setTimeout(r, 250))
    }
  }
}
