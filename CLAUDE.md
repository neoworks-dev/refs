# Refs

A self-hosted design reference library, like Mobbin but for websites we capture ourselves. A crawler drives a real browser through a site, takes screenshots of every page and UI state, crops out UI elements, and records how it got from one screen to the next. The SvelteKit app lets you browse all of that the way Mobbin does. It runs locally for now and gets hosted later, so nothing may assume a single user or a local disk forever.

## Architecture

The app and the crawler are two processes that only share the database and the media directory.

```
src/              SvelteKit 3 app (Svelte 5, Tailwind 4, adapter-node)
src/lib/server/   surreal.ts (connection, schema, plain()), media.ts (storage), db.ts (app singletons), library.ts (queries the app and the MCP share), queries.ts (the app's own queries), mcp/ (the MCP server)
src/lib/types.ts  plain shapes of the database records, shared by app and crawler
src/env.ts        server env vars, declared with defineEnvVars
crawler/          Playwright crawler run with bun: worker (crawl and flow request queues), cli, crawl (landing page, then the run), capture, in-page code, rules, exploration (explore, goals for planning, trajectory, agent), requests (flows people ask for), demo accounts (accounts, mail)
db/schema.surql   the data contract, applied on every connect; must stay idempotent
references/       Mobbin screenshots used as design references (images gitignored, README indexes them)
data/             crawler output (gitignored)
ml/               uv-managed launcher for local model servers (VLM on :8020, embedder on :8021), for development only
```

SurrealDB 3.3 runs in docker on `127.0.0.1:8010`, because port 8000 belongs to another project. The data model is in `db/schema.surql`, and its comments are the spec. In short, `site` is a website, `crawl` is one job for one site and one viewport and doubles as the work queue, `screen` is a captured page or UI state, `element` is a crop from a screen, and the `action` relation records which click or link led from one screen to another. Rects are CSS pixels in page coordinates. Media keys are paths like `sites/<site>/<viewport>/<screen>/full.webp`, served under `/media/` with immutable caching, so a key is never overwritten.

Every site is captured on desktop (1440x900) and on mobile (iPhone 15 Pro), both at device scale factor 2. The UI reads its query results through `plain()`, which turns record ids into their id string and datetimes into ISO strings.

## Commands

The `Taskfile.yml` wraps these (`go-task --list`); `go-task up` runs the app and the worker together.

```
bun run db:up      start SurrealDB
bun run dev        the app
bun run crawler    the worker that picks up queued crawls
bun run crawl <url> [--viewport desktop|mobile|both] [--max-trajectories N] [--plan-only]
bun run request <site> "<goal>" [--viewport desktop|mobile|both] [--queue]
bun run login <site>     sign up or log in to the demo account by hand, for sites whose bot protection refuses the crawler
bun run check      type check everything, including crawler/
bun run build
cd ml && uv run serve           a local VLM server for development (uv run serve download fetches weights)
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

The crawler and the app call the models directly over the OpenAI-compatible API (`src/lib/server/models.ts`), and the prompts live in TypeScript next to the code that sends them. Where the models run is configuration in `.env`. A local model on a 16 GB GPU proved too weak, so the models run hosted; which provider and which model per role (planning, deciding each step, pointing at elements) is still being decided on cost per site. `ml/` only starts local servers for development. There is no embedder for now, so nothing is embedded and search by meaning is off until `REFS_EMBEDDING_URL` is set.

A crawl opens the landing page, accepts the cookie banner, captures it as the first screen and learns the site's name, icon and cover from it. The model is then asked once, with the screenshot, the page's links and headings and what it knows about the product, which flows are worth recording. It lists the site's areas first and the flows per area, so the list covers the whole site. How many flows that is, a dozen for a shop and hundreds for a product like Figma, is the model's call, and `crawl.max_trajectories` only bounds how many a run tries. Every flow has a goal, a category from a fixed list, a start path, a success criterion and whether it needs the login. The browser agent (`crawler/trajectory.ts`) tries each one in a fresh browser and saves the attempt as a flow with source `goal`, whether it reached its goal or not, with a video. With a demo account the planning is repeated from the signed-in landing page for the flows behind the login. `bun run crawl <url> --plan-only` prints the plan without crawling.

People can also ask for a flow in the UI (`flow_request`). The worker tries it between crawls, inside the site's current crawl for that viewport, starting logged in when the demo account is active and the model judges the goal to need it, and saves it with source `request`. A site without a crawl for the viewport refuses the request. Flows with source `structure` come from the old structural crawl, which cut them from the action graph. They stay readable, and nothing creates them any more.

The library is also available to models through an MCP server at `/mcp`, hosted at `https://refs.neoworks.dev/mcp`. It is read-only, needs an API key (`bun run api-key create <name>`, stored as a SHA-256 hash in `api_key`), and has exactly two tools, because fewer tools are easier for a model to use well. `search` finds sites, pages, screens and elements, optionally scoped to one site and one page path. `get` returns everything about one screen or site. Results are inline preview images followed by one JSON block, modelled on Mobbin's MCP, without its telemetry parameters. Keep it to two tools; flows become a new `type` of `search`, not a new tool. Auth gets revisited before hosting.

