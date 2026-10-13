"""Prompts for the vision-language model, and the calls that send them.

The model only has to speak the OpenAI chat API with image inputs and JSON-schema output, so
swapping the model is a server change and nothing here needs to know which one runs. The one
model-specific part is the grounding prompt, which is Holo's own.
"""

import base64
import io
import json

import httpx
from PIL import Image

from . import settings
from .schemas import (
    ELEMENT_LABELS,
    FLOW_CATEGORIES,
    FLOW_CATEGORY_DESCRIPTIONS,
    PAGE_TYPES,
    ElementLabel,
    FlowNaming,
    FlowStepInput,
    HistoryStep,
    ScreenClassification,
)

# Screenshots are shrunk before they reach the model. A 2880x1800 retina capture is about 5000
# image tokens, which is slow and adds nothing for judging a layout. Coordinates stay valid
# because the agent answers in fractions of whatever image it was shown.
CLASSIFY_MAX_SIDE = 1280
# A flow sends several screenshots in one request, and the llama.cpp profile has a 16k context. At
# 768 px a desktop page is about 450 image tokens and a phone page about 350, so the cap below
# leaves room for the prompt and the captions. Layout and headings are still readable at this size.
FLOW_MAX_SIDE = 768
# 8 screenshots take about 4k tokens, so a flow of up to 16 would still fit, but small models
# lose track of order and caption the wrong screenshot with that many. The first steps say most
# about what a flow is for, so the rest are left out and get no caption.
MAX_FLOW_STEPS = 8
# Link text can be a whole paragraph (a card that is one big link), and a prompt needs only a hint.
MAX_ACTION_LABEL_CHARACTERS = 80
# The agent has to read small link text, so it gets a sharper image than the classifier.
AGENT_MAX_SIDE = 1600
# Element crops can be tiny (a button) or huge (a full-height section).
ELEMENT_MAX_SIDE = 1024

# Long accessibility trees would push the screenshot out of the context window.
MAX_ARIA_SNAPSHOT_CHARACTERS = 6000
# Small models repeat a failing action forever, so a streak of identical results gets called out.
STUCK_STEPS_BEFORE_WARNING = 3
# Only the latest steps matter for deciding the next one, and older ones just cost tokens.
MAX_HISTORY_STEPS = 12

# Holo is trained to emit click targets as integers in [0, 1000], relative to the image it saw.
HOLO_COORDINATE_RANGE = 1000
# Holo's own prompt for grounding: a description of an element in, a click point out. Choosing
# what to do and pointing at it are separate skills, and the model is far more accurate at
# pointing when asked only that. In a first test, clicks placed while also deciding were often
# 50 pixels off a link, which is why the agent decides first and then looks the element up.
GROUNDING_PROMPT = (
    "Localize an element on the GUI image according to the provided target and output a click "
    "position. You must output a valid JSON following the format: "
    '{{"x": <integer in [0, {range}]>, "y": <integer in [0, {range}]>}}. Your target is: '
    "{target}"
)

# Holo's browser-agent cookbook prompt, with "act with your tools" changed to what happens here.
AGENT_SYSTEM_PROMPT = (
    "You are a web agent. You see the browser through screenshots and decide the next action."
)

_client = httpx.AsyncClient(timeout=settings.REQUEST_TIMEOUT_SECONDS)


class ModelOutputError(Exception):
    """The model server answered, but not with a complete answer (usually cut off by max_tokens)."""


def image_to_data_uri(image_bytes: bytes, max_side: int) -> tuple[str, tuple[int, int]]:
    """Shrinks an image to fit `max_side` and returns it as a data URI plus its original size."""
    image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    original_size = image.size
    image.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=90)
    encoded = base64.b64encode(buffer.getvalue()).decode()
    return f"data:image/jpeg;base64,{encoded}", original_size


