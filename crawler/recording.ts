// Recording a browser session as a flow video: a screencast of one page, an overlay that makes the
// pointer visible, and the timestamps of the flow's steps. Shared by the replay of structural flows
// (videos.ts) and by goal-directed exploration, which records its run live.
//
// Recording method, chosen by comparing it with encoding the DevTools screencast frames ourselves
// with ffmpeg (x264, CRF 18) on a text-heavy page (issue #20). Playwright's screencast writes VP9
// at up to 3.6 Mbit/s for 1440x900, and both methods start from the same JPEG frames. Chromium
// delivers those at CSS resolution whatever the device scale factor and `maxWidth` ask for (a
// 2880 wide request still arrives 1440 wide), so neither can show more than 1x, and on small body
// text the two were indistinguishable. Playwright also ships its own ffmpeg, so a hosted crawler
// needs nothing installed. Real flows came out at 0.4 to 2 Mbit/s, 0.5 to 3.7 MB per flow.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';
import type { Surreal } from 'surrealdb';
import type { MediaStore } from '#lib/server/media.ts';
import { RecordId } from '#lib/server/surreal.ts';
import type { FlowVideo, Viewport } from '#lib/types.ts';
import { newId, VIEWPORT_SIZES } from './capture.ts';

/** Pointer travel across the screen, in animation frames of about 16 ms (roughly 0.4 s). */
const POINTER_MOVE_FRAMES = 24;
const POINTER_FRAME_MS = 16;
/** The pointer rests on a control for this long before the click, so a viewer sees what is clicked. */
const POINTER_HOVER_MS = 350;
/** On mobile there is no hovering pointer, so the touch point is shown this long before the tap. */
const TOUCH_LEAD_MS = 500;

/** Where the pointer is before the first move: low in the middle, where a thumb or hand rests. */
function restingPoint(viewport: Viewport): Point {
	const { width, height } = VIEWPORT_SIZES[viewport];
	return { x: width / 2, y: height * 0.8 };
}

export interface Point {
	x: number;
	y: number;
}

export interface FlowRecording {
	/** Notes that the visitor has just reached the next step of the flow. */
	markStep(): void;
	/**
	 * Moves the pointer to a point in the viewport (CSS px) and clicks it, or taps it on mobile.
	 * Resolves once the click is made; it doesn't wait for what the click causes.
	 */
	click(point: Point): Promise<void>;
	/**
	 * Redraws the pointer where it was. A new document starts without the overlay's arrow until a
	 * mouse event arrives, so call this after every navigation.
	 */
	restorePointer(): Promise<void>;
	/** Stops the recording, stores the file under a new media key and returns the stored video. */
	finish(options: {
		media: MediaStore;
		site: string;
		flowId: string;
		failed?: string;
	}): Promise<FlowVideo>;
}

/**
 * Starts recording a page. Call it once the page is where the recording should begin (after a
 * cookie banner was accepted, say), because the first frame is whatever the page shows right now.
 */
