# ChatGPT 账号 Agent：实现与待授权验收

日期：2026-11-01。现有 `agent-os`，基于 `7135a43e3aab1afe2f9337cca8042ef5cf4bb3fb`。本轮未提交、未推送、未部署 Docker；不混入既有岗位采集改动。

## 接入范围与入口

正式 `ResumeWritingCopilot` 增加“伴写 Agent 来源 → ChatGPT 账号授权”，不是单独做一个替代产品的演示界面。用户连接账号后，主动选择此账号模型目录中展示的模型；项目理解、共识确认和单字段简历伴写共用此通道。其他顾问、岗位采集和 JD 匹配入口未在本轮迁移。

- OAuth 采用官方本机 public-client 协议：动态注册、稳定主机 ID、独立账号 profile、PKCE S256、随机 state/nonce、127.0.0.1 随机端口 `/auth/callback`。
- 已签名 ID Token 由 `jose` 验证 issuer / audience / expiry / nonce / subject。回调签名、身份或注册 ID 不符时不替换既有凭据。身份登录不等于套餐授权，缺少套餐 scope 时禁止推理。
- 凭据仅存 Agent Host 独立 `chatgpt/accounts.json`，不进入浏览器 localStorage、前端配置、简历、岗位数据库或理解会话。Unix 目录 0700 / 文件 0600，原子保存、拒绝目标符号链接和硬链接。未实现系统钥匙串加密；Windows ACL 没有在本轮实机验收。一个 Agent Host 应独占此凭据目录，不能让两个进程共享刷新令牌。
- 不读取或复制 Codex / CLI / ChatGPT 网页的登录文件、Cookie 或 Key；不创建 API Key，不把任何已有 Key 当作回退。
- 账号令牌刷新按 profile 串行，保留旋转后的 refresh token；临时故障保留凭据，终态刷新失效要求重新授权。断开时尝试远端撤销，再清除本机令牌；远端撤销未确认有明确提示，保留注册 ID 以供重新授权。

## 模型、额度和结果真实性

模型来自官方 `GET /v1/models` 的可展示目录，保留顺序，不猜测型号、不自动代选。每次生成前重新核对所选模型仍在目录内。生成使用同一账号的 `POST /v1/responses`，只发送支持的 `instructions` / 输入数组 / 模型以及 `store:false, stream:true`。

只接受 `response.completed` 完整终态。断流、不完整、服务异常、模型下架、权限不足、套餐资格和用量限制均明确区分；不把部分流当作候选、不自动重试生成或更换提供方。额度限制阻止后续套餐生成，用户查看用量后需主动解除并再次手动发送。由于未提供可靠的剩余额度/恢复时间接口，UI 只链接官方用量页，不显示估算余额、百分比或恢复倒计时。

项目理解仍走既有 EvidenceBroker、每轮授权、动态问题和版本化人工确认。GPT 不拥有本机 shell 或原生任意文件工具；授权范围不因换模型扩大。已确认共识只解释术语和项目边界；写简历时还需选择是否附带，不能成为个人贡献或效果数据的证据。候选仍经逐字来源 / 数字 / 贡献校验、本人核对和 CAS 采用；不会自动写简历。

UI 显示等待本人登录、校验回调、模型目录加载、未授权套餐、失效、额度受限和失败。正在提交或运行时锁住来源/账号/模型切换。停止、超时和错误保留补充及历史；改来源或账号模型会要求重新确认发送。轻量按钮反馈遵从减少动态效果，不制造假进度。

## 实际浏览器验证

独立 Web `127.0.0.1:5197`、Agent Host `127.0.0.1:5207`、MemorySaver 和临时文件目录。测试页复用正式 FactEditor、ResumePreview、ResumeWritingCopilot、ProjectUnderstandingPanel；文档仅在内存中，localStorage 与正常 5173 origin 隔离，不导入真实简历或岗位库。

| 实际操作 | 观察结果 |
| --- | --- |
| 选择 ChatGPT、选择虚构账号 | 不自动选模型；没有隐式模型调用 |
| 明确选模型、打开项目理解 | 本轮使用 ChatGPT，需单独勾选材料发送授权 |
| 第一轮 / 第二轮 | 动态问题、未预选选项和自由补充；对话历史 4 条，理解版本 4 待本人确认 |
| 核对并确认 | 版本 5 已确认；不证明个人贡献，简历原文仍为“参与 RCS 搬运项目。” |
| 回到伴写 | 单独核对本人补充、可选携带项目背景，生成带来源约束的可编辑候选；未核对候选前不可采用 |
| 注入 429 额度错误 | 保留完整补充、无候选、生成按钮禁用；只有明确手动恢复入口，不请求其他 API |
| 注入断流 | 明确未收到成功终态，拒绝部分建议，补充保留 |
| 刷新重开 | ChatGPT 来源保留，不自动换成 API；账号/模型需主动选择，共识恢复到版本 5、历史保留 |

