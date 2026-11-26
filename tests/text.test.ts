import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeEntities, htmlToText } from "../src/ingestion/text";

test("decodes decimal and hex numeric entities", () => {
  assert.equal(decodeEntities("We&#8217;re hiring &#x2014; now"), "We\u2019re hiring \u2014 now");
  assert.equal(decodeEntities("&#X1F680;"), "\u{1F680}");
});

test("decodes common named entities and leaves unknown ones alone", () => {
  assert.equal(decodeEntities("&ldquo;Ship&rdquo; &amp; learn&hellip; &mdash; caf&eacute;"), "\u201CShip\u201D & learn\u2026 \u2014 caf\u00E9");
  assert.equal(decodeEntities("&notarealentity; &#0; &#xD800; &#99999999;"), "&notarealentity; &#0; &#xD800; &#99999999;");
});

test("decodes in one pass, so double-escaped text stays literal", () => {
  assert.equal(decodeEntities("&amp;lt;p&amp;gt; and &amp;#8217;"), "&lt;p&gt; and &#8217;");
});

test("htmlToText strips tags, decodes entities, and treats non-breaking spaces as spaces", () => {
  assert.equal(
    htmlToText("<p>We&#8217;re&nbsp;&#160;hiring</p><ul><li>Rust &amp; Go</li></ul>"),
    "We\u2019re hiring\nRust & Go",
  );
});
