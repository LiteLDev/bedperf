// Newline-delimited JSON framing over a TCP socket (core `ControllerFrame` / `AgentFrame`), plus the auth MAC.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import type { Socket } from 'node:net'

/** Longest accepted frame (one line), UTF-16 code units (about bytes for JSON). A peer sending more without a newline is cut off. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024

/** HMAC-SHA256(token, nonce), hex. */
export function authMac (token: string, nonce: string): string {
  return createHmac('sha256', token).update(nonce).digest('hex')
}

/** Constant-time comparison of a received MAC with the expected one. */
export function macMatches (token: string, nonce: string, mac: unknown): boolean {
  if (typeof mac !== 'string') return false
  const want = Buffer.from(authMac(token, nonce), 'hex')
  const got = Buffer.from(mac, 'hex')
  return got.length === want.length && timingSafeEqual(got, want)
}

export interface FrameLink {
  send (frame: object): boolean
  /** Close with a reason (logged by the caller's onClose). Idempotent. */
  close (reason: string): void
  readonly closed: boolean
}

export interface FrameLinkOptions {
  maxFrameBytes?: number
  /** Every parsed frame (an object with a string `type`); others close the link. */
  onFrame (frame: { type: string } & Record<string, unknown>): void
  /** Once, when the link ends for any reason. */
  onClose (reason: string): void
}

/**
 * Wrap a connected socket: parse incoming lines into frames, serialize outgoing frames. Malformed JSON, a
 * non-object frame or an over-long line closes the link with a reason.
 */
export function frameLink (socket: Socket, opts: FrameLinkOptions): FrameLink {
  const max = opts.maxFrameBytes ?? MAX_FRAME_BYTES
  let buf = ''
  let closed = false
  let closeReason: string | undefined
  socket.setEncoding('utf8')
  socket.setNoDelay(true)

  const finish = (reason: string): void => {
    if (closed) return
    closed = true
    closeReason ??= reason
    opts.onClose(closeReason)
  }
  const link: FrameLink = {
    send (frame) {
      if (closed || socket.destroyed || !socket.writable) return false
      try {
        socket.write(JSON.stringify(frame) + '\n')
        return true
      } catch {
        return false
      }
    },
    close (reason) {
      if (closed) return
      closeReason ??= reason
      socket.destroy()
      finish(reason)
    },
    get closed () { return closed }
  }

  socket.on('data', (chunk: string) => {
    if (closed) return
    buf += chunk
    let i: number
    while (!closed && (i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (line.trim() === '') continue
      if (line.length > max) { link.close(`frame longer than ${max} bytes`); return }
      let frame: unknown
      try { frame = JSON.parse(line) } catch { link.close('malformed JSON frame'); return }
      if (frame === null || typeof frame !== 'object' || Array.isArray(frame) || typeof (frame as { type?: unknown }).type !== 'string') {
        link.close('frame is not an object with a string type')
        return
      }
      try {
        opts.onFrame(frame as { type: string } & Record<string, unknown>)
      } catch (err) {
        link.close(`frame handler failed: ${(err as Error)?.message ?? String(err)}`)
        return
      }
    }
    if (!closed && buf.length > max) link.close(`frame longer than ${max} bytes`)
  })
  socket.on('error', err => { closeReason ??= `socket error: ${err.message}` })
  socket.on('close', () => finish('connection closed'))
  return link
}

/** Parse `host:port` (IPv6 as `[::1]:port`). Throws on a malformed address. */
export function parseAddress (address: string, defaultPort?: number): { host: string, port: number } {
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(address) ?? /^([^:]+)(?::(\d+))?$/.exec(address)
  let host: string | undefined
  let portStr: string | undefined
  if (m) {
    host = m[1]
    portStr = m[2]
  } else if (isIP(address) === 6) {
    host = address
  }
  if (!host) throw new Error(`invalid address "${address}" (expected host:port)`)
  const port = portStr !== undefined ? Number(portStr) : defaultPort
  if (port === undefined || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid port in address "${address}"`)
  }
  return { host, port }
}

/** True for loopback hosts (127.0.0.0/8, ::1, localhost). */
export function isLoopbackHost (host: string): boolean {
  const h = host.toLowerCase()
  return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h) || h === '::ffff:127.0.0.1'
}
