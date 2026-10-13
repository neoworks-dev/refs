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
	avif: 'image/avif',
	webm: 'video/webm',
	mp4: 'video/mp4'
};

export const GET: RequestHandler = async ({ params, request }) => {
	const key = params.key;
	// media.get() guards path traversal as well; rejecting early gives a clean 404 instead of a 500.
	if (!key || key.split('/').some((part) => part === '..' || part === '')) error(404);

	const data = await media.get(key);
	if (!data) error(404);

	const extension = key.split('.').pop()?.toLowerCase() ?? '';
	const headers: Record<string, string> = {
		'content-type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
		// Keys embed ids that never change content, so the browser can cache forever.
		'cache-control': 'public, max-age=31536000, immutable',
		'x-content-type-options': 'nosniff',
		// Browsers seek in a video with range requests and may refuse to seek without them.
		'accept-ranges': 'bytes'
	};

	const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') ?? '');
	if (range === null || (range[1] === '' && range[2] === '')) {
		return new Response(data as BodyInit, { headers });
	}
	// `bytes=-500` is the last 500 bytes; otherwise the end is optional and clamped to the file.
	const start = range[1] === '' ? Math.max(data.length - Number(range[2]), 0) : Number(range[1]);
	const end =
		range[1] === '' || range[2] === ''
			? data.length - 1
			: Math.min(Number(range[2]), data.length - 1);
	if (start > end || start >= data.length) {
		return new Response(null, {
			status: 416,
			headers: { 'content-range': `bytes */${data.length}` }
		});
	}
	return new Response(data.subarray(start, end + 1) as BodyInit, {
		status: 206,
		headers: { ...headers, 'content-range': `bytes ${start}-${end}/${data.length}` }
	});
};
