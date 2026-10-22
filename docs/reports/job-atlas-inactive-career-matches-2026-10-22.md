# 企业招聘发现跳过不可用的旧来源匹配

2026-10-22，修复企业招聘发现把“名称命中已登记来源”误当作可以使用的来源。此前只要 `matchedSources` 非空，工具就返回 `matched-existing`；禁用、待核实或不可用记录会因此阻断用户这次明确提交的官网读取和宿主配置的搜索。

现在只有至少一条来源同时满足 `enabled: true` 与 `status: active` 时，才保留命中后零网络请求的早返。其他命中仍原样出现在 `matchedSources`，同时继续已有的受限fallback：显式官网／种子仍须有效的独立发现策略；name-only 搜索仍只能调用宿主配置的 provider。禁用来源保存的 `entryUrl`、homepage、secret引用和访问策略都不成为外部读取授权。

候选仍标记为未核实；来源提案保持禁用／待审。工具不会注册来源、同步岗位、改动来源配置或写入岗位。active状态也不证明该来源实际具备岗位采集能力。本切片不增加数据库迁移，不扩大网络权限，不代表全网搜索、招聘归属验证、原岗读取或办公地址精度提升。

验证结果：

- `packages/source-adapters/tests/career-discovery.test.ts`: **31/31**。
- `apps/job-service/tests/application.test.ts`: **17/17**；覆盖共享应用工具对SQLite来源快照的读取，发现操作前后备份相同。
- `apps/web/tests/atlas-company-careers-panel.test.tsx`: **18/18**；禁用匹配与新候选同时展示，没有启用禁用来源的按钮。
- `@better-me/source-adapters`、`@better-me/job-service`、`@better-me/web` 类型检查通过；四个改动的TS源码／测试文件ESLint通过。
- `@better-me/web build` 通过。Vite仍报告既有的大包警告；无构建失败。

没有运行外部搜索provider、岗位来源采集、私人索引、浏览器或 5173／5178 服务。修改限于共享发现逻辑、对应的领域／应用／界面回归和工具说明。
