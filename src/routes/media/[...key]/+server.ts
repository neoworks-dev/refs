import { error } from '@sveltejs/kit';
import { media } from '#lib/server/db.ts';
import type { RequestHandler } from './$types';

const CONTENT_TYPES: Record<string, string> = {
	webp: 'image/webp',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	svg: 'image/svg+xml',
	ico: 'image/x-icon',
	avif: 'image/avif'
};

export const GET: RequestHandler = async ({ params }) => {
	const key = params.key;
	// media.get() guards path traversal as well; rejecting early gives a clean 404 instead of a 500.
	if (!key || key.split('/').some((part) => part === '..' || part === '')) error(404);

	const data = await media.get(key);
	if (!data) error(404);

	const extension = key.split('.').pop()?.toLowerCase() ?? '';
	return new Response(data as BodyInit, {
		headers: {
			'content-type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
			// Keys embed ids that never change content, so the browser can cache forever.
			'cache-control': 'public, max-age=31536000, immutable',
			'x-content-type-options': 'nosniff'
		}
	});
};
