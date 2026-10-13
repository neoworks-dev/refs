"""Closed-loop evaluation of the exploration agent.

A headless browser plays each task from `tasks.py` against a real public site: screenshot, ask
`/next-action`, execute, repeat. Success is checked by us from the browser state, not from what
the model claims, so a model that says "done" too early is caught.

    uv run python eval/agent.py <run-name> [task-name ...]

Screenshots and an action log per task land in eval/runs/<run-name>/<task-name>/.
"""

import json
import sys
import time
from pathlib import Path

import httpx
from playwright.sync_api import Page, sync_playwright, TimeoutError as PlaywrightTimeoutError

from tasks import TASKS, Task

API_URL = "http://127.0.0.1:8022"
VIEWPORT = {"width": 1440, "height": 900}
# Past 20 steps a model is wandering, and the crawler would not afford the time either.
MAX_STEPS = 20
# One wheel notch run of this size moves about three quarters of the viewport.
SCROLL_PIXELS = 700
# Pages keep long-polling analytics forever, so "network idle" is only waited for briefly.
SETTLE_TIMEOUT_MS = 4000
RUNS_DIRECTORY = Path(__file__).parent / "runs"


def execute(page: Page, action: dict) -> None:
    """Performs the model's action in the browser."""
    kind = action["action"]
    if kind == "click":
        page.mouse.click(action["x"], action["y"])
    elif kind == "type":
        page.mouse.click(action["x"], action["y"])
        page.keyboard.type(action["text"])
        if action["press_enter"]:
            page.keyboard.press("Enter")
    elif kind == "scroll":
        page.mouse.wheel(0, SCROLL_PIXELS if action["direction"] == "down" else -SCROLL_PIXELS)
    elif kind == "back":
        page.go_back()
    elif kind == "wait":
        page.wait_for_timeout(1000)

    page.wait_for_load_state("domcontentloaded")
    try:
        page.wait_for_load_state("networkidle", timeout=SETTLE_TIMEOUT_MS)
    except PlaywrightTimeoutError:
        pass  # Expected on sites that never go idle; what has rendered by now is what we show.


def describe(action: dict) -> str:
    """One line of history for the model, like "click 'Pricing link'"."""
    kind = action["action"]
    if kind == "click":
        return f"click {action['element']!r}"
    if kind == "type":
        return f"type {action['text']!r} into {action['element']!r}"
    if kind == "scroll":
        return f"scroll {action['direction']}"
    return kind


def run_task(task: Task, output_directory: Path, playwright_browser) -> dict:
    output_directory.mkdir(parents=True, exist_ok=True)
    context = playwright_browser.new_context(viewport=VIEWPORT)
    # The agent must never submit a form (log in, pay, subscribe). Blocking document POSTs
    # enforces that even when the model misjudges a click.
    context.route(
        "**/*",
        lambda route: route.abort()
        if route.request.method == "POST" and route.request.resource_type == "document"
        else route.continue_(),
    )
    page = context.new_page()
    page.goto(task.start_url, wait_until="domcontentloaded")

    history: list[dict] = []
    log: list[dict] = []
    outcome = "step_limit"
    final_reason = ""
    started = time.time()

    for step in range(1, MAX_STEPS + 1):
        # A click may open a new tab, which is where the agent continues.
        page = context.pages[-1]
        screenshot = page.screenshot()
        (output_directory / f"step-{step:02d}.png").write_bytes(screenshot)

        request_started = time.time()
        response = httpx.post(
            f"{API_URL}/next-action",
            files={"screenshot": ("screenshot.png", screenshot, "image/png")},
            data={
                "goal": task.goal,
                "url": page.url,
                "aria_snapshot": page.locator("body").aria_snapshot(),
                "history": json.dumps(history),
            },
            timeout=300,
        )
        latency = time.time() - request_started
        if response.status_code >= 400:
            # The model produced something unusable. That counts against it, so the task ends here.
            outcome = "api_error"
            final_reason = response.text[:1500]
            print(f"  {step:2d} {latency:4.1f}s API error: {final_reason}", flush=True)
            break
        action = response.json()

        entry = {"step": step, "url": page.url, "latency": round(latency, 1), **action}
        log.append(entry)
        print(f"  {step:2d} {latency:4.1f}s {describe(action)}  | {action['thought'][:110]}", flush=True)

        if action["action"] in ("done", "give_up"):
            outcome = action["action"]
            final_reason = action["reason"]
            break

        url_before = page.url
        structure_before = page.locator("body").aria_snapshot()
        execute(action=action, page=page)
        page = context.pages[-1]
        if page.url != url_before:
            result = f"now at {page.url}"
        elif page.locator("body").aria_snapshot() != structure_before:
            result = "the page changed"
        else:
            result = "nothing changed"
        history.append({"action": describe(action), "result": result})

    page = context.pages[-1]
    (output_directory / "final.png").write_bytes(page.screenshot())
    # Reaching the right page while the model never said "done" does not count as success:
    # the crawler would not know to stop.
    verified = outcome == task.expected_outcome and task.check(page, final_reason)
    result = {
        "task": task.name,
        "goal": task.goal,
        "outcome": outcome,
        "expected_outcome": task.expected_outcome,
        "verified_success": verified,
        "steps": len(log),
        "seconds": round(time.time() - started),
        "final_url": page.url,
        "final_reason": final_reason,
        "log": log,
    }
    (output_directory / "log.json").write_text(json.dumps(result, indent=2))
    context.close()
    return result


def main() -> None:
    run_name = sys.argv[1]
    selected = set(sys.argv[2:])
    results = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        for task in TASKS:
            if selected and task.name not in selected:
                continue
            print(f"== {task.name}: {task.goal}", flush=True)
            results.append(run_task(task, RUNS_DIRECTORY / run_name / task.name, browser))
            last = results[-1]
            print(f"   -> {last['outcome']} after {last['steps']} steps, verified={last['verified_success']}", flush=True)
        browser.close()

    successes = sum(result["verified_success"] for result in results)
    print(f"\n{successes}/{len(results)} tasks verified successful")
    for result in results:
        print(f"{result['task']:20s} {result['outcome']:10s} steps={result['steps']:2d} ok={result['verified_success']}")


if __name__ == "__main__":
    main()
