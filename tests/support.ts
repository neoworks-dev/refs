/// <reference types="bun" />
// Shared by the crawler tests.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
// Brings in the `window.pageInspector` declaration that tests use inside the page. Type-only: the
// file itself runs in the browser, where `openBrowser` injects it.
import type {} from '../crawler/page.ts';

export function fixtureUrl(name: string): string {
	return pathToFileURL(join(import.meta.dir, 'fixtures', name)).href;
}
