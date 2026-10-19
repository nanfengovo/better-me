import assert from "node:assert/strict";
import test from "node:test";
import { ToolError } from "@better-me/opportunities";
import { SourceJobRecordSchema } from "../src/contracts.js";
import { readJobPostingJsonLd } from "../src/jobposting-jsonld-reader.js";

const url = "https://careers.example.test/jobs/software-123?language=en";
const job = (changes: Record<string, unknown> = {}) => ({ "@context": "https://schema.org", "@type": "JobPosting", "@id": `${url}#jobposting`, url,
  title: "Senior C# &amp; .NET engineer", identifier: { "@type": "PropertyValue", name: "Original employer", value: "source-123" },
  hiringOrganization: { "@type": "Organization", name: "Original Employer" }, description: "<p>Build C# software.</p><p>Own reviews &amp; tests.</p>",
  datePosted: "2026-10-17", employmentType: "FULL_TIME", jobLocation: { "@type": "Place", name: "Shanghai office", address: { "@type": "PostalAddress", streetAddress: "Original street 10", addressLocality: "上海市", addressRegion: "上海", addressCountry: "中国", postalCode: "200000" }, geo: { latitude: 31, longitude: 121 } }, ...changes });
const script = (value: unknown, attributes = 'type="application/ld+json"') => `<script ${attributes}>${JSON.stringify(value).replace(/</g, "\\u003c")}</script>`;
function error(code: string) { return (value: unknown) => value instanceof ToolError && value.code === code; }

test("one literal JobPosting produces evidenced source fields, date-only raw time and no inferred office, ownership or social recruitment", () => {
  const result = readJobPostingJsonLd(`<html><head>${script(job())}</head></html>`, url), record = result.record!;
  assert.deepEqual(SourceJobRecordSchema.parse(record), record); assert.equal(record.title, "Senior C# & .NET engineer");
  assert.equal(record.url, url); assert.equal(record.sourceRecordId, "source-123"); assert.equal(record.companyName, "Original Employer");
  assert.equal(record.description, "Build C# software.\nOwn reviews & tests."); assert.equal(record.completeness, "detail");
  assert.equal(record.sourcePublishedRaw, "2026-10-17"); assert.equal(record.sourcePublishedAt, undefined);
  assert.equal(record.employmentType, "unknown"); assert.equal(record.workMode, "unknown"); assert.equal(record.availability, "unknown");
  assert.equal(record.applicationUrl, undefined); assert.deepEqual(record.compensations, []);
  assert.deepEqual(record.locations, [{ raw: "Shanghai office · Original street 10, 上海市, 上海, 200000, 中国", countryCode: "CN", city: "上海市", region: "上海" }]);
  assert.ok(record.evidence.every(e => e.sourceUrl === url && e.selector?.startsWith("jsonld-script[0]$") && !!e.quote));
  for (const field of ["title", "sourceRecordId", "companyName", "description", "locations", "sourcePublishedRaw", "source.employmentType"]) assert.ok(record.evidence.some(e => e.field === field));
  assert.match(result.warnings.join(" "), /not verified availability.*contexts and references were not fetched/);
});

test("root arrays and @graph find one explicit JobPosting and identical blocks can repeat without conflicting identity", () => {
  for (const value of [[{ "@type": "Organization", name: "Other node" }, job()], { "@context": "https://schema.org", "@graph": [{ "@type": "WebPage", "@id": url }, job()] }, { "@graph": [job({ "@type": ["Thing", "https://schema.org/JobPosting"] })] }]) {
    const result = readJobPostingJsonLd(script(value), url); assert.equal(result.record!.sourceRecordId, "source-123");
  }
  assert.equal(readJobPostingJsonLd(script(job()) + script(job()), url).record!.sourceRecordId, "source-123");
  for (const value of [[job(), job({ title: "Different position" })], { "@graph": [job(), job({ identifier: "other-123" })] }]) assert.throws(() => readJobPostingJsonLd(script(value), url), error("source-changed"));
});

