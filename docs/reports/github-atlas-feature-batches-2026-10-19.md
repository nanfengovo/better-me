# 岗位地图分功能交付

日期：2026-10-19。继承既有 main 与正常提交历史，保护并行简历、主题和研究成果，不改写已发布提交。

## 功能批次

| 批次 | 范围 | 暂存快照验证 |
| --- | --- | --- |
| 1 | 共享匹配、来源发现 / 腾讯、地名候选、归并与本机服务并发提交 | `0e3682d`；独立安装、types、lint、1555/1555 测试、build 通过 |
| 2 | 四平台单页搜索会话、API、可见快照、来源和时间标签 | `1ec9256`；独立安装、types、lint、1648/1648 测试、build 通过 |
| 3 | 连续三维地图、聚合进度、详情 / 原文 / 定位、应用联动和部署分发 | `48bc248`；独立安装、types、lint、1778/1778 测试、build 与地图分发通过 |
| 4 | README 两张独立合成截图、工具说明、路线图、验收和续聊指针 | 独立安装与 memory:check 通过；120 个本地文件 / 图片目标、9 个锚点与两图尺寸 / SHA 核对通过 |

每一功能批从 Git index 导出完整快照，独立安装冻结锁文件后检查；快照的 workspace 链接不指向后续未提交工作树。GeoNames 原始 `config/geography/gazetteer/SOURCE-README.txt` 与 Natural Earth 原始 `apps/web/src/components/atlas/geo/NATURAL-EARTH-LICENSE.md` 的原有空白完整保留，仅对这两个精确上游文件作差异空白检查例外。私人 SQLite / WAL、令牌、浏览器 profile、私人 SSOT 与 `.tmp` 均不发布。

最终共同产品工作树已有 1778/1778、types 10/10、lint、build 6/6、Pages 子路径 / 地理与 worker 分发、隔离 Docker 269 次 HTTP 检查通过；分批检查另行列出，不将数字累加。实际岗位和交互的有限证据及四站差异见 [聚合交互报告](job-atlas-aggregation-interaction-2026-10-19.md) 与 [平台报告](job-atlas-platform-search-2026-10-18.md)。研究、开发协作分工及用户澄清后的产品 Agent 场景文档仍是提案，没有将飞书、收件箱或自主 Agent 算成实现。

## 发布状态

前三批功能已独立提交，文档批次检查已通过。25 项文档 / 截图变更的暂存隐私检查无违规；令牌、数据库与临时证据未进入索引。远端提交、Actions 与线上更新在实际完成后核对，不以本机构建代替部署结果。
