# 办公地址提供方：真实响应与位置精度

日期：2026-10-19。接续[桌面三栏与办公地址](job-atlas-desktop-office-address-2026-10-19.md)，本批修复真实门牌结果漏召回，并分别记录服务连通、地址格式、查询匹配与岗位办公证据。它们是四项不同的验收。

## 已修复的真实返回格式

Nominatim 会把具有道路和门牌的具体地址返回为 `category=place`、`type=house`、`place_rank=30`。旧实现一概拒绝 `category=place`，导致这类地址被丢弃。

提交 `b010dd3dba4d17433ac45b996edfad22a902c94e` 只调整[提供方解析](../../apps/job-service/src/office-address-provider.ts)：允许 `place/house` 继续接受原有严格检查。仍要求地址级 rank、门牌、道路、有效 ISO 国家及合法 WGS84；城市、城镇、郊区、邮编、道路、行政边界、缺门牌、缺道路、未知国家、跨国返回和坏坐标继续拒绝。候选保留 `site`、`manual-user-confirmation`、`estimated:true`、`verification:unverified`。

没有放宽固定 HTTPS 端点、DNS 公网检查、禁止重定向、请求预算、速率和缓存，也没有自动采用候选作为岗位办公点。

## 真实请求及准确性边界

旧报告中的 system DNS 单次探针失败属当时记录，底层原因未留存，不能反推必然由 DNS 导致。本批先确认本机服务明确采用 `--dns google-doh`，再按相同配置执行一次公开地标查询：`350 Fifth Avenue, New York, NY, United States`。

- Google DoH 一次、Nominatim 一次，共两次预算消耗，没有重试、fallback、替换路由或端点。
- Nominatim HTTP 200，总耗时 4.035 秒，源响应 2144 字节。
- 响应 SHA-256：`f2ea859c0cf3bf1c2bd2792845fafadb604bcb54822d9aa67a26a440b26e9a22`。
- 未读取或发送岗位正文、家庭地址、私人索引或服务凭据。

原实现从这份响应解析出 0 条；修复后对已保存响应进行 SHA 校验及完全离线重放，解析出 3 条门牌级候选，没有再次联网。

**这 3 个点位于纽约州 Greenport、Watervliet、Pelham，没有准确命中所查询的纽约市地标。** 本次证明真实 HTTP 可达，以及该返回格式可以保留；没有证明查询精度，更没有证明雇主在候选处办公。网页仍须对照岗位来源地址、城市、邮编和楼宇依据，候选只填表，预览及本人确认后才保存。国内覆盖与实际岗位门牌核对继续验收。

## 真实索引字段与原观察时间

升级后的只读覆盖核对仍为 89 岗、11 个有岗位的来源。89 岗均有正文和所选快照，但只有 46 岗的所选观察明确为 `detail` 且正文与该快照一致；非空文本不能一概称完整 JD。核对时街址、结构化邮编、坐标和已确认办公点均为 0。

两条 ABB 旧公开响应已有邮编，原导入早于 street／postal 字段支持。对原响应校验 SHA 后使用现有 parser 离线读取，只补来源明确的邮编：

