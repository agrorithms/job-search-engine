const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  rsquo: "\u2019", lsquo: "\u2018", rdquo: "\u201D", ldquo: "\u201C",
  sbquo: "\u201A", bdquo: "\u201E", prime: "\u2032", Prime: "\u2033",
  mdash: "\u2014", ndash: "\u2013", hellip: "\u2026", bull: "\u2022",
  middot: "\u00B7", deg: "\u00B0", plusmn: "\u00B1", times: "\u00D7",
  divide: "\u00F7", copy: "\u00A9", reg: "\u00AE", trade: "\u2122",
  euro: "\u20AC", pound: "\u00A3", yen: "\u00A5", cent: "\u00A2",
  sect: "\u00A7", para: "\u00B6", laquo: "\u00AB", raquo: "\u00BB",
  rarr: "\u2192", larr: "\u2190", check: "\u2713", zwj: "\u200D",
  zwnj: "\u200C", shy: "",
  aacute: "\u00E1", eacute: "\u00E9", iacute: "\u00ED", oacute: "\u00F3",
  uacute: "\u00FA", ntilde: "\u00F1", ccedil: "\u00E7", uuml: "\u00FC",
  ouml: "\u00F6", auml: "\u00E4", szlig: "\u00DF", Eacute: "\u00C9",
};

function decodeCodePoint(code: number, original: string): string {
  // 0 and surrogates/out-of-range values are not valid characters.
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
    return original;
  }
  return String.fromCodePoint(code);
}

/**
 * Decode numeric (&#8217; / &#x2019;) and common named entities in a single
 * pass, so a double-escaped "&amp;lt;" becomes the literal text "&lt;"
 * rather than "<". Unknown named entities are left untouched.
 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (entity, body: string) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      return decodeCodePoint(parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10), entity);
    }
    return NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()] ?? entity;
  });
}

/**
 * Lightweight HTML-to-text conversion shared by connectors.
 * Intentionally simple (see README known limitations); not a sanitizer.
 */
export function htmlToText(html: string | null | undefined): string | null {
  if (!html) return null;

  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  const text = decodeEntities(stripped)
    .replace(/\u00A0/g, " ") // &#160; / &#xA0; decode to a non-breaking space
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text || null;
}
