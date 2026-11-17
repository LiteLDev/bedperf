# bedperf agent: runs loadgen bot workers for distributed runs (the server and orchestrator stay on another
# machine). See docker/README.md.
#
# Build from the repository root, with the vendor/bedboo submodule checked out:
#   docker build -f docker/agent.Dockerfile --build-arg BEDPERF_GIT=$(git rev-parse HEAD) -t bedperf-agent .
# Run:
#   docker run --rm -e BEDPERF_AGENT_TOKEN=<secret> -p 19260:19260 bedperf-agent
FROM node:24-bookworm

# The orchestrator only accepts agents on its own bedperf commit. A build context without git metadata
# (e.g. a git worktree, whose .git is a pointer file) cannot tell; BEDPERF_GIT pins the commit then.
ARG BEDPERF_GIT=
ENV BEDPERF_HARNESS_GIT=${BEDPERF_GIT} \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NODE_ENV=production

WORKDIR /bedperf
COPY . .
RUN test -f vendor/bedboo/package.json \
      || { echo 'vendor/bedboo is empty: run "git submodule update --init" before building' >&2; exit 1; } \
 && corepack pnpm install --frozen-lockfile --prod \
 && corepack pnpm store prune

# Control link from the orchestrator (TCP). The bots dial the server's UDP port from inside the container.
EXPOSE 19260
ENTRYPOINT ["node", "packages/cli/src/main.ts", "agent"]
CMD ["--listen", "0.0.0.0:19260"]
