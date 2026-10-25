# AGENTS.md — 迈向更好

## 每次会话开始（必须）

1. 阅读 `.agent-memory/activeContext.md`
2. 阅读 `.agent-memory/progress.md`
3. 若 `activeContext` 中 **「必读附加」** 列出文件 → **一并阅读**（用户说「聊到哪了 / 继续 / resume」时同样适用，无需用户点名）
4. 若涉及产品边界或历史取舍 → 再读 `decisionLog.md` / `projectbrief.md`
5. 若涉及改简历、面试、生成 Fact → 读 `careerObjectives.md` + `factBase.md` + `resumeGuidelines.md`（`careerStrategy.md` 仅为索引）

地图与拆分规则：`.agent-memory/README.md`。

## 每次收工或切换会话前（必须）

1. 更新 `activeContext.md`：**当前焦点**（一句人话停点）、**卡点**、**下一步**、**必读附加**（下一会话无感续聊用；无关则写「无」）
2. 更新 `progress.md`（勾选完成项、补充待办）
3. 若有新的架构/产品/记忆结构取舍，追加 `decisionLog.md`（含「不选的方案」）
4. 个人求职事实变更 → 改对应 SSOT（`careerObjectives` / `factBase` / `resumeGuidelines`），**禁止**往 `careerStrategy.md` 或 `activeContext` 堆长正文

Agent **无法检测**你何时关闭聊天窗口。及时保存靠：

- 里程碑结束就写（功能落地、决策拍板）
- 你说「保存 / 收工 / 换窗」立刻写
- 本轮有实质进展时，回复结束前默认短更新 memory

## 产品约束（摘要）

- V1：写好简历（Fact 防编造、模板库、导出、中英、JD 匹配、API Key + 本地模型）
- V1 不做：打卡学习、自动投递、插件
- 模板：自研为主；禁止爬取商业简历站模板

## 代码约定（随实现补充）

- 用户数据与 API Key 不进 Git
- 模板带 `LICENSE` / `NOTICE`（若移植开源主题）
- UI 与排版：Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.
- 开源借鉴：遇到不熟悉的功能别直接从零开发，先检索GitHub上维护活跃、许可证明确的同类开源项目，对比后优先借鉴成熟方案，避免用来源不明、兼容性差的代码，能有效减少项目返工~
