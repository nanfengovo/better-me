/** @jsxRuntime automatic */
import { useState, type ReactNode } from "react";
import { Check, Copy, Terminal, Shield, Sparkles } from "lucide-react";

interface AgentMarkdownRendererProps {
  content: string;
  isDark?: boolean;
}

/**
 * High-Tech Markdown renderer designed specifically for Career Copilot responses.
 * Highlights standards, bold technical terms, interview strategies, and code snippets.
 */
export function AgentMarkdownRenderer({ content, isDark = true }: AgentMarkdownRendererProps) {
  if (!content) return null;

  const blocks = parseBlocks(content);

  return (
    <div className="agent-markdown-content space-y-2.5 text-xs leading-relaxed font-sans select-text">
      {blocks.map((block, idx) => (
        <BlockRenderer key={idx} block={block} isDark={isDark} />
      ))}
    </div>
  );
}

// ── Types ────────────────────────────────────────────────────────────
type BlockType =
  | { type: "paragraph"; text: string }
  | { type: "header"; level: number; text: string }
  | { type: "code"; lang: string; code: string }
  | { type: "blockquote"; text: string }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] }
  | { type: "hr" };

// ── Block Parser ─────────────────────────────────────────────────────
function parseBlocks(markdown: string): BlockType[] {
  const blocks: BlockType[] = [];
  const lines = markdown.split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) {
      i++;
      continue;
    }

    // 1. Code Fence
    if (line.trim().startsWith("```")) {
      const lang = line.trim().slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length) {
        const cur = lines[i];
        if (cur === undefined || cur.trim().startsWith("```")) break;
        codeLines.push(cur);
        i++;
      }
      blocks.push({ type: "code", lang, code: codeLines.join("\n") });
      i++;
      continue;
    }

    // 2. Horizontal Rule
    if (/^(---|___|\*\*\*)\s*$/.test(line.trim())) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    // 3. Headers
    const headerMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headerMatch && headerMatch[1] && headerMatch[2]) {
      blocks.push({
        type: "header",
        level: headerMatch[1].length,
        text: headerMatch[2].trim(),
      });
      i++;
      continue;
    }

    // 4. Blockquote
    if (line.trim().startsWith(">")) {
      const quoteLines: string[] = [];
      while (i < lines.length) {
        const cur = lines[i];
        if (cur === undefined || !cur.trim().startsWith(">")) break;
        quoteLines.push(cur.replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ type: "blockquote", text: quoteLines.join("\n") });
      continue;
    }

    // 5. Unordered List
    if (/^\s*[-*•]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const cur = lines[i];
        if (cur === undefined || !/^\s*[-*•]\s+/.test(cur)) break;
        items.push(cur.replace(/^\s*[-*•]\s+/, ""));
        i++;
      }
      blocks.push({ type: "ul", items });
      continue;
    }

    // 6. Ordered List
    if (/^\s*\d+[\.、]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const cur = lines[i];
        if (cur === undefined || !/^\s*\d+[\.、]\s+/.test(cur)) break;
        items.push(cur.replace(/^\s*\d+[\.、]\s+/, ""));
        i++;
      }
      blocks.push({ type: "ol", items });
      continue;
    }

    // 7. Empty line
    if (!line.trim()) {
      i++;
      continue;
    }

    // 8. Paragraph (gather consecutive text lines until blank line or special block)
    const paraLines: string[] = [];
    while (i < lines.length) {
      const cur = lines[i];
      if (cur === undefined || !cur.trim()) break;
      const trimmed = cur.trim();
      if (
        trimmed.startsWith("```") ||
        trimmed.startsWith(">") ||
        /^(#{1,4})\s+/.test(cur) ||
        /^\s*[-*•]\s+/.test(cur) ||
        /^\s*\d+[\.、]\s+/.test(cur) ||
        /^(---|___|\*\*\*)\s*$/.test(trimmed)
      ) {
        break;
      }
      paraLines.push(cur);
      i++;
    }
    if (paraLines.length > 0) {
      blocks.push({ type: "paragraph", text: paraLines.join("\n") });
    }
  }

  return blocks;
}

