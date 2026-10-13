"""The multi-step tasks the agent is judged on.

Every task stays inside what the crawler may do: no logins, no payments, no submitted forms.
Each task has a check that looks at the real browser state, so success never depends on what
the model says about itself. One task is deliberately impossible without an account, and the
right outcome there is `give_up`.
"""

from collections.abc import Callable
from dataclasses import dataclass
from urllib.parse import urlparse

from playwright.sync_api import Page


@dataclass
class Task:
    name: str
    start_url: str
    goal: str
    # Receives the final page and the reason the model gave when it stopped.
    check: Callable[[Page, str], bool]
    expected_outcome: str = "done"


def shopify_cart_has_items(page: Page, _reason: str) -> bool:
    """Shopify stores expose the cart as JSON, which is more reliable than reading the page."""
    origin = "{0.scheme}://{0.netloc}".format(urlparse(page.url))
    return page.request.get(f"{origin}/cart.js").json()["item_count"] > 0


TASKS = [
    Task(
        name="stripe-docs",
        start_url="https://stripe.com",
        goal="Open Stripe's documentation and reach the payments quickstart for Node.js.",
        check=lambda page, _reason: "docs.stripe.com" in page.url and "quickstart" in page.url,
    ),
    Task(
        name="linear-signup",
        start_url="https://linear.app",
        goal="Go from the homepage to the sign up form and stop at the email step. Do not enter anything.",
        check=lambda page, _reason: "signup" in page.url or "login" in page.url,
    ),
    Task(
        name="allbirds-cart",
        start_url="https://www.allbirds.com",
        goal=(
            "Pick any men's shoe, choose a size and add it to the cart. "
            "Stop before checkout and finish once it is in the cart."
        ),
        check=shopify_cart_has_items,
    ),
    Task(
        name="tailwind-search",
        start_url="https://tailwindcss.com/docs",
        goal="Use the documentation's search to find the page about the flex-wrap utility and open it.",
        check=lambda page, _reason: "flex-wrap" in page.url,
    ),
    Task(
        name="notion-enterprise",
        start_url="https://www.notion.com/pricing",
        goal=(
            "On the pricing page switch the billing toggle to yearly, then open the form to "
            "contact sales about the Enterprise plan. Do not submit it."
        ),
        check=lambda page, _reason: "contact-sales" in page.url or "enterprise" in page.url,
    ),
    Task(
        name="github-pricing",
        start_url="https://github.com",
        goal="Open the pricing page and report how much the Team plan costs per user per month.",
        check=lambda page, reason: "github.com/pricing" in page.url and "4" in reason,
    ),
    Task(
        name="hn-comments",
        start_url="https://news.ycombinator.com",
        goal="Open the comments page of the story at the top of the front page.",
        check=lambda page, _reason: "news.ycombinator.com/item?id=" in page.url,
    ),
    Task(
        name="wikipedia-search",
        start_url="https://www.wikipedia.org",
        goal="Search for 'Rust (programming language)' and open the article.",
        check=lambda page, _reason: "wikipedia.org/wiki/Rust_(programming_language)" in page.url,
    ),
    Task(
        name="vercel-env-docs",
        start_url="https://vercel.com",
        goal="Open the Vercel documentation and find the page about environment variables.",
        check=lambda page, _reason: "environment-variables" in page.url,
    ),
    Task(
        name="github-new-repo",
        start_url="https://github.com",
        goal="Create a new repository named 'test-repo' on GitHub.",
        check=lambda page, reason: bool(reason),
        expected_outcome="give_up",
    ),
]
