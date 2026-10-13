#!/usr/bin/env bash
# Starts the `a100` profile on a pod prepared by setup.sh. The servers listen on 127.0.0.1 only,
# so they are reached through an SSH tunnel and never exposed on the internet.
# Runs in the background and survives the SSH session ending; the log is /workspace/serve.log.
set -euo pipefail

export HF_HOME=/workspace/hf
export UV_CACHE_DIR=/workspace/uv/cache
export UV_PYTHON_INSTALL_DIR=/workspace/uv/python
export PATH=/workspace/bin:$PATH

cd /workspace/refs/ml
nohup uv run --no-default-groups serve --profile "${REFS_PROFILE:-a100}" >/workspace/serve.log 2>&1 &
echo "Starting (pid $!). Loading takes a few minutes: tail -f /workspace/serve.log"
