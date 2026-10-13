# Refs model service

A small HTTP API in front of two local models, so the crawler and the app never deal with
model servers or prompt formats.

- **Vision-language model (VLM):** [Holo3.1-4B](https://huggingface.co/Hcompany/Holo-3.1-4B) by H Company
  (a Qwen3.5 fine-tune, Apache-2.0). It classifies screens, labels elements and drives the
  browser agent.
- **Embedder:** [Qwen3-VL-Embedding-2B](https://huggingface.co/Qwen/Qwen3-VL-Embedding-2B).
  Screenshots and text queries land in one vector space.

Both fit on one 16 GB card at the same time, next to a desktop session.

```
crawler / app  ->  API :8022  ->  llama-server :8020  (Holo3.1-4B, GGUF Q6_K)
                              ->  vLLM         :8021  (Qwen3-VL-Embedding-2B, bf16)
```

## Setup

Needs [uv](https://docs.astral.sh/uv/), an NVIDIA GPU with a recent driver, and a CUDA build
of `llama-server` from [llama.cpp](https://github.com/ggml-org/llama.cpp) on the `PATH`.
Python is pinned to 3.12, because vLLM does not support 3.14 yet.

```sh
cd ml
uv sync                  # about 8 GB: vLLM brings its own CUDA 13 libraries
uv run serve download    # about 9 GB of weights into ~/.cache/huggingface
```

## Running

```sh
uv run serve             # VLM, then embedder, then API; Ctrl-C stops all three
```

Or one at a time, in this order (vLLM sizes its memory pool from what is free when it starts,
so the VLM must be fully loaded first):

```sh
uv run serve vlm         # llama-server on :8020
uv run serve embeddings  # vLLM on :8021
uv run serve api         # FastAPI on :8022
```

| Port | What | Public |
| ---- | ---- | ------ |
| 8020 | VLM (OpenAI-compatible, internal) | no |
| 8021 | Embedder (OpenAI-compatible, internal) | no |
| 8022 | This API | yes |

Environment variables (`REFS_VLM_URL`, `REFS_EMBEDDING_URL`, `REFS_API_PORT`, ...) are listed in
`refs_ml/settings.py`. Interactive API docs are at http://127.0.0.1:8022/docs.

## API

All endpoints take `multipart/form-data`.

### `POST /classify-screen`

Fields: `image` (file), `url`, `title` (optional).

```json
{ "page_type": "login", "description": "A login form with email and social sign-in buttons.", "confidence": 0.9 }
```

`page_type` is one of `home, pricing, features, product, about, blog_index, blog_post, docs,
signup, login, onboarding, checkout, cart, settings, dashboard, search, contact, careers,
legal, error, other`. The server decodes against a JSON schema, so the answer always parses
and always uses one of those values.

### `POST /label-element`

Fields: `image` (file), `kind` (`section`, `header`, `footer`, `nav`, `button`, `input`,
`form`, `dialog`, `menu` or `table`). Returns `{ "label": "hero", "confidence": 0.9 }`.
The label lists per kind are in `refs_ml/schemas.py`, and `GET /label-element/labels` returns them.

### `POST /embed`

Fields: `image` and/or `text`, `dimensions` (64 to 2048, default 1024), `instruction`
(optional, defaults to the model's own). Returns `{ "model": "embedder", "dimensions": 1024, "vector": [...] }`.

Vectors are cut to `dimensions` (Matryoshka) and normalized to unit length, so a dot product
is the cosine similarity. Use the same `dimensions` for everything you compare.

### `POST /next-action`

One step of the browser agent. Fields: `goal`, `screenshot` (file), `url`, `aria_snapshot`
(Playwright's `ariaSnapshot()`, optional), `history` (JSON list of `{"action", "result"}`, optional).
Returns one action. Every action has a `thought`.

```json
{ "action": "click", "thought": "...", "element": "Sign Up link at the bottom", "x": 1613, "y": 1404 }
```

| `action` | Extra fields |
| -------- | ------------ |
| `click` | `element`, `x`, `y` |
| `type` | `element`, `x`, `y`, `text`, `press_enter` |
| `scroll` | `direction` (`up` or `down`) |
| `back`, `wait` | none |
| `done`, `give_up` | `reason` |

`x` and `y` are pixels of the screenshot you sent, whatever its size. The caller executes the
action and reports back in `history` what happened, for example `"now at https://..."` or
`"nothing changed"`. Three identical results in a row make the prompt tell the model it is stuck.

Failures of a model server come back as `502`.

## How the agent works

Holo is far more accurate at pointing at an element than at choosing an action and pointing in
one go (clicks placed that way were often 50 pixels off). So a step is two model calls:

1. The agent prompt (goal, URL, history, accessibility tree and screenshot) returns an action
   and, for clicks, a *description* of the target.
2. Holo's own grounding prompt turns that description into coordinates.

Both answers are JSON-schema constrained, with `thought` first so the model reasons before it
commits. Swapping the VLM only means pointing `REFS_VLM_URL` at another OpenAI-compatible server.

## GPU memory and speed

Measured with `nvidia-smi` on an RTX 4080 SUPER (16 GB) while both servers and the API were running:

| Process | VRAM |
| ------- | ---- |
| llama-server, Holo3.1-4B Q6_K + 16k context | 5.2 GB |
| vLLM, Qwen3-VL-Embedding-2B | 5.5 GB |
| Desktop (Wayland, browsers) | 2.2 GB |
| **Total** | **12.8 of 16.4 GB** |

| Call | Time |
| ---- | ---- |
| `/classify-screen`, 2880x1800 screenshot | 0.7 to 1.4 s, about 1.0 s typical |
| `/label-element` | 0.3 to 0.7 s |
| `/embed`, screenshot | 0.2 s |
| `/embed`, text | about 0.5 s (measured once with curl, including connection setup) |
| `/next-action`, one agent step including grounding | about 2.0 s |

Screenshots are shrunk to 1280 px on the long side before they reach a model, which is why a
retina capture costs no more than a small one.

## Why these model files

Holo3.1-4B has no official quantization (H Company only publishes quantized 35B-A3B). It runs
on both servers, with these results:

- **vLLM 0.31** supports the Qwen3.5 architecture and served a community FP8 build well, but
  needs 7.5 GB for it. The embedder then no longer fits next to it (out of memory while profiling).
  vLLM also let the model emit endless whitespace inside constrained JSON.
- **llama.cpp** with the community `mradermacher/Holo-3.1-4B-GGUF` Q6_K (4.3 GB) plus the f16
  vision projector (0.7 GB) leaves room for the embedder, and its grammar-based JSON output
  does not run away. Q6_K is close to lossless; Q8_0 would be 5.2 GB.

Other VLM sizes need a different profile in `refs_ml/serve.py` (`VLM_PROFILES`). A larger model
such as a 27B at 3-bit does not fit next to the embedder: stop the VLM and run `uv run serve
embeddings` as a batch step instead.

## Evaluation

Scripts in `eval/` check the service on real data. They need the API running, and write nothing
outside `eval/runs/`.

```sh
uv run python eval/samples.py classify 12   # classify screens from data/media, judge by eye
uv run python eval/samples.py label 10
uv run python eval/samples.py embed 40      # text queries and image neighbours
uv run python eval/agent.py my-run          # closed-loop agent on 10 real sites
```

`agent.py` drives headless Chromium at 1440x900: screenshot, `/next-action`, execute, repeat,
at most 20 steps. It blocks form submissions. Success is checked from the browser state
(final URL, or the Shopify cart contents), not from what the model says. Tasks are in
`eval/tasks.py`.

Results with Holo3.1-4B Q6_K, two runs of the same 10 tasks (the second after adding the rules
"only click what is visible" and "call done once the goal is shown" to the prompt):

| Task | Run 1 | Run 2 |
| ---- | ----- | ----- |
| Stripe docs, payments quickstart for Node | failed, 20 steps | done, 18 steps |
| Linear homepage to the signup email step | done, 4 | done, 4 |
| Allbirds, add a shoe in size 10 to the cart | done, 15 | done, 12 |
| Tailwind, find flex-wrap with search | done, 3 | failed, gave up after 10 |
| Notion pricing, open the Enterprise contact form | failed, 20 | failed, 20 |
| GitHub, Team plan price | done, 2 | done, 2 |
| Hacker News, comments of the top story | done, 2 | done, 2 |
| Wikipedia, search and open an article | done, 6 | done, 14 |
| Vercel docs, environment variables | done, 9 | done, 18 |
| GitHub, create a repo (needs login, expect `give_up`) | give_up, 2 | give_up, 2 |

8 of 10 both times. Failure modes seen:

- **Targets that are off screen.** The accessibility tree lists them, so the model clicks where
  it imagines them, once repeatedly on a cookie banner. The prompt rule helped here.
- **Grounding in dense lists.** On Tailwind's sidebar the click kept landing on the neighbouring
  link (`break-inside` instead of `flex-wrap`).
- **Not recognising success.** On Notion it reached the contact form on step 1, decided it
  should "go back to the pricing page", left the history and wandered on a blank page.
- **Wandering.** Reaching a goal took 2 to 4 steps on simple pages but up to 18 on docs sites.
