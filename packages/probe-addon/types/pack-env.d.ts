// Globals the Bedrock Script API runtime (QuickJS) provides to pack scripts but which
// @minecraft/server does not declare. Used only by tsconfig.pack.json.
declare const console: {
  log (...args: unknown[]): void
  warn (...args: unknown[]): void
  error (...args: unknown[]): void
}