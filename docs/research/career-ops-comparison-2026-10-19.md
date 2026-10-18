# career-ops 中国版与上游：功能及复用评估

日期：2026-10-19，Asia/Shanghai。状态：**只读研究与候选建议，未决定或实施接入**。本轮核对 GitHub 元数据、固定源码快照及 BetterMe 当前实现；未执行外部仓库代码、安装依赖、启动服务或验证真实招聘站，也未读取私人求职事实库。

## 仓库关系与检查快照

| 对象 | 本轮固定快照 | 关系与定位 |
| --- | --- | --- |
| [shuheng-mo/career-ops-china](https://github.com/shuheng-mo/career-ops-china/tree/452980a8cd82630389335287a360eb7b4e82c147) | `452980a8cd82630389335287a360eb7b4e82c147`；package 版本字段 `1.0.0` | README 自称原 career-ops 的中国大陆深度定制版。GitHub API 的 `fork` 为 false，没有 parent/source 字段；衍生关系依据作者说明、版权及源码，不是 GitHub fork-network 元数据。 |
| [career-ops-hq/career-ops](https://github.com/career-ops-hq/career-ops/tree/19df53bec3cb860d967b0f68a87d0fbb268e4e22) | `19df53bec3cb860d967b0f68a87d0fbb268e4e22`；package 版本字段 `1.37.0` | 中国版链接的 `santifer/career-ops` 现重定向至此。最新上游已有显著扩展，不能仅依照中国版对旧上游的介绍判断当前能力。 |

上述版本是检查时 package 字段，不用于推断两者全部提交的祖先关系或发布兼容性。

## 两个项目分别做什么

中国版把 Claude Code 工作目录组织成个人求职工作流：接收 JD/截图/链接，生成 A–F 报告（岗位摘要、简历匹配、级别策略、薪酬调研、材料调整、面试准备），再生成 PDF、记录申请和跟进。国内定制包括中文模式、公司/岗位方向预置、中文薪酬与公司调研指引、书签捕获和本地 JD 收件箱，以及实际的飞书工具与 Markdown/Bitable tracker 后端。

其中评估、调研、故事同步、雷达的大部分实现是 `modes/*.md` 操作指令，依赖模型与宿主工具执行；不是安装后即可确定性调用的独立匹配服务。看准、脉脉、天眼查等主要是调研来源指引，不能算现成数据 API。README 的模式数量与部分目录描述也未完全跟上当前文件。

当前上游已扩展为 Markdown 工作流、独立 Node 工具、公开 ATS/source providers、多 CLI 执行适配、可选本地 Next.js Web 和 Go TUI。功能包括 A–H 评估、岗位可用性观察、简历/求职信与表单回答草稿、来源发现、批处理、面试与谈判准备、申请台账、回复与漏斗复盘。当前也有中文文档和国内来源，不能概括成仅支持海外。Web 自标 alpha；源码及测试存在不等于本轮运行验收通过。

两者都强调用户最后决定和提交。它们的核心价值在筛选机会与组织求职流程；没有直接提供 BetterMe 所需的岗位三维地图、地理确认或完整证据化跨源归并。

## 对 BetterMe 的功能价值

| 优先级 | 候选能力 | 主要来源及实现性质 | 对应 BetterMe 的使用方式与边界 |
| --- | --- | --- | --- |
| 高 | 人工页面捕获与待核对收件箱 | 中国版 `tools/bookmarklets/`、`jd-inbox-server.mjs`；采集为 JS，后续 inbox 编排主要为 prompt | 补充现有链接、截图及专用浏览器读取入口。用户正常打开并看到岗位后捕获原文，先待核对，再显式采用为观察/JD/私人机会；不能把页面捕获自动当规范岗位。 |
| 高 | 更多官网招聘系统适配器 | 上游 `providers/feishu-jobs.mjs`、`mokahr.mjs`、`workday.mjs`、`smartrecruiters.mjs`、`personio.mjs`、`recruitee.mjs` 等真实模块 | 优先选择本人实际关注公司的协议，在 `packages/source-adapters` 中按现有契约适配。保留稳定身份、原文、时间语义、部分覆盖、请求预算和取消，不把外部 `Job` 直接写入规范索引。 |
| 高 | JD 逐项要求与证据表 | 上游 `modes/oferta.md`、`jd-skill-gap.mjs`、`skill-extract.mjs`；表格设计为 prompt，技能抽取/对照有纯函数 | 扩充现有 JD 分析为“要求原句—重要性依据—Fact 证据—判断—待确认”。重要性可标明确措辞/结构/推断；能力、简历呈现、个人偏好仍分开。 |
| 高 | 生成材料前的事实与来源检查 | 上游 `verify-cv-facts.mjs`、`story-provenance-check.mjs` 及导出接线；真实代码 | 借数字、单位、责任范围、工具与作者归属的反例和回归案例，补强现有 claimId/原句绑定。应将每个断言绑定相同 Fact 与版本，不能仅因为某数字在整份履历出现就视作有依据。 |
| 中高 | 岗位可用性观察 | 上游 `liveness-core.mjs`、`liveness-api.mjs`、`liveness-browser.mjs` | 对“可访问/明确关闭/受限或未知”保留观察证据与时点，降低在失效岗位上生成材料的成本。一次失败、验证墙、空壳、列表缺席继续不能判关闭。 |
| 中 | 偏好、强约束与候选来源配置 | 中国版 profile/portals；上游 profile、discover-ats 与 company-funded | 将地点、工作方式、公司类型、薪资及强约束做成个人配置；信息不足保留待确认。公司目录仅作待审种子，融资/公司新闻只是线索，不能计作岗位或认定企业性质。 |
| 中 | 面试故事、复盘与申请漏斗 | 中国版 `story-sync`；上游 `match-star.mjs`、`story-provenance-check.mjs`、`funnel-velocity.mjs`、`analyze-patterns.mjs` | 在现有机会/跟进和材料快照上增加事实引用、问题—故事适配、真实面试观察、渠道和阶段统计。模型生成故事是表达材料；反思、演练、事实分别保存，不反向自动写 Fact。 |
| 后置 | 多 CLI/Agent 薄适配、飞书等外部联动 | 上游 worker capabilities/spawn/fencing；中国版飞书 calendar/task/docs/notify 真实工具 | 前者可参考以后共享工具如何包装给不同执行器；后者作为显式可选适配器另立范围。当前非 Agent 优先，不因存在脚本就安装、授权、发消息或创建自动化。 |

### 官网来源中更具体的增量

- 上游飞书招聘 provider 处理 `jobs.bytedance.com` 与 `*.jobs.feishu.cn` 的列表协议、岗位 ID、详情路由及分页；它与“把提醒发到飞书”是两个不同模块。源码把职责和要求拼接后截到 4,000 字符，因此不能不加完整性标记就将其当完整 JD。
- 上游 Mokahr provider 处理租户 URL、`limit/offset` 分页、API 响应与地区映射。源码明确这不是官方第三方 API，而是站点前端使用的内部协议；含依赖特定响应封装及固定 IV 的处理。作者注释的实测不是本轮验证，需要另做少量、受控、按租户的实际验收。
- Workday、SmartRecruiters、Personio、Recruitee 等可作为扩官网覆盖的候选。现有 Greenhouse/Lever/Ashby/腾讯与 BetterMe 有重叠，避免重复维护采集主干。

## 不能直接搬的部分

1. **中国版书签不能证明绕过登录墙。** 它读取用户已访问到的 DOM；没有自动搜索、翻页、登录或解验证码。Mokahr 跨域 iframe 仍受浏览器同源限制，部分 `textContent`/整页兜底可能读到隐藏或无关文本。BOSS 公司/HR、Mokahr 部门/公司、标题推断地点等启发式必须作为待核对字段，不能升级成已核实事实。
2. **中国版 inbox server 不能原样接入。** 虽只监听 loopback，但允许 `Access-Control-Allow-Origin: *`，无 token/Origin/Host 验证、严格 payload schema、可靠文件名约束、原子持久化及耐久幂等。同秒同平台同标题可能覆盖。应沿用 BetterMe 现有认证与存储边界，另设计安全配对或显式文件导入；不能把现有服务 token 嵌进外站书签。
3. **中国版评分/画像带个人假设。** `modes/offers.md` 的十项权重合计 115%，未说明归一化；单岗评分也没有确定公式。`tracker-backend.mjs` 仍硬编码作者的 AI/汽车方向与主次，模板残留固定成果数字；`merge-tracker.mjs` 仅接受更高重评分，会忽略降分。这些不符合 BetterMe 的未知值、可复算规则与版本化结果要求。
4. **上游的技能 gap 不等于已证实不会。** `jd-skill-gap.mjs` 的第三桶仅表示当前 `cv.md` 没找到文本依据。BetterMe 应映射为“未找到依据/待确认”，且有权限时可查未展示的 Fact；只有确认后的能力缺口才进入学习规划。
5. **事实检查并非通用语义证明。** 上游已有多语覆盖告警和 `pass/warn/block`，但词表、正则、责任范围规则仍有语言/改写覆盖限制；故事的 `source: cv.md`/`user-stated` 文本标记本身也不能替代 BetterMe 可信确认回执。可以借测试和状态设计，不能据此宣称彻底防编造。
6. **时间和可用性语义需要重映射。** 上游 `providers/tencent.mjs:76` 把 `LastUpdateTime` 写为 `postedAt`；BetterMe 应继续保留为更新时间而不造发布时间。`liveness-core.mjs:303` 将短内容判 `expired/insufficient_content`，而其高层模式又要求该信号保持未确认；移植时必须统一为证据不足，不能无条件照搬底层 verdict。可见 Apply 按钮也不足以独立核实当前岗位在招。
7. **存储与执行架构不同。** 上游以 `applications.md`/报告/pipeline 为主源，SQLite 是可重建索引；BetterMe 已有结构化主库、公开岗位与私人资料边界。上游 provider runtime 校验多为 JSDoc/形状检查，CLI fencing 也明确存在 full/partial/none，不能替换现有 Zod 契约、可信宿主权限或主库。
8. **它们不修当前项目运行接线。** 书签、腾讯/LinkedIn脚本、更多 ATS 都不能解决现有 Vite 模块加载与旧接口 404，也不能代替真实 51JOB/BOSS/猎聘/LinkedIn 搜索列表验收。新来源应该在现有运行缺口解决后按需扩展。

上游的 `agent-inbox.mjs` 是 Agent 待办意图队列；`data/pipeline.md` 是岗位待评估清单；`jd-capture.mjs` 主要解析已归档 JD。它们与中国版原始页面捕获 inbox 各有职责，不能合称为已实现统一采集到规范索引的闭环。

## 建议接入顺序与本地映射

1. 先完成当前四平台执行端加载与真实列表验收。研究结论不自动替代已有工程停点。
2. 然后按实际需求选择“人工捕获待核对箱”与一两个官网适配器：采集接 `apps/web/server` / `apps/job-service` 既有认证入口，规范映射放 `packages/source-adapters`，观察/JD/来源保持现有域契约。外部发送方的身份方案需要独立设计，不复用开放 CORS 接收器。
3. 匹配增强放 `packages/core/src/ai/types.ts`、`client.ts` 和事实/投影相关域中，按 [真实技能匹配方案](../planning/job-skill-matching-loop-2026-10-17.md) 实现稳定引用、未知、版本过期和建议确认；复用测试思路，不复刻主观总分门槛。
4. 后续在现有机会/跟进中加面试故事与渠道漏斗。完整 Agent 编排、外部飞书通知、远端例行任务及插件继续按产品边界另立范围。

近期不值得引入另一套 PDF 模板引擎、Web 壳、Markdown/Bitable 主库、Go TUI 或 Bash worker 编排。BetterMe 已有 119 套模板与结构化工作台，新增维护成本高于当前增益。

## 许可与验证范围

两仓库根许可均为 MIT。中国版同时保留 Santiago Fernández de Valderrama 与 Mo Shuheng 的版权；如实质移植源码或文档，随对应适配单元保留完整 LICENSE 与署名/NOTICE。上游字体分别有 SIL OFL，品牌另有 TRADEMARK 文件；岗位/JD、外部新闻、平台访问条件不因仓库 MIT 获得再分发或访问授权。

本轮只审查选定模块源码与测试断言，没有运行外部测试或真实 API；文档中的作者覆盖率、成功率、实测时间、求职成绩不作为本轮验证结果。没有修改 BetterMe 产品代码、安装外部功能或配置实际自动化。

## 固定源码入口

- 中国版：[README](https://github.com/shuheng-mo/career-ops-china/blob/452980a8cd82630389335287a360eb7b4e82c147/README.md)、[书签源码](https://github.com/shuheng-mo/career-ops-china/tree/452980a8cd82630389335287a360eb7b4e82c147/tools/bookmarklets)、[接收服务](https://github.com/shuheng-mo/career-ops-china/blob/452980a8cd82630389335287a360eb7b4e82c147/tools/jd-inbox-server.mjs#L25)、[offer 模式](https://github.com/shuheng-mo/career-ops-china/blob/452980a8cd82630389335287a360eb7b4e82c147/modes/offer.md)、[115% 权重表](https://github.com/shuheng-mo/career-ops-china/blob/452980a8cd82630389335287a360eb7b4e82c147/modes/offers.md#L12)、[重评分合并](https://github.com/shuheng-mo/career-ops-china/blob/452980a8cd82630389335287a360eb7b4e82c147/tools/merge-tracker.mjs#L401)、[LICENSE](https://github.com/shuheng-mo/career-ops-china/blob/452980a8cd82630389335287a360eb7b4e82c147/LICENSE)。
- 上游：[README](https://github.com/career-ops-hq/career-ops/blob/19df53bec3cb860d967b0f68a87d0fbb268e4e22/README.md)、[provider 规则](https://github.com/career-ops-hq/career-ops/blob/19df53bec3cb860d967b0f68a87d0fbb268e4e22/providers/README.md)、[飞书招聘](https://github.com/career-ops-hq/career-ops/blob/19df53bec3cb860d967b0f68a87d0fbb268e4e22/providers/feishu-jobs.mjs)、[Mokahr](https://github.com/career-ops-hq/career-ops/blob/19df53bec3cb860d967b0f68a87d0fbb268e4e22/providers/mokahr.mjs)、[候选发现](https://github.com/career-ops-hq/career-ops/blob/19df53bec3cb860d967b0f68a87d0fbb268e4e22/discover-ats.mjs)。
- 匹配与真实性：[要求/证据表](https://github.com/career-ops-hq/career-ops/blob/19df53bec3cb860d967b0f68a87d0fbb268e4e22/modes/oferta.md#L154)、[技能对照](https://github.com/career-ops-hq/career-ops/blob/19df53bec3cb860d967b0f68a87d0fbb268e4e22/jd-skill-gap.mjs#L560)、[事实检查](https://github.com/career-ops-hq/career-ops/blob/19df53bec3cb860d967b0f68a87d0fbb268e4e22/verify-cv-facts.mjs#L2037)、[故事来源四状态](https://github.com/career-ops-hq/career-ops/blob/19df53bec3cb860d967b0f68a87d0fbb268e4e22/story-provenance-check.mjs#L624)、[可用性分类](https://github.com/career-ops-hq/career-ops/blob/19df53bec3cb860d967b0f68a87d0fbb268e4e22/liveness-core.mjs#L225)。
- 宿主与许可：[worker 能力](https://github.com/career-ops-hq/career-ops/blob/19df53bec3cb860d967b0f68a87d0fbb268e4e22/web/src/lib/worker-capabilities.mjs#L51)、[CLI 隔离覆盖](https://github.com/career-ops-hq/career-ops/blob/19df53bec3cb860d967b0f68a87d0fbb268e4e22/web/src/lib/cli-fencing.mjs#L337)、[存储契约](https://github.com/career-ops-hq/career-ops/blob/19df53bec3cb860d967b0f68a87d0fbb268e4e22/DATA_CONTRACT.md#L37)、[MIT](https://github.com/career-ops-hq/career-ops/blob/19df53bec3cb860d967b0f68a87d0fbb268e4e22/LICENSE)、[品牌政策](https://github.com/career-ops-hq/career-ops/blob/19df53bec3cb860d967b0f68a87d0fbb268e4e22/TRADEMARK.md)。