async def chat(messages: list[dict], **parameters) -> dict:
    """Sends one chat completion request to the VLM server and returns the first choice."""
    response = await _client.post(
        f"{settings.VLM_BASE_URL}/chat/completions",
        json={
            "model": settings.VLM_MODEL,
            "messages": messages,
            "temperature": 0,
            # Reasoning is off: classification is a perception task, and the extra tokens
            # would make every screenshot several times slower.
            "chat_template_kwargs": {"enable_thinking": False},
            **parameters,
        },
    )
    response.raise_for_status()
    choice = response.json()["choices"][0]
    if choice["finish_reason"] == "length":
        raise ModelOutputError(
            f"The model ran out of tokens before finishing its answer: {choice['message']['content'][:1500]!r}"
        )
    return choice["message"]


def json_schema_format(name: str, schema: dict) -> dict:
    """Wraps a JSON schema as `response_format`, so the server only produces valid output."""
    return {"type": "json_schema", "json_schema": {"name": name, "schema": schema, "strict": True}}


async def classify_screen(image_bytes: bytes, url: str, title: str) -> ScreenClassification:
    data_uri, _ = image_to_data_uri(image_bytes, CLASSIFY_MAX_SIDE)
    schema = {
        "type": "object",
        "properties": {
            "page_type": {"type": "string", "enum": PAGE_TYPES},
            "description": {"type": "string"},
            "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        },
        "required": ["page_type", "description", "confidence"],
        "additionalProperties": False,
    }
    prompt = (
        "This is a screenshot of a web page, captured for a library of website design "
        "references.\n"
        f"URL: {url}\nTitle: {title}\n\n"
        "Classify the page by what it is for, not by what site it belongs to. "
        f"Allowed page types: {', '.join(PAGE_TYPES)}. "
        "Use 'other' only when none fits. Describe what the page shows and how it is laid out "
        "in one or two sentences. Give your confidence as a number from 0 to 1."
    )
    message = await chat(
        [{"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": data_uri}},
            {"type": "text", "text": prompt},
        ]}],
        response_format=json_schema_format("screen_classification", schema),
        max_tokens=300,
    )  # fmt: skip
    return ScreenClassification.model_validate_json(message["content"])


