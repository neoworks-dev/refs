"""Starts and stops the model servers and the API: `uv run serve [vlm|embeddings|api] [--profile NAME]`.

With no server named, all of them start in order and stop together on Ctrl-C. Each server is
fully loaded before the next one starts, because vLLM sizes its memory pool from what is free at
that moment, and two servers starting at once would both claim the same memory.

`uv run serve download [--profile NAME]` fetches the weights into the Hugging Face cache.

Profiles:
- `holo-4b` (the default) fits a 16 GB card: Holo3.1-4B on llama.cpp decides, points and
  classifies, next to the embedder on vLLM.
- `a100` is for a rented 80 GB card (A100 or H100): Qwen3.8-27B in FP8 does everything, next to
  the embedder. Everything runs on vLLM, which serves many requests at once, so several
  explorations can share the card. ml/runpod/ sets up a rented machine.
- `a100-holo-9b` has Holo3.1-9B do everything instead, to compare.
- `a100-holo-grounding` is the same as `a100`, with Holo3.1-4B pointing at elements instead, to compare.
"""

import argparse
import os
import shutil
import signal
import subprocess
import sys
import time
from dataclasses import dataclass, field

import httpx
from huggingface_hub import hf_hub_download, snapshot_download

from . import settings

EMBEDDING_REPO = "Qwen/Qwen3-VL-Embedding-2B"
VLM_PORT = 8020
EMBEDDING_PORT = 8021
GROUNDING_PORT = 8023
# The name the separate grounding server advertises, which the API asks for.
GROUNDING_MODEL_NAME = "grounder"

# Models take minutes to load from disk and compile kernels on first start.
STARTUP_TIMEOUT_SECONDS = 900


@dataclass
class LlamaCppModel:
    """A GGUF vision-language model for llama.cpp's `llama-server`.

    Quantized GGUF files are what fits on a 16 GB card next to the embedder. The projector
    (`mmproj`) is the separate file that turns image patches into tokens.
    """

    repo: str
    model_file: str
    projector_file: str
    context_tokens: int


@dataclass
class VllmModel:
    """A vision-language model served by vLLM from a Hugging Face repository."""

    repo: str
    # Share of the card's memory this server may claim, weights and cache together.
    memory_share: float
    context_tokens: int
    # Images one request may carry. Naming a flow sends up to eight screenshots.
    images_per_request: int
    extra_arguments: list[str] = field(default_factory=list)


@dataclass
class Profile:
    vlm: LlamaCppModel | VllmModel
    # A separate model that points at elements. None means the VLM does the pointing itself.
    grounder: VllmModel | None
    embedding_memory_share: float
    # Compiling and capturing CUDA graphs takes memory, which is skipped where it is tight.
    embedding_eager: bool


PROFILES = {
    "holo-4b": Profile(
        # Holo3.1-4B has no official quantization, so this is a community GGUF of H Company's
        # weights. Q6_K is the largest quantization that leaves room for the embedder.
        vlm=LlamaCppModel(
            repo="mradermacher/Holo-3.1-4B-GGUF",
            model_file="Holo-3.1-4B.Q6_K.gguf",
            projector_file="Holo-3.1-4B.mmproj-f16.gguf",
            context_tokens=16384,
        ),
        grounder=None,
        # Of 16 GB, what is left after the VLM and the desktop.
        embedding_memory_share=0.40,
        embedding_eager=True,
    ),
    # Qwen's own FP8 build, 31 GB. The A100 has no FP8 tensor cores, so vLLM runs the 8-bit
    # weights with 16-bit math there. That costs little, because generating is limited by memory
    # bandwidth rather than math. An H100 runs it natively.
    "a100": Profile(
        # Qwen3.8 does everything, pointing at elements included: Qwen's vision models are trained
        # to answer with positions on the same 0 to 1000 grid the grounding prompt asks for.
        vlm=VllmModel(
            repo="Qwen/Qwen3.8-27B-FP8",
            # 56 of 80 GB: 31 for the weights, the rest caches the requests of parallel explorations.
            memory_share=0.70,
            # An exploration step carries a screenshot, the accessibility tree and the history,
            # and planning gets the site map, so 32k leaves room for both.
            context_tokens=32768,
            images_per_request=10,
            # The network volume is a FUSE mount, where vLLM otherwise reads the weights in
            # small scattered pieces. Reading the files in one go first is faster there.
            extra_arguments=["--safetensors-load-strategy=prefetch"],
        ),
        grounder=None,
        # 6 of 80 GB, about what the embedder gets on the small card.
        embedding_memory_share=0.08,
        embedding_eager=False,
    ),
    # Holo3.1-9B in bf16 (19 GB) does everything, to compare a model fine-tuned for driving a
    # browser against the larger general Qwen3.8 on the evaluation in eval/.
    "a100-holo-9b": Profile(
        vlm=VllmModel(
            repo="Hcompany/Holo-3.1-9B",
            memory_share=0.70,
            context_tokens=32768,
            images_per_request=10,
            extra_arguments=["--safetensors-load-strategy=prefetch"],
        ),
        grounder=None,
        embedding_memory_share=0.08,
        embedding_eager=False,
    ),
    # The same, with Holo3.1-4B pointing at elements instead, because it is fine-tuned for just
    # that. Kept to compare click accuracy against Qwen on the evaluation in eval/.
    "a100-holo-grounding": Profile(
        vlm=VllmModel(
            repo="Qwen/Qwen3.8-27B-FP8",
            # 44 of 80 GB, so that Holo fits next to it.
            memory_share=0.55,
            context_tokens=32768,
            images_per_request=10,
        ),
        grounder=VllmModel(
            repo="Hcompany/Holo-3.1-4B",
            # 12 of 80 GB: 10 for the bf16 weights. A grounding request is one image and one
            # line of text, so it needs little cache.
            memory_share=0.15,
            context_tokens=8192,
            images_per_request=1,
        ),
        embedding_memory_share=0.08,
        embedding_eager=False,
    ),
}
DEFAULT_PROFILE = "holo-4b"


