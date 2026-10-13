import { error } from '@sveltejs/kit';
import { getLiveGoalScreenshot } from '#lib/server/queries.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
	const screenshot = await getLiveGoalScreenshot(params.goal);
	if (screenshot === undefined) error(404);
	return new Response(screenshot as BodyInit, {
		headers: {
			'content-type': 'image/jpeg',
			// The row is overwritten after every step; the panel's `?step=` only busts the browser cache.
			'cache-control': 'no-store',
			'x-content-type-options': 'nosniff'
		}
	});
};