test("comments, attributes, escaped markup, inert containers, non-JSONLD and external scripts cannot supply a fake job", () => {
  const real = script(job());
  for (const html of [ `<!-- ${real} -->`, `<div data-value='${real}'></div>`, `<textarea>${real}</textarea>`, `<style>${real}</style>`, `<title>${real}</title>`, `<template>${real}</template>`, `<noscript>${real}</noscript>`, `<iframe>${real}</iframe>`,
    `<svg>${real}</svg>`, `<math>${real}</math>`, `&lt;script type="application/ld+json"&gt;${JSON.stringify(job())}&lt;/script&gt;`, script(job(), 'type="text/javascript"'), script(job(), 'type="application/ld+json" src="https://other.example.test/data.js"'), script(job(), 'type="application/ld+json" src=""'),
    script({ "@context": { fake: job() } }), script({ unrelated: job() }), `<script>const example = ${JSON.stringify(real)};</script>` ]) {
    const result = readJobPostingJsonLd(html, url); assert.equal(result.record, undefined, html.slice(0, 80)); assert.match(result.warnings.join(" "), /No inline Schema.org JobPosting/);
  }
  assert.ok(readJobPostingJsonLd(script(job(), 'TYPE="Application/LD+JSON; charset=utf-8"'), url).record);
});

test("malformed and absent JSONLD remain explicit warnings, recognized invalid primary jobs fail with fixed errors", () => {
  const absent = readJobPostingJsonLd('<script type="application/ld+json">{ broken }</script>', url);
  assert.equal(absent.record, undefined); assert.match(absent.warnings.join(" "), /not valid JSON/);
  for (const changes of [{ title: "" }, { title: {} }, { description: {} }, { title: "x".repeat(1001) }, { identifier: ["source-123", "other-123"] }, { identifier: {} }, { identifier: "PRIVATE\u0000ID" }]) {
    assert.throws(() => readJobPostingJsonLd(script(job(changes)), url), error("source-changed"));
  }
  assert.throws(() => readJobPostingJsonLd(script(job({ url: "https://foreign.example.test/PRIVATE" })), url), value => error("source-changed")(value) && !String(value).includes("PRIVATE"));
});

test("plaintext cannot resume JSONLD markup at a fake closing tag or inject a second conflicting posting", () => {
  for (const prefix of ["<plaintext>Example </plaintext>", "<plaintext>Example </plaintext></body></html>"]) {
    const hidden = readJobPostingJsonLd(prefix + script(job()), url);
    assert.equal(hidden.record, undefined);
    assert.match(hidden.warnings.join(" "), /No inline Schema.org JobPosting/);
    const original = readJobPostingJsonLd(script(job()) + prefix + script(job({ title: "Conflicting text example", identifier: "other" })), url);
    assert.equal(original.record!.sourceRecordId, "source-123");
    assert.equal(original.record!.title, "Senior C# & .NET engineer");
  }
});

test("object fallback cannot supply a primary posting, conflict with the real page job or create JSON warnings", () => {
  for (const attributes of ['data="source.pdf"', 'type="application/pdf"', ""]) {
    assert.equal(readJobPostingJsonLd(`<object ${attributes}>${script(job())}</object>`, url).record, undefined);
    const result = readJobPostingJsonLd(`<object ${attributes}>${script(job({ identifier: "fallback-other", title: "Fallback example" }))}<script type="application/ld+json">not JSON</script></object>${script(job())}`, url);
    assert.equal(result.record!.sourceRecordId, "source-123");
    assert.equal(result.warnings.some(warning => warning.includes("not valid JSON")), false);
  }
});