def llama_cpp_command(model: LlamaCppModel) -> list[str]:
    llama_server = shutil.which("llama-server")
    if llama_server is None:
        sys.exit("llama-server was not found. Install llama.cpp with CUDA support first.")
    return [
        llama_server,
        "--model", hf_hub_download(model.repo, model.model_file),
        "--mmproj", hf_hub_download(model.repo, model.projector_file),
        "--alias", settings.VLM_MODEL,
        "--host", "127.0.0.1",
        "--port", str(VLM_PORT),
        "--ctx-size", str(model.context_tokens),
        "--n-gpu-layers", "99",
        # One request at a time: the context is not split into slots, so the whole window is
        # available to a long agent history.
        "--parallel", "1",
        "--flash-attn", "on",
        "--no-webui",
    ]  # fmt: skip


def vllm_command(model: VllmModel, served_name: str, port: int) -> list[str]:
    return [
        sys.executable, "-m", "vllm.entrypoints.cli.main", "serve", model.repo,
        "--served-model-name", served_name,
        "--host", "127.0.0.1",
        "--port", str(port),
        "--max-model-len", str(model.context_tokens),
        "--gpu-memory-utilization", str(model.memory_share),
        "--limit-mm-per-prompt", f'{{"image": {model.images_per_request}}}',
        # JSON allows whitespace between its parts, and constrained decoding lets the model take
        # that freedom: Qwen3.8 and Holo both got stuck writing newlines after a string until
        # they ran out of tokens, on 4 of 10 agent tasks. Compact JSON leaves no such way out.
        "--structured-outputs-config", '{"backend": "xgrammar", "disable_any_whitespace": true}',
        *model.extra_arguments,
    ]  # fmt: skip


def embedding_command(profile: Profile) -> list[str]:
    command = [
        sys.executable, "-m", "vllm.entrypoints.cli.main", "serve", EMBEDDING_REPO,
        "--served-model-name", settings.EMBEDDING_MODEL,
        "--runner", "pooling",
        "--host", "127.0.0.1",
        "--port", str(EMBEDDING_PORT),
        # A screenshot is about 1000 tokens, so the model's 32k window would only cost memory.
        "--max-model-len", "2048",
        "--max-num-batched-tokens", "2048",
        "--max-num-seqs", "2",
        "--gpu-memory-utilization", str(profile.embedding_memory_share),
        # Memory is reserved for the largest image a request may hold, so this caps it.
        "--limit-mm-per-prompt", '{"image": {"count": 1, "width": 1280, "height": 800}}',
    ]  # fmt: skip
    if profile.embedding_eager:
        command.append("--enforce-eager")
    return command


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


def download(profile: Profile) -> None:
    if isinstance(profile.vlm, LlamaCppModel):
        hf_hub_download(profile.vlm.repo, profile.vlm.model_file)
        hf_hub_download(profile.vlm.repo, profile.vlm.projector_file)
    else:
        snapshot_download(profile.vlm.repo)
    if profile.grounder is not None:
        snapshot_download(profile.grounder.repo)
    snapshot_download(EMBEDDING_REPO)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("servers", nargs="*", choices=["vlm", "embeddings", "api", "download"])
    parser.add_argument("--profile", default=DEFAULT_PROFILE, choices=list(PROFILES))
    arguments = parser.parse_args()
    profile = PROFILES[arguments.profile]

    if arguments.servers == ["download"]:
        download(profile)
        return

    # The API reads where the grounding model lives from these, see settings.py.
    api_environment = dict(os.environ)
    if profile.grounder is not None:
        api_environment["REFS_GROUNDING_URL"] = f"http://127.0.0.1:{GROUNDING_PORT}/v1"
        api_environment["REFS_GROUNDING_MODEL"] = GROUNDING_MODEL_NAME

    # A background run (runpod/start.sh) is stopped with SIGTERM rather than Ctrl-C. Treat it
    # the same, so the servers are stopped too instead of being left holding the GPU.
    def stop_on_terminate(_signal_number: int, _frame: object) -> None:
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop_on_terminate)

    wanted = arguments.servers or ["vlm", "embeddings", "api"]
    processes: list[subprocess.Popen] = []
    try:
        if "vlm" in wanted:
            if isinstance(profile.vlm, LlamaCppModel):
                command = llama_cpp_command(profile.vlm)
            else:
                command = vllm_command(profile.vlm, settings.VLM_MODEL, VLM_PORT)
            processes.append(subprocess.Popen(command))
            wait_until_ready("VLM", VLM_PORT, processes[-1])
            if profile.grounder is not None:
                command = vllm_command(profile.grounder, GROUNDING_MODEL_NAME, GROUNDING_PORT)
                processes.append(subprocess.Popen(command))
                wait_until_ready("Grounder", GROUNDING_PORT, processes[-1])
        if "embeddings" in wanted:
            processes.append(subprocess.Popen(embedding_command(profile)))
            wait_until_ready("Embedder", EMBEDDING_PORT, processes[-1])
        if "api" in wanted:
            processes.append(
                subprocess.Popen(
                    [sys.executable, "-m", "uvicorn", "refs_ml.api:app", "--host", "127.0.0.1",
                     "--port", str(settings.API_PORT)],
                    env=api_environment,
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
