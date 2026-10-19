# 同岗可见地址与来源搬迁 · 2026-10-19

本批继续解决岗位无法显示为具体办公室的问题，补上native可见地址来源和来源换址兼容。地图差量上传、相机运动暂停hover、手势后700ms恢复自转及空库两栏已由[上一批](job-atlas-detail-address-review-2026-10-19.md)交付；本批没有新增GPU帧率或最新页面目视验收。

## 完整可见地址独立于JD

JSON-LD地点继续使用V1，四平台原行为保持。新增V2仅支持已实证的Liepin结构：唯一已采用职责section下直接兄弟dl.paragraph，dt明确为工作地址或工作地点、dd唯一且完整可见。native projector独立检查CSS、布局、文本范围和原有全页门禁；隐藏、透明、裁剪、ellipsis、line-clamp、特殊布局或不完整地址不成为sidecar，不从原始DOM补尾文。既有会使整个JD失败的全页gate/text-range语义仍保持。

sidecar不进入JD HTML。BrowserSnapshot限制平台、正式单岗URL、导航前后一致、数量和严格字段，native capture保留原文档、generation/root和adoption重查。extractor只在明确native标记、同岗来源、唯一职责owner、已接受正文与有意义主标题下采用。稳定等待同时绑定JD和地址，capturedAt不影响稳定key，地址在同正文下变化仍重计800ms。

V2保存规范原句与label/selector JSON证据，字段和逐项索引须重放一致。没有结构化行政字段就不推country/city/region/postal，不产生坐标；只有清晰道路门牌或明确楼宇编号才产生street。完全远程、无需到岗、明确总部地址/注册地址或仅供参考等披露拒绝，普通“总部工作/总部办公室”不凭词语误删。V1拒绝可见证据；V2不混合两种地点证据，结构化冲突不任取一条。JSON-LD只有城市、可见DD有门牌时，本批保守省略不凑地址；后续需要可重放的多证据契约。

预览/import复用既有工具，绑定原listing/同岗/版本/指纹/时间和耐久幂等回执，只有selector/quote进入领域evidence；完整capture仍在原观察。JD、薪资、公司和其他listing贡献保持。V2不继承旧卡片行政字段/覆盖，保存可能退出原筛选；reader仍可继续处理，不为了筛选可见性伪造地址。

## 来源搬迁与永久失效

旧投影只按raw/country/region/city建位置ID，同label街道或邮编改变时原实现会报source-changed。新规则保留无地址legacy ID兼容，在明确冲突时以实际新字段建立新身份，不将未披露街道/邮编从旧办公室拼来。搬迁后稀疏响应优先当前listing地点，不回到历史legacy街址；同label多办公室保持各自贡献，证据不足不任选一个。

真实Ashby parser→source projection→SQLite回归覆盖原label不变的A→B→A、已确认address-ID B→C→同B ID、另一来源贡献、幂等、重开与V4备份恢复。来源变化在同revision持久失效旧办公确认，历史地址恢复也不会自动复活旧坐标。

## 本机真实地址与匹配

国内静态读取首次失败因为原配置本地17891代理停止；恢复既有本机helper后，原同岗链接成功返回V1 JSON-LD。其后在当前国内C#计划内排除已读岗，串行最多5个未读Liepin原canonicalURL、间隔2.1秒，5/5成功，单次约0.28–0.52秒，总10.36秒含间隔。没有遇到登录/验证或更换URL，没有浏览器读取或猜接口。LinkedIn先前静态读到正文但未披露地址。有限6岗不代表其他来源或所有页面可读取。

完整SQLite V4备份、快检、原同岗身份/证据检查后，6份V1来源地址分别通过原preview/import保存，真实89岗revision67→73；6个当前引用地点有source street字段，但只有2条含道路编号，其余是楼宇/企业称呼，不称6份完整门牌。预览不写，保存保留原JD/snapshots/薪资/公司/来源及其他岗位事实；没有写人工办公坐标。原sourcePublishedAt保留，不把读取时间当岗位发布。

对2条道路地址明确提交原地址与上海市约束查询，认证HTTP均200，耗时约2.34/2.71秒，结果均no-address-match、0候选，未写坐标。当前免费Nominatim国内覆盖仍不足，不能把连通、street字段或城市分布称为实际办公点。

原5178在新的完整备份与owner/idle检查后更新为本批源码；89岗/revision73、V4、dataset/token哈希、quick_check/外键与无running保持。C#全球52/36企业、国内26/22、上海25/21、浦东7/6、松江3/2保持，mapped均0。所有原始页面响应、URL细节、数据库、token、备份和实证留在Git忽略的本机目录。

## 验证与发布

18文件最终冻结树`caf30cd10b6d0bcd4ad431bd5888ecbf216e691c`，离线frozen安装、memory、types10、lint、全量2504/2504和build6通过；fail/cancelled/skipped/todo均0。独立快照排除并行Career Agent/package/lock改动。相关native projector三文件219、投影45、后端20均为各阶段范围，不能与全量相加。

已按功能推送`28840e5`（来源换址）和`a21fc4a`（可见地址链路）；远端Actions及公开资源最终状态另补记录。浏览器URL策略拒绝后没有改浏览器、换地址、CDP或其他方式绕过，最新布局/GPU实测仍未完成。合成页不是私人索引，原图的零岗位不能解释为实际89岗已全部消失。

当前剩余：所有真实岗位办公点、可靠国内地址服务、更多平台可见地址、官网精确同岗read-detail与保存、多证据组合和规模交互实测。完整统一岗位地图目标仍active。
## 后续真实来源覆盖与 Key 准备

在相同国内C#计划的19个Liepin目标中，剩余13条原canonicalURL继续静态串行读取，全部HTTP200且capture严格通过，间隔2.1秒，约29.7秒；前后dataset value完整hash相同，HTTP envelope仅requestId不同。没有浏览器、地理编码或写入。逐一复核后12条进一步经preview/import保存；另1条虽然源字段叫streetAddress，实际只含上海/区县文字，未把它作为具体办公地址采用。

最终本机仍89岗，revision85，18个当前引用来源地点有street字段，9条含道路编号；原JD/snapshots/薪资/公司/来源等保持。来源字段含楼宇/公司名称不意味着完整门牌，办公确认和映射office仍0。新最终检查再次验证V4、quick_check、外键、token、无running以及五组原查询计数不变，没有新增地址服务调用。原两次0匹配结论保持，不能说18岗已完成地图精确定位。

产品`a21fc4a`的[Actions39214993602](https://github.com/nanfengovo/better-me/actions/runs/39214993602)中Windows质量、Linux构建、Docker运行和Pages部署四任务均success；前一来源换址批同样通过。文档`321a110`另发。公共资源HTTP检查与编译代码核对不等于最新页面目视或GPU验收。

用户选择没有高德Key、需要配置步骤，新增[申请与准备说明](../amap-setup.md)，官方教程明确创建应用后选择Web服务Key，实际额度查控制台；未登录或替用户开通付费。当前程序仍只有Nominatim，尚无高德配置入口/启动参数。高德坐标不能直接当WGS84，官方存储/展示范围也需确认具体组合；没有将自行逆算坐标、落库到现有MapLibre描述为已接通。Key保管、服务接入、源地址匹配和办公关联分别完成。