// ── Block Component Renderer ─────────────────────────────────────────
function BlockRenderer({ block, isDark }: { block: BlockType; isDark: boolean }) {
  switch (block.type) {
    case "header": {
      if (block.level === 1) {
        return (
          <h2 className={`text-sm font-extrabold pb-1.5 border-b mt-3 mb-1.5 flex items-center gap-1.5 ${
            isDark ? "text-emerald-400 border-[var(--ui-border,#484b58)]" : "text-emerald-800 border-slate-200"
          }`}>
            <Sparkles size={14} className="text-emerald-500 shrink-0" />
            <span>{renderInline(block.text, isDark)}</span>
          </h2>
        );
      }
      if (block.level === 2) {
        return (
          <h3 className={`text-xs font-bold pb-1 border-b mt-2.5 mb-1 flex items-center gap-1.5 ${
            isDark ? "text-[var(--ui-text,#edeef4)] border-[var(--ui-border,#484b58)]/60" : "text-slate-900 border-slate-200"
          }`}>
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
            <span>{renderInline(block.text, isDark)}</span>
          </h3>
        );
      }
      return (
        <h4 className={`text-xs font-bold mt-2 mb-1 flex items-center gap-1.5 ${
          isDark ? "text-teal-300" : "text-teal-800"
        }`}>
          <span>{renderInline(block.text, isDark)}</span>
        </h4>
      );
    }

    case "paragraph": {
      return (
        <p className="leading-relaxed whitespace-pre-wrap">
          {renderInline(block.text, isDark)}
        </p>
      );
    }

    case "blockquote": {
      return (
        <blockquote className={`my-2 p-3 rounded-2xl border-l-3 text-xs leading-relaxed space-y-1 ${
          isDark
            ? "border-emerald-500 bg-[var(--ui-surface-soft,#363842)]/70 text-[var(--ui-text-secondary,#c7cad4)]"
            : "border-emerald-600 bg-emerald-50/60 text-slate-700"
        }`}>
          <div className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-emerald-500 mb-0.5">
            <Shield size={12} />
            <span>核心防守准则 / 顾问指导建议</span>
          </div>
          <div>{renderInline(block.text, isDark)}</div>
        </blockquote>
      );
    }

    case "ul": {
      return (
        <ul className="space-y-1.5 my-1.5 pl-0.5">
          {block.items.map((item, idx) => (
            <li key={idx} className="flex items-start gap-2">
              <span className="shrink-0 h-1.5 w-1.5 rounded-full bg-emerald-400 mt-2 shadow-[0_0_6px_rgba(16,185,129,0.8)]" />
              <div className="flex-1 min-w-0 leading-relaxed">{renderInline(item, isDark)}</div>
            </li>
          ))}
        </ul>
      );
    }

    case "ol": {
      return (
        <ol className="space-y-2 my-1.5 pl-0.5">
          {block.items.map((item, idx) => (
            <li key={idx} className="flex items-start gap-2">
              <span
                className={`shrink-0 h-4.5 w-4.5 rounded-lg text-[10px] font-mono font-bold flex items-center justify-center mt-0.5 border shadow-2xs ${
                  isDark
                    ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                    : "bg-emerald-100 text-emerald-800 border-emerald-300"
                }`}
              >
                {idx + 1}
              </span>
              <div className="flex-1 min-w-0 leading-relaxed">{renderInline(item, isDark)}</div>
            </li>
          ))}
        </ol>
      );
    }

    case "code": {
      return <CodeBlock lang={block.lang} code={block.code} isDark={isDark} />;
    }

    case "hr": {
      return (
        <hr className={`my-3 border-t ${
          isDark ? "border-[var(--ui-border,#484b58)]/60" : "border-slate-200"
        }`} />
      );
    }

    default:
      return null;
  }
}

