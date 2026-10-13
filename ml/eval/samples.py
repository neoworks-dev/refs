"""Runs the API on real crawler output and prints what comes back, to be judged by eye.

    uv run python eval/samples.py classify|label|embed [count]

It reads screens and elements from the crawler's database and images from data/media, and
only ever reads. Nothing is written back.
"""

import json
import math
import sys
import time
from pathlib import Path

import httpx

API_URL = "http://127.0.0.1:8022"
DATABASE_URL = "http://127.0.0.1:8010/sql"
# The same local development credentials as .env.example, since this only reads.
DATABASE_AUTH = ("root", "root")
DATABASE_HEADERS = {"Surreal-NS": "refs", "Surreal-DB": "main", "Accept": "application/json"}
MEDIA_DIRECTORY = Path(__file__).parents[2] / "data" / "media"

TEXT_QUERIES = [
    "pricing table", "login form", "dark hero section", "documentation page",
    "footer with many link columns", "product grid of shoes", "cookie consent dialog",
]  # fmt: skip


def query_database(statement: str) -> list[dict]:
    response = httpx.post(DATABASE_URL, content=statement, auth=DATABASE_AUTH, headers=DATABASE_HEADERS)
    return response.json()[0]["result"]


def spread(items: list[dict], count: int) -> list[dict]:
    """Picks `count` items evenly through the list, so the sample covers every site."""
    step = max(len(items) // count, 1)
    return items[::step][:count]


def classify(count: int) -> None:
    screens = query_database(
        "SELECT url, title, media.viewport AS image FROM screen "
        "WHERE viewport = 'desktop' ORDER BY url"
    )
    for screen in spread(screens, count):
        started = time.time()
        response = httpx.post(
            f"{API_URL}/classify-screen",
            files={"image": (screen["image"], (MEDIA_DIRECTORY / screen["image"]).read_bytes())},
            data={"url": screen["url"], "title": screen["title"]},
            timeout=300,
        )
        result = response.json()
        print(f"{time.time() - started:.1f}s  {MEDIA_DIRECTORY / screen['image']}")
        print(f"    {screen['url']}  [{screen['title']}]")
        print(f"    -> {result['page_type']} ({result['confidence']})  {result['description']}\n")


def label(count: int) -> None:
    elements = query_database(
        "SELECT kind, name, media FROM element WHERE viewport = 'desktop' ORDER BY id"
    )
    # Buttons and inputs are most of the elements and the least interesting, so sections come first.
    elements.sort(key=lambda element: element["kind"] != "section")
    for element in spread(elements[: count * 4], count):
        started = time.time()
        response = httpx.post(
            f"{API_URL}/label-element",
            files={"image": (element["media"], (MEDIA_DIRECTORY / element["media"]).read_bytes())},
            data={"kind": element["kind"]},
            timeout=300,
        )
        result = response.json()
        print(f"{time.time() - started:.1f}s  {MEDIA_DIRECTORY / element['media']}")
        print(f"    {element['kind']} '{element['name'][:60]}' -> {result['label']} ({result['confidence']})\n")


def embed(count: int) -> None:
    screens = spread(
        query_database(
            "SELECT url, title, media.viewport AS image FROM screen "
            "WHERE viewport = 'desktop' ORDER BY url"
        ),
        count,
    )
    vectors = []
    started = time.time()
    for screen in screens:
        response = httpx.post(
            f"{API_URL}/embed",
            files={"image": (screen["image"], (MEDIA_DIRECTORY / screen["image"]).read_bytes())},
            timeout=300,
        )
        vectors.append(response.json()["vector"])
    print(f"{(time.time() - started) / len(screens):.2f}s per screenshot, {len(vectors[0])} dimensions\n")

    def cosine(first: list[float], second: list[float]) -> float:
        return sum(left * right for left, right in zip(first, second))  # unit vectors

    for text in TEXT_QUERIES:
        response = httpx.post(f"{API_URL}/embed", data={"text": text}, timeout=300)
        query = response.json()["vector"]
        ranked = sorted(zip(screens, vectors), key=lambda pair: -cosine(query, pair[1]))
        print(f"'{text}'")
        for screen, vector in ranked[:3]:
            print(f"    {cosine(query, vector):.3f}  {screen['url']}  [{screen['title'][:40]}]  {screen['image']}")

    # Image to image: the neighbours of a few screens should be the same kind of page.
    for probe in range(0, len(screens), max(len(screens) // 5, 1)):
        ranked = sorted(zip(screens, vectors), key=lambda pair: -cosine(vectors[probe], pair[1]))
        print(f"nearest to {screens[probe]['url']}")
        for screen, vector in ranked[1:4]:
            print(f"    {cosine(vectors[probe], vector):.3f}  {screen['url']}  [{screen['title'][:40]}]")


if __name__ == "__main__":
    command, count = sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 12
    {"classify": classify, "label": label, "embed": embed}[command](count)

