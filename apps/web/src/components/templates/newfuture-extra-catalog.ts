/** Source print modes are translated to the same live preview/PDF paper. */
export const NEWFUTURE_EXTRA_TEMPLATES = [
  {
    id: "newfuture-flex", source: "newfuture", name: "NewFuture · 密集侧标", label: "NEWFUTURE FLEX",
    description: "适配源码 flex 打印配置：保留侧标、紧凑经历、无框日期与逗号技能。", tag: "密集侧标",
    en: { name: "NewFuture · Dense side labels", description: "Adapts the flex print configuration: marginal labels, compact entries, plain dates and comma-separated tags.", tag: "Dense side labels" },
    recommended: { accentColor: "#66aaee", fontFamily: "serif" },
    upstreamUrl: "https://github.com/NewFuture/CV", licensePath: "newfuture", licenseLabel: "MIT",
  },
  {
    id: "newfuture-block", source: "newfuture", name: "NewFuture · 居中分节", label: "NEWFUTURE BLOCK",
    description: "适配源码 block 打印配置：取消侧标栏、居中整行章节与紧凑条目。", tag: "整行章节",
    en: { name: "NewFuture · Centered chapters", description: "Adapts the block print configuration: centered full-width chapters, no side-label column and compact entries.", tag: "Full-width chapters" },
    recommended: { accentColor: "#66aaee", fontFamily: "serif" },
    upstreamUrl: "https://github.com/NewFuture/CV", licensePath: "newfuture", licenseLabel: "MIT",
  },
] as const;
