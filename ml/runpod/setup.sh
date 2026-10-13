#!/usr/bin/env bash
# Prepares a RunPod pod for the `a100` profile. Run it once per new pod; everything it installs
# lives on the network volume at /workspace, so a later pod on the same volume starts in minutes.
#
#   curl -fsSL https://raw.githubusercontent.com/neoworks-dev/refs/main/ml/runpod/setup.sh | bash
set -euo pipefail

# Weights, packages, Python and the checkout all go on the volume, which outlives the pod.
export HF_HOME=/workspace/hf
export UV_CACHE_DIR=/workspace/uv/cache
export UV_PYTHON_INSTALL_DIR=/workspace/uv/python
export PATH=/workspace/bin:$PATH

if ! command -v uv >/dev/null; then
	curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/workspace/bin UV_NO_MODIFY_PATH=1 sh
fi

if [ -d /workspace/refs ]; then
	git -C /workspace/refs pull --ff-only
else
	git clone https://github.com/neoworks-dev/refs /workspace/refs
fi

cd /workspace/refs/ml
# The default group adds Playwright for the evaluation, which the pod doesn't run.
uv sync --no-default-groups
# About 45 GB the first time; already downloaded files are skipped.
uv run --no-default-groups serve download --profile a100

echo "Ready. Start the models with: bash /workspace/refs/ml/runpod/start.sh"
