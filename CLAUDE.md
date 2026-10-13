# Refs

A self-hosted design reference library, like Mobbin but for websites we capture ourselves. A crawler drives a real browser through a site, takes screenshots of every page and UI state, crops out UI elements, and records how it got from one screen to the next. The SvelteKit app lets you browse all of that the way Mobbin does. It runs locally for now and gets hosted later, so nothing may assume a single user or a local disk forever.

## Architecture

The app and the crawler are two processes that only share the database and the media directory.

```
src/              SvelteKit 3 app (Svelte 5, Tailwind 4, adapter-node)
src/lib/server/   surreal.ts (connection, schema, plain()), media.ts (storage), db.ts (app singletons), library.ts (queries the app and the MCP share), queries.ts (the app's own queries), mcp/ (the MCP server)
src/lib/types.ts  plain shapes of the database records, shared by app and crawler
src/env.ts        server env vars, declared with defineEnvVars
crawler/          Playwright crawler run with bun: worker (job queue), cli, crawl loop, capture, in-page code, rules
db/schema.surql   the data contract, applied on every connect; must stay idempotent
references/       Mobbin screenshots used as design references (images gitignored, README indexes them)
data/             crawler output (gitignored)
ml/               uv-managed Python service: llama.cpp VLM on :8020, vLLM embedder on :8021, FastAPI on :8022
```

SurrealDB 3.3 runs in docker on `127.0.0.1:8010`, because port 8000 belongs to another project. The data model is in `db/schema.surql`, and its comments are the spec. In short, `site` is a website, `crawl` is one job for one site and one viewport and doubles as the work queue, `screen` is a captured page or UI state, `element` is a crop from a screen, and the `action` relation records which click or link led from one screen to another. Rects are CSS pixels in page coordinates. Media keys are paths like `sites/<site>/<viewport>/<screen>/full.webp`, served under `/media/` with immutable caching, so a key is never overwritten.

Every site is captured on desktop (1440x900) and on mobile (iPhone 15 Pro), both at device scale factor 2. The UI reads its query results through `plain()`, which turns record ids into their id string and datetimes into ISO strings.

## Commands

```
bun run db:up      start SurrealDB
bun run dev        the app
bun run crawler    the worker that picks up queued crawls
bun run crawl <url> [--viewport desktop|mobile|both] [--max-screens N] [--max-depth N]
bun run check      type check everything, including crawler/
bun run build
cd ml && uv run serve           the model servers and the API (uv run serve download fetches weights)
```

## SvelteKit 3

Kit 3 differs from v2 in ways that are easy to get wrong from memory. Check `node_modules/@sveltejs/kit` before using an API.

- Kit config lives in `vite.config.ts`. There is no `svelte.config.js` to edit.
- Imports go through the package.json `#lib` subpath import, with explicit `.ts` extensions: `import { db } from '#lib/server/db.ts'`.
- `$env/*` is gone. Env vars are declared in `src/env.ts` and imported from `$app/env/private` or `$app/env/public`.
- Remote functions are still experimental, so we use form actions.
- `pushState` is deprecated, and `goto` has no `keepFocus` or `noScroll`. Use `reset: false`, or `data-sveltekit-reset="false"` on links.

## Roadmap

1. Capture without AI: the crawler and the browsing UI. This is the current milestone.
2. The models: page classification and descriptions, embeddings, and semantic search.
3. AI exploration: goal-directed browsing and flows.
4. The element library across sites, collections, and dark mode.

The models run locally on a 16 GB GPU. Holo3.1-4B, a fine-tune of Qwen3.5, drives the browser and classifies screens. It runs as a Q6_K GGUF on llama.cpp, so it fits next to the embedder, and it passed the exploration eval (8 of 10 real multi-step tasks, see `ml/README.md`). If it proves too weak on our screens, Qwen3.8-27B at IQ3_S replaces it as another profile in `ml/refs_ml/serve.py`. Qwen3-VL-Embedding-2B produces embeddings, and OmniParser v2.0.1 detects elements only where the DOM gives us nothing usable.

Flows will be cut out of the action graph by structure first. A flow starts at a main navigation click and continues while the URL stays under one prefix, the same dialog or form advances, or the clicked labels are words like "Continue". The model then names each flow with a category from a fixed list, a free-text title and a caption per step. Goal-directed exploration produces flows that are labelled by construction.

The library is also available to models through an MCP server at `/mcp`, hosted at `https://refs.neoworks.dev/mcp`. It is read-only, needs an API key (`bun run api-key create <name>`, stored as a SHA-256 hash in `api_key`), and has exactly two tools, because fewer tools are easier for a model to use well. `search` finds sites, pages, screens and elements, optionally scoped to one site and one page path. `get` returns everything about one screen or site. Results are inline preview images followed by one JSON block, modelled on Mobbin's MCP, without its telemetry parameters. Keep it to two tools; flows become a new `type` of `search`, not a new tool. Auth gets revisited before hosting.

Crawls never log in. Refs only captures what a site shows to a visitor who isn't signed in, so there are no accounts, sessions or stored credentials.

## How we work

Implementation is handed to at most three subagents at a time, Sonnet unless asked otherwise. The lead splits the work, gives each agent its own files, owns the shared contract (`db/schema.surql`, `src/lib/types.ts`, `src/lib/server/{surreal,media,db}.ts`, `src/env.ts`) and reviews what comes back against this file. Every subagent prompt includes the code style below and the rule that work is only done when verified.

