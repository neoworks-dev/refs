-- Applied on startup by the app and the crawler (see src/lib/server/surreal.ts). Must stay idempotent.
-- Tables and fields use OVERWRITE so edits here take effect on the next connect. Indexes use
-- IF NOT EXISTS, because OVERWRITE rebuilds an index on every connect, which took seconds. Changing
-- an index means a `REMOVE INDEX` by hand first.

-- A website we collect references from.
DEFINE TABLE OVERWRITE site SCHEMAFULL;
DEFINE FIELD OVERWRITE name ON site TYPE string;
DEFINE FIELD OVERWRITE slug ON site TYPE string;
-- Start URL, normalised. `host` is unique: one site per host.
DEFINE FIELD OVERWRITE url ON site TYPE string;
DEFINE FIELD OVERWRITE host ON site TYPE string;
DEFINE FIELD OVERWRITE description ON site TYPE option<string>;
-- Media key of the favicon / touch icon.
DEFINE FIELD OVERWRITE icon ON site TYPE option<string>;
-- Screen used as the card preview, per viewport. Set by the crawler from the start page.
DEFINE FIELD OVERWRITE cover ON site TYPE object DEFAULT {};
DEFINE FIELD OVERWRITE cover.desktop ON site TYPE option<record<screen>>;
DEFINE FIELD OVERWRITE cover.mobile ON site TYPE option<record<screen>>;
DEFINE FIELD OVERWRITE created_at ON site TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD OVERWRITE updated_at ON site TYPE datetime DEFAULT ALWAYS time::now();
DEFINE INDEX IF NOT EXISTS site_slug ON site FIELDS slug UNIQUE;
DEFINE INDEX IF NOT EXISTS site_host ON site FIELDS host UNIQUE;

-- One crawl job: one site, one viewport. The crawler worker picks up `queued` jobs.
DEFINE TABLE OVERWRITE crawl SCHEMAFULL;
DEFINE FIELD OVERWRITE site ON crawl TYPE record<site>;
DEFINE FIELD OVERWRITE viewport ON crawl TYPE string ASSERT $value IN ['desktop', 'mobile'];
DEFINE FIELD OVERWRITE status ON crawl TYPE string DEFAULT 'queued'
	ASSERT $value IN ['queued', 'running', 'done', 'failed', 'cancelled'];
DEFINE FIELD OVERWRITE max_screens ON crawl TYPE int DEFAULT 30;
DEFINE FIELD OVERWRITE max_depth ON crawl TYPE int DEFAULT 3;
-- Counters updated while running, for progress display.
DEFINE FIELD OVERWRITE screens ON crawl TYPE int DEFAULT 0;
DEFINE FIELD OVERWRITE elements ON crawl TYPE int DEFAULT 0;
-- Human-readable line describing what the crawler is doing right now.
DEFINE FIELD OVERWRITE activity ON crawl TYPE option<string>;
DEFINE FIELD OVERWRITE error ON crawl TYPE option<string>;
DEFINE FIELD OVERWRITE created_at ON crawl TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD OVERWRITE started_at ON crawl TYPE option<datetime>;
DEFINE FIELD OVERWRITE finished_at ON crawl TYPE option<datetime>;
DEFINE INDEX IF NOT EXISTS crawl_status ON crawl FIELDS status, created_at;
DEFINE INDEX IF NOT EXISTS crawl_site ON crawl FIELDS site;

