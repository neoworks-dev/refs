"""Vocabularies and response shapes of the HTTP API.

The page types and element labels are fixed lists on purpose: the app filters by them, so the
model must never invent a new one. Each list is also turned into a JSON schema enum, which the
model server enforces while decoding.
"""

from typing import Annotated, Literal

from pydantic import BaseModel, Field

PAGE_TYPES = [
    "home", "pricing", "features", "product", "about", "blog_index", "blog_post", "docs",
    "signup", "login", "onboarding", "checkout", "cart", "settings", "dashboard", "search",
    "contact", "careers", "legal", "error", "other",
]  # fmt: skip

# Labels per element kind. The kinds are the ones in db/schema.surql, and every list ends with
# "other" so the model always has an honest answer when nothing fits.
ELEMENT_LABELS = {
    "section": [
        "hero", "features", "pricing", "testimonials", "logos", "faq", "cta", "stats", "team",
        "footer_cta", "gallery", "comparison", "how_it_works", "newsletter", "other",
    ],
    "header": ["top_nav", "announcement_bar", "hero_header", "other"],
    "footer": ["simple_footer", "link_columns_footer", "newsletter_footer", "other"],
    "nav": ["top_nav", "sidebar", "tabs", "breadcrumbs", "pagination", "other"],
    "button": ["primary", "secondary", "ghost", "icon", "link", "other"],
    "input": ["text", "search", "email", "password", "select", "checkbox", "other"],
    "form": ["login", "signup", "contact", "newsletter", "search", "checkout", "settings", "other"],
    "dialog": ["cookie_consent", "signup_modal", "login_modal", "confirmation", "promo", "other"],
    "menu": ["dropdown", "mega_menu", "context_menu", "other"],
    "table": ["pricing_table", "comparison_table", "data_table", "other"],
}  # fmt: skip

ElementKind = Literal[
    "section", "header", "footer", "nav", "button", "input", "form", "dialog", "menu", "table"
]


class ScreenClassification(BaseModel):
    page_type: str
    description: str
    confidence: float


class ElementLabel(BaseModel):
    label: str
    confidence: float


class Embedding(BaseModel):
    model: str
    dimensions: int
    vector: list[float]


class HistoryStep(BaseModel):
    """One earlier step of an exploration: what the agent did and what came of it."""

    action: str
    result: str = ""


# The agent's actions. Each carries the model's one-sentence reasoning, so a failed run can be
# read afterwards. Click and type coordinates are pixels of the screenshot that was sent in, whatever size it was.
class ClickAction(BaseModel):
    action: Literal["click"] = "click"
    thought: str
    element: str
    x: int
    y: int


class TypeAction(BaseModel):
    action: Literal["type"] = "type"
    thought: str
    element: str
    x: int
    y: int
    text: str
    press_enter: bool = False


class ScrollAction(BaseModel):
    action: Literal["scroll"] = "scroll"
    thought: str
    direction: Literal["up", "down"]


class BackAction(BaseModel):
    action: Literal["back"] = "back"
    thought: str


class WaitAction(BaseModel):
    action: Literal["wait"] = "wait"
    thought: str


class DoneAction(BaseModel):
    action: Literal["done"] = "done"
    thought: str
    reason: str


class GiveUpAction(BaseModel):
    action: Literal["give_up"] = "give_up"
    thought: str
    reason: str


NextAction = Annotated[
    ClickAction | TypeAction | ScrollAction | BackAction | WaitAction | DoneAction | GiveUpAction,
    Field(discriminator="action"),
]