async def name_flow(
    images: list[bytes], steps: list[FlowStepInput], known_category: str | None
) -> FlowNaming:
    """Names a flow from its screenshots: a category, a title and one caption per step.

    Only the first `MAX_FLOW_STEPS` steps are looked at, so `captions` can be shorter than the
    flow the caller holds.
    """
    steps = steps[:MAX_FLOW_STEPS]
    content = [{"type": "text", "text": (
        "These screenshots are consecutive steps of one visitor's path through a website, "
        "captured for a library of design references. Each step names its URL and the click "
        "that led to it.\n"
    )}]  # fmt: skip
    for number, (image, step) in enumerate(zip(images, steps), start=1):
        data_uri, _ = image_to_data_uri(image, FLOW_MAX_SIDE)
        action = step.action_label.strip()[:MAX_ACTION_LABEL_CHARACTERS]
        reached_by = f'reached by clicking "{action}"' if action else "the first page"
        content.append({"type": "text", "text": f"\nStep {number}: {step.url} ({reached_by})"})
        content.append({"type": "image_url", "image_url": {"url": data_uri}})

    categories = [known_category] if known_category is not None else FLOW_CATEGORIES
    # Property order is decoding order: the captions come first, so the title and category are
    # chosen after the model has described every step, and the array length is pinned to the
    # screenshots that were sent.
    schema = {
        "type": "object",
        "properties": {
            "captions": {
                "type": "array",
                "items": {"type": "string", "maxLength": 200},
                "minItems": len(steps),
                "maxItems": len(steps),
            },
            "title": {"type": "string", "maxLength": 80},
            "category": {"type": "string", "enum": categories},
            "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        },
        "required": ["captions", "title", "category", "confidence"],
        "additionalProperties": False,
    }
    category_lines = "\n".join(
        f"- {category}: {FLOW_CATEGORY_DESCRIPTIONS[category]}" for category in categories
    )
    instructions = (
        "\n\nName this flow. captions: one sentence per step, in order, saying what the "
        "screenshot shows and what the visitor did to get there (for the first step, what the "
        "visitor starts on). title: a short free-text name for the whole flow, like 'Contacting "
        "sales' or 'Browsing customer stories', without the site's name. category: what the "
        "visitor is trying to do, judged by what the screenshots show and not by the first "
        f"page alone. Allowed categories:\n{category_lines}\nUse 'other' only when none fits. "
        "confidence: a number from 0 to 1."
    )
    content.append({"type": "text", "text": instructions})
    message = await chat(
        [{"role": "user", "content": content}],
        response_format=json_schema_format("flow_naming", schema),
        max_tokens=150 * len(steps) + 150,
    )
    return FlowNaming.model_validate_json(message["content"])


async def label_element(image_bytes: bytes, kind: str) -> ElementLabel:
    labels = ELEMENT_LABELS[kind]
    data_uri, _ = image_to_data_uri(image_bytes, ELEMENT_MAX_SIDE)
    schema = {
        "type": "object",
        "properties": {
            "label": {"type": "string", "enum": labels},
            "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        },
        "required": ["label", "confidence"],
        "additionalProperties": False,
    }
    prompt = (
        f"This is a cropped UI element of kind '{kind}' from a website. "
        f"Which of these labels describes it best: {', '.join(labels)}? "
        "Use 'other' only when none fits. Give your confidence as a number from 0 to 1."
    )
    message = await chat(
        [{"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": data_uri}},
            {"type": "text", "text": prompt},
        ]}],
        response_format=json_schema_format("element_label", schema),
        max_tokens=60,
    )  # fmt: skip
    return ElementLabel.model_validate_json(message["content"])


# Without a length limit the model sometimes rambles until it runs out of tokens. These are a
# couple of sentences, and a target description is one line.
MAX_THOUGHT_CHARACTERS = 300
MAX_ELEMENT_CHARACTERS = 120


def _action_schema(name: str, properties: dict) -> dict:
    """The JSON schema of one action. `thought` comes first so the model reasons before it commits.

    Property order is what the model server follows while decoding, and a model that has to
    name the action before explaining it will explain whatever it already chose.
    """
    properties = {
        "thought": {"type": "string", "maxLength": MAX_THOUGHT_CHARACTERS, "description": "One short sentence on why this is the next step."},
        "action": {"const": name},
        **properties,
    }
    return {
        "type": "object",
        "properties": properties,
        "required": list(properties),
        "additionalProperties": False,
    }


_ELEMENT = {"type": "string", "maxLength": MAX_ELEMENT_CHARACTERS, "description": "The target element, with its visible text."}
_REASON = {"type": "string", "maxLength": MAX_THOUGHT_CHARACTERS, "description": "What was reached, or why the goal cannot be reached."}

# One schema that allows exactly the actions below, so the answer always parses and always
# carries the arguments its action needs.
AGENT_ACTION_SCHEMA = {
    "anyOf": [
        _action_schema("click", {"element": _ELEMENT}),
        _action_schema("type", {"element": _ELEMENT, "text": {"type": "string"}, "press_enter": {"type": "boolean"}}),
        _action_schema("scroll", {"direction": {"enum": ["up", "down"]}}),
        _action_schema("back", {}),
        _action_schema("wait", {}),
        _action_schema("done", {"reason": _REASON}),
        _action_schema("give_up", {"reason": _REASON}),
    ]
}  # fmt: skip

AGENT_ACTIONS_PROMPT = """\
Actions you can take, one per step:
- click: click an element, described by what it is and its visible text.
- type: click an input field and type text into it, optionally pressing Enter.
- scroll: scroll the page up or down.
- back: go back to the previous page.
- wait: wait for the page to finish loading or animating.
- done: the goal has been reached, with a reason saying what you found.
- give_up: the goal cannot be reached without logging in, paying or leaving the site."""


