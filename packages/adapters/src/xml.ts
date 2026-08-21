/**
 * Just enough XML for S3.
 *
 * S3's responses are a handful of flat, well-known shapes rather than arbitrary
 * documents, so a full parser would be a dependency earning very little. What
 * this does not do is as deliberate as what it does: no namespaces, no
 * attributes, no CDATA, no nesting beyond one repeated element. If a response
 * ever needs more than that, reach for a real parser rather than growing this.
 */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

export function decodeXmlText(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return ENTITIES[entity] ?? whole;
  });
}

/** The text of the first `<name>` element, or undefined when there is none. */
export function firstTag(xml: string, name: string): string | undefined {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  return match ? decodeXmlText(match[1]!) : undefined;
}

/** The raw inner XML of every `<name>` element, in document order. */
export function eachTag(xml: string, name: string): string[] {
  const pattern = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'g');
  const found: string[] = [];
  let match = pattern.exec(xml);
  while (match) {
    found.push(match[1]!);
    match = pattern.exec(xml);
  }
  return found;
}

/**
 * The message from an S3 error document.
 *
 * Every S3-compatible store returns this shape on failure, and the Code is
 * worth keeping: `NoSuchKey` and `AccessDenied` mean very different things to
 * the caller, and the HTTP status alone does not always separate them.
 */
export function parseS3Error(xml: string): { code?: string; message?: string } {
  const result: { code?: string; message?: string } = {};
  const code = firstTag(xml, 'Code');
  const message = firstTag(xml, 'Message');
  if (code !== undefined) result.code = code;
  if (message !== undefined) result.message = message;
  return result;
}
