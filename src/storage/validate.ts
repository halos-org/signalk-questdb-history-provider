const IDENTIFIER = /^[a-zA-Z0-9_.:-]+$/;

/** Accepts a value spliced into SQL as an identifier or a quoted literal. */
export function validateIdentifier(value: string): string {
  if (!IDENTIFIER.test(value)) {
    throw new Error(`Invalid identifier: ${value}`);
  }
  return value;
}

/** Returns the instant as `YYYY-MM-DDTHH:mm:ss.sssZ`, the SQL literal form. */
export function validateTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid timestamp: ${value}`);
  }
  return parsed.toISOString();
}
