# ABB sitemap-index 有界真实探测

日期：2026-10-25（UTC）  
状态：只读探测；没有注册、启用或写入本机岗位索引。

## 目的

验证 `jobposting-jsonld@1` 新增的 sitemap-index 路径能够读取一个真实企业官网的根索引、同源叶子 sitemap 和岗位页，并把结果保持在受限的来源工具边界内。探测使用目录中的 `abb-official-structured-jobs` 配置，但临时绕过了目录的 `needs-review` 状态，仅用于本次验证；配置本身仍然是禁用、待审核。

## 证据

- `https://careers.abb/robots.txt` 返回 HTTP 200，并声明 `https://careers.abb/global/en/sitemap_index.xml`。
- 根索引返回 HTTP 200，列出 5 个同源叶子清单：`sitemap1.xml` 到 `sitemap5.xml`。
- 受控适配器共执行 9 次 GET：根索引 1 次、叶子清单 5 次、岗位详情 3 次；响应累计约 1,136,245 字节。
- 首页详情尝试返回 3 条真实 JobPosting JSON-LD：
  - `C#/.NET Software Developer`，ABB，Ostrava，Czechia，邮编 `703 00`。
  - `Senior Software Engineer (m/f/d) – MES`，ABB，Mannheim，Germany，邮编 `68309`。
  - `嵌线操作工`，ABB，Shanghai，China，邮编 `200023`。
- 三条记录均保留官网原始岗位 URL 和结构化地点证据；本次样本没有门牌街道或坐标字段。
- 根索引共暴露 2,157 个候选 URL，但本次只读取了 3 个详情，结果仍有后续队列，不能称 ABB 全量、全球市场或在招状态已核实。

## 边界

根索引只允许同源 HTTPS 叶子清单；跨域、嵌套索引、不可读响应和预算耗尽会保持 partial。sitemap URL 只是候选页面，只有岗位页的有效 JobPosting JSON-LD 才能形成来源记录。城市、地区和邮编是招聘页披露的地点字段，不自动变成办公坐标、门牌地址、距离或控股方证据。

本次探测没有调用地址地理编码、没有确认办公地点、没有启用 ABB 来源、没有修改 SQLite，也没有改变 5173/5178 进程。要进入真实工作台，仍需本人核对来源条款、在来源面板明确保存并手动刷新；每次刷新仍受 `maxRecords`、`maxPages`、请求和字节预算限制。

