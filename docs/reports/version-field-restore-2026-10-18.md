# 版本历史逐项恢复

日期：2026-10-18，Asia/Shanghai。用户希望在版本差异中只回滚某个差异。

## 当前行为

- 历史版本 → 选择版本 → 展开“查看逐项差异” → 每行“恢复此项”。左侧为最新编辑，右侧为本次采用的历史值，新增/移除/修改按恢复方向展示。
- 支持展示出的单个资料字段、中文/英文项、经历字段、事实要点正文/属性、经历或要点整体增删、顺序、简历设置、布局属性、展示选择、可见性及对应文字格式。粒度是差异行，不是任意字符选择或逐字补丁。
- 只把选中字段合并到最新编辑，面板与历史版本选择保留；成功后重新计算差异，已恢复行消失，其他当前编辑保留。完整版本恢复入口继续存在。
- 缺失父经历/简历、不同正文对应的格式、已核实指标、逆序日期及不存在的引用会禁用并说明前置条件；删除最后一份简历被阻止。导入来源对象出现/消失时用“导入来源资料（整组）”恢复，不能用单个子字段创建不完整来源。

## 保存与依赖

- typed target 按稳定 ID 定位，不解析展示文案，不依赖数组下标。恢复目标旧值、所属结构或必要原文发生变化时拒绝旧比较句柄，要求重新比较；不相关编辑可以继续合并。
- 比较句柄冻结，真实值存私有 WeakMap，机器目标及 ID 不枚举；JSON 展示不新增原始 ID、照片或完整内部快照。复制/序列化的句柄不能应用。
- 恢复前完整内容必须先追加“单项恢复前 · 当前编辑”检查点；未完成内容精确保存在切换前草稿（含 NaN）。保护失败时不改当前编辑。外部窗口冲突需先处理，不借单项恢复覆盖。
- 结果仍未完成时只保存本地草稿，保留其他无效输入并说明尚未生成完整版本；完整结果保存正式数据和恢复版本。正式保存成功但结果历史追加失败时如实提示，保留恢复前保护，不误报字段未应用。
- 改动正文仅重定位仍对应的格式，被替换文字不继承旧格式；关联已核实量化改回待核实。删除结构只清理本次删除 ID 的展示依赖，不清空无关旧草稿引用，并保留明确隐藏语义。
- 当前 LocalJsonStore 的 async 方法内部同步落盘；本次没有扩展为任意异步存储事务或跨窗口 CAS。

## 验证

- 新增纯恢复 21、持久化 13、真实 React UI 8，共 42 个专项测试通过；覆盖陈旧比较、稳定 ID、单语言合并、NaN、日期/正文/格式依赖、保护失败、外部冲突、迟到响应、新编辑保留、撤回与重新加载。
- 最终 core/storage 与版本、视图、导入来源、问题导航、导出和关联 JD 界面回归共 257 项通过，0 失败/跳过/取消。命令：`node node_modules/tsx/dist/cli.mjs --test --test-reporter=dot packages/core/tests/*.test.mjs packages/storage/tests/*.test.ts apps/web/tests/version-history-field-restore.test.tsx apps/web/tests/version-time.test.tsx apps/web/tests/resume-views.test.tsx apps/web/tests/import-source.test.tsx apps/web/tests/issue-navigation.test.tsx apps/web/tests/docx-export.test.tsx apps/web/tests/jd-match-readiness-ui.test.tsx apps/web/tests/jd-browser-cleanup-ui.test.tsx`。
- `pnpm typecheck` 5/5、`pnpm lint`、最终 `pnpm build` 3/3 通过；保留既有大 chunk 提示。独立只读审查无阻断问题，`git diff --check` 通过。
- 最终构建由临时静态服务 `http://[::1]:5199/` 提供，以独立 origin 的默认示例及合成修改进行真实浏览器验收：建立基线，改姓名和电话，仅恢复电话，姓名保留新值、差异 2→1、面板不关闭、保护快照出现；从保护快照逐项撤回电话后再次恢复。刷新仍显示新姓名与已恢复电话。
- 证据位于仓库外 `<local-artifacts>/version-field-restore/`：`phone-restored-name-preserved.png`、`after-reload.png`、`after-reload.txt`、`acceptance.json`。临时页面已关闭、静态服务已停止，5199 无监听。

原 localhost 用户页、私人简历/历史、API Key、代理及岗位服务均未用于变更验收。已有工作区修改保留，无 commit/push。前批默认简历匹配守卫、46 模型与招聘四岗验收保持独立，Chrome Gemini 网页问题仍按原报告记录。
