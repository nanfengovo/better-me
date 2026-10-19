import assert from "node:assert/strict";
import test from "node:test";
import { ToolError } from "@better-me/opportunities";
import { JobPostingJsonLdOptionsSchema } from "../src/jobposting-jsonld-contracts.js";
import { enumerateJobPostingUrls } from "../src/jobposting-enumeration.js";

const entry = "https://careers.example.com/list.xml";
const options = JobPostingJsonLdOptionsSchema.parse({ enumerationKind: "sitemap-urlset", enumerationUrls: [entry], postingPathPrefixes: ["/jobs"] });
const xml = (body: string) => `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</urlset>`;
const loc = (value: string) => `<url><loc>${value}</loc></url>`;
const enumerate = (body: string) => enumerateJobPostingUrls(body, entry, options);
const html = (body: string) => enumerateJobPostingUrls(body, entry, { ...options, enumerationKind: "html-list" });
const code = (expected: string) => (error: unknown) => error instanceof ToolError && error.code === expected;

test("sitemap URL-set preserves observed order, decodes predefined XML entities, ignores metadata and deduplicates", () => {
  const result = enumerate(xml(`${loc("https://careers.example.com/jobs/2?a=1&amp;b=2")}<url><lastmod>2026-09-13</lastmod><loc>https://careers.example.com/jobs/1</loc><changefreq>daily</changefreq><priority>0.5</priority></url>${loc("https://careers.example.com/jobs/1")}`));
  assert.deepEqual(result, { urls: ["https://careers.example.com/jobs/2?a=1&b=2", "https://careers.example.com/jobs/1"], warnings: [], truncated: false });
  assert.equal(Object.hasOwn(result, "datePosted"), false);
});

test("XML prefix namespaces, unnamespaced URL-sets and foreign image extensions do not turn image locs into jobs", () => {
  assert.deepEqual(enumerate('<s:urlset xmlns:s="http://www.sitemaps.org/schemas/sitemap/0.9"><s:url><s:loc>https://careers.example.com/jobs/1</s:loc></s:url></s:urlset>').urls, ["https://careers.example.com/jobs/1"]);
  assert.deepEqual(enumerate('<urlset><url><loc><![CDATA[https://careers.example.com/jobs/2?a=1&b=2]]></loc></url></urlset>').urls, ["https://careers.example.com/jobs/2?a=1&b=2"]);
  assert.deepEqual(enumerate(xml('<url><loc>https://careers.example.com/jobs/1</loc><image:image xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"><image:loc>https://careers.example.com/jobs/image.jpg</image:loc></image:image></url>')).urls, ["https://careers.example.com/jobs/1"]);
});

test("sitemap ignores out-of-scope hosts, non-job navigation and path lookalikes without broadening prefixes", () => {
  assert.deepEqual(enumerate(xml(["https://other.example.com/jobs/1", "https://careers.example.com/about", "https://careers.example.com/jobs-copy/2",
    "https://careers.example.com/jobs/valid", "https://careers.example.com/jobs"].map(loc).join(""))).urls,
  ["https://careers.example.com/jobs/valid", "https://careers.example.com/jobs"]);
});

test("sitemap rejects DTDs, custom entities, malformed XML, non-urlset roots and loc outside its direct url", () => {
  for (const body of ['<!DOCTYPE urlset><urlset/>', '<!DOCTYPE urlset [<!ENTITY x "https://careers.example.com/jobs/1">]><urlset><url><loc>&x;</loc></url></urlset>',
    xml('<url><loc>&undefined;</loc></url>'), '<urlset><url></urlset>', '<sitemapindex><sitemap><loc>https://careers.example.com/list2.xml</loc></sitemap></sitemapindex>',
    '<urlset><loc>https://careers.example.com/jobs/1</loc></urlset>', '<urlset><other><loc>https://careers.example.com/jobs/1</loc></other></urlset>',
    '<urlset><url><other><loc>https://careers.example.com/jobs/1</loc></other></url></urlset>', '<urlset><url><loc><b>https://careers.example.com/jobs/1</b></loc></url></urlset>',
    '<urlset xmlns="https://unrelated.example.com/schema"><url><loc>https://careers.example.com/jobs/1</loc></url></urlset>',
    '<urlset/>trailing', '<urlset/><urlset/>', '<urlset><?stylesheet href="remote"?></urlset>', 'not XML', '']) {
    assert.throws(() => enumerate(body), code("source-changed"), body);
  }
});