// ── Code Block with Copy Button ──────────────────────────────────────
function CodeBlock({ lang, code, isDark }: { lang: string; code: string; isDark: boolean }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    void navigator.clipboard?.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className={`my-2 rounded-2xl border overflow-hidden text-xs font-mono shadow-xs ${
      isDark ? "bg-[var(--ui-input,#22232a)] border-[var(--ui-border,#484b58)]" : "bg-slate-900 text-slate-100 border-slate-800"
    }`}>
      <div className={`flex items-center justify-between px-3 py-1.5 border-b text-[10px] ${
        isDark ? "bg-[var(--ui-surface-raised,#2e3038)] border-[var(--ui-border,#484b58)] text-[var(--ui-text-muted,#a7adbd)]" : "bg-slate-800 border-slate-700 text-slate-400"
      }`}>
        <div className="flex items-center gap-1.5">
          <Terminal size={12} className="text-emerald-400" />
          <span className="uppercase font-semibold">{lang || "code"}</span>
        </div>
        <button
          type="button"
          onClick={handleCopy}
          className="agent-btn-press inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] hover:text-white transition cursor-pointer"
        >
          {copied ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
          <span>{copied ? "已复制" : "复制"}</span>
        </button>
      </div>
      <pre className="p-3 overflow-x-auto agent-custom-scrollbar leading-relaxed text-[11px]">
        <code>{code}</code>
      </pre>
    </div>
  );
}

// ── Inline Markdown & Standard Highlight Tokenizer ──────────────────
function renderInline(text: string, isDark: boolean): ReactNode[] {
  if (!text) return [];

  // Match bold (**text**), inline code (`code`), markdown links ([label](url)), and special Chinese brackets (【tag】)
  const regex = /(\*\*[^*]+?\*\*|`[^`]+?`|\[[^\]]+?\]\([^)]+?\)|【[^】]+?】)/g;
  const parts = text.split(regex);

  return parts.map((part, index) => {
    if (!part) return null;

    // 1. **Bold text** -> readable inline emphasis, not a pill/tag.
    if (part.startsWith("**") && part.endsWith("**") && part.length >= 4) {
      const inner = part.slice(2, -2);
      return (
        <strong
          key={index}
          className={`font-semibold ${isDark ? "text-emerald-300" : "text-emerald-800"}`}
        >
          {inner}
        </strong>
      );
    }

    // 2. `Inline Code`
    if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) {
      const inner = part.slice(1, -1);
      return (
        <code
          key={index}
          className={`font-mono text-[11px] px-1.5 py-0.5 mx-0.5 rounded border ${
            isDark
              ? "bg-[var(--ui-input,#22232a)] text-teal-300 border-[var(--ui-border,#484b58)]"
              : "bg-slate-100 text-teal-800 border-slate-300"
          }`}
        >
          {inner}
        </code>
      );
    }

    // 3. 【Special Tags】
    if (part.startsWith("【") && part.endsWith("】")) {
      const inner = part.slice(1, -1);
      const isDefense = inner.includes("防守") || inner.includes("话术");
      const isPoint = inner.includes("考点") || inner.includes("技术") || inner.includes("深度");
      const isStar = inner.includes("STAR") || inner.includes("润色") || inner.includes("准则");

      return (
        <span
          key={index}
          className={`inline-flex items-center gap-1 px-2 py-0.5 mx-1 rounded-md text-[10px] font-bold border tracking-wide uppercase align-baseline shadow-2xs ${
            isDefense
              ? isDark
                ? "bg-amber-500/15 text-amber-300 border-amber-500/35"
                : "bg-amber-100 text-amber-900 border-amber-300"
              : isPoint
              ? isDark
                ? "bg-sky-500/15 text-sky-300 border-sky-500/35"
                : "bg-sky-100 text-sky-900 border-sky-300"
              : isStar
              ? isDark
                ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/35"
                : "bg-emerald-100 text-emerald-900 border-emerald-300"
              : isDark
              ? "bg-[var(--ui-surface-soft,#363842)] text-teal-300 border-[var(--ui-border,#484b58)]"
              : "bg-slate-100 text-slate-800 border-slate-300"
          }`}
        >
          {isDefense ? "🛡️ " : isPoint ? "🎯 " : isStar ? "✨ " : "🏷️ "}
          <span>{inner}</span>
        </span>
      );
    }

    // 4. [Link](url)
    const linkMatch = part.match(/^\[([^\]]+?)\]\(([^)]+?)\)$/);
    if (linkMatch) {
      return (
        <a
          key={index}
          href={linkMatch[2]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-emerald-400 hover:text-emerald-300 underline font-medium inline-flex items-center gap-0.5 mx-0.5"
        >
          {linkMatch[1]}
        </a>
      );
    }

    return part;
  });
}
