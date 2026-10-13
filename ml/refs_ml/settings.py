"""Where the model servers live. Everything is overridable with environment variables."""

import os

# The VLM and the embedder are separate OpenAI-compatible servers that only this API talks to.
# The names are what `vllm serve --served-model-name` (or llama-server --alias) advertises.
VLM_BASE_URL = os.environ.get("REFS_VLM_URL", "http://127.0.0.1:8020/v1")
VLM_MODEL = os.environ.get("REFS_VLM_MODEL", "vlm")
EMBEDDING_BASE_URL = os.environ.get("REFS_EMBEDDING_URL", "http://127.0.0.1:8021/v1")
EMBEDDING_MODEL = os.environ.get("REFS_EMBEDDING_MODEL", "embedder")

API_PORT = int(os.environ.get("REFS_API_PORT", "8022"))

# Generation on a 16 GB card is slow, so a stuck request should fail rather than hang a crawl.
REQUEST_TIMEOUT_SECONDS = 300
