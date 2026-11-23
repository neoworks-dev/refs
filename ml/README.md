# Local model servers

Starts model servers on your own GPU for development. The crawler and the app call models over
the OpenAI-compatible API (`src/lib/server/models.ts`) and keep the prompts themselves, so these
servers are one place the models can run, next to hosted providers. Nothing here is needed when
`.env` points at a hosted model.

```
crawler / app  ->  llama-server or vLLM :8020  (the VLM)
               ->  vLLM                 :8021  (Qwen3-VL-Embedding-2B, only when started)
```

## Setup

Needs [uv](https://docs.astral.sh/uv/), an NVIDIA GPU with a recent driver, and for the default
profile a CUDA build of `llama-server` from [llama.cpp](https://github.com/ggml-org/llama.cpp) on
the `PATH`. Python is pinned to 3.12, because vLLM does not support 3.14 yet.

```sh
cd ml
uv sync                  # about 8 GB: vLLM brings its own CUDA 13 libraries
uv run serve download    # the weights of the profile into ~/.cache/huggingface
```

## Running

```sh
uv run serve                   # the VLM on :8020
uv run serve vlm embeddings    # also the embedder on :8021, started after the VLM
```

vLLM sizes its memory pool from what is free when it starts, so the servers start one after the
other. The defaults of `REFS_VLM_URL` and `REFS_VLM_MODEL` in `.env.example` match the VLM server.
Set `REFS_EMBEDDING_URL=http://127.0.0.1:8021/v1` to use the embedder.

## Profiles

Profiles are in `refs_ml/serve.py`, chosen with `--profile`.

- `holo-4b` (the default) fits a 16 GB card: Holo3.1-4B as a Q6_K GGUF on llama.cpp. It drives the
  browser well enough to test the crawler, but plans and judges too weakly for real crawls.
- `a100` is Qwen3.8-27B in FP8 on vLLM, for a rented 80 GB card. [runpod/](runpod/) walks through
  renting one and reaching it through an SSH tunnel.
- `a100-holo-9b` and `a100-holo-grounding` were for comparing Holo against Qwen.

## What the models did on the old evaluation

Before the prompts moved to TypeScript, `eval/agent.py` drove a browser through 10 real tasks
(Stripe docs, Linear sign-up, an Allbirds cart, Tailwind search, Notion's contact form and others),
checking success from the browser state. Holo3.1-4B reached 8 of 10 in two runs. Qwen3.8-27B on an
A100 ended 9 of 10 runs the way the task expected on its third run, judging by its logs. The failures were clicks on the neighbouring link in dense lists, not
noticing that the goal was already reached, and wandering on docs sites. The tasks are in the git
history at `ml/eval/tasks.py`, for whoever ports the evaluation to the crawler.