async def next_action(
    goal: str,
    image_bytes: bytes,
    url: str,
    aria_snapshot: str,
    history: list[HistoryStep],
) -> dict:
    """Asks the agent model for its next browser action.

    The result is the action as a dictionary with an `action` key. For clicks and typing it also
    carries `x` and `y` in pixels of the screenshot as it was sent in, not of the shrunk copy
    the model saw.
    """
    data_uri, (width, height) = image_to_data_uri(image_bytes, AGENT_MAX_SIDE)
    recent_steps = history[-MAX_HISTORY_STEPS:]
    steps = "\n".join(
        f"{number}. {step.action}" + (f" -> {step.result}" if step.result else "")
        for number, step in enumerate(recent_steps, start=len(history) - len(recent_steps) + 1)
    )
    # The wording of a repeated click varies, but a stuck page reports the same result each time.
    last_results = [step.result for step in history[-STUCK_STEPS_BEFORE_WARNING:]]
    repetition_warning = ""
    if len(last_results) == STUCK_STEPS_BEFORE_WARNING and len(set(last_results)) == 1 and last_results[0]:
        repetition_warning = (
            f"- The last {STUCK_STEPS_BEFORE_WARNING} actions all had the same result, so you are "
            "stuck. Choose a different action, such as scrolling, or call give_up.\n"
        )
    prompt = (
        f"Goal: {goal}\n\nCurrent URL: {url}\n\n"
        f"Steps so far:\n{steps or '(none yet)'}\n\n"
        "Page structure (accessibility tree, may be cut off):\n"
        f"{aria_snapshot[:MAX_ARIA_SNAPSHOT_CHARACTERS]}\n\n"
        f"{AGENT_ACTIONS_PROMPT}\n\n"
        "Choose the single next action. Rules:\n"
        "- Only click what is visible in the screenshot. If the element you need is not "
        "visible, scroll to it first; the page structure may list elements that are off screen.\n"
        "- Call done as soon as the screenshot shows what the goal asks for, and do not undo it.\n"
        "- Never log in, pay, or submit personal data.\n"
        f"{repetition_warning}\n"
        "<observation>"
    )
    message = await chat(
        [
            {"role": "system", "content": AGENT_SYSTEM_PROMPT},
            {"role": "user", "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": data_uri}},
                {"type": "text", "text": "</observation>"},
            ]},
        ],
        response_format=json_schema_format("agent_action", AGENT_ACTION_SCHEMA),
        max_tokens=600,
    )  # fmt: skip
    action = json.loads(message["content"])
    if "element" in action:
        action["x"], action["y"] = await locate(data_uri, (width, height), action["element"])
    return action


async def locate(data_uri: str, size: tuple[int, int], target: str) -> tuple[int, int]:
    """Finds where to click for a described element, in pixels of an image of the given `size`."""
    schema = {
        "type": "object",
        "properties": {
            "x": {"type": "integer", "minimum": 0, "maximum": HOLO_COORDINATE_RANGE},
            "y": {"type": "integer", "minimum": 0, "maximum": HOLO_COORDINATE_RANGE},
        },
        "required": ["x", "y"],
        "additionalProperties": False,
    }
    prompt = GROUNDING_PROMPT.format(range=HOLO_COORDINATE_RANGE, target=target)
    message = await chat(
        [{"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": data_uri}},
            {"type": "text", "text": prompt},
        ]}],
        response_format=json_schema_format("click_point", schema),
        max_tokens=30,
    )  # fmt: skip
    point = json.loads(message["content"])
    width, height = size
    return round(point["x"] / HOLO_COORDINATE_RANGE * width), round(point["y"] / HOLO_COORDINATE_RANGE * height)
