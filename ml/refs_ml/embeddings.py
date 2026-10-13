"""Embeds screenshots and text queries into one shared vector space."""

import math

import httpx

from . import settings
from .vlm import image_to_data_uri

DEFAULT_DIMENSIONS = 1024
# Qwen3-VL-Embedding-2B outputs 2048 numbers and is trained so that any prefix of at least 64
# of them (Matryoshka representation learning) is still a usable embedding.
MIN_DIMENSIONS = 64
MAX_DIMENSIONS = 2048
# The model's default instruction. The model card reports a 1 to 5 percent gain from a task
# specific one, which is why callers can override it.
DEFAULT_INSTRUCTION = "Represent the user's input."
# Embedding input is shrunk like the other screenshots, so a retina capture doesn't cost 5000 tokens.
EMBEDDING_MAX_SIDE = 1280

_client = httpx.AsyncClient(timeout=settings.REQUEST_TIMEOUT_SECONDS)


async def embed(
    text: str | None,
    image_bytes: bytes | None,
    dimensions: int = DEFAULT_DIMENSIONS,
    instruction: str = DEFAULT_INSTRUCTION,
) -> list[float]:
    """Embeds text, an image, or both together, truncated to `dimensions` and unit length."""
    content = []
    if image_bytes is not None:
        data_uri, _ = image_to_data_uri(image_bytes, EMBEDDING_MAX_SIDE)
        content.append({"type": "image_url", "image_url": {"url": data_uri}})
    if text is not None:
        content.append({"type": "text", "text": text})

    response = await _client.post(
        f"{settings.EMBEDDING_BASE_URL}/embeddings",
        json={
            "model": settings.EMBEDDING_MODEL,
            "messages": [
                {"role": "system", "content": [{"type": "text", "text": instruction}]},
                {"role": "user", "content": content},
            ],
            "encoding_format": "float",
        },
    )
    response.raise_for_status()
    vector = response.json()["data"][0]["embedding"][:dimensions]

    # Cutting a prefix off a normalized vector leaves it shorter than 1, and cosine search
    # in the database expects unit vectors.
    length = math.sqrt(sum(value * value for value in vector))
    return [value / length for value in vector]
