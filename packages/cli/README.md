# @bedperf/cli

The `bedperf` command. It wires every package together: bds-install creates the instance, bds-process runs it, probe-addon and sysmon measure it, loadgen and scenarios supply the bots, the orchestrator runs the search, and report writes the result.

```bash
corepack pnpm bedperf run --scenario walk                      # quick preset, 5→50 bots
corepack pnpm bedperf run --preset standard --scenario build --set ramp.max=200
corepack pnpm bedperf run --config my.json --dry-run           # print the resolved config
corepack pnpm bedperf report runs/<id>
corepack pnpm bedperf compare runs/<a> runs/<b> -o compare.html
corepack pnpm bedperf install latest --accept-eula
corepack pnpm bedperf scenarios
```

## What `run` adds on top of the orchestrator

- **Versions.** `bdsVersion` (`latest`, `preview` or `x.y.z.w`) is resolved to a concrete build and downloaded only if it is not cached. A download needs `--accept-eula`. The bot protocol family is derived from the build (BDS 1.26.63.1 → `1.26.60`) unless `botVersion` is set. Both concrete values are recorded in `config.json` and `meta.json`.
- **Scenarios.** `scenario.module` may be a registry name (`walk`), the alias `@bedperf/scenarios/walk`, or any module URL. The scenario's `serverSetup` runs once after the server starts.
- **Server properties.** Layers apply in this order: `REQUIRED_BOT_PROPERTIES` < `bench-default` < the config's `serverProperties` and `world`. A config that overrides a required property (for example `online-mode=true`), or sets the port or level name, is rejected. Scenarios that send commands as bots get `default-player-permission-level=operator`.
- **Instances.** Each repeat gets a fresh instance with the probe pack installed. Instances are deleted afterwards unless `--keep-instances` is given. The BDS output goes to `runs/<id>/bds.log`, or `bds-r<n>.log` when there are several repeats.
- **Machine lock.** Only one measured run per machine: two benchmarks sharing a CPU measure each other. `run` creates the lock file `$BEDPERF_LOCK`, or `machine.lock` in the cache root (`%LOCALAPPDATA%\bedperf\cache`, `~/.cache/bedperf` or `BEDPERF_CACHE_DIR`), before resolving or downloading BDS, and removes it when it finishes, fails, or exits after a second Ctrl+C. A second `run` fails at once, naming the holder's pid, run id and start time. A lock left behind by a process that was killed hard is taken over once its pid is gone. Benchmarks that share a machine must share the lock file. `--no-lock` skips it (for runs whose numbers you do not care about).
- **Provenance.** `meta.json` records the BDS zip sha256 (from the bds-install cache sidecar), the probe pack tree hash, the bedboo commit, the config hash, a machine fingerprint and the bedperf commit; meta.json and config.json are scrubbed of absolute paths, user and host names (see the orchestrator README).
- **Interrupts.** The first Ctrl+C stops after the current step and still cleans up. A second Ctrl+C kills the process.
