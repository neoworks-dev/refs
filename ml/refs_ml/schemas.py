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

# What a flow is about, for browsing the library by flow type across sites. It follows Mobbin's
# flow tree (onboarding, logging in, checkout, searching, filtering and sorting, ...), adapted to
# websites: Mobbin's app flows such as "booking a home" or "verifying identity" become the
# visitor's goals on a marketing or shop site. "other" is the honest answer for a run of pages
# that only belong together by section.
#
# The model reads the descriptions, because a bare name like "exploring_features" is too easy to
# use for any run of marketing pages, and they decide between near neighbours.
FLOW_CATEGORY_DESCRIPTIONS = {
    "onboarding": "first-run setup after signing up: welcome steps, preferences, invitations",
    "signing_up": "creating an account or starting a free trial: registration forms",
    "logging_in": "signing in, password reset and verification steps",
    "checkout": "cart, shipping, payment and order confirmation",
    "subscribing": "choosing a plan and paying for it or upgrading",
    "pricing_and_plans": "comparing prices, plans and tiers",
    "searching": "typing a query and looking at the results",
    "filtering_and_sorting": "narrowing or ordering a list with filters, tabs or sort controls",
    "browsing_products": "looking through products, offers, deals, recipes or listings, and opening one",
    "reading_content": "reading articles, blog posts, documentation or guides",
    "exploring_features": "learning what a product does, page by page: product, solution and feature pages",
    "contacting": "reaching the company: contact, sales or demo request forms",
    "getting_help": "support, help center, FAQ and status pages",
    "customer_stories": "case studies, testimonials and customer lists",
    "settings": "account, profile or preference settings",
    "other": "none of the above",
}
FLOW_CATEGORIES = list(FLOW_CATEGORY_DESCRIPTIONS)

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


class FlowStepInput(BaseModel):
    """One step of a flow as the caller knows it: the page, and the click that led there."""

    url: str
    # Missing on the first step, which nothing led to.
    action_label: str = ""


class FlowNaming(BaseModel):
    category: str
    title: str
    # One per screenshot that was sent, in order.
    captions: list[str]
    confidence: float


class PageSummary(BaseModel):
    """One page of a crawled site as the planner sees it."""

    path: str
    page_type: str = ""
    description: str = ""
    title: str = ""


class Goal(BaseModel):
    """Something a visitor would plausibly try on the site, set by the model after surveying it."""

    goal: str
    category: str
    start_path: str
    # What the screen shows once the goal is reached, so a run can be judged against it.
    success: str
    # How many actions the model thinks the goal takes at least. The crawler tries the longer
    # goals first, because a goal that follows one navigation link was already captured.
    actions: int


class GoalPlan(BaseModel):
    goals: list[Goal]


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
