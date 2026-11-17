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