上述是**真实浏览器 + 真实本地 HTTP + 签名有效的虚构 OpenID / 模型提供方**验收，不是实际 ChatGPT 账号或 GPT 模型质量验收。没有发送任何内容到 OpenAI；不能据此证明账号资格、真实模型目录、真实刷新/撤销或真实套餐生成成功。

忽略目录中的截图：`output/chatgpt-acceptance/candidate.png`、`quota-preserved.png`、`authorization-handoff.png`。日志：`full-tests.log` 和 `final-focused-tests.log`。

## 验证与边界

- 本地全量测试：3520 项，3510 通过、0 失败、10 项按既有开关跳过。测试过程中额外补的超时/取消/账号切换回归在最后定向中复验，不把重叠统计相加。
- 最后定向：全部 Agent Host tests，加 ChatGPT client、ProjectUnderstandingPanel、ResumeWritingCopilot，151/151 通过，0 失败、0 跳过。
- 全量 typecheck：13/13 任务通过；常规 ESLint 零警告通过，Web 生产构建成功；最终变更再做类型 / lint / diff 检查。
- 构建仍有既有地图 Node 内置模块外置及大分块提示，没有降低门禁或扩大到无关地图代码。
- 当前 Docker 打包未映射宿主机的随机 OAuth 回调端口，因此容器运行时明确禁用发起授权并说明需要本机 Agent Host，不能把“按钮能显示”当作 Docker 授权已接通。现有容器及服务没有重启。
- 真实 5173 页没有手动刷新、重置或切换配置；业务项目、真实简历、岗位数据以及现有岗位采集脏改动未操作。

## 当前停点：本人登录授权

已把隔离 Agent Host 换成**官方真实传输**、全新临时凭据目录，浏览器停在：

`http://127.0.0.1:5197/tests/ui-lab/chatgpt-plan.html?chatgpt=authorization`

页面顶部明确“官方 ChatGPT 通道 · 等待用户本人授权（未验证真实模型调用）”。初次交接时尚未点击 Continue with ChatGPT，不读取现有登录文件，不代填密码或处理验证码。

用户需自己点击 Continue with ChatGPT，在官方 `auth.openai.com` 完成登录与套餐授权。只有验证身份、scope、实际模型目录并通过一次完整生成后，才能把真实账号端到端标为通过。账号不符合资格或地区 / 策略拒绝时，应保持失败并告知用户，不能转付费 API、绕过限制或反复登录。

隔离启动：

```sh
# 故障/恢复验收；只使用虚构提供方，不联系 OpenAI
pnpm exec tsx apps/agent-host/tests/chatgpt-browser-host.ts
pnpm --filter @better-me/web exec vite --config tests/ui-lab/chatgpt-plan.config.ts

# 仅在停止上面自建测试 Host 后启动，等待用户自己授权
BETTER_ME_CHATGPT_BROWSER_MODE=authorization pnpm exec tsx apps/agent-host/tests/chatgpt-browser-host.ts
```

服务生成的临时授权目录要保持私有，不能将其中内容复制到报告或提交 Git。用户登录后勿重建 Host 目录，否则会建立另一个独立主机注册。

### 本人报告登录完成后的复核

2026-11-01 本轮实际核对，而不是沿用虚构提供方结果：

- 分支仍为 `agent-os`，HEAD 仍为 `7135a43e3aab1afe2f9337cca8042ef5cf4bb3fb`；5197/5207为交接时同一进程，没有重启或重建授权目录。
- 仅调用本地Host的公开安全状态接口：HTTP200、`profiles: []`、无 `attempt`、`automaticBillingFallback:false`。浏览器点击“刷新授权与模型”仍显示“尚未连接可用账号”。这只能证明本实例没有收到有效授权，不推断用户在其他窗口的登录情况。
- 排查顺序为：未从BetterMe发起、授权落在其他实例、官方授权准备失败、回调未完成。通过BetterMe点击Continue with ChatGPT，官方发现和授权准备成功，Host进入 `waiting`；新官方窗口位于 `https://auth.openai.com/log-in`，仍要求本人登录。未代填、未提交最终授权，也未绕过验证。
- 两个窗口及服务已保留交接，登录等待有10分钟期限，过期需用户从BetterMe重新发起。未读取OAuth凭据、Cookie或其他Agent登录文件；没有模型目录或生成请求，不能确认真实scope、资格、额度、可用型号或真实项目理解/共识/伴写成功。
- 本轮没有产品代码修复、没有重跑上轮测试套件，也没有提交/推送。只补充验收停点；业务项目、真实简历、岗位和其他未提交改动不动。

本轮停点截图仅在忽略目录：`output/chatgpt-acceptance/actual-authorization-pending.png`，不包含账号输入或授权参数。

## 官方依据与采用取舍

核对日期 2026-11-01：

- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [UI/UX guidelines](https://developers.openai.com/siwc/ui-ux-guidelines)

比较了官方 Sign-in DevKit。其仓库使用单独的 non-commercial 许可且示例工作区包并非直接发布的稳定 npm 依赖，因此没有搬入代码或改变 BetterMe 许可；按公开协议实现窄接口，JWT 签名验证采用维护中的 `jose`，不自行实现密码学。
