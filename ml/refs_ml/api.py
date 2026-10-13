"""The HTTP API that the crawler and the app call.

It hides the model servers and their prompt formats behind a few endpoints that take plain
multipart forms, so callers never build a prompt themselves.
"""

import json
from typing import Annotated

import httpx
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse

from . import embeddings, settings, vlm
from .schemas import (
    ELEMENT_LABELS,
    BackAction,
    ClickAction,
    DoneAction,
    ElementKind,
    ElementLabel,
    Embedding,
    FLOW_CATEGORIES,
    FlowNaming,
    FlowStepInput,
    GiveUpAction,
    HistoryStep,
    NextAction,
    ScreenClassification,
    ScrollAction,
    TypeAction,
    WaitAction,
)

app = FastAPI(title="Refs model service")


@app.exception_handler(httpx.HTTPError)
@app.exception_handler(vlm.ModelOutputError)
async def model_server_failed(_request, error: Exception):
    """A model server that is down or failing is a gateway problem, not a bug in this API."""
    return JSONResponse(status_code=502, content={"detail": f"Model server error: {error!r}"})


@app.post("/classify-screen")
async def classify_screen(
    image: Annotated[UploadFile, File(description="Screenshot of the page")],
    url: Annotated[str, Form()],
    title: Annotated[str, Form()] = "",
) -> ScreenClassification:
    return await vlm.classify_screen(await image.read(), url, title)


@app.post("/label-element")
async def label_element(
    image: Annotated[UploadFile, File(description="Crop of the element")],
    kind: Annotated[ElementKind, Form()],
) -> ElementLabel:
    return await vlm.label_element(await image.read(), kind)


@app.post("/name-flow")
async def name_flow(
    images: Annotated[list[UploadFile], File(description="Screenshots of the steps, in order")],
    steps: Annotated[
        str, Form(description='JSON list with one {"url", "action_label"} per image')
    ],
    category: Annotated[
        str | None, Form(description="The category, when it is already known")
    ] = None,
) -> FlowNaming:
    step_inputs = [FlowStepInput.model_validate(step) for step in json.loads(steps)]
    if len(step_inputs) != len(images):
        raise HTTPException(status_code=422, detail="Send one entry in steps per image.")
    if category is not None and category not in FLOW_CATEGORIES:
        raise HTTPException(status_code=422, detail=f"category must be one of {FLOW_CATEGORIES}.")
    return await vlm.name_flow([await image.read() for image in images], step_inputs, category)


@app.get("/name-flow/categories")
async def flow_categories() -> list[str]:
    """The fixed category list of flows."""
    return FLOW_CATEGORIES


@app.get("/label-element/labels")
async def element_labels() -> dict[str, list[str]]:
    """The fixed label list of every element kind."""
    return ELEMENT_LABELS


@app.post("/embed")
async def embed(
    image: Annotated[UploadFile | None, File(description="Screenshot to embed")] = None,
    text: Annotated[str | None, Form(description="Search query or caption to embed")] = None,
    dimensions: Annotated[
        int, Form(ge=embeddings.MIN_DIMENSIONS, le=embeddings.MAX_DIMENSIONS)
    ] = embeddings.DEFAULT_DIMENSIONS,
    instruction: Annotated[str, Form()] = embeddings.DEFAULT_INSTRUCTION,
) -> Embedding:
    if image is None and text is None:
        raise HTTPException(status_code=422, detail="Send an image, a text, or both.")
    image_bytes = await image.read() if image is not None else None
    vector = await embeddings.embed(text, image_bytes, dimensions, instruction)
    return Embedding(model=settings.EMBEDDING_MODEL, dimensions=len(vector), vector=vector)


@app.post("/next-action")
async def next_action(
    goal: Annotated[str, Form()],
    screenshot: Annotated[UploadFile, File(description="Current viewport")],
    url: Annotated[str, Form()],
    aria_snapshot: Annotated[str, Form(description="Playwright ariaSnapshot()")] = "",
    history: Annotated[
        str, Form(description='JSON list of {"action": str, "result": str}')
    ] = "[]",
) -> NextAction:
    steps = [HistoryStep.model_validate(step) for step in json.loads(history)]
    action = await vlm.next_action(goal, await screenshot.read(), url, aria_snapshot, steps)
    action_models = {
        "click": ClickAction, "type": TypeAction, "scroll": ScrollAction, "back": BackAction,
        "wait": WaitAction, "done": DoneAction, "give_up": GiveUpAction,
    }  # fmt: skip
    return action_models[action["action"]](**action)
