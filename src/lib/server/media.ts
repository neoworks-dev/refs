// Screenshot and crop storage. Keys are relative paths like `sites/<site>/<screen>/full.webp`.
// Local filesystem for now; swap the implementation for object storage when hosting.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve } from 'node:path';

export interface MediaStore {
	put(key: string, data: Uint8Array): Promise<void>;
	get(key: string): Promise<Uint8Array | undefined>;
}

export function localMedia(root: string): MediaStore {
	const rootDir = resolve(root);
	const pathOf = (key: string) => {
		const filePath = join(rootDir, normalize(key));
		// Keys come from URLs; refuse anything that would resolve outside the media root.
		if (!filePath.startsWith(rootDir + '/')) throw new Error(`invalid media key: ${key}`);
		return filePath;
	};
	return {
		async put(key, data) {
			const filePath = pathOf(key);
			await mkdir(dirname(filePath), { recursive: true });
			await writeFile(filePath, data);
		},
		async get(key) {
			try {
				return await readFile(pathOf(key));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
				throw error;
			}
		}
	};
}

/** Public URL of a media key, served by `src/routes/media/[...key]/+server.ts`. */
export function mediaUrl(key: string): string {
	return `/media/${key}`;
}
