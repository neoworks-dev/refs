// Cuts a crawl's action graph into flows: runs of screens that belong together, like the pricing
// pages or the steps of a signup. Pure structure, no model. `bun crawler/flows.ts [site-slug]`
// recuts the current crawls of one site, or of every site.
import type { Surreal } from 'surrealdb';
import { sourceCrawls } from '#lib/server/library.ts';
import { configFromEnv, connect, plain, RecordId } from '#lib/server/surreal.ts';
import type { Action, Screen } from '#lib/types.ts';

export type FlowScreen = Pick<Screen, 'id' | 'kind' | 'path' | 'seq'>;
export type FlowAction = Pick<Action, 'id' | 'in' | 'out' | 'kind' | 'label' | 'region'>;

export interface CutStep {
	screen: FlowScreen;
	/** The edge that led here; missing on the first step. */
	action?: FlowAction;
}

export interface CutFlow {
	title: string;
	steps: CutStep[];
}

/**
 * Labels that move a visitor one step further along something they started: a form, a wizard, a
 * signup. A click on one of them keeps the flow going even when the URL leaves the section.
 */
const PROGRESSION_LABEL =
	/^(continue|next( step)?|get started|start( now| free| for free)?|proceed|begin|try (it )?(for )?free)\b/i;

/** A title is read in a list, so a link's full text (which can run on for a paragraph) is cut. */
const MAX_TITLE_LENGTH = 60;

/** A single screen is a page, not a journey. */
const MIN_FLOW_STEPS = 2;

/**
 * Cuts the screens and actions of one crawl into flows.
 *
 * A flow starts at the start page or at a click in the main navigation. It is made of
 * - the pages under the same first path segment as where it started, so a click on "Pricing" takes
 *   in `/pricing/enterprise` however the crawler found that page,
 * - the next state of a dialog or form that is already open, and
 * - the screens reached from a step by a click on a progression word such as "Continue".
 *
 * Every screen belongs to at most one flow, which is what keeps the flows from repeating each
 * other, and a screen that another flow starts at is never taken over by this one.
 */
export function cutFlowsFromGraph(screens: FlowScreen[], actions: FlowAction[]): CutFlow[] {
	if (screens.length === 0) return [];
	const orderedScreens = [...screens].sort((first, second) => first.seq - second.seq);
	const screensById = new Map(orderedScreens.map((screen) => [screen.id, screen]));
	const startScreen = orderedScreens[0];

	// Only actions between two known screens count. The crawler finds screens breadth first, so
	// sorting an action list by the screen it points at gives capture order.
	const outgoing = new Map<string, FlowAction[]>();
	const incoming = new Map<string, FlowAction[]>();
	const sortedActions = actions
		.filter(
			(action) =>
				screensById.has(action.in) && screensById.has(action.out) && action.in !== action.out
		)
		.sort((first, second) => screensById.get(first.out)!.seq - screensById.get(second.out)!.seq);
	for (const action of sortedActions) {
		outgoing.set(action.in, [...(outgoing.get(action.in) ?? []), action]);
		incoming.set(action.out, [...(incoming.get(action.out) ?? []), action]);
	}

	// Sites that serve everything under a locale (`/de`) start there, and that segment must not
	// count as the section of every page. Without the locale, `/de/products` and `/products` are
	// the same page.
	const homePath = pathnameOf(startScreen.path);
	const relativePathOf = (screen: FlowScreen): string => {
		const pathname = pathnameOf(screen.path);
		return pathname === homePath || pathname.startsWith(`${homePath}/`)
			? pathname.slice(homePath.length)
			: pathname;
	};
	const sectionOf = (screen: FlowScreen): string =>
		relativePathOf(screen).split('/').filter(Boolean)[0] ?? '';

	// Where flows start: the start page, and the destination of every click in the main navigation.
	// The main navigation sits on every page, but the crawler records a link where it first met it.
	// A "nav" link on a page deeper in the site that stays in that page's own section is a local
	// menu (a docs sidebar, a contact submenu), so it continues the section instead of starting a
	// flow. Only the start page's nav links, and ones that leave the section, are the main navigation.
	const entryActions = new Map<string, FlowAction | undefined>([[startScreen.id, undefined]]);
	for (const action of sortedActions) {
		const source = screensById.get(action.in)!;
		const target = screensById.get(action.out)!;
		const isMainNavigation =
			action.region === 'nav' &&
			(source === startScreen || sectionOf(source) !== sectionOf(target));
		if (isMainNavigation && !entryActions.has(target.id)) entryActions.set(target.id, action);
	}

	const claimed = new Set<string>();
	const flows: CutFlow[] = [];
	const entries = [...entryActions.keys()]
		.map((id) => screensById.get(id)!)
		.sort((first, second) => first.seq - second.seq);

	for (const entry of entries) {
		if (claimed.has(entry.id)) continue;
		const section = sectionOf(entry);
		claimed.add(entry.id);
		const steps: CutStep[] = [{ screen: entry }];
		const seenPaths = new Set([relativePathOf(entry)]);

		// The rest of the section. A state shares the path of the page it opens on, so only pages
		// say anything about the section; states join through the dialog rule below.
		for (const screen of orderedScreens) {
			if (screen.kind !== 'page' || section === '' || sectionOf(screen) !== section) continue;
			if (claimed.has(screen.id)) continue;
			// A page that differs only in its query string (`/login?redirect=...`) is the same
			// page again, not a next step.
			if (seenPaths.has(relativePathOf(screen))) continue;
			seenPaths.add(relativePathOf(screen));
			claimed.add(screen.id);
			steps.push({ screen, action: incoming.get(screen.id)?.[0] });
		}

		// Breadth-first in capture order: `steps` doubles as the queue.
		for (let index = 0; index < steps.length; index++) {
			const from = steps[index].screen;
			for (const action of outgoing.get(from.id) ?? []) {
				const target = screensById.get(action.out)!;
				if (claimed.has(target.id) || entryActions.has(target.id)) continue;

				// Opening a menu or an accordion from a page is not a step, so the first state only
				// counts once it leads on to another state, the way a dialog or form advances.
				const advancesDialog =
					target.kind === 'state' &&
					action.kind === 'click' &&
					(from.kind === 'state' ||
						(outgoing.get(target.id) ?? []).some(
							(onward) => onward.kind === 'click' && screensById.get(onward.out)?.kind === 'state'
						));
				const isProgression = PROGRESSION_LABEL.test(action.label.trim());
				if (!advancesDialog && !isProgression) continue;

				claimed.add(target.id);
				steps.push({ screen: target, action });
			}
		}
		if (steps.length < MIN_FLOW_STEPS) continue;

		// The entry stays first, the rest follows in the order the crawler captured it.
		const [entryStep, ...laterSteps] = steps;
		laterSteps.sort((first, second) => first.screen.seq - second.screen.seq);
		flows.push({
			title: titleOf(entryActions.get(entry.id), section),
			steps: [entryStep, ...laterSteps]
		});
	}
	return flows;
}