test("sitemap requires one nonempty absolute loc per url and rejects duplicate loc or missing locations", () => {
  for (const body of ['<url/>', '<url><lastmod>2026-09-13</lastmod></url>', '<url><loc/></url>', '<url><loc>/jobs/1</loc></url>',
    '<url><loc>https://careers.example.com/jobs/1</loc><loc>https://careers.example.com/jobs/2</loc></url>']) {
    assert.throws(() => enumerate(xml(body)), code("source-changed"));
  }
});

test("candidate links cannot introduce credentials, fragments, encoded separators, hidden controls or double encodings", () => {
  const values = ["https://user@careers.example.com/jobs/1", "https://careers.example.com/jobs/2#part", "https://careers.example.com/jobs/3#",
    "https://careers.example.com/jobs%2fescape", "https://careers.example.com/jobs/%2e%2e/escape", "https://careers.example.com/jobs/a%5cb", "https://careers.example.com/jobs/a%0ab",
    "https://careers.example.com/jobs/a%252fb", "https://careers.example.com/jobs/%zz", "https://careers.example.com/jobs/valid"];
  assert.deepEqual(enumerate(xml(values.map(loc).join(""))).urls, [values.at(-1)]);
});

test("HTML takes only real static anchors and never uses script data, comments, frames, forms or pagination hints", () => {
  const result = html(`<!doctype html><html><head><script>const jobs=[{url:'/jobs/script'}]</script></head><body>
    <!-- <a href='/jobs/comment'>Comment</a> --><iframe src='/jobs/frame'></iframe><form action='/jobs/form'></form>
    <link rel='next' href='/jobs/page2'><a href='/search?page=2'>Next</a><div data-url='/jobs/data'>Data</div>
    <a href='/jobs/first?a=1&amp;b=2'>First</a><a href='../jobs/second'>Second</a><a href='/jobs/first?a=1&amp;b=2'>Duplicate</a>
    </body></html>`);
  assert.deepEqual(result.urls, ["https://careers.example.com/jobs/first?a=1&b=2", "https://careers.example.com/jobs/second"]);
  assert.equal(result.truncated, false);
  assert.match(result.warnings.join(" "), /static anchors/);
});

test("HTML suppresses raw and inert containers but resumes after their real closing tags", () => {
  const tags = ["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript", "object", "template", "svg", "math", "canvas"];
  const result = html(tags.map((tag) => `<${tag}><a href='/jobs/${tag}'>Hidden</a></${tag}>`).join("") + "<a href='/jobs/visible'>Visible</a>");
  assert.deepEqual(result.urls, ["https://careers.example.com/jobs/visible"]);
  assert.deepEqual(html("<plaintext><a href='/jobs/text'>Text</a></plaintext><a href='/jobs/after'>Still text</a>").urls, []);
});

test("raw-text, RCDATA and fallback content cannot supply a base or change earlier relative links", () => {
  for (const tag of ["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript", "object", "template", "svg", "math", "canvas"]) {
    assert.deepEqual(html(`<a href='/jobs/before'>Before</a><${tag}><base href='https://other.example.com/'><a href='/jobs/fake'>Fake</a></${tag}><a href='/jobs/after'>After</a>`).urls,
      ["https://careers.example.com/jobs/before", "https://careers.example.com/jobs/after"], tag);
  }
});

test("raw-text fake ancestor closings and script openings cannot escape or swallow later real links", () => {
  for (const tag of ["script", "style", "xmp", "iframe", "noembed", "noframes", "noscript", "title", "textarea"]) {
    const body = `<section><${tag}></section><base href='https://other.example.com/'><a href='/jobs/fake'>Fake</a><script></${tag}><a href='/jobs/after'>After</a></section>`;
    assert.deepEqual(html(body).urls, ["https://careers.example.com/jobs/after"], tag);
    assert.deepEqual(html(`<section hidden><${tag}></section><a href='/jobs/fake'>Fake</a></${tag}><a href='/jobs/still-hidden'>Hidden</a></section><a href='/jobs/visible'>Visible</a>`).urls,
      ["https://careers.example.com/jobs/visible"], tag);
  }
});

