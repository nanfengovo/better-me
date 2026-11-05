# 旧资料恢复核对与统一鉴权接入停点 · 2026-11-03

## 当前结论

已找到旧简历与 Agent 资料，已制作仓库外独立副本并通过指纹和当前项目 schema 校验；**未执行归属认领、迁移、导入或覆盖**。用户要求先确认归属，当前账号与旧资料之间尚缺本人确认。统一鉴权尚未选定平台、配置或实现，不将方案调研记成已接通。

本报告仅记录脱敏数量和流程。真实姓名、机构、账号 ID、会话内容、文件指纹清单和导出文件仅保存在本机私有恢复目录，不进入 Git。

## 已验证证据

| 类别 | 当前只读核对结果 | 恢复边界 |
| --- | --- | --- |
| 原 Chrome `localhost:5173` 旧主文档 | 4 段经历、31 条要点；正式保存、IndexedDB 草稿和一条历史快照通过 DocumentSchema，规范化后内容相同 | 建议作为主恢复候选，仍需本人确认 |
| 旧版本与其他 origin | localhost 的较早 localStorage 草稿、127.0.0.1 的正式文档/草稿均可解析，且与主候选不同；另有示例前稿 | 各自保留，不跨 origin 自动覆盖或按保存时间盲选 |
| 浏览器统一 Agent | 23 条消息、1 条记忆、1 项已完成任务，AgentStateSchema 通过 | 记忆链接到下列已确认会话；不是另加 23 条独立消息 |
| Host 项目理解 | 2 份 UnderstandingSessionSchema 通过：已确认 revision 43 / 23 条消息；较早 error revision 27 / 10 条消息 | 原 session 与浏览器指针需共同处理；旧资料仍无账号归属 |
| Host 旧 Run | 1 个目录、6 个文件已复制并核对字节指纹 | 不执行、不视为可自动恢复的任务 |
| Checkpoint | SQLite 独立备份 integrity_check=ok；92 行 checkpoint / 23 个 thread / 208 行 writes | thread 数量不是对话数；尚未完成每个 thread 的归属核对 |
| 当前账号 | 原页面已登录一个本机账号，当前简历仍是示例；目标账号草稿已单独导出保护 | 登录状态不构成认领所有旧资料的授权 |

## 私有备份与校验

恢复根目录位于本机 BetterMe 数据目录的 `recovery/2026-11-03-pre-migration-ZFu31M/`，不是应用正在读取的 owner 目录：

- `manifest.json`：原理解会话、Run、localhost IndexedDB 与 blob 的 17 个文件副本指纹，以及 SQLite 一致性备份信息。
- `browser-extracted/manifest.json`：20 条选择性浏览器导出记录的来源、键、序号、指纹与核对元信息。
- `validation.json`：8 份文档表示、1 份 Agent 状态、2 份完整理解会话的当前 schema 校验；17 个原文件与副本指纹均再次一致，SQLite 副本指纹一致。
- 新目录权限 0700，备份及导出文件权限 0600；写入新文件采用排他创建。未覆盖源记录、旧备份或当前账号资料。

SQLite 使用只读源连接的 `.backup`，再对独立副本使用只读 immutable 校验；没有将 live WAL 数据库当作 immutable 打开。浏览器 LevelDB 使用固定版本的只读离线解析器读取；IndexedDB 解析在已核对的副本上进行。localStorage 是多站点共享物理库，仅在 origin 和 BetterMe 键白名单筛选后解码、导出，未复制整库。原 localhost IndexedDB 物理副本包含同 origin 的其他 store，但应用级提取仅选择简历/草稿/版本/Agent，不导入扩展或岗位 store。

模型 Key、ChatGPT 授权、账号密码摘要、Cookie 与其他站点记录未选择性导出或迁移。未打开、重解析或修改原简历 PDF；已恢复的结构化文档优先于重新导入 PDF。原浏览器未刷新、重登、导入或保存，核对后返回原资料库视图，自动保存仍关闭；正常服务、模型选择和付费通道未更改。

