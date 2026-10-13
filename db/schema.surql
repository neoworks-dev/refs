-- Applied on startup by the app and the crawler (see src/lib/server/surreal.ts). Must stay idempotent.

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
DEFINE INDEX OVERWRITE site_slug ON site FIELDS slug UNIQUE;
DEFINE INDEX OVERWRITE site_host ON site FIELDS host UNIQUE;

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
DEFINE INDEX OVERWRITE crawl_status ON crawl FIELDS status, created_at;
DEFINE INDEX OVERWRITE crawl_site ON crawl FIELDS site;

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
DEFINE FIELD OVERWRITE captured_at ON screen TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX OVERWRITE screen_site ON screen FIELDS site, viewport, seq;
DEFINE INDEX OVERWRITE screen_crawl ON screen FIELDS crawl;

-- A UI element cropped from a screen. Rect is in CSS px, page coordinates (relative to the
-- top-left of the full-page image at scale 1).
DEFINE TABLE OVERWRITE element SCHEMAFULL;
DEFINE FIELD OVERWRITE site ON element TYPE record<site>;
DEFINE FIELD OVERWRITE screen ON element TYPE record<screen>;
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
DEFINE FIELD OVERWRITE captured_at ON element TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX OVERWRITE element_screen ON element FIELDS screen;
DEFINE INDEX OVERWRITE element_site ON element FIELDS site, viewport, kind;

-- screen -> action -> screen: how the crawler got from one screen to another.
DEFINE TABLE OVERWRITE action TYPE RELATION IN screen OUT screen SCHEMAFULL;
DEFINE FIELD OVERWRITE crawl ON action TYPE record<crawl>;
DEFINE FIELD OVERWRITE kind ON action TYPE string ASSERT $value IN ['navigate', 'click'];
-- Link text / button name that was used.
DEFINE FIELD OVERWRITE label ON action TYPE string DEFAULT '';
-- Rect of the clicked element on the source screen, CSS px page coordinates.
DEFINE FIELD OVERWRITE rect ON action TYPE option<object>;
DEFINE FIELD OVERWRITE rect.x ON action TYPE number;
DEFINE FIELD OVERWRITE rect.y ON action TYPE number;
DEFINE FIELD OVERWRITE rect.w ON action TYPE number;
DEFINE FIELD OVERWRITE rect.h ON action TYPE number;