test("raw-text ends require the matching HTML tag boundary and handle case, slash and quoted end-tag attributes", () => {
  for (const tag of ["script", "style", "xmp", "iframe", "noembed", "noframes", "noscript", "title", "textarea"]) {
    for (const closing of [`</${tag.toUpperCase()}>`, `</${tag}/>`, `</${tag} ignored='>'>`]) {
      assert.deepEqual(html(`<${tag}></${tag}-fake><a href='/jobs/fake'>Fake</a>${closing}<a href='/jobs/real'>Real</a>`).urls,
        ["https://careers.example.com/jobs/real"], `${tag}: ${closing}`);
    }
    assert.deepEqual(html(`<${tag}><a href='/jobs/fake'>Fake</a></${tag}-fake><a href='/jobs/still-text'>Text</a>`).urls, [], tag);
  }
});

test("a self-closed foreign raw-text name does not swallow a later ordinary anchor", () => {
  assert.deepEqual(html("<svg><iframe/></svg><a href='/jobs/real'>Real</a>").urls, ["https://careers.example.com/jobs/real"]);
  for (const tag of ["script", "style", "xmp", "iframe", "noembed", "noframes", "noscript", "title", "textarea"]) {
    assert.deepEqual(html(`<${tag}/><a href='/jobs/still-text'>Text</a>`).urls, [], tag);
    assert.deepEqual(html(`<section><${tag}/></section><a href='/jobs/fake'>Fake</a></${tag}><a href='/jobs/real'>Real</a>`).urls,
      ["https://careers.example.com/jobs/real"], tag);
  }
});

test("WHATWG script escaped and double-escaped states do not release fake anchors or bases", () => {
  assert.deepEqual(html("<script><!--<script></script><a href='/jobs/fake'>Fake</a><base href='https://other.example.com/'></script><a href='/jobs/real'>Real</a>").urls,
    ["https://careers.example.com/jobs/real"]);
  assert.deepEqual(html("<script><!--<script>--></script><a href='/jobs/real'>Real</a>").urls,
    ["https://careers.example.com/jobs/real"]);
  assert.deepEqual(html("<script><!--<script></script-fake><a href='/jobs/still-text'>Text</a>").urls, []);
});

test("WHATWG select parsing ignores non-option anchor tokens instead of inventing visible links", () => {
  assert.deepEqual(html("<select><a href='/jobs/fake'>Fake</a><option>Choice</option></select><a href='/jobs/real'>Real</a>").urls,
    ["https://careers.example.com/jobs/real"]);
});

test("HTML suppresses hidden attributes, hidden ancestors and inline CSS while keeping open dialogs/details", () => {
  const hiddenAttributes = ["hidden", "hidden='false'", "inert", "aria-hidden=' TRUE '", "style='display: none !important'", "style='visibility: collapse'",
    "style='content-visibility:hidden'", "style='opacity: 0.0'", "style='display:/* comment */none'"];
  const body = hiddenAttributes.map((attributes, index) => `<section ${attributes}><a href='/jobs/hidden-${index}'>Hidden</a></section>`).join("");
  assert.deepEqual(html(`${body}<a hidden href='/jobs/self-hidden'>Hidden</a><details><a href='/jobs/closed'>Closed</a></details><dialog><a href='/jobs/dialog-closed'>Closed</a></dialog>
    <details open><a href='/jobs/detail-open'>Open</a></details><dialog open><a href='/jobs/dialog-open'>Open</a></dialog><a aria-hidden='false' href='/jobs/visible'>Visible</a>`).urls,
  ["https://careers.example.com/jobs/detail-open", "https://careers.example.com/jobs/dialog-open", "https://careers.example.com/jobs/visible"]);
});

test("HTML attribute quotes cannot manufacture nested anchors and large inert metadata does not hide valid later links", () => {
  assert.deepEqual(html(`<meta data-wizard='${"x".repeat(64 * 1024)}'><div title="<a href='/jobs/fake'>">Text</div><a href='/jobs/real'>Real</a>`).urls,
    ["https://careers.example.com/jobs/real"]);
});

test("HTML relative anchors honor the first real base, including a base after the anchor, without fabricating local URLs", () => {
  assert.deepEqual(html("<a href='1'>One</a><base href='/jobs/'><base href='/else/'><a href='2'>Two</a>").urls,
    ["https://careers.example.com/jobs/1", "https://careers.example.com/jobs/2"]);
  assert.deepEqual(html("<head><base href='https://other.example.com/jobs/'></head><a href='1'>External</a><a href='https://careers.example.com/jobs/2'>Local</a>").urls,
    ["https://careers.example.com/jobs/2"]);
  assert.deepEqual(html("<template><base href='https://other.example.com/'></template><a href='/jobs/1'>One</a>").urls,
    ["https://careers.example.com/jobs/1"]);
  assert.deepEqual(html("<base href='http://['><a href='/jobs/1'>Unresolved</a>").urls, []);
});