test("HTML raw-text, RCDATA, inert, fallback and foreign containers never promote examples into primary job data", () => {
  const containers = ["style", "xmp", "iframe", "noembed", "noframes", "noscript", "title", "textarea", "template", "object", "canvas", "svg", "math"];
  const embedded = script(job({ identifier: "embedded-example", title: "Embedded example position" }));
  for (const tag of containers) {
    // Case folding and the real closing container both matter to source HTML semantics.
    const markup = `<${tag.toUpperCase()}>${embedded}</${tag}>`;
    assert.equal(readJobPostingJsonLd(markup, url).record, undefined, tag);
    const actual = readJobPostingJsonLd(script(job()) + markup + script(job()), url);
    assert.equal(actual.record!.sourceRecordId, "source-123", tag);
    assert.equal(actual.record!.title, "Senior C# & .NET engineer", tag);
  }
  // A normal executable-script element is raw text, even when it contains script-looking markup.
  const example = `<script>const snippet = ${JSON.stringify(embedded)};</script>`;
  assert.equal(readJobPostingJsonLd(example, url).record, undefined);
  assert.equal(readJobPostingJsonLd(example + script(job()), url).record!.sourceRecordId, "source-123");
});

test("raw-text ancestors cannot be closed by payload examples to release a fake JobPosting", () => {
  const embedded = script(job({ title: "Text-only example", identifier: "embedded-example" }));
  for (const tag of ["script", "style", "xmp", "iframe", "noembed", "noframes", "noscript", "title", "textarea"]) {
    const html = `<div><${tag}>Example </div>${embedded}</${tag}></div>`;
    assert.equal(readJobPostingJsonLd(html, url).record, undefined, tag);
    const result = readJobPostingJsonLd(script(job()) + html + script(job()), url);
    assert.equal(result.record!.sourceRecordId, "source-123", tag);
    assert.equal(result.record!.title, "Senior C# & .NET engineer", tag);
    assert.equal(result.warnings.some(warning => warning.includes("not valid JSON")), false, tag);
  }
});

test("HTML non-void raw-text openings ignore self-closing slashes while foreign self-closing elements do close", () => {
  const embedded = script(job({ title: "Self-closing text example", identifier: "embedded-example" }));
  for (const tag of ["script", "style", "xmp", "iframe", "noembed", "noframes", "noscript", "title", "textarea"]) {
    const html = `<section><${tag}/>Example </section>${embedded}</${tag}></section>`;
    assert.equal(readJobPostingJsonLd(html, url).record, undefined, tag);
    assert.equal(readJobPostingJsonLd(html + script(job()), url).record!.sourceRecordId, "source-123", tag);
  }
  assert.equal(readJobPostingJsonLd(`<script type="application/ld+json"/>${JSON.stringify(job())}</script>`, url).record!.sourceRecordId, "source-123");
  for (const tag of ["iframe", "script", "style", "title"]) {
    assert.equal(readJobPostingJsonLd(`<svg><${tag}/></svg>${script(job())}`, url).record!.sourceRecordId, "source-123", tag);
  }
});

test("raw-text closing requires the matching name and complete delimiter before primary scripts resume", () => {
  const embedded = script(job({ title: "Unclosed raw-text example", identifier: "embedded-example" }));
  for (const tag of ["iframe", "noembed", "noframes", "noscript", "style", "xmp", "title", "textarea"]) {
    for (const ending of [`</${tag}-example>`, `</${tag}`, `</${tag} title='unterminated>`]) {
      assert.equal(readJobPostingJsonLd(`<${tag}>${ending}${embedded}`, url).record, undefined, `${tag}: ${ending}`);
    }
    for (const ending of [`</${tag.toUpperCase()}>`, `</${tag}/>`, `</${tag} title='>'>`]) {
      const html = `<div><${tag}>Example </div>${embedded}${ending}</div>${script(job())}`;
      assert.equal(readJobPostingJsonLd(html, url).record!.sourceRecordId, "source-123", `${tag}: ${ending}`);
    }
  }
});