| 公开岗位 | 原来源地点 | 可补字段 | 原响应 SHA-256 |
| --- | --- | --- | --- |
| [C#/.NET Software Developer](https://careers.abb/global/en/job/JR00044541/C-NET-Software-Developer) | Ostrava／CZ | `703 00` | `48d9cd9c34c264fcf685588613589dffa70d79929d819a23db54bba09e266c8c` |
| [Senior Software Engineer — MES](https://careers.abb/global/en/job/JR00042905/Senior-Software-Engineer-m-f-d-MES) | Mannheim／DE | `68309` | `689a838516e7662ab99efff5795567fecabdbf8f6cbf3e5bf5e9d268669954ee` |

两条原证据时间均为 `2026-10-19T01:27:56.030Z`，不重新伪装为本次采集。来源没有 streetAddress，geo 没有办公楼／入口精度，因此不采用为办公坐标。

最小增量只包含依赖闭合的 1 来源、1 企业、2 岗位、2 地点、2 listing、2 observation、2 snapshot，无薪资或本人覆盖。完整 SQLite 备份恢复至内存后，正常 merge 证明：来源层只补两处邮编；有效岗位只出现相应 revision 与 updatedAt 投影变化；其余字段、行政与办公决议、归并及合并期间的 alias 历史和既有回执均保持。内存 restore 自身的版本递增与恢复 alias 事件单独记录，不冒充真实 merge 的变化。

真实服务已完成完整在线备份及版本、数据、令牌、0 running 预检后，通过现有认证 `dataset/import` 一次写请求执行最小增量，89 岗／revision 66→67；没有新增岗位、listing、观察或 JD 快照。最终只有两处来源／有效地点邮编、两条有效岗位必要版本与更新时间、对应版本计数、索引版本和一条耐久回执发生变化。27 条行政、0 条办公、0 条归并、89 条 alias 历史及所有原回执逐值保留，Schema／FTS／派生关联与 token 不变，备份哈希、quick_check 和外键检查通过。五组 C# 查询的岗位集合及其余字段保持。当前结构化邮编为 2，街址、坐标和已核办公点仍为 0，不把邮编补充称为门牌定位完成。

## 独立验证与本机服务

本次两文件修复的冻结树为 `11d0296f2e65271daa6f481365ee2ed88ae28a9d`。离线冻结安装、Memory 检查、Typecheck 10/10、Lint、Build 6/6，以及 provider／transport／办公工具／真实 React → 认证 HTTP → SQLite 的相关测试 **39/39** 通过，失败、取消、跳过和 todo 均为 0。未与前批 2332 项相加；新增[边界回归](../../apps/job-service/tests/office-address-transport.test.ts)覆盖门牌类型保留及非地址拒绝。

[Actions39192115753](https://github.com/nanfengovo/better-me/actions/runs/39192115753) 的 Windows 质量检查、Linux 构建、Docker 构建运行和 Pages 部署均 success。公开首页、主脚本、Atlas、办公地址面板及 CSS 五项资源均 HTTP200，并核对三栏规则、确认／撤销入口和 WGS84 说明；这是实际分发资源检查，没有新增私人页面目视验收。前批办公地址功能与文档的 Actions39190824724、39191250068 也已全部 success。

完整在线备份及 quick_check 通过后，原自有服务温和停止，再以原目录、端口、Origin、Google DoH 和显式 Nominatim 配置启动。升级后 listener／进程身份、89 岗／revision 66、数据与 token 哈希、SQLite V4、外键检查、0 running、0 办公决议均通过；无 query 的候选接口只读返回已配置，不调用地图服务。C# 查询保持全球 52 岗／36 企业、严格国内 26／22、上海 25／21、浦东 7／6、松江 3／2，办公坐标仍为 0。

本机 5286 的 Vite 进程路径和四个静态模块响应已核对，新三栏属性、ResizeObserver、样式和办公地址确认面板均实际 HTTP200；没有重启或修改该服务。

本批没有再次操作私人浏览器页面，不把 HTTP 核对称为新增目视验收。桌面三栏与合成地址确认／撤销／双击高亮的既有 UI 验收见前批报告。并行 Career Agent 改动保留在工作树，未混入本次发布；私人库、凭据、备份和完整来源响应不入 Git。

后续可比薪资、FX 与控股核对的源码缺口见[后续能力报告](job-atlas-salary-control-gap-2026-10-19.md)，其中新增流程仍为规划。完整岗位聚合目标继续，不将本次地址修复称为全网覆盖或所有岗位门牌已完成。

[地图使用说明](../job-atlas.md) · [本机服务](../../apps/job-service/README.md) · [路线图](../ROADMAP.md)
