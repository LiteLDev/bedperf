# bedperf on Linux as the server machine: every Linux server flavor (bds, endstone, and LeviLamina
# with or without LeviOptimize under lip's Wine), with the bots local or on `bedperf agent` machines.
# See docker/README.md. Build from the repository root (vendor/bedboo checked out):
#   docker build -f docker/server-linux.Dockerfile --build-arg BEDPERF_GIT=$(git rev-parse HEAD) -t bedperf-server .
FROM node:24-bookworm

# xz-utils: lip's release archive; python3 + venv + libpython3.11: Endstone (its bedrock_server links
# against the shared libpython); util-linux: taskset (CPU placement); procps: ps/kill for debugging;
# tini: PID 1 that reaps Wine's reparented helpers and forwards SIGTERM to bedperf.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates xz-utils python3 python3-venv libpython3.11 util-linux procps tini \
 && rm -rf /var/lib/apt/lists/*

# Agents only accept an orchestrator on their own bedperf commit; a context without usable git metadata
# (a git worktree) cannot tell, so BEDPERF_GIT pins it (as in agent.Dockerfile).
ARG BEDPERF_GIT=
ENV BEDPERF_HARNESS_GIT=${BEDPERF_GIT} \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    # Instance dirs next to the cache (same volume), so the server files are hard-linked, not copied.
    TMPDIR=/root/.cache/bedperf-tmp

WORKDIR /bedperf
COPY . .
RUN corepack enable \
 && corepack pnpm install --frozen-lockfile \
 && mkdir -p /bedperf/runs "$TMPDIR"

# Persist downloads across containers (see docker/README.md):
#   /root/.cache            bedperf cache (BDS builds, LeviLamina / Endstone installs, Wine prefixes)
#                           and lip's download cache
#   /root/.local/share/lip  lip's own data, including the Wine build it installs
#   /bedperf/runs           run directories
VOLUME ["/root/.cache", "/root/.local/share/lip", "/bedperf/runs"]

ENTRYPOINT ["tini", "--", "sh", "-c", "mkdir -p \"$TMPDIR\" && exec node /bedperf/packages/cli/src/main.ts \"$@\"", "bedperf"]
CMD ["--help"]
