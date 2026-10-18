# 功能分批发布记录 · 2026-10-18

用户要求按功能分多批推送GitHub。沿用 [nanfengovo/better-me](https://github.com/nanfengovo/better-me) 的 `main`，已有两笔提交先推送，再将累计改动拆成九批代码与一批文档；正常push，不改写历史。

## 已推送功能批次

此前已有的 `94c5a5e`（工作室升级/自动保存/预览）和 `ff67cdd`（验收与交接）已先推送。新增代码如下，每行是一笔提交并单独push：

| 批次 | 功能范围 | 提交 | 暂存快照相关测试 |
| --- | --- | --- | --- |
| 1 | 界面语言/主题与共享依赖基础 | [e2b6291](https://github.com/nanfengovo/better-me/commit/e2b6291) | 7/7 |
| 2 | 网络代理配置、分站点路线和连接检查 | [b8f447a](https://github.com/nanfengovo/better-me/commit/b8f447a) | 23/23 |
| 3 | 岗位浏览器读取、来源与可恢复会话 | [1ec1d81](https://github.com/nanfengovo/better-me/commit/1ec1d81) | 799/799 |
| 4 | 简历导入、PDF分行与AI规范化及来源核对 | [1d59e21](https://github.com/nanfengovo/better-me/commit/1d59e21) | 63/63 |
| 5 | AI端点与个人匹配依据约束 | [5cd3034](https://github.com/nanfengovo/better-me/commit/5cd3034) | 49/49 |
| 6 | 高亮格式数据、Markdown/DOCX/RenderCV导出 | [d667d61](https://github.com/nanfengovo/better-me/commit/d667d61) | 30/30 |
| 7 | 历史差异逐项恢复与草稿保护 | [198a7af](https://github.com/nanfengovo/better-me/commit/198a7af) | 40/40 |
| 8 | 机会跟进、多简历与资料工作台 | [ab99fb0](https://github.com/nanfengovo/better-me/commit/ab99fb0) | 16/16 |
| 9 | 工作台集成、修改指引和可视高亮色板 | [5268015](https://github.com/nanfengovo/better-me/commit/5268015) | 72/72 |

第10批为本记录、README、规划/调研、验收报告和项目续聊文档。具体提交号由Git历史给出，避免在正文中自引用尚未生成的提交散列。

## 验证方法与结果

每批先明确路径暂存，再通过checkout-index导出“前序提交＋本批暂存内容”的独立快照；workspace的core/storage解析到快照内源码。依次编译core、storage、Web和服务端四份TypeScript配置并运行本批相关测试，全部通过后提交与push。共享App及有必填props变更的组件保留到集成批次。导入原文差异测试发现依赖尚未交付的历史模块后，移到字段恢复批次执行并通过；没有删减断言或拿最终工作区代替中间版本验证。

最终源码全量验证：

- `pnpm test`：1192/1192通过，失败/取消/跳过/todo均0。
- `pnpm lint`：通过，无错误或警告。
- `pnpm typecheck`：5/5成功。
- `pnpm build`：3/3成功，Web重新构建；core/storage复用刚完成的类型阶段构建缓存。
- 保留既有minified chunk超过500kB提示；主JS807.89kB、导入chunk852.98kB、CSS152.29kB。
- 每批暂存格式检查通过；源码只额外整理了一处测试末尾空行，无业务行为修改。

完整测试、构建及批次快照收据保留本地忽略目录/本地验收产物中，未公开机器路径。全量浏览器测试使用隔离临时上下文及合成响应拦截，native/persistent用注入fake或临时夹具；不把这次回归称为新的招聘网站实测。

## 公开范围与边界

API Key、私人求职SSOT、data/、环境文件、简历及机会导出、浏览器profile和运行日志均未纳入。本轮补充英文`*-source.txt`忽略规则。15份原始公开候选文档先逐字节归档，公开版去掉本机用户名、PID/SID/handle与出口切换流水；项目记忆原版也保留本地，进度改为当前交付/待办索引。

功能报告仍区分已通过、历史失败和未验证内容：真实四岗通过仅代表指定样本；Google官方mTLS模型列表成功不能代表Chrome Gemini网页、生成或视觉成功；PDF/DOCX逐页视觉、更多岗位长期覆盖与本人材料匹配另验。受管招聘网络仍为本机适配，克隆或换机不会自动通过核验。

本轮未重启原工作台、切换系统代理、访问新的招聘岗位或操作私人简历。后续工作从当前main继续，先核对工作区与远端状态。
