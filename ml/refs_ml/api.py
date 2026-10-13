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
    AgentIdentity,
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
    GoalPlan,
    HistoryStep,
    NextAction,
    PageSummary,
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


@app.post("/plan-goals")
async def plan_goals(
    image: Annotated[UploadFile, File(description="Screenshot of the page to plan from")],
    site_name: Annotated[str, Form()],
    host: Annotated[str, Form()],
    path: Annotated[str, Form(description="Path of the page, which every goal starts at")],
    page_type: Annotated[str, Form()] = "",
    title: Annotated[str, Form()] = "",
    description: Annotated[str, Form()] = "",
    interactive_parts: Annotated[
        str, Form(description='JSON list of strings like "form: Subscribe" or "button: Monthly"')
    ] = "[]",
    site_pages: Annotated[
        str, Form(description='JSON list of {"path", "page_type", "title"} of the whole site')
    ] = "[]",
    nav_labels: Annotated[str, Form(description="JSON list of the main navigation labels")] = "[]",
    viewport: Annotated[str, Form(description="desktop or mobile")] = "desktop",
    max_goals: Annotated[int, Form(ge=1, le=8)] = 5,
    has_account: Annotated[
        bool, Form(description="The site has a demo account the browser agent can log in with")
    ] = False,
    signed_in: Annotated[
        bool, Form(description="The screenshot shows the page as a signed-in user sees it")
    ] = False,
) -> GoalPlan:
    page = PageSummary(path=path, page_type=page_type, title=title, description=description)
    return await vlm.plan_goals(
        await image.read(),
        site_name,
        host,
        page,
        json.loads(interactive_parts),
        [PageSummary.model_validate(other) for other in json.loads(site_pages)],
        json.loads(nav_labels),
        viewport,
        max_goals,
        has_account,
        signed_in,
    )


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
    identity: Annotated[
        str | None,
        Form(
            description='JSON {"email", "password", "name", "verification_code"} of the site\'s demo '
            "account. Without it the agent never logs in or enters personal data."
        ),
    ] = None,
) -> NextAction:
    steps = [HistoryStep.model_validate(step) for step in json.loads(history)]
    demo_identity = AgentIdentity.model_validate_json(identity) if identity else None
    action = await vlm.next_action(
        goal, await screenshot.read(), url, aria_snapshot, steps, demo_identity
    )
    action_models = {
        "click": ClickAction, "type": TypeAction, "scroll": ScrollAction, "back": BackAction,
        "wait": WaitAction, "done": DoneAction, "give_up": GiveUpAction,
    }  # fmt: skip
    return action_models[action["action"]](**action)