Exploration may sign up and log in, with one demo account per site (the `account` table, shared by both viewports). Its address is a plus address of the demo Gmail inbox (`REFS_MAIL_ADDRESS`, read over IMAP with `REFS_MAIL_APP_PASSWORD`), so the verification email of a sign-up lands in one place and says which site it was for. Its password is random. The model gets the email and password in its context and types them itself, plus a made-up name; payment details, phone numbers, other people's data, and "Continue with Google" style logins stay refused. The crawler opens verification links itself and hands codes to the model. After a login the browser's storage state is saved in `account.storage_state`, and goals that need the login start from it. Most real products guard their sign-up with bot protection (GitHub, resend.com), and the crawler does not try to get around it. There a person runs `bun run login <site>` once and signs up with the account's address and password in a plain Chrome that nothing controls (`crawler/login.ts`). Only then does the crawler connect to read the cookies and local storage, which are saved the same way. Screens and goal flows captured while logged in carry `signed_in`, and the UI labels them. The landing page and the flows planned for a visitor capture only what a visitor sees. Passwords and storage state are plain text in the database, which has to change before hosting (#17).

## How we work

Implementation is handed to at most three subagents at a time, Sonnet unless asked otherwise. The lead splits the work, gives each agent its own files, owns the shared contract (`db/schema.surql`, `src/lib/types.ts`, `src/lib/server/{surreal,media,db}.ts`, `src/env.ts`) and reviews what comes back against this file. Every subagent prompt includes the code style below and the rule that work is only done when verified.

Work is done when it has been shown to work, not when it compiles. For the UI that means driving it with Playwright and looking at the screenshots next to the matching Mobbin reference. For the crawler it means crawling real sites and looking at the produced images. `bun run check` passes either way. Scratch scripts go in `/tmp`, never in the repo root, because Vite reloads on new files there.

## Code style

The code is written to be read by people seeing it for the first time, as if it were an open source repo.

- Comment code where it doesn't explain itself: the reason behind a heuristic, a threshold or a non-obvious step. Don't comment what the code already says.
- Give a function a short doc comment saying why it exists when its name doesn't make that obvious.
- Use readable names. Never use single letters such as `e`, `p`, `k` or `s`, and that includes callback parameters, loop variables and event handlers. A plain numeric loop index `i` is the only exception. Don't use project abbreviations either.
- Don't use the nullish assignment `??=` unless there is no other way. Write the explicit `if (value === undefined)` instead.
- Never nest ternaries. Use `if` statements, an early return, or a lookup instead.
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
- `area:models` is the models, their prompts and providers, and everything they produce.
- `area:data` is the schema, queries and media storage.
- `area:infra` is docker, deployment and tooling.

Two areas is fine when an issue genuinely spans them; three means split it.
