# Greenhouse 办公室地址与 Hudl 真实样本验收

日期：2026-10-25

## 结论

Greenhouse 职位列表中的 `offices` 字段可以提供比岗位卡片地点更细的地址，但不能默认套用到岗位。适配器现在仅在一个明确办公室采用受支持的美国地址格式，且岗位列表地点的城市、州和国家全部吻合时，才把街址作为该岗位来源地点。无法建立关联的办公室文本留在独立的未关联证据字段中，不进入地点、地图或距离计算。多办公室、地点缺失、远程／全国范围、国家或城市／州不匹配及未支持的国际地址语法都不会被自动关联。

## Hudl 官方样本

通过受控 Greenhouse 适配器对 Hudl board 做了一次只读 GET，时间为 `2026-10-25T14:39:40Z`。读取 425,553 字节，返回 36 条记录，没有写入或注册来源。目标岗位为 [Account Executive - Club & Youth Sports](https://job-boards.greenhouse.io/hudl/jobs/8274728)，来源 ID `8274728`。

- 岗位列表地点：`Lincoln, NE, United States`
- 同一记录 `offices[0].location`：`600 P Street, Lincoln, NE, United States`
- 来源岗位链接保留为原始 HTTPS 链接
- 适配器结构化地点：城市 `Lincoln`、州 `NE`、国家 `US`、街址 `600 P Street`
- 街址证据 selector：`jobs[0].offices[0].location`

美国格式测试也覆盖了 `600 P Street, Suite 4, Lincoln, NE 68508, United States`，确保套间保留在街址内，邮编不误作城市或州。状态、公司占用情况和办公点坐标不会由 Greenhouse 地址解析推断。

## 单地址 Photon 查询

只对上述 Hudl 来源披露的街址执行了一次明确的 Photon 地理编码 GET，时间为 `2026-10-25T14:40:45Z`，读取 2,158 字节。provider 返回 4 个估算、待核实的楼宇级候选：3 个将 `600 P Street` 规范为 `P Street 600`、城市 Lincoln、邮编 `68508`；另 1 个是相邻的 `600 Q Street`，属于错误街道候选。三个 P Street 候选给出不同的 OSM node/way 与坐标，provider 也未给出可用于结构化核对的州字段。

这次请求只查询该单一地址，没有自动选择、确认或保存任何候选，也没有写入岗位服务、地图索引或私人 SQLite。候选数量和街道／邮编相符不能证明 Hudl 目前在此办公，亦不能唯一确定楼宇入口或建筑内部位置；真实办公坐标仍未验收。最终确认仍须由用户核对候选地图位置和来源地址，再通过现有预览与明确保存流程。

## 验证与后续

- Greenhouse adapter 定向测试：10/10；source-adapters 全量测试：440/440。
- `@better-me/source-adapters` typecheck、目标 ESLint、job-service 地址 provider 精度测试 16/16 通过。
- BOSS 官方详情页样本：用户确认暂时没有，故 BOSS 办公地址读取仍未验收；没有添加猜测性 selector。
- 真实岗位索引仍维持此前观察值：89 个岗位，0 个带坐标。5173／5178 和现有数据目录未重启或写入。

下一步需要用户在地址核对面板中审查并选定或拒绝 Hudl 的估算候选；若没有明确选择，继续保留来源街址但不画办公室点、不参与距离排序。BOSS 链路则待有官方详情页样本后再做实站验收。
