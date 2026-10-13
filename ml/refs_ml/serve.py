"""Starts and stops the model servers and the API: `uv run serve [vlm|embeddings|api] [--profile NAME]`.

With no server named, all three start in order and stop together on Ctrl-C. The VLM comes first
and is fully loaded before the embedder starts, because vLLM sizes its memory pool from what is
free at that moment, and two servers starting at once would both claim the same memory.

`uv run serve download` fetches the weights into the Hugging Face cache.
"""

import argparse
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass

import httpx
from huggingface_hub import hf_hub_download, snapshot_download

from . import settings

EMBEDDING_REPO = "Qwen/Qwen3-VL-Embedding-2B"
VLM_PORT = 8020
EMBEDDING_PORT = 8021

# Models take minutes to load from disk and compile kernels on first start.
STARTUP_TIMEOUT_SECONDS = 600


@dataclass
class VlmProfile:
    """A vision-language model for llama.cpp's `llama-server`.

    Quantized GGUF files are what fits on the card next to the embedder. The projector
    (`mmproj`) is the separate file that turns image patches into tokens.
    """

    repo: str
    model_file: str
    projector_file: str
    context_tokens: int


VLM_PROFILES = {
    # Holo3.1-4B has no official quantization, so this is a community GGUF of H Company's
    # weights. Q6_K is the largest quantization that leaves room for the embedder.
    "holo-4b": VlmProfile(
        repo="mradermacher/Holo-3.1-4B-GGUF",
        model_file="Holo-3.1-4B.Q6_K.gguf",
        projector_file="Holo-3.1-4B.mmproj-f16.gguf",
        context_tokens=16384,
    ),
}
DEFAULT_PROFILE = "holo-4b"


def vlm_command(profile: VlmProfile) -> list[str]:
    llama_server = shutil.which("llama-server")
    if llama_server is None:
        sys.exit("llama-server was not found. Install llama.cpp with CUDA support first.")
    return [
        llama_server,
        "--model", hf_hub_download(profile.repo, profile.model_file),
        "--mmproj", hf_hub_download(profile.repo, profile.projector_file),
        "--alias", settings.VLM_MODEL,
        "--host", "127.0.0.1",
        "--port", str(VLM_PORT),
        "--ctx-size", str(profile.context_tokens),
        "--n-gpu-layers", "99",
        # One request at a time: the context is not split into slots, so the whole window is
        # available to a long agent history.
        "--parallel", "1",
        "--flash-attn", "on",
        "--no-webui",
    ]  # fmt: skip


def embedding_command() -> list[str]:
    return [
        sys.executable, "-m", "vllm.entrypoints.cli.main", "serve", EMBEDDING_REPO,
        "--served-model-name", settings.EMBEDDING_MODEL,
        "--runner", "pooling",
        "--port", str(EMBEDDING_PORT),
        # A screenshot is about 1000 tokens, so the model's 32k window would only cost memory.
        "--max-model-len", "2048",
        "--max-num-batched-tokens", "2048",
        "--max-num-seqs", "2",
        # Share of the card this server may claim. The rest belongs to the VLM and the desktop.
        "--gpu-memory-utilization", "0.40",
        # Compiling and capturing CUDA graphs takes memory that does not fit next to the VLM.
        "--enforce-eager",
        # Memory is reserved for the largest image a request may hold, so this caps it.
        "--limit-mm-per-prompt", '{"image": {"count": 1, "width": 1280, "height": 800}}',
    ]  # fmt: skip


def wait_until_ready(name: str, port: int, process: subprocess.Popen) -> None:
    deadline = time.monotonic() + STARTUP_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if process.poll() is not None:
            sys.exit(f"{name} exited during startup with code {process.returncode}.")
        try:
            if httpx.get(f"http://127.0.0.1:{port}/v1/models").status_code == 200:
                print(f"{name} is ready on port {port}", flush=True)
                return
        except httpx.TransportError:
            pass  # Expected while the server is still loading and not listening yet.
        time.sleep(2)
    sys.exit(f"{name} did not become ready within {STARTUP_TIMEOUT_SECONDS} seconds.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("servers", nargs="*", choices=["vlm", "embeddings", "api", "download"])
    parser.add_argument("--profile", default=DEFAULT_PROFILE, choices=list(VLM_PROFILES))
    arguments = parser.parse_args()
    profile = VLM_PROFILES[arguments.profile]

    if arguments.servers == ["download"]:
        hf_hub_download(profile.repo, profile.model_file)
        hf_hub_download(profile.repo, profile.projector_file)
        snapshot_download(EMBEDDING_REPO)
        return

    wanted = arguments.servers or ["vlm", "embeddings", "api"]
    processes: list[subprocess.Popen] = []
    try:
        if "vlm" in wanted:
            processes.append(subprocess.Popen(vlm_command(profile)))
            wait_until_ready("VLM", VLM_PORT, processes[-1])
        if "embeddings" in wanted:
            processes.append(subprocess.Popen(embedding_command()))
            wait_until_ready("Embedder", EMBEDDING_PORT, processes[-1])
        if "api" in wanted:
            processes.append(
                subprocess.Popen(
                    [sys.executable, "-m", "uvicorn", "refs_ml.api:app", "--host", "127.0.0.1",
                     "--port", str(settings.API_PORT)]
                )  # fmt: skip
            )
        # Block until one of them dies or the user interrupts.
        while all(process.poll() is None for process in processes):
            time.sleep(1)
    except KeyboardInterrupt:
        pass  # Ctrl-C is how the servers are meant to be stopped; the cleanup below runs either way.
    finally:
        for process in reversed(processes):
            process.terminate()
        for process in processes:
            process.wait()


if __name__ == "__main__":
    main()
