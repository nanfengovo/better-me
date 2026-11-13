import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { chromium } from "playwright-core";
import type { BrowserContext } from "playwright-core";
import { SaxesParser } from "saxes";
import { fromBufferPromise } from "yauzl";
import { createSandboxPlan } from "../runs/sandbox.js";

export type TrustedExportExecutable = { executablePath: string; sha256?: string; version?: string; runtimeReadPaths?: string[] };
export type FinalExportRenderInput = { format: "pdf" | "docx"; input: Buffer; inputContentHash: string; signal: AbortSignal; isCurrent(): Promise<boolean> };
export type FinalExportRenderResult = { format: "pdf" | "docx"; inputContentHash: string; sourceSha256: string; renderedSha256: string; pdfBytes: Buffer; sourceBytes: Buffer; renderer: { name: string; version: string }; at: string };
export class FinalExportRenderError extends Error { constructor(readonly code: string) { super(code); this.name = "FinalExportRenderError"; } }
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const hashPattern = /^[a-f0-9]{64}$/;
let processRendering = false;
function fail(code: string): never { throw new FinalExportRenderError(code); }
const hasControl = (value: string, space = false) => [...value].some(character => character.charCodeAt(0) < (space ? 33 : 32) || character.charCodeAt(0) === 127);

function safeAnnotation(value: string): boolean {
  if (hasControl(value, true)) return false;
  if (value.startsWith("#")) return true;
  try { const url = new URL(value); return ["https:", "http:", "mailto:", "tel:"].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}
function parseSvg(text: string) {
  const parser = new SaxesParser({ xmlns: true }); let count = 0;
  parser.on("doctype", () => fail("final_export_svg_active_content"));
  parser.on("processinginstruction", () => fail("final_export_svg_active_content"));
  parser.on("error", () => fail("final_export_svg_invalid"));
  parser.on("opentag", tag => {
    if (++count > 20_000 || !["svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "defs", "linearGradient", "radialGradient", "stop", "clipPath", "title", "desc"].includes(tag.local)) fail("final_export_svg_active_content");
    for (const attribute of Object.values(tag.attributes)) if (/^on/i.test(attribute.local) || ["href", "src"].includes(attribute.local) || (/(?:url\s*\(|@import)/i.test(attribute.value) && !/^url\(#[A-Za-z0-9_-]+\)$/.test(attribute.value))) fail("final_export_svg_active_content");
  });
  parser.write(text).close();
}
function safeEmbeddedUrl(value: string) {
  if (value.startsWith("#")) return;
  const match = /^data:([^;,]+)(;base64)?,([\s\S]*)$/i.exec(value);
  if (!match || value.length > 6_000_000) fail("final_export_external_resource_blocked");
  const mime = match[1]!.toLowerCase();
  if (!/^(?:image\/(?:png|jpeg|gif|webp|avif|svg\+xml)|font\/(?:woff2?|ttf|otf)|application\/(?:font-woff|vnd\.ms-fontobject|octet-stream))$/.test(mime)) fail("final_export_data_type_blocked");
  if (mime === "image/svg+xml") {
    let text: string; try { text = match[2] ? new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(match[3]!, "base64")) : decodeURIComponent(match[3]!); } catch { return fail("final_export_svg_invalid"); }
    parseSvg(text);
  }
}

/** Central-directory based, sequential bounded decompression; no extraction to
 * the filesystem and no filename repair. All bytes (including non-XML media)
 * are actually inflated and CRC-checked before LibreOffice can see the ZIP.
 * External hyperlinks are retained only as safe PDF annotations, never fetched.
 * Every external resource/template, macro, embedded object and active field is
 * rejected; the process sandbox is an independent mandatory second boundary. */
export async function inspectFinalDocx(input: Buffer, signal: AbortSignal): Promise<void> {
  if (signal.aborted) fail("final_export_cancelled");
  let zip: Awaited<ReturnType<typeof fromBufferPromise>>;
  try { zip = await fromBufferPromise(input, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }); } catch { return fail("final_export_docx_invalid_zip"); }
  const names = new Set<string>(), folded = new Set<string>(), internalTargets: string[] = []; let total = 0, entries = 0, mainContentType = false, documentRoot = false;
  try {
    if (zip.entryCount > 1500 || zip.entryCount < 3) fail("final_export_docx_zip_budget");
    for await (const entry of zip.eachEntry()) {
      if (signal.aborted) fail("final_export_cancelled");
      const name = entry.fileName, lower = name.normalize("NFC").toLowerCase();
      if (++entries > 1500 || folded.has(lower) || name.length > 500 || /[\\:]/.test(name) || hasControl(name) || name.split("/").some(part => part === ".." || part === ".") || name.startsWith("/") || ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000) fail("final_export_docx_entry_invalid");
      folded.add(lower); names.add(name);
      if (entry.isEncrypted() || ![0, 8].includes(entry.compressionMethod) || !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize > 12_000_000 || entry.compressedSize > input.length || entry.uncompressedSize / Math.max(1, entry.compressedSize) > 250 || (total += entry.uncompressedSize) > 64_000_000) fail("final_export_docx_zip_budget");
      if (name.endsWith("/")) { if (entry.uncompressedSize !== 0) fail("final_export_docx_entry_invalid"); continue; }
      if (/vba|macro|(?:^|\/)(?:embeddings|activex|customui)(?:\/|$)/i.test(name) || !/\.(?:xml|rels|png|jpe?g|gif|webp|svg)$/i.test(name)) fail("final_export_docx_active_content");
      const stream = await zip.openReadStreamPromise(entry), parts: Buffer[] = []; let bytes = 0, checksum = 0;
      const abort = () => stream.destroy(new FinalExportRenderError("final_export_cancelled")); signal.addEventListener("abort", abort, { once: true });
      try {
        for await (const chunk of stream) {
          const part = Buffer.from(chunk); bytes += part.length;
          if (bytes > entry.uncompressedSize || bytes > 12_000_000 || signal.aborted) { stream.destroy(); fail(signal.aborted ? "final_export_cancelled" : "final_export_docx_zip_budget"); }
          checksum = crc32(part, checksum); if (/\.(?:xml|rels|svg)$/i.test(name)) parts.push(part);
        }
      } finally { signal.removeEventListener("abort", abort); stream.destroy(); }
      if (bytes !== entry.uncompressedSize || checksum !== (entry.crc32 >>> 0)) fail("final_export_docx_crc_or_size_mismatch");
      if (!parts.length) continue;
      const data = Buffer.concat(parts);
      if (data.length > 4_000_000) fail("final_export_docx_xml_budget");
      let text: string; try { text = new TextDecoder("utf-8", { fatal: true }).decode(data); } catch { return fail("final_export_docx_xml_invalid"); }
      if (/\.svg$/i.test(name)) { parseSvg(text); continue; }
      const parser = new SaxesParser({ xmlns: true }), relationIds = new Set<string>(); let depth = 0, fieldDepth = 0, field = "";
      const validField = (value: string) => { if (!/^\s*(?:PAGE|NUMPAGES|SECTIONPAGES)(?:\s+\\\*\s+(?:MERGEFORMAT|ARABIC))?\s*$/i.test(value)) fail("final_export_docx_active_field"); };
      parser.on("doctype", () => fail("final_export_docx_dtd_blocked"));
      parser.on("processinginstruction", () => fail("final_export_docx_active_content"));
      parser.on("error", () => fail("final_export_docx_xml_invalid"));
      parser.on("opentag", tag => {
        if (++depth > 100) fail("final_export_docx_xml_budget");
        const attrs = Object.fromEntries(Object.values(tag.attributes).map(attribute => [attribute.local, attribute.value]));
        if (name === "word/document.xml" && depth === 1) documentRoot = tag.local === "document" && tag.uri === "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
        if (["object", "OLEObject", "altChunk", "control", "subDoc", "script", "applet"].includes(tag.local)) fail("final_export_docx_active_content");
        if (Object.values(attrs).some(value => /(?:macroEnabled|vbaProject|oleObject|attachedTemplate|aFChunk|activeX|externalLink)/i.test(value))) fail("final_export_docx_active_content");
        if (name === "[Content_Types].xml" && tag.local === "Override" && attrs.PartName === "/word/document.xml" && attrs.ContentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml") mainContentType = true;
        if (tag.local === "instrText") { fieldDepth = depth; field = ""; }
        if (tag.local === "fldSimple") validField(attrs.instr ?? "");
        if (name.endsWith(".rels") && tag.local === "Relationship") {
          if (!attrs.Id || relationIds.has(attrs.Id) || !attrs.Target || !attrs.Type) fail("final_export_docx_relationship_invalid"); relationIds.add(attrs.Id);
          if (attrs.TargetMode?.toLowerCase() === "external") {
            if (!attrs.Type.endsWith("/hyperlink") || !safeAnnotation(attrs.Target)) fail("final_export_docx_external_resource_blocked");
          } else {
            let target: string; try { target = decodeURIComponent(attrs.Target); } catch { return fail("final_export_docx_relationship_invalid"); }
            if (/[\\:]/.test(target) || hasControl(target, true) || target.startsWith("/")) fail("final_export_docx_external_resource_blocked");
            if (!target.startsWith("#")) {
              const ownerPart = name === "_rels/.rels" ? "" : name.replace(/\/_rels\//, "/").replace(/\.rels$/, ""), resolved = path.posix.normalize(path.posix.join(path.posix.dirname(ownerPart), target.split("#")[0]!));
              if (resolved.startsWith("../") || resolved === ".." || resolved.startsWith("/")) fail("final_export_docx_external_resource_blocked");
              internalTargets.push(resolved);
            }
          }
        }
      });
      parser.on("text", value => { if (fieldDepth) { field += value; if (field.length > 2000) fail("final_export_docx_active_field"); } });
      parser.on("closetag", () => { if (depth === fieldDepth) { validField(field); fieldDepth = 0; field = ""; } depth--; });
      parser.write(text).close();
    }
    if (!["[Content_Types].xml", "_rels/.rels", "word/document.xml"].every(name => names.has(name)) || !mainContentType || !documentRoot || internalTargets.some(target => !names.has(target))) fail("final_export_docx_package_incomplete");
  } catch (error) { if (error instanceof FinalExportRenderError) throw error; fail(signal.aborted ? "final_export_cancelled" : "final_export_docx_invalid_zip"); }
  finally { zip.close(); }
}

const profileString = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
async function isolatedOfficePlan(spec: TrustedExportExecutable, executable: string, args: string[], directory: string, env: NodeJS.ProcessEnv) {
  const reads: string[] = [executable];
  for (const selected of spec.runtimeReadPaths ?? []) {
    if (!path.isAbsolute(selected)) fail("final_export_runtime_scope_invalid");
    const canonical = await fs.realpath(selected);
    if ([path.parse(canonical).root, os.homedir(), "/Users", "/home", "/Library", "/private", "/private/tmp", os.tmpdir()].includes(canonical) || (path.relative(canonical, process.cwd()) !== "" && !path.relative(canonical, process.cwd()).startsWith("..")) || canonical === process.cwd()) fail("final_export_runtime_scope_invalid");
    reads.push(path.resolve(selected), canonical);
  }
  const plan = await createSandboxPlan({ command: executable, args, cwd: directory, runDirectory: directory, allowedReadPaths: reads, mode: "required", env });
  if (plan.isolation !== "os-sandbox") fail("final_export_os_sandbox_unavailable");
  if (plan.provider === "macos-sandbox-exec" && plan.profilePath) {
    const selected = [...new Set([directory, ...reads, "/System/Library", "/System/Cryptexes", "/System/Volumes/Preboot", "/usr/lib", "/usr/share", "/usr/bin", "/usr/libexec", "/bin", "/sbin", "/dev", "/Library/Fonts"])], ancestors = new Set<string>();
    for (const readable of selected) { let parent = path.dirname(readable); for (;;) { ancestors.add(parent); if (parent === path.dirname(parent)) break; parent = path.dirname(parent); } }
    const profile = ["(version 1)", "(deny default)", "(allow process*)", "(allow sysctl-read)", ...[...ancestors].map(value => `(allow file-read* (literal "${profileString(value)}"))`), ...selected.map(value => `(allow file-read* (subpath "${profileString(value)}"))`), `(allow file-write* (subpath "${profileString(directory)}"))`, '(allow file-write* (subpath "/dev"))', "(deny network*)"].join("\n");
    await fs.writeFile(plan.profilePath, profile, { mode: 0o600 });
    return plan;
  }
  if (plan.provider === "linux-bubblewrap") {
    const system: string[] = [];
    for (const selected of ["/usr/bin", "/usr/lib", "/usr/share", "/lib", "/lib64", "/bin", "/sbin", "/etc/fonts", "/etc/ld.so.cache"]) if (await fs.stat(selected).then(() => true, () => false)) system.push(selected);
    return { ...plan, args: ["--die-with-parent", "--new-session", "--unshare-all", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", ...[...new Set([...system, ...reads])].flatMap(selected => ["--ro-bind", selected, selected]), "--bind", directory, directory, "--chdir", directory, "--", executable, ...args] };
  }
  return fail("final_export_os_sandbox_unavailable");
}

async function configureOfficeFonts(directory: string, env: NodeJS.ProcessEnv): Promise<void> {
  if (process.platform !== "darwin") return;
  // Headless macOS builds may otherwise enumerate only bundled Latin fonts:
  // Unicode extraction still succeeds while the page contains blank/tofu CJK.
  // Do not load the machine/user fontconfig, discover home fonts, or widen the
  // OS sandbox. This fixed public directory is already in its read-only scope.
  const fonts = "/System/Library/Fonts";
  if (!(await fs.stat(fonts)).isDirectory()) fail("final_export_public_fonts_unavailable");
  const cache = path.join(directory, "font-cache"), config = path.join(directory, "fonts.conf");
  await fs.mkdir(cache, { mode: 0o700 });
  const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
  await fs.writeFile(config, `<?xml version="1.0" encoding="UTF-8"?><fontconfig><dir>${fonts}</dir><cachedir>${xml(cache)}</cachedir></fontconfig>`, { mode: 0o600 });
  env.FONTCONFIG_FILE = config; env.FONTCONFIG_PATH = directory;
}

/** A renderer, not a template/compiler or a visual-quality certificate. PDF
 * input must be the current existing ResumeTemplate print-HTML capture supplied
 * by Host/UI; source bytes and caller content binding are retained exactly.
 * DOCX pagination is a derived PDF, never a rewrite of the editable source.
 * No selected executable means UNAVAILABLE, not discovery/install/fallback.
 */
export function createFinalExportRenderer(options: { chromium?: TrustedExportExecutable; soffice?: TrustedExportExecutable; maxInputBytes?: number; maxPdfBytes?: number; maxActiveMs?: number; tempRoot?: string }) {
  const maxInputBytes = options.maxInputBytes ?? 16_000_000, maxPdfBytes = options.maxPdfBytes ?? 32_000_000, maxActiveMs = options.maxActiveMs ?? 300_000;
  if (![maxInputBytes, maxPdfBytes, maxActiveMs].every(Number.isSafeInteger) || maxInputBytes < 1 || maxInputBytes > 32_000_000 || maxPdfBytes < 1 || maxPdfBytes > 64_000_000 || maxActiveMs < 1 || maxActiveMs > 300_000 || (options.tempRoot && !path.isAbsolute(options.tempRoot))) fail("final_export_limits_invalid");
  const specifications = structuredClone(options), active = new Set<AbortController>(), pins = new Map<string, { path: string; hash: string; signature: string }>(); let closed = false;
  async function executable(spec: TrustedExportExecutable): Promise<{ path: string; hash: string }> {
    if (!path.isAbsolute(spec.executablePath) || /[\0\r\n]/.test(spec.executablePath) || (spec.sha256 !== undefined && !hashPattern.test(spec.sha256))) fail("final_export_executable_not_trusted");
    try {
      const canonical = await fs.realpath(spec.executablePath), stat = await fs.stat(canonical, { bigint: true });
      if (!stat.isFile() || stat.size > 1_000_000_000n || (process.platform !== "win32" && ((Number(stat.mode) & 0o022) !== 0 || !(Number(stat.mode) & 0o111) || (Number(stat.uid) !== 0 && Number(stat.uid) !== process.getuid?.())))) fail("final_export_executable_not_trusted");
      const signature = [canonical, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":"), pin = pins.get(spec.executablePath);
      if (pin?.signature === signature) return { path: pin.path, hash: pin.hash };
      const actual = hash(await fs.readFile(canonical));
      if ((spec.sha256 && actual !== spec.sha256) || (pin && (pin.hash !== actual || pin.path !== canonical))) fail("final_export_executable_changed");
      pins.set(spec.executablePath, { path: canonical, hash: actual, signature }); return { path: canonical, hash: actual };
    } catch (error) { if (error instanceof FinalExportRenderError) throw error; return fail("final_export_executable_unavailable"); }
  }
  return {
    async render(input: FinalExportRenderInput): Promise<FinalExportRenderResult> {
      if (closed) fail("final_export_renderer_closed");
      if (processRendering) fail("final_export_renderer_busy");
      if (!["pdf", "docx"].includes(input.format) || !Buffer.isBuffer(input.input) || input.input.length < 1 || input.input.length > maxInputBytes || !hashPattern.test(input.inputContentHash)) fail("final_export_input_invalid_or_oversized");
      const spec = input.format === "pdf" ? specifications.chromium : specifications.soffice; if (!spec) fail("final_export_renderer_not_configured");
      const local = new AbortController(), signal = AbortSignal.any([input.signal, local.signal, AbortSignal.timeout(maxActiveMs)]), sourceBytes = Buffer.from(input.input); processRendering = true; active.add(local);
      let directory: string | undefined, context: BrowserContext | undefined, contextClosing: Promise<void> | undefined, child: ChildProcess | undefined;
      const closeContext = () => context ? (contextClosing ??= context.close().catch(() => undefined)) : Promise.resolve();
      const kill = () => { if (child?.pid) { try { if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* Already exited; never log process errors. */ } } } void closeContext(); };
      signal.addEventListener("abort", kill, { once: true });
      const check = async () => { if (signal.aborted || closed) fail("final_export_cancelled"); let current: boolean; const cancelled = () => fail("final_export_cancelled");
        try { current = await new Promise<boolean>((resolve, reject) => { const abort = () => reject(new FinalExportRenderError("final_export_cancelled")); signal.addEventListener("abort", abort, { once: true }); Promise.resolve().then(input.isCurrent).then(resolve, () => reject(new FinalExportRenderError("final_export_stale"))).finally(() => signal.removeEventListener("abort", abort)); if (signal.aborted) abort(); }); } catch (error) { if (signal.aborted) cancelled(); throw error; }
        if (!current) fail("final_export_stale"); if (signal.aborted || closed) fail("final_export_cancelled"); };
      try {
        await check();
        if (input.format === "docx") await inspectFinalDocx(sourceBytes, signal);
        const trusted = await executable(spec); await check();
        directory = await fs.realpath(await fs.mkdtemp(path.join(specifications.tempRoot ?? os.tmpdir(), "betterme-final-export-"))); await fs.chmod(directory, 0o700);
        const env: NodeJS.ProcessEnv = { HOME: directory, USERPROFILE: directory, TMPDIR: directory, TMP: directory, TEMP: directory, PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", XDG_CACHE_HOME: path.join(directory, "cache"), XDG_CONFIG_HOME: path.join(directory, "config"), SAL_USE_VCLPLUGIN: "svp", SAL_DISABLE_OPENCL: "1" };
        let pdfBytes: Buffer, renderer: FinalExportRenderResult["renderer"];
        if (input.format === "pdf") {
          let html: string; try { html = new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes); } catch { return fail("final_export_html_invalid_utf8"); }
          context = await chromium.launchPersistentContext(path.join(directory, "chromium-profile"), { executablePath: trusted.path, headless: true, chromiumSandbox: true, javaScriptEnabled: false, serviceWorkers: "block", acceptDownloads: false, bypassCSP: false, offline: true, viewport: { width: 794, height: 1123 }, deviceScaleFactor: 1, env: env as Record<string, string>, timeout: Math.min(maxActiveMs, 30_000), args: ["--disable-extensions", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-default-apps", "--no-first-run", "--no-default-browser-check"] });
          await check(); let blocked = false;
          await context.route("**/*", route => { if (route.request().url().startsWith("data:")) return route.continue(); blocked = true; return route.abort("blockedbyclient"); });
          const page = context.pages()[0] ?? await context.newPage(); page.setDefaultTimeout(Math.min(maxActiveMs, 30_000));
          const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline' data:; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">`;
          await page.emulateMedia({ media: "print", reducedMotion: "reduce" }); await page.setContent("<!doctype html>" + csp + html, { waitUntil: "load" });
          // A reviewed constant script, not source-provided code. A function
          // serialized from tsx can carry an unbound __name helper into the
          // browser; keeping this browser-only program literal avoids that.
          const observed = await page.evaluate<{ unsafe: boolean; urls: string[]; links: string[]; imagesValid: boolean; fontsReady: boolean }>(String.raw`(async () => {
            await document.fonts.ready;
            const urls = [], links = []; let unsafe = !!document.querySelector("script,iframe,frame,object,embed,applet,base,form,link,foreignObject,animate,animateMotion,animateTransform,set");
            const css = (value) => { if (/@import/i.test(value)) unsafe = true; for (const match of value.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)) urls.push(match[1] ?? ""); };
            for (const element of document.querySelectorAll("*")) for (const attr of element.attributes) {
              if (/^on/i.test(attr.name) || attr.name === "srcset" || (element.tagName === "META" && attr.name === "http-equiv" && attr.value.toLowerCase() === "refresh")) unsafe = true;
              if (attr.name === "style") css(attr.value);
              if (["src", "href", "xlink:href", "poster", "data", "background"].includes(attr.name)) { if (element.tagName === "A" && attr.name === "href") links.push(attr.value); else urls.push(attr.value); }
            }
            for (const sheet of document.styleSheets) { try { const walk = (rules) => { for (const rule of rules) { css(rule.cssText); if ("cssRules" in rule) walk(rule.cssRules); } }; walk(sheet.cssRules); } catch { unsafe = true; } }
            return { unsafe, urls, links, imagesValid: [...document.images].every(image => image.complete && image.naturalWidth > 0), fontsReady: document.fonts.status === "loaded" };
          })()`);
          if (observed.unsafe || blocked || observed.links.some(value => !safeAnnotation(value))) fail("final_export_html_active_or_external_content");
          observed.urls.forEach(safeEmbeddedUrl);
          if (!observed.imagesValid || !observed.fontsReady) fail("final_export_html_resource_unavailable");
          await check(); pdfBytes = await page.pdf({ printBackground: true, preferCSSPageSize: true, format: "A4", displayHeaderFooter: false, tagged: true });
          renderer = { name: "chromium-existing-resume-print-html", version: `${context.browser()!.version()} / sha256:${trusted.hash}` };
        } else {
          await configureOfficeFonts(directory, env);
          const profile = path.join(directory, "lo-profile"), output = path.join(directory, "output"), filename = path.join(directory, "source.docx");
          await fs.mkdir(path.join(profile, "user"), { recursive: true, mode: 0o700 }); await fs.mkdir(output, { mode: 0o700 }); await fs.mkdir(path.join(directory, "input"), { mode: 0o700 });
          await fs.writeFile(path.join(profile, "user", "registrymodifications.xcu"), `<?xml version="1.0" encoding="UTF-8"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop><prop oor:name="DisableActiveContent" oor:op="fuse"><value>true</value></prop></item></oor:items>`, { mode: 0o600 });
          await fs.writeFile(filename, sourceBytes, { mode: 0o600 });
          const args = [`-env:UserInstallation=${pathToFileURL(profile).href}`, "--headless", "--invisible", "--nodefault", "--nologo", "--norestore", "--nolockcheck", "--convert-to", "pdf:writer_pdf_Export", "--outdir", output, filename];
          let plan: Awaited<ReturnType<typeof isolatedOfficePlan>>; try { plan = await isolatedOfficePlan(spec, trusted.path, args, directory, env); } catch (error) { if (error instanceof FinalExportRenderError) throw error; return fail("final_export_os_sandbox_unavailable"); }
          await check();
          // shell:false is the same fixed-argv boundary as execFile. spawn is
          // required here because execFile cannot create a process group; a
          // cancelled conversion must terminate its LibreOffice children too.
          await new Promise<void>((resolve, reject) => { child = spawn(plan.command, plan.args, { cwd: directory, env, shell: false, stdio: "ignore", windowsHide: true, detached: process.platform !== "win32" }); child.once("error", () => reject(new FinalExportRenderError(signal.aborted ? "final_export_cancelled" : "final_export_office_failed"))); child.once("exit", code => code === 0 ? resolve() : reject(new FinalExportRenderError(signal.aborted ? "final_export_cancelled" : "final_export_office_failed"))); if (signal.aborted) kill(); });
          await check();
          const rendered = path.join(output, "source.pdf"), stat = await fs.stat(rendered); if (!stat.isFile() || stat.size > maxPdfBytes) fail("final_export_pdf_output_limit"); pdfBytes = await fs.readFile(rendered);
          renderer = { name: "isolated-bundled-libreoffice-docx-pagination", version: spec.version ? `${spec.version} / sha256:${trusted.hash}` : `sha256:${trusted.hash}` };
        }
        await executable(spec); await check();
        if (pdfBytes.length < 100 || pdfBytes.length > maxPdfBytes || pdfBytes.subarray(0, 5).toString("ascii") !== "%PDF-" || !pdfBytes.subarray(-1024).includes(Buffer.from("%%EOF"))) fail("final_export_pdf_invalid_or_oversized");
        return { format: input.format, inputContentHash: input.inputContentHash, sourceSha256: hash(sourceBytes), renderedSha256: hash(pdfBytes), pdfBytes, sourceBytes, renderer, at: new Date().toISOString() };
      } catch (error) { if (error instanceof FinalExportRenderError) throw error; return fail(signal.aborted ? "final_export_cancelled" : "final_export_render_failed"); }
      finally { signal.removeEventListener("abort", kill); kill(); await closeContext(); let cleanupFailed = false; if (directory) try { await fs.rm(directory, { recursive: true, force: true }); } catch { cleanupFailed = true; } active.delete(local); processRendering = false; if (cleanupFailed) fail("final_export_private_cleanup_failed"); }
    },
    close(): void { closed = true; for (const controller of active) controller.abort(); },
  };
}