function pathnameOf(path: string): string {
	return path.split('?')[0].replace(/\/+$/, '');
}

/** The label of the click that opened the flow, else the section it covers, else "Home". */
function titleOf(entryAction: FlowAction | undefined, section: string): string {
	const label = entryAction?.label.replace(/\s+/g, ' ').trim();
	if (label) {
		return label.length > MAX_TITLE_LENGTH ? `${label.slice(0, MAX_TITLE_LENGTH - 1)}…` : label;
	}
	return section === '' ? 'Home' : `/${section}`;
}

/** Recuts the structural flows of one crawl: deletes the old ones and writes the new ones. */
export async function cutFlows(db: Surreal, crawlId: string): Promise<CutFlow[]> {
	const crawl = new RecordId('crawl', crawlId);
	const [[crawlRow], screenRows, actionRows] = await db
		.query(
			`SELECT site, viewport FROM crawl WHERE id = $crawl;
			 SELECT id, kind, path, seq FROM screen WHERE crawl = $crawl;
			 SELECT id, in, out, kind, label, region FROM action WHERE crawl = $crawl`,
			{ crawl }
		)
		.collect<[{ site: RecordId; viewport: string }[], unknown[], unknown[]]>();
	if (crawlRow === undefined) throw new Error(`no crawl ${crawlId}`);

	const screens = plain<FlowScreen[]>(screenRows);
	const actions = plain<FlowAction[]>(actionRows);
	if (!actions.some((action) => action.region !== undefined) && actions.length > 0) {
		console.warn(`crawl ${crawlId} has no action regions, so only its start page can open a flow`);
	}

	const flows = cutFlowsFromGraph(screens, actions);
	await db.query("DELETE flow WHERE crawl = $crawl AND source = 'structure'", { crawl }).collect();
	if (flows.length === 0) return flows;
	await db
		.query('INSERT INTO flow $flows', {
			flows: flows.map((flow) => ({
				site: crawlRow.site,
				crawl,
				viewport: crawlRow.viewport,
				source: 'structure',
				title: flow.title,
				steps: flow.steps.map((step) => ({
					screen: new RecordId('screen', step.screen.id),
					action: step.action && new RecordId('action', step.action.id)
				}))
			}))
		})
		.collect();
	return flows;
}

if (import.meta.main) {
	const db = await connect(configFromEnv(process.env));
	const crawls = await sourceCrawls(db, process.argv[2]);
	for (const crawl of crawls) {
		const flows = await cutFlows(db, crawl.id);
		console.log(`\n${crawl.site} ${crawl.viewport} (crawl ${crawl.id}): ${flows.length} flows`);
		for (const flow of flows) {
			console.log(`  ${flow.title}`);
			for (const step of flow.steps) {
				const label = step.action
					? `  <- ${step.action.kind} "${step.action.label.slice(0, 40)}"`
					: '';
				console.log(`    ${step.screen.kind} ${step.screen.path}${label}`);
			}
		}
	}
	await db.close();
}
