# Active Context

## 当前焦点

2026-11-10：工坊 Agent 身份与系统设置联动。`LocalAgentRuntimeProvider` 通过 SWR 共用运行时探测与会话内选择，`AgentCompanion` 和工坊使用同一 ID / 名称 / `AgentBrandIcon`；保留原有视觉，补充浅色材质、键盘节点、减少动态及未配置/离线状态。显式选择失效不会静默切换品牌。选择延续原先的会话语义，不新增持久化或改变模型路由。

### 此前交付

2026-11-08 JD 原句深度拆解与证据链匹配抽屉落地（双端闭环）：
- **核心拆解与证据对齐引擎（packages/core）**：
  - 新增 `packages/core/src/project/jd-decomposition.ts`，导出 `decomposeJdText` 与 `alignJdWithResume`；
  - 严格保持 **原句保真（`originalQuote`）**，按核心职责、硬性资格（年限/技术栈/学历/领域）、加分优先、约束（Base地点等）进行结构化切分；
  - 自动提取 C#/.NET/Kafka/Redis/K8s/MySQL 等全量关键技术栈关键词；
  - 实现与简历的事实证据对齐，区分 **强有力实证（verified_match）**、**表达弱待强化（weak_expression）** 与 **能力缺口（gap）**，严格遵从防编造原则不虚构事实；
  - 编写 `packages/core/tests/jd-decomposition.test.mjs`，断言 Schema 校验与匹配准确性。
- **面试攻防防御专区（Interview Defense）与 BOSS 移动短链解析闭环**：
  - **BOSS 直聘移动短链规范化**：自动将 `m.zhipin.com/mpa/html/weijd/weijd-job/<id>` 映射为桌面端 `https://www.zhipin.com/job_detail/<id>.html`，避开移动端 WAF 滑块拦截，测试守护 `apps/web/tests/jd-boss-url-normalization.test.ts` 通过；
  - **结构化面试防守策略引擎**：`alignJdWithResume` 产出结构化 `InterviewDefenseStrategy`（分类涵盖 `education_gap` / `scenario_troubleshooting` / `deep_tech_dive`，风险分级，STAR 结构化回答提纲）；
  - **前端匹配抽屉交互升级**：`JdMatchDrawer` 新增 **「面试攻防防御」** 专属 Tab，展示高/中/低风险追问、防守核心要点、结构化作答提纲，支持「一键复制提纲」与「与 Copilot 模拟对练这道题」直通 Agent Chat；
  - `apps/web/tests/jd-match-drawer.test.tsx` 扩充至 10/10 全绿通过。

## 卡点
本轮定向 ESLint、Web 类型检查、9 项组件回归及 `pnpm desktop:build` 通过。正式浏览器页停在登录门禁；隔离工坊测试页遭遇 CDP `DOM.enable` 超时，尚未获得视觉截图。Linux 沙箱无法刷新或启动用户本机 macOS `BetterMe.app`，不可将共享产物构建成功视作桌面实机验收。

## 下一步
1. 在已登录环境复核设置 → 工坊的 7 种 Agent 图标、清除选择、离线状态以及移动端布局；隔离页面为 `apps/web/tests/ui-lab/studio-agent-identity.html`，只使用测试运行时。
2. 在 macOS 刷新并运行 BetterMe.app，验证共享界面改动。
3. 继续此前 JD 样本库与 DOCX/PDF 排版抽检工作。

## 必读附加
- `docs/ROADMAP.md`
- 历史记忆归档见 `.agent-memory/archive/README.md`