test("a real base remains effective under hidden or inert attributes while fallback bases stay ignored", () => {
  for (const attributes of ["hidden", "inert", "style='display:none'"]) {
    assert.deepEqual(html(`<section ${attributes}><base href='https://other.example.com/'></section><a href='/jobs/relative'>Relative</a><a href='https://careers.example.com/jobs/absolute'>Absolute</a>`).urls,
      ["https://careers.example.com/jobs/absolute"], attributes);
  }
  assert.deepEqual(html("<head hidden inert><base href='https://other.example.com/'></head><a href='/jobs/relative'>Relative</a><a href='https://careers.example.com/jobs/absolute'>Absolute</a>").urls,
    ["https://careers.example.com/jobs/absolute"]);
});

test("HTML scan truncation does not assume the base for relative links from an incomplete document", () => {
  const result = html("<a href='/jobs/relative'>Relative</a><a href='https://careers.example.com/jobs/absolute'>Absolute</a>" + "<div>".repeat(129));
  assert.deepEqual(result.urls, ["https://careers.example.com/jobs/absolute"]);
  assert.equal(result.truncated, true);
});

test("priority URLs do not create postings or reorder one document before the adapter verifies the manifest", () => {
  const prioritized = { ...options, priorityPostingUrls: ["https://careers.example.com/jobs/2", "https://careers.example.com/jobs/absent"] };
  assert.deepEqual(enumerateJobPostingUrls(xml(`${loc("https://careers.example.com/jobs/1")}${loc("https://careers.example.com/jobs/2")}`), entry, prioritized).urls,
    ["https://careers.example.com/jobs/1", "https://careers.example.com/jobs/2"]);
});

test("an empty valid URL-set or static HTML does not establish no vacancies", () => {
  for (const result of [enumerate(xml("")), html("<html><body><h1>Loading</h1></body></html>")]) {
    assert.deepEqual(result.urls, []);
    assert.equal(result.truncated, false);
    assert.match(result.warnings.join(" "), /does not establish/);
  }
});

test("URL enumeration bounds apply before deduplication and return truthful partial links", () => {
  const result = enumerate(xml(loc("https://careers.example.com/jobs/1").repeat(10_001)));
  assert.deepEqual(result.urls, ["https://careers.example.com/jobs/1"]);
  assert.equal(result.truncated, true);
  assert.match(result.warnings.join(" "), /limit/);
  const htmlResult = html("<a href='/jobs/1'>1</a>".repeat(10_001));
  assert.deepEqual(htmlResult.urls, ["https://careers.example.com/jobs/1"]);
  assert.equal(htmlResult.truncated, true);
});

test("HTML nesting/node traversal bounds do not surface later hidden or unread links", () => {
  const result = html("<div>".repeat(129) + "<a href='/jobs/late'>Late</a>" + "</div>".repeat(129));
  assert.deepEqual(result.urls, []);
  assert.equal(result.truncated, true);
  const tokenResult = html("<br>".repeat(100_001) + "<a href='/jobs/late'>Late</a>");
  assert.deepEqual(tokenResult.urls, []);
  assert.equal(tokenResult.truncated, true);
});

test("2 MiB is a UTF-8 byte limit, enforced before parsing rather than a UTF-16 character count", () => {
  assert.throws(() => enumerate("x".repeat(2 * 1024 * 1024 + 1)), code("budget-exceeded"));
  assert.throws(() => html("汉".repeat(800_000)), code("budget-exceeded"));
  const body = "<!--" + "x".repeat(2 * 1024 * 1024 - 7) + "-->";
  assert.equal(html(body).truncated, false);
});

test("enumeration requires an explicitly reviewed document URL and never follows a new response location", () => {
  assert.throws(() => enumerateJobPostingUrls(xml(""), "https://other.example.com/list.xml", options), code("invalid-input"));
  assert.throws(() => enumerateJobPostingUrls(xml(""), "https://careers.example.com/unreviewed.xml", options), code("invalid-input"));
  assert.throws(() => enumerateJobPostingUrls(xml(""), entry, { ...options, pageSize: 21 }), code("invalid-input"));
});
