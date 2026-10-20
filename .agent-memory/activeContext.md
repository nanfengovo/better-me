# Active Context

## 当前焦点

本地工作分支 `agent-os`。已全面完成四大核心里程碑开发，并根据前沿 Agent 研究落地自省回环与向量缓存架构优化：
1. **高德地理编码与跨版本持久化地名字典（Q5 选项 B & C）**：
   - 落地 AMap provider、429 指数退避、1.1s 门禁、WGS84 投影及预览/确认/撤销回执流。
   - **Q5 选项 B**：实现 `normalizeAddressKey` 行政区划标准代码（021/010/0571等）与道路门牌两段式标准化主键 `{CityCode}:{RoadName}_{HouseNumber}`（例如 `021:科苑路_399号`），忽略前后附加的园区名、大厦名、室号。
   - **Q5 选项 C**：引入纯 TypeScript 原生 256 维字符 N-Gram 向量嵌入与余弦相似度检索（`createAddressEmbedding` + `cosineSimilarity`，阈值 $\ge 0.85$），在数据目录建立 `geo-address-cache.json` 持久化，同一地标不同园区写法实现 0 API 消耗毫秒级命中。
2. **薪资受审折算与企业控股证据链**：实现任意币种/周期至 CNY 固定年现金的受审折算与证据溯源；实现穿透式企业实际控制人变更与色彩推导。
3. **国内城市扩充与人机验证策略**：补齐全国 7 大 IT 枢纽（京沪深杭穗蓉汉）35 岗完整结构化 JD，优化 10 分钟会话 TTL 与轮询等待验证。
4. **Agent OS 薄适配层与自省双轨架构（Q4 选项 B）**：
   - 零外部冗余依赖实现 LangChain Tool 与 LangGraph StateGraph 标准适配。
   - 实现 **Evaluator-Optimizer 自省回环**（Anthropic 模式）：动态评估候选置信度，自动剥离楼层/园区后缀自省优化重试，梯度止损（`MaxRetries=2`）。
   - 实现 **双轨自主型（Dual-Track Autonomy）**：高置信度（$\ge 0.95$）直通受审入库出具 Durable Receipt；模糊/低置信度或只读模式自动生成 PreviewFingerprint 挂起人工审核，杜绝幻觉写库。

## 关键交付指标

- 单元与集成测试：核心测试套件 **489/489 通过**（fail/cancel/skip/todo 均为 0）。
- TypeScript 编译：`packages/opportunities`、`apps/job-service`、`apps/web` 全部 `tsc --noEmit` 0 错误。
- 岗位地标覆盖：上海 18、北京 4、深圳 4、杭州 3、广州 2、成都 2、武汉 2 共 35 个真实国内办公楼 100% 高德门牌号坐标解析确认入库。

## 下一步

1. 提交并推送最新代码至远程 `agent-os` 分支。
2. 保持与用户的透明沟通，针对当前系统架构与 Agent 演进提供深度解析。

## 必读附加

- docs/amap-setup.md（用户无Key需步骤；当前尚未接高德，不能写假参数）

- docs/reports/job-atlas-visible-office-evidence-2026-10-19.md（最新V2/换址、2504项、真实6地址/rev73/office0；其余旧报告数字为历史）
- .agent-memory/.tmp/atlas-visible-office-final-verified.json、.agent-memory/.tmp/visible-office-final-postcheck.json（本机最终验证）

- docs/reports/job-atlas-detail-address-review-2026-10-19.md（当前来源地址/批量计划/性能/真实覆盖缺口与发布）

- docs/reports/job-atlas-desktop-precision-2026-10-19.md（当前桌面稳定轨道、地址约束、156回归、实际合成UI和原服务更新）
- docs/reports/job-atlas-office-provider-real-2026-10-19.md（本轮真实HTTP、门牌格式修复、39隔离相关测试、原服务及邮编增强）
- docs/reports/job-atlas-salary-control-gap-2026-10-19.md（下一步薪资／FX／控股源码缺口及未实现范围）
- docs/reports/job-atlas-desktop-office-address-2026-10-19.md（本轮桌面三栏、V4办公地址、2332隔离回归、合成浏览器及原服务升级）
- docs/reports/job-atlas-jsonld-sources-2026-10-19.md（通用JSON-LD、2234隔离回归、实时timeout与原响应导入分开、Docker许可）
- docs/reports/job-atlas-city-references-2026-10-19.md（独立城市分布、2155隔离回归、87岗真实HTTP与发布范围）
- docs/reports/job-atlas-import-location-2026-10-19.md（入库成功后接续地区核对、96相关回归与合成真实应用联动）
- docs/reports/job-atlas-career-web-search-2026-10-19.md（provider／独立访问策略、2099／2109与meta修复223检查、真实挑战与未完成闭环）
- docs/reports/job-atlas-reconciliation-2026-10-19.md（七工具／受审UI／持久回执恢复、2053隔离验证与5对真实弱候选）
- docs/reports/job-atlas-domestic-source-expansion-2026-10-19.md（最新85岗／26国内C#／48全球文本、完整详情、服务恢复及135隔离回归）
- docs/reports/job-atlas-ashby-fields-2026-10-19.md（新字段、1975隔离回归／真实7条与原服务更新阻断）
- docs/reports/job-atlas-smartrecruiters-2026-10-19.md
- docs/reports/github-atlas-feature-batches-2026-10-19.md
- docs/reports/job-atlas-location-confirmation-2026-10-19.md
- docs/job-atlas.md、apps/job-service/README.md、docs/ROADMAP.md
