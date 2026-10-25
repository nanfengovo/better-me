# 高德 Web 服务 Key 与本机地址 provider

BetterMe 现在提供可选的高德 Web 服务地理编码 provider。它默认关闭，只能由本机服务在用户明确查询一条岗位办公地址时调用；没有 `BETTERME_AMAP_WEB_SERVICE_KEY` 时不会发出高德请求。Nominatim 和 Photon 仍可作为无 Key 的候选 provider，现有地图与私人岗位库继续保留。

没有高德 Key 时，可以先使用 Photon 做少量、明确触发的地址候选查询。它不提供批量岗位采集，也不会自动把候选保存为办公地点：

```powershell
$jobDataDirectory = Join-Path $env:LOCALAPPDATA "BetterMe/job-atlas"
pnpm --filter @better-me/job-service start --data-dir $jobDataDirectory --origin http://localhost:5173 --office-geocoder photon
```

Photon 和 Nominatim 都只在用户对具体岗位地址点击查询后发出单次请求；候选会保留 OSM/Photon 署名，必须核对岗位与完整办公地址后再确认保存。

准备好高德 Web 服务 Key 后，只在启动该本机服务的进程环境中设置它，再显式选择 provider：

```powershell
$env:BETTERME_AMAP_WEB_SERVICE_KEY = (Get-Content "C:\private\betterme-amap-key.txt" -Raw).Trim()
$jobDataDirectory = Join-Path $env:LOCALAPPDATA "BetterMe/job-atlas"
pnpm --filter @better-me/job-service start --data-dir $jobDataDirectory --origin http://localhost:5173 --office-geocoder amap
```

Key 只从宿主环境读取，不进入网页请求、岗位索引、候选出处、日志、README 或 Git。启动参数只安装 provider；网页仍必须输入具体地址并点击查询。高德返回的国内坐标原始为 GCJ-02，服务会在候选中保留 `originalCoordinates`，并生成用于现有 WGS84 地图的转换坐标；转换不代表高德或雇主确认了办公室位置。

## 申请步骤

1. 打开[高德开放平台](https://lbs.amap.com/)，注册或登录，按控制台要求完成开发者认证。选择与你实际用途相符的账号与认证类型。操作依据为[官方创建应用和 Key 教程](https://lbs.amap.com/api/webservice/create-project-and-key)。
2. 进入[控制台 Key 管理](https://console.amap.com/dev/key)，在“应用管理／我的应用”中新建应用，例如 `BetterMe 本机岗位地图`。控制台名称可能调整，以当前页面为准。
3. 在应用下“添加 Key”，服务平台选择 **Web 服务**。用于服务端地理编码的 Key 与浏览器的“Web 端（JS API）”是不同类型，本步骤选择前者。
4. 在“流量分析 → 配额管理”查看该 Key 的服务权限、可用地理编码接口与配额。个人／企业账号、认证及当前政策影响额度，本文不写固定免费次数；以[官方定价](https://lbs.amap.com/upgrade#price)和账号实际额度为准。官方教程没有统一的“激活地理编码”额外按钮，不需要寻找这类未列明步骤。
5. 将 Key 存入本机密码管理器或项目外的私有文件，勿发到聊天、GitHub Issue、README、截图或前端 `VITE_*` 环境变量。后续接入会由本机后台读取，网页和共享工具输入不携带 Key。

如启用 IP 白名单，应使用真正发出高德请求的服务器公网出口，`127.0.0.1` 不是公网出口；代理或更换网络会改变出口。具体配置以账号控制台为准。

## 接入前还需完成的部分

[高德地理编码文档](https://lbs.amap.com/api/webservice/guide/api/georegeo)说明请求、返回位置与地址级别。当前实现只接受高德声明为“门牌号”或“楼栋”、且有道路和门牌／楼栋字段的结果；城市、道路、兴趣点和行政区结果会被丢弃。坐标转换只满足地图显示契约，候选仍标记为未核实，必须先核对岗位原文与办公地点关联，再使用办公地址预览和明确确认流程。

[高德服务协议](https://lbs.amap.com/pages/terms/)对数据展示、缓存、存储及脱离本服务使用有约束。高德候选的缓存、展示和长期保存仍需按你的账号和当前条款核对；本实现不批量扫描岗位、不自动保存候选，也不把高德结果当作全市场地址覆盖。申请 Key 不等于获得招聘数据再分发或雇主办公关系证明。

当前仍可以使用原有“读取原岗位办公地点”保存有出处的来源地址；缺可靠办公点的岗位继续标为待核对。本次已完成的代码、真实地址范围及限制见[同岗可见地址与来源搬迁](reports/job-atlas-visible-office-evidence-2026-10-19.md)。
