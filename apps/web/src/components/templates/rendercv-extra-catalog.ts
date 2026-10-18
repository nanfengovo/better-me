/** All remaining RenderCV 2.8 themes at the pinned MIT source revision.
 * Each has a separate CSS treatment in rendercv-themes.css; none aliases
 * another theme or requires the Python/Typst runtime in the browser. */
export const EXTRA_RENDERCV_TEMPLATES = [
  {
    id: "rendercv-engineeringclassic", source: "rendercv", name: "RenderCV · 工程经典", label: "ENGINEERING CLASSIC",
    description: "左对齐姓名、常规字重标题和全宽节线；工作职位优先，保留 Engineering Classic 的轻盈无衬线节奏。", tag: "左对齐工程履历",
    en: { name: "RenderCV · Engineering Classic", description: "Left-aligned identity, regular-weight headings, full-width rules and role-first work entries follow Engineering Classic's light sans-serif rhythm.", tag: "Left-aligned engineering" },
    recommended: { accentColor: "#004f90", fontFamily: "sans" }, upstreamUrl: "https://github.com/rendercv/rendercv", licensePath: "rendercv",
  },
  {
    id: "rendercv-sb2nov", source: "rendercv", name: "RenderCV · Sb2nov", label: "SB2NOV",
    description: "居中姓名、全宽节线、职位与斜体机构上下排列，配合斜体日期、完整链接和空心圆要点。", tag: "双行学术层次",
    en: { name: "RenderCV · Sb2nov", description: "Centered identity and full rules frame stacked role/italic organization headings, italic dates, visible link destinations and hollow bullets.", tag: "Stacked academic hierarchy" },
    recommended: { accentColor: "#111111", fontFamily: "serif" }, upstreamUrl: "https://github.com/rendercv/rendercv", licensePath: "rendercv",
  },
  {
    id: "rendercv-harvard", source: "rendercv", name: "RenderCV · Harvard", label: "HARVARD",
    description: "居中姓名与章节、标题两侧等长细线、机构优先的简练单栏；衬线默认保留正式感。", tag: "居中双侧节线",
    en: { name: "RenderCV · Harvard", description: "Centered identity and chapter labels between balanced rules, with company-first headings and a concise serif default.", tag: "Balanced centered rules" },
    recommended: { accentColor: "#111111", fontFamily: "serif" }, upstreamUrl: "https://github.com/rendercv/rendercv", licensePath: "rendercv",
  },
  {
    id: "rendercv-ink", source: "rendercv", name: "RenderCV · 墨韵", label: "INK",
    description: "左对齐大字姓名、无横线小型大写章节、机构下的斜体职位与紧凑要点，建议使用深紫衬线配色。", tag: "无节线衬线",
    en: { name: "RenderCV · Ink", description: "A left-aligned name, unruled small-cap chapters, italic roles below organizations and compact bullets. A deep-purple serif palette is suggested.", tag: "Unruled serif" },
    recommended: { accentColor: "#2a1852", fontFamily: "serif" }, upstreamUrl: "https://github.com/rendercv/rendercv", licensePath: "rendercv",
  },
  {
    id: "rendercv-opal", source: "rendercv", name: "RenderCV · 蛋白石", label: "OPAL",
    description: "居中无节线章节、轻字重小型大写、空心圆要点与收窄正文列；建议青绿无衬线配色。", tag: "轻盈短行正文",
    en: { name: "RenderCV · Opal", description: "Centered unruled chapters, light small caps and hollow bullets, with shorter body rows aligned before the date column. A teal sans-serif palette is suggested.", tag: "Light short rows" },
    recommended: { accentColor: "#00645a", fontFamily: "sans" }, upstreamUrl: "https://github.com/rendercv/rendercv", licensePath: "rendercv",
  },
  {
    id: "rendercv-ember", source: "rendercv", name: "RenderCV · 余烬", label: "EMBER",
    description: "衬线姓名与无衬线正文、居中无节线章节、独立斜体职位和菱形要点；建议暖红配色。", tag: "混合字体菱形要点",
    en: { name: "RenderCV · Ember", description: "A serif identity over a sans-serif default body, centered unruled chapters, separate italic roles and diamond bullets. A warm-red palette is suggested.", tag: "Mixed type and diamonds" },
    recommended: { accentColor: "#9b2319", fontFamily: "sans" }, upstreamUrl: "https://github.com/rendercv/rendercv", licensePath: "rendercv",
  },
] as const;
