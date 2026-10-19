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
