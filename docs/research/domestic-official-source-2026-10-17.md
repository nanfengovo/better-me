# 国内官网主源试点：腾讯招聘

研究与验证日期：2026-10-17，Asia/Shanghai。本轮只新增用户触发的官网搜索预览，Agent、定时采集、批量申请和账号登录均未接入。

## 已实施的入口

机会工作区「从公司公开招聘页发现机会」新增「腾讯招聘官网」。输入关键词（可留空）后，只读取公开搜索接口的第 1 页、最多 100 条；结果先显示在预览中，勾选并点击「收藏所选」才写入机会库。搜索结果还有更多岗位时，界面明确显示本次不是完整结果。可调整关键词缩小范围，不会自动翻页抓取全库。

接口仍使用现有 `POST /api/opportunities/source`，新增请求：

```json
{"provider":"tencent","company":"tencent","keyword":"后台"}
```

服务端固定请求：

```text
https://careers.tencent.com/tencentcareer/api/post/Query?keyword=后台&pageIndex=1&pageSize=100&language=zh-cn
```

请求中的关键词由 URLSearchParams 编码；不接受用户提供的上游地址，公司固定为 `tencent`。继承同源 POST／JSON 检查、请求体 32 KB、响应 8 MB、15 秒总超时、禁止重定向与不携带凭据的边界。腾讯只发起一次搜索请求，不请求详情、Workday 或申请页。

纯静态部署仍需要兼容后端；Vite dev／preview 插件并不随 `dist` 静态文件部署。

## 真实公开样本

首先对源码已公开记录的腾讯官网 Query 路径做单次只读验证：关键词「后台」、第 1 页、每页 10 条，HTTP 200，`application/json; charset=utf-8`，`Code=200`，`Data.Count=112`。

完成适配后，实际调用本项目 `fetchOpportunitySource`，观察时间 `2026-10-17T02:08:08.946Z`（北京时间 10:08:08）：

| 项目 | 当次结果 |
| --- | --- |
| 关键词 | 后台 |
| 官网当次匹配总数 | 112（实时快照，后续可能变化） |
| 本次返回 | 100，`truncated=true` |
| 示例岗位 | 3D动作游戏《狩》-后台开发-UE5 DS后台开发 |
| 独立 PostId | `2059160518509379584` |
| RecruitPostId | `120228`；保留为招聘编号，不作为独立岗位去重键 |
| 官网明确地点 | CountryName=`中国`，LocationName=`北京` |
| 原始 LastUpdateTime | `2026年10月15日` |
| 原始发布时间 | 来源未提供 |
| 岗位原页 | `https://careers.tencent.com/jobdesc.html?postId=2059160518509379584` |

这 100 条中有 1 条 `PostURL` 指向腾讯自己的 Workday 租户：`https://tencent.wd1.myworkdayjobs.com/Tencent_Careers/job/China-Shenzhen/_R108057-2`。最初仅接受腾讯主站详情链接的实现因此明确失败；根据真实官网响应增加了**精确租户主机和路径**的链接许可后，完整 100 条预览成功。没有向 Workday 发起请求，也没有泛化为接受任意 ATS 主机。

官网 `jobdesc.html` 页面本次可返回 HTTP 200。搜索响应中的部分 `PostURL` 仍为 HTTP；仅对相同 `careers.tencent.com` 主机、`/jobdesc.html` 路径且 `postId` 一致的链接升级为同页 HTTPS。非官方、带凭据、异常端口或岗位号不符的链接明确失败。当前仅额外允许上文已观察到的腾讯 Workday HTTPS 租户和 `/Tencent_Careers/job/` 路径。

## 字段语义

- `PostId` 是本源独立岗位号；`Id=0` 不使用，可能覆盖多个发布的 `RecruitPostId` 不用于去重。
- `Responsibility` 仅作为**官网搜索结果的岗位职责摘录**。搜索接口可能不含完整任职要求，预览说明和收藏正文开头均提示打开原岗位核对，不能当作完整 JD 已采集。
- `LastUpdateTime` 只给日期，没有时分秒、时区。它在收藏正文中单独标为「来源最后更新日期（原文）」，**不写入原始发布日期，也不补 00:00 到精确 ISO 时间字段**。当前 `sourcePublishedAt`、`sourcePublishedText`、`sourceUpdatedAt` 均保持缺失。未来需要统一日精度字段时再扩展领域 Schema。
- 首次发现、本次采集和最近核验使用本次观察时间；核验方式为 `source-read`，不会显示为人工核验。
- 公司固定为腾讯；平台为腾讯招聘官网；发布主体为公司。详情／申请入口保留官网返回的原页或其精确 Workday 租户页；发现来源独立记录搜索 API。
- 国家与单个城市直接来自 `CountryName`／`LocationName`。国家精确等于「中国」时归国内；其他国家／地区仍待用户分类。多城市字符串保留在地点原文，不强行拆成一个城市，不从总部或公司名推断地点。
- `IsValid=true/false` 分别保留为开放／关闭，缺失则未知；工作方式、招聘类型、薪资、远程允许地区未披露时保持未知／空值。

## 源码参考与采用边界

路径发现与结构对照来自用户指定的 [career-ops 腾讯 adapter](https://github.com/career-ops-hq/career-ops/blob/55a51658d17332c23b1d5383bc093e0a17b5df9f/providers/tencent.mjs)，并通过腾讯官网真实响应重新确认。本项目独立实现受限入口和解析，没有复制上游分页爬取器、Agent、岗位库或申请逻辑。

特意没有沿用上游 `LastUpdateTime → postedAt` 的映射；刷新／更新不等于首次发布。公开可读的官网职位响应也不构成模板、字体、题库或全站内容可任意再分发的许可。

## 验证与剩余边界

- 定向机会来源测试 **13/13 通过**（原有 8 项加腾讯 5 项）：固定主机与一次请求、关键词编码／校验、100 条上限、真空结果与错误区别、精确官网链接和 Workday 租户、独立岗位号、地点与未知项、职责摘录、日精度更新时间和来源时间分离。
- 本轮服务端和预览组件 ESLint 通过；主任务负责最终全量检查与浏览器交互验收。
- 未登录腾讯账号、未采集个人数据、未提交申请；真实样本仅在终端读取，没有写入用户机会库。
- 尚无完整详情采集、分页、官网筛选枚举、持续刷新、旧新 JD 观察快照、关闭复核、去重归并或浏览器完整收藏路径验收。
- 腾讯官网可调整公开网页接口，本次 HTTP 200 证据不等于长期稳定或可用性承诺。其他国内企业和 BOSS／51job／猎聘／LinkedIn 没有因这次试点而完成接入验收。
