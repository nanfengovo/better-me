# M2 离线地理候选与证据

日期：2026-10-18。已实现纯领域 Schema、离线 provider 和实际候选工具；尚未接入岗位位置写入、HTTP/UI 确认或家庭位置设置。此报告不表示整体 M2、三维地图或系统联动已经完成。

`packages/opportunities/src/geocoding.ts` 提供版本化 Gazetteer / Request / Candidate / Result / Selection 契约。`acceptGeocodingCandidate(result, id)` 只能接受本次返回的候选，产生显式选择 proposal，不修改任何 JobLocation、Listing 或私人事实。候选始终为城市级估算与未核实办公室位置，即便只有一个精确名称结果，也不自动选中。

`packages/source-adapters/src/geocoding.ts` 提供 `GeocodingProvider`、可注入加载器的 `createGazetteerProvider`、可信 host 选择固定 manifest 路径的 `createLocalGazetteerProvider`，以及实际 `locations.geocode-candidates` 工具。当前 provider 完全离线、按国家分片加载并缓存，不自动逐岗执行；工具的 effect 根据 provider.offline 分别为 read-index / external-read，未来外部 provider 不能沿用本地只读权限。当前未实现或调用在线 provider。

查询保留原文，默认仅按 Unicode NFKC 名称或数据自带别名精确匹配；前缀候选必须显式允许。国家代码 / 来源行政代码 / 地理 bounds 是硬范围，countryBias 只排序，不消除同名歧义。支持日期变更线范围。原始主国家／地区代码及 alternate-country codes 均保留，产品显示区域由调用方配置，不能把主码重写成 UI 分组。remote-region / unknown 返回不适用且不加载数据，不能把远程资格区域或总部当办公室。

实际公开数据为 [GeoNames cities15000](https://download.geonames.org/export/dump/cities15000.zip)，原 [数据说明](https://download.geonames.org/export/dump/readme.txt) 明确 CC BY 4.0 和 WGS84。本次下载 3,361,901 字节，SHA-256 `7d1c80d5be04850227384c1f6f9163b56401dc46270be1012e1a2de0a5bf4a70`。固定版本 `geonames-cities15000-7d1c80d5be048502` 包含 34,167 个聚居地、244 个原国家／地区代码。上海／北京市／香港等中文别名实际存在；没有手写城市偏好或翻译别名。

数据放在 `config/geography/gazetteer`，保留原说明、完整 CC BY 4.0 法律 HTML、下载元数据与 NOTICE。244 份确定性 gzip JSON 共 3,967,775 字节，展开共 19,311,872 字节；manifest SHA-256 `51c1a172eb87ed2041788850690e68e4f8379fc49d2b4f807f7a4b92b90acc45`。manifest 记录每片压缩 hash、压缩 / 展开大小与数量，provider 在返回候选前逐项校验，并拒绝非 WGS84、损坏 UTF-8 / JSON、重复身份和范围不符的结果。数据不导入 React 包。

`scripts/build-geonames-gazetteer.py` 从明确的本地 archive 和下载元数据重建，不自行联网；原 archive hash 不符时拒绝。保留 GeoNames 原始名字、别名、国家 / 行政代码、来源修改日期和代表点，没有 GCJ-02 / BD-09 转换、街道 / 门牌精度、通勤估算或地理位置真伪核验。城市参考点只支持估算地图落点与显式允许后的估算直线距离。

定向自动验收涵盖领域语义约束、同名歧义、国家偏好与硬范围、原代码保留、Unicode / 前缀边界、远程不适用、跨日期变更线、缓存隔离、取消、压缩 hash / 展开限制、非 WGS84 拒绝、实际工具权限与 JSON 往返；另外真实读取并校验全部 244 个分片，用中文别名和跨地区 Springfield 同名记录验证。两包 typecheck 与定向 ESLint 通过。测试计数以主任务最终命令输出为准，单独测试不能代替 UI、雇主地址精度或大规模岗位性能验收。

没有读取家庭地址、用户资料或密钥，没有调用 Nominatim、地图地理编码接口或自动批量网络查询。城市库的有限覆盖不等于全球完整地址服务；无匹配应保留未解析，有歧义应展示候选，后续接线仍须显式确认和版本检查。
