// What the browser and the server both need to know about saving things into collections. It
// stays out of src/lib/server so the save button can import it.

/** The tables a collection can hold, as named in the `saved` relation of db/schema.surql. */
export const SAVED_TABLES = ['screen', 'element', 'flow'] as const;
export type SavedTable = (typeof SAVED_TABLES)[number];

export function isSavedTable(value: unknown): value is SavedTable {
	return SAVED_TABLES.includes(value as SavedTable);
}

/** Key of one saved thing in the picker's `savedIn` map, such as `screen:abc123`. */
export function savedKey(table: SavedTable, id: string): string {
	return `${table}:${id}`;
}
