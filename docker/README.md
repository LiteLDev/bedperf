# Docker

## Bot agent (`agent.Dockerfile`)

A distributed run keeps the server and the orchestrator (`bedperf run`) on one machine and runs the bots on
other machines through `bedperf agent`. The image runs such an agent.

```sh
git submodule update --init                     # vendor/bedboo must be in the build context
docker build -f docker/agent.Dockerfile --build-arg BEDPERF_GIT=$(git rev-parse HEAD) -t bedperf-agent .
docker run --rm -e BEDPERF_AGENT_TOKEN=<secret> -p 19260:19260 bedperf-agent
# extra agent flags go after the image name (they replace the default --listen 0.0.0.0:19260):
docker run --rm --network host -e BEDPERF_AGENT_TOKEN=<secret> bedperf-agent --listen 0.0.0.0:19413 --name lg1 --no-lock
```

On the server machine:

```sh
export BEDPERF_AGENT_TOKEN=<secret>
pnpm bedperf run --agents 10.0.0.5:19260,10.0.0.6:19260 --bot-target-host 10.0.0.10 ...
```

- **Same commit.** The orchestrator refuses agents on another bedperf commit. A clone with its `.git` directory in
  the build context reports its own commit; otherwise (a git worktree, an exported tree) pass
  `--build-arg BEDPERF_GIT=$(git rev-parse HEAD)` and build from a clean checkout of that commit.
- **Token.** `BEDPERF_AGENT_TOKEN` is the shared secret on both sides; it authenticates the orchestrator, but the
  control link is not encrypted: keep it on a trusted network.
- **Reachability.** The orchestrator connects to the agent over TCP (port 19260 by default, `-p 19260:19260`).
  The bots then dial the server **over UDP** at `--bot-target-host` and the server's port (`--port`, default
  19200; RakNet): that address must be the server machine's address as seen from the container, and the server
  machine's firewall must accept UDP on that port from the agent machines. A loopback `--bot-target-host` is
  refused when an agent runs on another machine. With Docker's default bridge network outbound UDP works through
  NAT; `--network host` avoids the NAT hop.
- **Machine lock.** The agent takes the machine lock (inside the container's cache dir) while a session is
  active; `--no-lock` skips it. It does not see other containers or the host.
- **Placement.** `--placement auto` pins every worker to a bots-only CPU set of the container's CPUs.
- **Saturation.** The agent reports itself saturated above 90% machine CPU or 1 core of foreign load
  (`--saturation-busy`, `--saturation-foreign`); steps measured while an agent is saturated are invalid.

## `server-linux.Dockerfile`: the server machine on Linux

An image that runs `bedperf` on a Linux host as the machine that runs the server: any Linux server flavor (`bds`, `endstone`, `levilamina-wine`, `levilamina-levioptimize-wine`), with the bots in the same container or on `bedperf agent` machines. Based on `node:24-bookworm`, plus `xz-utils` (lip's release archive), `python3`, `python3-venv` and `libpython3.11` (Endstone; its `bedrock_server` links against the shared libpython), `util-linux` (`taskset`, for CPU placement), `ca-certificates` and `tini` (PID 1: forwards SIGTERM to bedperf and reaps the Wine helpers that get reparented to it). pnpm comes from corepack. The entrypoint is `bedperf`.

Build from the repository root, with `vendor/bedboo` checked out (`git submodule update --init`):

```bash
docker build -f docker/server-linux.Dockerfile --build-arg BEDPERF_GIT=$(git rev-parse HEAD) -t bedperf-server .
```

It uses the root `.dockerignore`. As with the agent image, a clone's `.git` reports the commit; from a worktree or an exported tree, `BEDPERF_GIT` pins it, and it must match the agents' commit for a distributed run.

### Volumes

Installing a modded flavor downloads hundreds of MB (BDS, LeviLamina and its dependencies, lip's Wine build, Endstone's wheel and its Python dependencies) from GitHub, Mojang and PyPI. Mount named volumes so those survive the container and a failed download is retried from what is already there:

| path in the container | holds |
|---|---|
| `/root/.cache` | the bedperf cache (`bedperf/bds/`, `bedperf/servers/` with the LeviLamina workspaces and their Wine prefixes, `bedperf/tools/lip-*`), lip's download cache (`lip/`) and the instance dirs (`bedperf-tmp/`, `TMPDIR`, on the same volume so instances hard-link the server files) |
| `/root/.local/share/lip` | lip's data, including the Wine build it installs |
| `/bedperf/runs` | run directories (bind-mount a host dir to read the reports) |

```bash
docker volume create bedperf-cache
docker volume create bedperf-lip
alias bedperf-docker='docker run --rm -it -v bedperf-cache:/root/.cache -v bedperf-lip:/root/.local/share/lip -v "$PWD/runs:/bedperf/runs" bedperf-server'

bedperf-docker install --server levilamina-levioptimize-wine --accept-eula   # once; downloads
bedperf-docker run --preset quick --server levilamina-levioptimize-wine
bedperf-docker run --preset quick --server endstone --accept-eula
```

lip fetches from github.com, which can time out: each lip step is retried 3 times, and rerunning the install reuses everything already in the volumes. A Ctrl+C (`docker run -it`) or `docker stop` (SIGTERM, through tini) stops the server before bedperf exits; give `docker stop` time for it (`docker stop -t 20`), since the default 10 s may end in a SIGKILL that leaves the container's processes to Docker. With `--rm` nothing outlives the container either way.

Placement uses `taskset`; `placement.priority=above_normal` needs `--cap-add SYS_NICE`. To run the bots on other machines (`bedperf agent`), publish the server port (`-p <port>:<port>/udp`, the run's `--port`); the orchestrator dials the agents, so nothing else needs publishing.
