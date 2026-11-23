# Model benchmarks

Compares models on the steps of a crawl, by what they produce and what that costs in tokens,
dollars and seconds. The crawler itself is not involved: a benchmark sends the same input to one
model per run and saves the answer, and the runs of a site add up to one table.

## Planning

The first step of a crawl. A model gets a website's landing page and plans the flows worth
capturing, from the page and from what it knows about the product. The target is what Mobbin
lists for a product: the screens of the signed-in product as areas, small flows with short titles
like "Creating a branch", and flows that continue inside what an earlier flow created, like the
codespace flows after "Adding a codespace". A plan expresses that with an `id` per flow and a
`continues_from` that names the flow it starts after.

```sh
bun bench/plan.ts --dry-run                          # snapshot github.com and write the prompt, no model call
bun bench/plan.ts --model qwen/qwen3.8-27b
bun bench/plan.ts --model z-ai/glm-5.3-flash@streamlake/fp8 --reasoning low
bun bench/plan.ts --model hcompany/holo4-35b-a3b
bun bench/plan.ts --model z-ai/glm-5.3-flash --site https://linear.app
```

| Option | Default | |
| --- | --- | --- |
| `--model` | none, required | An OpenRouter id, or `hcompany/<model>` for H Company's Holo models. An OpenRouter id can pin the upstream provider and its quantization the way OpenRouter's pages write it, `model@provider/quantization`, with no fallback to another provider. Without it, OpenRouter picks. |
| `--site` | `https://github.com` | The landing page to plan from. |
| `--reasoning` | `none` | `none`, `minimal`, `low`, `medium` or `high`, passed to OpenRouter. |
| `--max-tokens` | `32000` | Output limit, reasoning included. Mobbin lists about 160 flows for GitHub, and a flow takes 80 to 120 tokens in a plan. |
| `--retake` | off | Take a new snapshot of the page instead of the saved one. |
| `--dry-run` | off | Write the prompt and stop. |

Before anything is spent, the model is looked up in OpenRouter's public model list. A typo, a
model that cannot read images, or one with no provider that supports JSON schemas fails right
there. The list prices shown in the results come from there too.

The model gets:

- a screenshot of the landing page on the crawler's desktop viewport, shrunk to 1280 pixels,
- the URL, the title and the description,
- every element that can be clicked or typed into, with its destination and whether it is hidden
  (like the entries of a closed menu), grouped by header, content and footer,
- a whole example plan of Notion as a tree of about 50 flows, four of them written out field by
  field, and the instructions.

The page is captured once into `runs/<site>/snapshot/` and reused, so every run sees the same
page. The browser opens on screen while it captures. `--retake` captures the page again.

### What a run writes

- `runs/<site>/<time>-plan-<model>/` with `prompt.txt` (the exact text sent with the screenshot),
  `result.json` (token counts, cost, seconds, the raw answer and the parsed plan) and `summary.md`
  (the numbers, Mobbin's flows for the site when `reference/` has them, and the plan as a tree).
- One row per run in `runs/<site>/plan-results.md`, so every model tried on a site ends up in one
  table.

The table counts flows and areas, chained flows and the longest chain, chains that point at a flow
the plan does not have, flows that need the login, start paths the page links to (so they surely
exist), duplicate titles, input, output and reasoning tokens, the cost and the cost per flow, the
seconds, and why the answer ended (`length` means it was cut off). These numbers are cheap signals;
whether a plan is good is decided by reading it against Mobbin's list.

## Running flows

The second step of a crawl. `flows.ts` takes a plan saved by `plan.ts` and runs its flows in a
visible browser with a decider: a model that does not write text but chooses from options and gives
every option a probability. It goes through OpenRouter's System One endpoint. The default is
Perplexity's `perplexity/pplx-decider-v1.1-27b`, which also reads the screenshot; TypeSafe's
`typesafe/jev-1.13` reads text only and gets the state without it. The design follows Browser
Use's Jev Ultrafast.

```sh
bun bench/flows.ts --plan bench/runs/penny-de/<plan run>               # the first 5 flows it can run
bun bench/flows.ts --plan bench/runs/penny-de/<plan run> --flows g3,g7
bun bench/flows.ts --plan bench/runs/penny-de/<plan run> --decider typesafe/jev-1.13 --images off
```

At every step the decider gets one question whose options are whole actions: click or type into
one of the controls whose center is on screen (numbered, named, without link targets), press Enter
after typing, scroll down or up where there is more page, go back, done, or blocked. The state
next to it holds the goal, the success criterion, the URL, the scroll position and page height,
the last ten actions with whether each changed the screen, and the screenshot (1280 pixels). With
`--images off` the decider gets the text visible on screen instead, the way Jev Ultrafast works,
which is the only way for a decider that reads no images. One question instead of an operation
question and a target question matters because the Decisions API bills every question for the
whole state, screenshot included. When the decider chooses to type, a small text model
(`--text-model`, GLM-5.3 Flash by default) writes what goes into the field, because a decider
cannot.

An action changed the screen when the URL, the title, the visible text or the controls on screen
differ afterwards, as in Jev Ultrafast, so scrolling into new content counts and scrolling at the
bottom does not. Three actions in a row that change nothing end the flow as blocked. Scrolling
moves 560 pixels.

Every step waits for you: the terminal prints the decision with its confidence and the runners-up,
and the browser outlines the element and shows a panel with the flow, the goal and the decision.
Accept in the panel or Enter in the terminal carries it out, `s` skips the flow, `q` stops the run.

A flow that continues from another runs its parents first, in the same browser context. Flows
that need the login are not run unless `--storage-state` names a saved Playwright login, and flows
that need payment or personal data are never run.

| Option | Default | |
| --- | --- | --- |
| `--plan` | none, required | A run folder written by `plan.ts`. |
| `--decider` | `perplexity/pplx-decider-v1.1-27b` | A decision model on OpenRouter. |
| `--images` | `on` | `off` sends the visible page text instead of the screenshot. Deciders that read no images, like `typesafe/jev-1.13`, need `off`. |
| `--flows` | the first runnable ones | Flow ids from the plan, separated by commas. |
| `--limit` | `5` | How many flows to run without `--flows`. |
| `--text-model` | `z-ai/glm-5.3-flash` | The model that writes what to type, `model@provider/quantization` works. |
| `--text-reasoning` | `low` | Reasoning of the text model. |
| `--max-steps` | `15` | Steps before a flow counts as not done. |
| `--storage-state` | none | A Playwright storage state JSON saved after logging in. |

A run writes `runs/<site>/<time>-flows-<decider>/` with a folder per flow (a screenshot
per step and `steps.json` with every decision and its probabilities, written after every step so a
stopped run keeps them) and `summary.md`, and adds a
row to `runs/<site>/flows-results.md` with the planner, the decider, flows done, steps, tokens and
cost. OpenRouter reports the decider's cost with every call.

## Keys

Keys go into `.env`:

- `OPENROUTER_API_KEY` for everything on OpenRouter. OpenRouter reports the cost of every call,
  so that cost is exact.
- `HCOMPANY_API_KEY` for H Company's Holo models. Their API reports no cost, so it is estimated
  from the prices in `models.ts` and marked (est.).

Requests to OpenRouter only go to providers that support JSON schemas (`require_parameters`), so a
model that cannot follow the schema fails visibly instead of answering in another format.

## References

`reference/<site>.md` holds Mobbin's flow list for a site, copied by hand, such as
`reference/github-com.md`. It only goes into the summary, never into the prompt, so no model can
copy it.