test("WHATWG double-escaped script text cannot expose example JSONLD before the actual closing script", () => {
  const embedded = script(job({ title: "Double-escaped example", identifier: "embedded-example" }));
  for (const opening of ["<script>", "<script/>", "<SCRIPT data-example='>'>"]) {
    const html = `${opening}<!--<script></script>${embedded}</script>`;
    assert.equal(readJobPostingJsonLd(html, url).record, undefined, opening);
    assert.equal(readJobPostingJsonLd(html + script(job()), url).record!.sourceRecordId, "source-123", opening);
  }
  // The double-escaped end tag returns to escaped script data; an unterminated outer script runs to EOF.
  assert.equal(readJobPostingJsonLd(`<script><!--<script></script>${embedded}`, url).record, undefined);
});

test("JSONLD MIME essence trims whitespace around parameters while still rejecting lookalikes and external scripts", () => {
  for (const type of ["application/ld+json ; charset=utf-8", " Application/LD+JSON  ; charset=UTF-8 ", "application/ld+json\t; charset=utf-8"]) {
    assert.equal(readJobPostingJsonLd(script(job(), `type="${type}"`), url).record!.sourceRecordId, "source-123");
    assert.equal(readJobPostingJsonLd(script(job(), `type="${type}" src="https://other.example.test/data.js"`), url).record, undefined);
  }
  for (const type of ["application/ld+jsonx ; charset=utf-8", "text/application/ld+json", "application/ld+json extra ; charset=utf-8"]) {
    assert.equal(readJobPostingJsonLd(script(job(), `type="${type}"`), url).record, undefined);
  }
});

test("main posting identity cannot point to another host, page, query, fragment route, private URL or conflicting main entity", () => {
  for (const changes of [{ url: "https://foreign.example.test/jobs/123" }, { url: "/jobs/other?language=en" }, { url: "/jobs/software-123?language=zh" }, { url: `${url}#other-job` },
    { url: "https://127.0.0.1/jobs/123" }, { url: "javascript:alert(1)" }, { url: "https://user:password@careers.example.test/jobs/software-123?language=en" },
    { "@id": "https://foreign.example.test/job#posting" }, { "@id": "/jobs/other#posting" }, { "@id": "urn:job:123" },
    { mainEntityOfPage: { "@id": `${url}#page`, url: "https://foreign.example.test/other" } }, { mainEntityOfPage: {} }, { mainEntityOfPage: "https://foreign.example.test/other" }]) {
    assert.throws(() => readJobPostingJsonLd(script(job(changes)), url), error("source-changed"));
  }
  for (const changes of [{ "@id": "#jobposting" }, { url: "/jobs/software-123?language=en", mainEntityOfPage: { "@id": `${url}#page` } }, { url: `${url}&utm_source=source` }]) {
    assert.equal(readJobPostingJsonLd(script(job(changes)), url).record!.url, url);
  }
});

test("a missing actual identifier falls back to the original URL, and graph node @id is never an invented employer record ID", () => {
  for (const changes of [{ identifier: undefined }, { identifier: undefined, "@id": undefined, url: undefined }, { identifier: 0 }]) {
    const result = readJobPostingJsonLd(script(job(changes)), url).record!;
    assert.equal(result.url, url); assert.equal(result.sourceRecordId, changes.identifier === 0 ? "0" : undefined);
  }
});

test("company and description stay absent when undisclosed; country fields use only explicit finite aliases", () => {
  const result = readJobPostingJsonLd(script(job({ hiringOrganization: undefined, description: undefined, jobLocation: [
    { address: { addressLocality: "Paris", addressCountry: { "@type": "Country", name: "France" } } }, { address: { addressLocality: "Unknown City", addressCountry: "Europe" } },
    { address: { addressLocality: "London", addressCountry: "UK" } }, "Source original location only", { geo: { latitude: 20, longitude: 30 } },
  ] })), url).record!;
  assert.equal(result.companyName, undefined); assert.equal(result.description, undefined); assert.equal(result.completeness, "excerpt");
  assert.equal(result.locations[0]!.countryCode, "FR"); assert.equal(result.locations[1]!.countryCode, undefined); assert.equal(result.locations[2]!.countryCode, "GB");
  assert.deepEqual(result.locations[3], { raw: "Source original location only" }); assert.equal(result.locations.length, 4);
  assert.equal(JSON.stringify(result.locations).includes("latitude"), false);
});