-- A captured UI state. `kind = 'page'` is a URL load; `kind = 'state'` is what a click on a page
-- revealed (menu, dialog, tab). How a screen was reached is the `action` edge pointing at it.
DEFINE TABLE OVERWRITE screen SCHEMAFULL;
DEFINE FIELD OVERWRITE site ON screen TYPE record<site>;
DEFINE FIELD OVERWRITE crawl ON screen TYPE record<crawl>;
DEFINE FIELD OVERWRITE viewport ON screen TYPE string ASSERT $value IN ['desktop', 'mobile'];
DEFINE FIELD OVERWRITE kind ON screen TYPE string ASSERT $value IN ['page', 'state'];
DEFINE FIELD OVERWRITE url ON screen TYPE string;
-- Path + query of `url`, for display.
DEFINE FIELD OVERWRITE path ON screen TYPE string;
DEFINE FIELD OVERWRITE title ON screen TYPE string DEFAULT '';
-- Link distance from the start URL.
DEFINE FIELD OVERWRITE depth ON screen TYPE int DEFAULT 0;
-- Order of capture within the crawl.
DEFINE FIELD OVERWRITE seq ON screen TYPE int DEFAULT 0;
-- Viewport size in CSS px and full page height in CSS px (capped, see crawler).
DEFINE FIELD OVERWRITE width ON screen TYPE int;
DEFINE FIELD OVERWRITE height ON screen TYPE int;
DEFINE FIELD OVERWRITE full_height ON screen TYPE int;
-- Media keys: `viewport` = above-the-fold, `full` = full page, `thumb` = small preview of `viewport`.
DEFINE FIELD OVERWRITE media ON screen TYPE object;
DEFINE FIELD OVERWRITE media.viewport ON screen TYPE string;
DEFINE FIELD OVERWRITE media.full ON screen TYPE string;
DEFINE FIELD OVERWRITE media.thumb ON screen TYPE string;
-- Dedupe signatures: structural DOM hash and 64-bit dHash of the viewport image (hex).
DEFINE FIELD OVERWRITE dom_sig ON screen TYPE string;
DEFINE FIELD OVERWRITE image_hash ON screen TYPE string;
-- Filled in by the model pipeline (milestone 2).
DEFINE FIELD OVERWRITE page_type ON screen TYPE option<string>;
DEFINE FIELD OVERWRITE description ON screen TYPE option<string>;
-- Embedding of the viewport image from the model service, 1024 dimensions of unit length, so that
-- a text query embedded the same way is matched by cosine distance. 1024 found the same neighbours
-- as the full 2048 on our screens, where 512 started to return unrelated pages (issue #7).
DEFINE FIELD OVERWRITE embedding ON screen TYPE option<array<float>>;
DEFINE FIELD OVERWRITE captured_at ON screen TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX IF NOT EXISTS screen_site ON screen FIELDS site, viewport, seq;
DEFINE INDEX IF NOT EXISTS screen_crawl ON screen FIELDS crawl;
-- Changing the dimension means removing this index and re-embedding everything.
DEFINE INDEX IF NOT EXISTS screen_embedding ON screen FIELDS embedding HNSW DIMENSION 1024 DIST COSINE;

-- A UI element cropped from a screen. Rect is in CSS px, page coordinates (relative to the
-- top-left of the full-page image at scale 1).
DEFINE TABLE OVERWRITE element SCHEMAFULL;
DEFINE FIELD OVERWRITE site ON element TYPE record<site>;
DEFINE FIELD OVERWRITE screen ON element TYPE record<screen>;
-- The crawl of `screen`, copied here because filtering elements through their screen made every
-- library query scan all screens once per element (12 s at 2000 elements).
DEFINE FIELD OVERWRITE crawl ON element TYPE record<crawl>;
DEFINE FIELD OVERWRITE viewport ON element TYPE string ASSERT $value IN ['desktop', 'mobile'];
DEFINE FIELD OVERWRITE kind ON element TYPE string
	ASSERT $value IN ['section', 'header', 'footer', 'nav', 'button', 'input', 'form', 'dialog', 'menu', 'table'];
-- Accessible name or first heading text.
DEFINE FIELD OVERWRITE name ON element TYPE string DEFAULT '';
DEFINE FIELD OVERWRITE rect ON element TYPE object;
DEFINE FIELD OVERWRITE rect.x ON element TYPE number;
DEFINE FIELD OVERWRITE rect.y ON element TYPE number;
DEFINE FIELD OVERWRITE rect.w ON element TYPE number;
DEFINE FIELD OVERWRITE rect.h ON element TYPE number;
DEFINE FIELD OVERWRITE media ON element TYPE string;
-- Filled in by the model pipeline (milestone 2), e.g. 'hero', 'pricing', 'testimonials'.
DEFINE FIELD OVERWRITE label ON element TYPE option<string>;
-- Embedding of the crop, same model and dimensions as `screen.embedding`.
DEFINE FIELD OVERWRITE embedding ON element TYPE option<array<float>>;
DEFINE FIELD OVERWRITE captured_at ON element TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX IF NOT EXISTS element_screen ON element FIELDS screen;
DEFINE INDEX IF NOT EXISTS element_crawl ON element FIELDS crawl, kind;
DEFINE INDEX IF NOT EXISTS element_site ON element FIELDS site, viewport, kind;
DEFINE INDEX IF NOT EXISTS element_embedding ON element FIELDS embedding HNSW DIMENSION 1024 DIST COSINE;

-- screen -> action -> screen: how the crawler got from one screen to another.
DEFINE TABLE OVERWRITE action TYPE RELATION IN screen OUT screen SCHEMAFULL;
DEFINE FIELD OVERWRITE crawl ON action TYPE record<crawl>;
DEFINE FIELD OVERWRITE kind ON action TYPE string ASSERT $value IN ['navigate', 'click'];
-- Link text / button name that was used.
DEFINE FIELD OVERWRITE label ON action TYPE string DEFAULT '';
-- Where the clicked link or control sat on the source screen. Flows start at main navigation
-- clicks, so this is what tells them apart. Missing on actions recorded before it existed.
DEFINE FIELD OVERWRITE region ON action TYPE option<'nav' | 'main' | 'footer' | 'other'>;
-- Rect of the clicked element on the source screen, CSS px page coordinates.
DEFINE FIELD OVERWRITE rect ON action TYPE option<object>;
DEFINE FIELD OVERWRITE rect.x ON action TYPE number;
DEFINE FIELD OVERWRITE rect.y ON action TYPE number;
DEFINE FIELD OVERWRITE rect.w ON action TYPE number;
DEFINE FIELD OVERWRITE rect.h ON action TYPE number;

-- A flow: an ordered run of screens that belongs together, like the pricing pages or a signup
-- form's steps. Cut out of one crawl's action graph by structure (crawler/flows.ts) and recut
-- from scratch whenever that runs again; goal-directed exploration will add flows of its own.
DEFINE TABLE OVERWRITE flow SCHEMAFULL;
DEFINE FIELD OVERWRITE site ON flow TYPE record<site>;
DEFINE FIELD OVERWRITE crawl ON flow TYPE record<crawl>;
DEFINE FIELD OVERWRITE viewport ON flow TYPE string ASSERT $value IN ['desktop', 'mobile'];
-- 'structure' is cut from the action graph, 'goal' comes from goal-directed exploration.
DEFINE FIELD OVERWRITE source ON flow TYPE 'structure' | 'goal';
-- Set from the label of the click that starts the flow; the model replaces it with a real title.
DEFINE FIELD OVERWRITE title ON flow TYPE string DEFAULT '';
-- One of a fixed list chosen by the model (milestone 3), e.g. 'onboarding', 'pricing'.
DEFINE FIELD OVERWRITE category ON flow TYPE option<string>;
-- The screens in order. `action` is the edge that led to the step and is missing on the first.
DEFINE FIELD OVERWRITE steps ON flow TYPE array<object> DEFAULT [];
DEFINE FIELD OVERWRITE steps[*].screen ON flow TYPE record<screen>;
DEFINE FIELD OVERWRITE steps[*].action ON flow TYPE option<record<action>>;
DEFINE FIELD OVERWRITE steps[*].caption ON flow TYPE option<string>;
DEFINE FIELD OVERWRITE created_at ON flow TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX IF NOT EXISTS flow_crawl ON flow FIELDS crawl;
DEFINE INDEX IF NOT EXISTS flow_site ON flow FIELDS site, viewport;

-- A named set of saved references, like the pricing pages kept for one project. There are no
-- accounts, so collections belong to the library as a whole.
DEFINE TABLE OVERWRITE collection SCHEMAFULL;
DEFINE FIELD OVERWRITE name ON collection TYPE string;
DEFINE FIELD OVERWRITE slug ON collection TYPE string;
DEFINE FIELD OVERWRITE description ON collection TYPE option<string>;
DEFINE FIELD OVERWRITE created_at ON collection TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD OVERWRITE updated_at ON collection TYPE datetime DEFAULT ALWAYS time::now();
DEFINE INDEX IF NOT EXISTS collection_slug ON collection FIELDS slug UNIQUE;

-- collection -> saved -> screen | element | flow. Saving the same thing twice is refused by the index.
DEFINE TABLE OVERWRITE saved TYPE RELATION IN collection OUT screen | element | flow SCHEMAFULL;
DEFINE FIELD OVERWRITE saved_at ON saved TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX IF NOT EXISTS saved_once ON saved FIELDS in, out UNIQUE;

-- API keys for the MCP server. Only a SHA-256 hash of the key is stored; the key itself is shown
-- once when it is created and can't be recovered. Keys look like `refs_<random>`.
DEFINE TABLE OVERWRITE api_key SCHEMAFULL;
-- Who or what the key is for, e.g. "Moritz laptop".
DEFINE FIELD OVERWRITE name ON api_key TYPE string;
-- Hex SHA-256 of the full key.
DEFINE FIELD OVERWRITE hash ON api_key TYPE string;
DEFINE FIELD OVERWRITE created_at ON api_key TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD OVERWRITE last_used_at ON api_key TYPE option<datetime>;
-- Set when the key is revoked; a revoked key is refused.
DEFINE FIELD OVERWRITE revoked_at ON api_key TYPE option<datetime>;
DEFINE INDEX IF NOT EXISTS api_key_hash ON api_key FIELDS hash UNIQUE;
