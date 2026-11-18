/** Bracket placeholders like [delivery time] that must be filled before send. */

const PLACEHOLDER_RE = /\[([^\[\]]{1,80})\]/g;

export function findPlaceholders(text: string): string[] {
  const found: string[] = [];
  const re = new RegExp(PLACEHOLDER_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const inner = match[1]?.trim();
    if (inner) found.push(inner);
  }
  return found;
}

export function hasOpenPlaceholders(text: string): boolean {
  return findPlaceholders(text).length > 0;
}
