# Active Context

## 当前焦点

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
无。核心包与 Web 界面测试全部畅通。

## 下一步
1. 建立 2~3 个典型脱敏技术岗（如高并发后端、云原生架构）的真实 JD/简历对比样本库；
2. 推进阶段 2 的 DOCX/PDF 真实多栏排版打印抽检。

## 必读附加
- `docs/ROADMAP.md`
- 历史记忆归档见 `.agent-memory/archive/README.md`