一次性核对脚本与独立 Python 工具环境位于被忽略的 `output/recovery/`，不改变项目依赖或 lockfile。解析器为 [ccl_chromium_reader](https://github.com/cclgroupltd/ccl_chromium_reader) 的 MIT 版本，固定 commit `ad37443541dd91dac3ac1fb2eecaeb8693f36815`；它仅用于本机恢复核对，不是产品依赖。

## 迁移的确认门槛与验收

1. 本人确认私有清单中的姓名/经历/项目资料归属，并明确当前已登录账号为目标。确认前保持 `validated-not-migrated`。
2. 实际迁移前重新备份当前目标文档、草稿、版本、Agent 和服务端 owner 数据；核对目标账号与源指纹未发生变化。有并发变化则停止并重新预览，不覆盖。
3. 使用新增恢复文档/恢复档案保留原 documentId 与关联关系，保持当前文档可返回；不能以现有单一文档的“恢复备份”替换路径冒充追加合并。其他 origin、旧草稿和历史各自保留，不自动混合事实或合并示例。
4. Agent 保留消息和来源映射；同一会话的统一索引与完整记录去重关联，冲突时保留两份并生成回执。原始备份完整保留；可复用记忆与历史归档分开，文件授权重新确认，凭据不复制，旧任务不自动重跑。
5. 所有写入经已认证 owner 与 revision/CAS 校验，迁移事务有 manifest 和幂等标识；失败可回退到迁移前指针，原档及当前数据仍保留。不能通过直接向共享目录复制整库绕过 owner。
6. 在独立合成数据中覆盖重复执行、同 ID 冲突、切换账号、A→B→A、两个窗口、并发任务、迟到 HTTP/SSE 与失败回滚；正式数据只做已确认范围的迁移及只读回查，不向模型发送。

以上是待实施要求，不是本轮已完成的迁移验收。全局 checkpoint 的逐 thread 归属仍待核对，不整体认领到新账号。

## 统一鉴权接入建议（待用户选定）

BetterMe 作为标准 OIDC 客户端，QQ、微信、邮箱、手机号由一个 IdP 管理。外部身份 `(issuer, subject)` 映射到稳定内部 owner ID；给当前账号绑定登录方式后沿用原 owner，不能按 QQ 昵称、邮箱或手机号直接替换数据归属。账号绑定需同时证明当前账号和外部身份控制权；不自动按未验证联系信息合并。

优先建议可自部署的 [Casdoor](https://github.com/casdoor/casdoor)，官方有 [QQ](https://casdoor.ai/docs/provider/oauth/Tencent/)、[微信](https://casdoor.ai/docs/provider/oauth/Wechat/)、[邮箱](https://casdoor.ai/docs/category/email/)与[短信](https://casdoor.ai/docs/category/sms/)接入说明。若用户已有托管平台，可改接其 OIDC；[Authing 社会化身份源](https://docs.authing.cn/v2/guides/connections/social.html)与[注册登录](https://docs.authing.cn/v2/tenant/login-register.html)也覆盖这些方向，实际权益和费用需按当前平台配置核对。本轮未选择云托管、创建外部应用、发送短信或部署平台。

生产前需用户确定平台/部署方式、issuer、client、回调域名及官方渠道应用；QQ 与微信需要开发者应用配置，微信 PC 扫码和微信内网页授权是不同场景，邮箱和短信需要发送服务。密钥通过安全本地配置提供，不要求在聊天中粘贴。

实现门槛：服务端完成授权码 + PKCE、state/nonce、issuer/audience/签名/有效期验证，安全会话 Cookie、登出/吊销、限速和显式绑定审计。保留现有本机救援登录，直到新鉴权与原 owner 绑定验收通过；旧本机密码不直接同步至 IdP。简历与 Agent 内容保持现有本地持久化，不因接入 IdP 默认上传。

收尾：本轮仅私有恢复产物、脱敏报告和项目交接记录；没有产品源码、模型配置、身份服务或数据迁移实现变更，没有暂存、提交、推送或 Docker 更新。

本轮核对脚本通过；`pnpm memory:check` 与 `git diff --check` 通过。开始时已有的98个脏文件中，仅按交接要求追加了activeContext/progress，其余96个指纹不变、无文件丢失；HEAD/agent-os不变、暂存为空。私有恢复目录42个产物的文件/目录权限全部符合0600/0700。未重跑产品全量测试，不引用历史测试数量作为本轮接入或迁移成功的证据。