Work is done when it has been shown to work, not when it compiles. For the UI that means driving it with Playwright and looking at the screenshots next to the matching Mobbin reference. For the crawler it means crawling real sites and looking at the produced images. `bun run check` passes either way. Scratch scripts go in `/tmp`, never in the repo root, because Vite reloads on new files there.

## Code style

The code is written to be read by people seeing it for the first time, as if it were an open source repo.

- Comment code where it doesn't explain itself: the reason behind a heuristic, a threshold or a non-obvious step. Don't comment what the code already says.
- Give a function a short doc comment saying why it exists when its name doesn't make that obvious.
- Use readable names. Never use single letters such as `e`, `p`, `k` or `s`, and that includes callback parameters, loop variables and event handlers. A plain numeric loop index `i` is the only exception. Don't use project abbreviations either.
- Don't use the nullish assignment `??=` unless there is no other way. Write the explicit `if (value === undefined)` instead.
- Keep logic where it's used. Don't create a function or a component just because you can. A helper used once stays inline at its call site, and something gets extracted only when it is reused or is a genuinely separate concept.
- Don't make files unnecessarily large either. Split modules along their responsibilities, never by size, and don't create tiny files.
- Keep constants next to the code that uses them, named, with a comment saying why the value was chosen. Types live with what produces them.
- Prefer the direct API over indirection. In the crawler, use Playwright locators wherever they can express the logic, and keep in-page `evaluate` code for what locators can't do, such as extraction and measuring rects.
- Don't pass mutable state objects into a function to be changed there. Return a result, and pass intent explicitly, as in `acceptCookieBanner(page, { waitForBanner: isFirstPage })`.
- Wait for real conditions, not fixed sleeps or retry counters.
- Never swallow errors with `.catch(() => {})`. Catch only the failure you expect, and say in a comment why it's expected.
- Keep the happy path flat, so it reads from top to bottom.

Svelte:

- Use Svelte 5 the intended way: runes, typed `$props()`, snippets with `{@render}`, and `onclick=` event attributes. No `export let`, `$:`, slots, `createEventDispatcher` or stores for local state.
- Prefer `$derived`, writable when needed, over an `$effect` that copies state. Use `$effect` only for real side effects such as timers, scrolling or DOM APIs.
- Class names stay in the markup. Never put classes in variables, constants, variant maps or `$derived`. Write conditional classes with the array and object form, `class={['rounded-full px-4', active && 'bg-black text-white']}`, without `cn()`, clsx or template literals.
- Use the platform before building your own. A modal is a native `<dialog>` opened with `showModal()`.
- Use Inter as the font and follow the Mobbin references in `references/mobbin/` for the visual language. Don't copy Mobbin's name or logo.

## Git

Commits and pushes are mine; GitHub writes such as issues and comments go through the bot (see Issues). Short, to-the-point commit title, and a body explaining the change when the title doesn't carry it. Ask if you're unsure what to write.

No trailers, ever: no `Co-Authored-By` on a commit, no "Generated with Claude Code" on a PR.

## Writing

Commits and issues carry only what matters. Say the thing, explain what a reader won't see for themselves, and stop. Don't restate the diff, summarise what you just said, or add a section only because the format seemed to want one.

Write issues and their comments the way you'd explain it to a colleague, in complete sentences.

- Start with a 2–3 sentence summary: what happened, why, and the fix.
- Use short headings, with short paragraphs of normal prose under them.
- Never join ideas with arrows, slashes, colons or dashes. Write "first X, then Y" instead of "X → Y", and "A and B" instead of "A / B".
- Use at most two code identifiers per sentence. Say what each one does the first time it appears.
- Use bullets only for genuinely separate items, and make each bullet a full sentence.
- Use tables only for numbers or timelines.
- Use one date format everywhere: 2026-10-07 18:28.
- Put error messages, paths and commands in code formatting, and long logs in a collapsed `<details>` block.
- Put side findings in a short "Out of scope" section at the end.

## Issues

Issues on `neoworks-dev/refs` carry goals across sessions. A session ends and its context goes with it, so an issue is the only thing that carries a goal to the next one.

- Work that finishes in this session, with me here, needs no issue.
- Work that won't finish in one session gets one, however loosely defined it still is.
- Something concrete found along the way that isn't what we're doing now gets an issue instead of being done.

Write them as soon as the list exists, not once the work starts.

Write to GitHub as the bot. Issues, comments and labels go through `gh bot` (`gh bot issue comment 12 --body …`), so they show as `neoworks-bot[bot]`. Plain `gh` is for reading only. The bot as author already says a model wrote it, so no "written by Claude" line in the text. If `gh bot` fails, say so rather than falling back to plain `gh`. It lives in `~/Documents/neoworks/gh-bot`.

Every issue gets a type, a priority, an effort and an area. Type, priority and effort are GitHub's own issue type and the organization's issue fields, never labels.

- **Type.** `Bug` means something is broken, `Feature` something new, and `Task` everything else.
- **Priority.** `Urgent` means drop everything, `High` next up, `Medium` normal, and `Low` nice to have.
- **Effort.** `Low` is an hour or two, `Medium` about a day, and `High` several days or needs splitting.

`gh bot` sets all three at once, by name: `gh bot issue create --type Bug --priority High --effort Low --label area:crawler …`, and `gh bot issue edit 12 --priority Urgent` changes them later.

Area is a label, exactly one of:

- `area:crawler` is the capture side: exploration, screenshots, extraction and dedupe.
- `area:ui` is the SvelteKit app.
- `area:models` is the model service and everything the models produce.
- `area:data` is the schema, queries and media storage.
- `area:infra` is docker, deployment and tooling.

Two areas is fine when an issue genuinely spans them; three means split it.