test("explicit remote eligibility remains separate from location text, and base salary stays raw with unknown tax and period", () => {
  const result = readJobPostingJsonLd(script(job({ jobLocationType: "TELECOMMUTE", applicantLocationRequirements: [{ "@type": "Country", name: "United States" }, { "@type": "Country", name: "United States" }, "Europe"],
    baseSalary: { "@type": "MonetaryAmount", currency: "USD", value: { minValue: 100000, maxValue: 150000, unitText: "YEAR" } }, datePosted: "2026-10-17T10:30:00+08:00", validThrough: "2026-10-18" })), url).record!;
  assert.equal(result.workMode, "remote"); assert.deepEqual(result.remoteEligibleRegions, ["United States", "Europe"]);
  assert.equal(result.sourcePublishedAt, "2026-10-17T02:30:00.000Z"); assert.equal(result.availability, "unknown");
  assert.equal(result.compensations.length, 1); assert.equal(result.compensations[0]!.tax, "unknown"); assert.equal(result.compensations[0]!.period, "unknown");
  assert.equal(result.compensations[0]!.min, undefined); assert.equal(result.compensations[0]!.currency, undefined);
});

test("explicit country names use the shared ISO catalog and unknown two-letter labels never become countries", () => {
  const result = readJobPostingJsonLd(script(job({ jobLocation: [
    { address: { addressLocality: "Ostrava", addressCountry: "Czechia" } },
    { address: { addressLocality: "Source City", addressCountry: "XX" } },
    { address: { addressLocality: "Source City", addressCountry: "EU" } },
  ] })), url).record!;
  assert.equal(result.locations[0]!.countryCode, "CZ");
  assert.equal(result.locations[0]!.city, "Ostrava");
  assert.equal(result.locations[1]!.countryCode, undefined);
  assert.match(result.locations[1]!.raw, /XX/);
  assert.equal(result.locations[2]!.countryCode, undefined);
  assert.match(result.locations[2]!.raw, /EU/);
});

test("HTML/script bytes, total JSONLD payload, script count, node count and depth have independent hard limits", () => {
  assert.throws(() => readJobPostingJsonLd("汉".repeat(700_000), url), error("budget-exceeded"));
  assert.throws(() => readJobPostingJsonLd(script({ padding: "x".repeat(1024 * 1024) }), url), error("budget-exceeded"));
  assert.throws(() => readJobPostingJsonLd(script({ padding: "x".repeat(550_000) }) + script({ padding: "x".repeat(550_000) }), url), error("budget-exceeded"));
  assert.throws(() => readJobPostingJsonLd(Array.from({ length: 33 }, () => script({ "@type": "Thing" })).join(""), url), error("budget-exceeded"));
  assert.throws(() => readJobPostingJsonLd(script({ values: Array.from({ length: 10_001 }, () => 0) }), url), error("budget-exceeded"));
  let deep: unknown = "leaf"; for (let i = 0; i < 34; i++) deep = { nested: deep };
  assert.throws(() => readJobPostingJsonLd(script(deep), url), error("budget-exceeded"));
  assert.throws(() => readJobPostingJsonLd("<div>".repeat(260), url), error("budget-exceeded"));
});

test("contexts, references and script-like descriptions are data only and never resolve additional jobs or execute code", () => {
  const result = readJobPostingJsonLd(script(job({ "@context": "https://foreign.example.test/context", description: '<p>Safe requirement</p><script>globalThis.__jobpostingExecuted = true</script>', hiringOrganization: { "@id": "https://foreign.example.test/organization" } })), url).record!;
  assert.equal(result.description, "Safe requirement"); assert.equal(result.companyName, undefined);
  assert.equal((globalThis as Record<string, unknown>).__jobpostingExecuted, undefined);
  assert.match(result.warnings.join(" "), /not fetched or expanded/);
});
