/** Separates an object path from an escaped field name in a leaf's name. */
export const POINTER = "#/";

/** `<path>#/<key>`, the key escaped per RFC 6901: `~` to `~0`, then `/` to `~1`. */
export const pointerName = (path: string, key: string): string =>
  `${path}${POINTER}${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;

/** The object path of a pointer name, or null for any other name. */
export function objectPathOf(name: string): string | null {
  const at = name.indexOf(POINTER);
  return at < 0 ? null : name.slice(0, at);
}

/** The field of a pointer name, unescaped: `~1` to `/`, then `~0` to `~`. */
export function fieldName(name: string): string {
  return name
    .slice(name.indexOf(POINTER) + POINTER.length)
    .replace(/~1/g, "/")
    .replace(/~0/g, "~");
}