export async function startRecording(page: Page, viewport: Viewport): Promise<FlowRecording> {
	const size = VIEWPORT_SIZES[viewport];
	const directory = await mkdtemp(join(tmpdir(), 'refs-video-'));
	const file = join(directory, 'recording.webm');

	await page.addInitScript(installPointerOverlay);
	await page.evaluate(installPointerOverlay);
	// `size` has to be given: without it Playwright scales the video down to fit 800x800.
	await page.screencast.start({ path: file, size });
	const startedAt = Date.now();

	const stepSeconds: number[] = [];
	let pointer = restingPoint(viewport);

	const recording: FlowRecording = {
		markStep() {
			stepSeconds.push((Date.now() - startedAt) / 1000);
		},

		async click(target) {
			if (viewport === 'mobile') {
				await page.evaluate(
					({ x, y }) =>
						window.dispatchEvent(new CustomEvent('visitor-touch-point', { detail: { x, y } })),
					target
				);
				await page.waitForTimeout(TOUCH_LEAD_MS);
				await page.touchscreen.tap(target.x, target.y);
				return;
			}
			// An ease-in-out path, so the pointer speeds up and slows down like a hand does. The
			// frames are paced because the overlay only draws where the mouse events say.
			const from = pointer;
			for (let frame = 1; frame <= POINTER_MOVE_FRAMES; frame++) {
				const progress = frame / POINTER_MOVE_FRAMES;
				const eased = progress < 0.5 ? 2 * progress * progress : 1 - (-2 * progress + 2) ** 2 / 2;
				await page.mouse.move(
					from.x + (target.x - from.x) * eased,
					from.y + (target.y - from.y) * eased
				);
				await page.waitForTimeout(POINTER_FRAME_MS);
			}
			pointer = target;
			await page.waitForTimeout(POINTER_HOVER_MS);
			await page.mouse.click(target.x, target.y);
		},

		async restorePointer() {
			if (viewport !== 'mobile') await page.mouse.move(pointer.x, pointer.y);
		},

		async finish({ media, site, flowId, failed }) {
			const duration = (Date.now() - startedAt) / 1000;
			await page.screencast.stop();
			try {
				const key = `sites/${site}/${viewport}/flows/${flowId}/${newId()}.webm`;
				await media.put(key, await readFile(file));
				return {
					media: key,
					width: size.width,
					height: size.height,
					duration,
					steps: stepSeconds,
					...(failed === undefined ? {} : { failed }),
					recorded_at: new Date().toISOString()
				};
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		}
	};
	return recording;
}

/** Writes a recorded video onto its flow. */
export async function setFlowVideo(db: Surreal, flowId: string, video: FlowVideo): Promise<void> {
	await db
		.query('UPDATE $flow SET video = $video', {
			flow: new RecordId('flow', flowId),
			video: { ...video, recorded_at: new Date(video.recorded_at) }
		})
		.collect();
}

/**
 * Runs in every page of a recorded browser: an arrow that follows the mouse and a ring that
 * pulses where a click or tap lands. The screencast only shows what the page itself draws, so
 * without this a viewer sees links activate with nothing pointing at them. Written as one
 * self-contained function because Playwright serialises it into the page.
 */
function installPointerOverlay(): void {
	const installedKey = Symbol.for('refs.pointerOverlay');
	const flagged = window as unknown as Record<symbol, boolean>;
	// Frames get their own documents, and the arrow must exist once, on the top page.
	if (flagged[installedKey] || window !== window.top) return;
	flagged[installedKey] = true;

	const host = document.createElement('div');
	host.style.cssText =
		'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;';
	const shadow = host.attachShadow({ mode: 'closed' });
	shadow.innerHTML = `
		<style>
			.arrow { position: fixed; left: 0; top: 0; width: 22px; height: 22px; display: none;
				filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.5)); }
			.ring { position: fixed; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%;
				border: 2px solid #fff; background: rgba(40, 120, 255, 0.45);
				box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.45); animation: pulse 700ms ease-out forwards; }
			.ring.waiting { animation: none; opacity: 0.9; }
			@keyframes pulse { from { transform: scale(0.6); opacity: 1; } to { transform: scale(1.5); opacity: 0; } }
		</style>
		<svg class="arrow" viewBox="0 0 22 22"><path d="M3 2 L3 17 L7 13 L10 20 L13 19 L10 12 L16 12 Z"
			fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
	const arrow = shadow.querySelector<SVGElement>('.arrow')!;

	// Init scripts run before the document has an element to attach to, and frameworks that rebuild
	// the page can drop the host later, so it is attached again whenever it is needed.
	const attach = () => {
		if (!host.isConnected && document.documentElement) document.documentElement.append(host);
	};
	attach();
	document.addEventListener('readystatechange', attach);

	const showRing = (x: number, y: number, waiting: boolean) => {
		attach();
		const ring = document.createElement('div');
		ring.className = waiting ? 'ring waiting' : 'ring';
		ring.style.left = `${x}px`;
		ring.style.top = `${y}px`;
		shadow.append(ring);
		// A pulse removes itself; a waiting ring is replaced by the pulse of the touch that follows.
		if (!waiting) ring.addEventListener('animationend', () => ring.remove());
		return ring;
	};

	window.addEventListener(
		'mousemove',
		(event) => {
			attach();
			arrow.style.display = 'block';
			arrow.style.transform = `translate(${event.clientX}px, ${event.clientY}px)`;
		},
		true
	);
	window.addEventListener(
		'pointerdown',
		(event) => {
			shadow.querySelectorAll('.waiting').forEach((ring) => ring.remove());
			showRing(event.clientX, event.clientY, false);
		},
		true
	);
	window.addEventListener('visitor-touch-point', (event) => {
		const { x, y } = (event as CustomEvent<{ x: number; y: number }>).detail;
		showRing(x, y, true);
	});
}
