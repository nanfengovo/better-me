# 履历盘点：把“按住说话”接到本人的回答

2026-11-14 · 本机 macOS 工作区，延续[四段式倒序盘点](career-inventory-2026-11-14.md)。这不是通话录音、实时会议转写，也不是默认向模型开放整份履历。

## 使用与保存

在简历工作室点「盘点履历 → 开始盘点」，或在导入后选「一起盘点最近的变化」。不想说时照常打字。需要语音时：

1. 「准备本机语音输入」仅载入本站自带的离线组件，不碰麦克风。浏览器需要安全上下文（HTTPS 或受信任的本机回环地址）。
2. 按住按钮（也可用空格或回车）才申请音频输入；松手立即停轨，单段最多 30 秒。未取得许可就松手，迟到的音轨也必须停止。离开页面、窗口失焦、账号失效或退出当前题均会取消采集。失败后可继续打字，不换用云听写。
3. 在「核对本次转写」里修改或丢弃识别出来的字；「填入回答」只追加到这道题里，保留既有手打文字。模型追问也可口述补充，不覆盖先前回答，不触发第二次推理。合并后超出 7,000 字会提示缩短，不静默裁掉任何一句。
4. 「保存回答并继续」才把核对过的回答放进账号的盘点草稿；共识卡上另行勾选并确认，才影响工作画像或选材。原始声音不进 Host、业务数据库、备份或正式简历。不把模型转写当作用户已确认的事实。

## 如何离线工作

采用[浏览器版 Vosk](https://github.com/lichess-org/vosk-browser) 0.0.8 与 [Alpha Cephei 普通话小模型](https://alphacephei.com/vosk/models) 0.22，两项随 Web/桌面资源分发；第一次准备读取约 47.4 MiB 压缩资源。此后浏览器可缓存公开模型文件；不缓存录音。无 API Key、CDN 脚本或浏览器云听写依赖。只延迟加载，不增加普通简历页面的首屏模型流量。

- 音频在当前窗口由 AudioWorklet 转 16 kHz 单声道，交给本地 WASM Worker，不回放到扬声器。松手先停麦，再处理已采集末包；普通识别结果和最终结果在上游用同一种消息，因此必须等末包及先前采样的响应全部返回，再索取最终文本。部分结果不当作本人回答。退出时终止该题的专用 Worker。
- Electron 的许可限当前聚焦的工作区顶层窗口、精确的回环来源、单次按住和仅音频请求；新的按住需重新取得许可，摄像头、屏幕、其他来源和子框架没有随之获得许可。没有改动系统隐私设置。桌面系统权限对话框的表现与设备/操作系统有关。
- 上游压缩包和 npm 完整性固定；模型仅重打包，文件内容不变。`scripts/pack-inventory-speech.py` 可从固定输入在空目录离线复现。发布资源的 SHA-256、上游署名及许可证随资源见 `apps/web/public/speech/vosk-cn-v1/NOTICE.txt`。

## 可复验路径

- `node --import tsx --test apps/web/tests/inventory-speech-assets.test.ts apps/web/tests/career-inventory.test.ts apps/agent-host/tests/career-inventory.test.ts apps/agent-host/tests/career-inventory-http.test.ts` 核对资源本体、画像隔离、用途及保存协议；`pnpm test:desktop` 包含单次音频许可正常/负例。
- `pnpm desktop:build` 后运行 `node --import tsx apps/agent-host/scripts/verify-inventory-ui.ts --dictation`；加 `--installed` 使用已同步的本机 BetterMe.app 主程序、preload 和界面，`--native-only` 可只验桌面。隔离壳使用项目的 Electron 45.2.3，不是用日常安装壳的 Electron 34.2.0 完成真实录音。脚本仅在 macOS 用系统中文声音合成原创句子，使用隔离账号、浏览器/窗口和回环服务。Web 用文件虚拟麦克风；在原生沙箱窗口内先验证未授权拒绝、正式许可通过，再从 MediaStream 输入节点注入同一句合成 PCM。两端均使用真正的 AudioWorklet、WASM 识别器与确认界面，不预设转写内容。
- 桌面测试这样分层，是因为在本机沙箱中用临时路径直接模拟 WAV 时，实测麦克风返回连续静音；同一份 WAV 在 Chrome 与直接输入识别器均有信号。[Chromium 上游记录](https://chromium.googlesource.com/chromium/src.git/+/167f34ae932ed8f702d9127339acbff246b4eb47)也描述了沙箱路径不可读会造成该现象。没有因此关闭桌面沙箱，不把这项测试当作真实硬件验收。

## 验收结果与回退

- 最终已安装资源同轮 Web → Electron 验收退出 0。对同一句原创合成音频，Web 候选为“我只设计了从事是流程没有上线”，Electron 候选为“我只设计了重是流程没有上线”，原句是“我只设计了重试流程，没有上线。”两端都保住否定、都错了术语，不能把候选直接当事实。两端实测丢弃/关闭不产生盘点写请求；修正后只追加、明确保存并在共识卡选中后，生成的策略显示修正文字；实际下载的普通简历备份及其公开投影未变。Web 另验拒绝、迟到许可和模型追问的独立语音补充。整轮语言模型替身 1 次（独立点击同意追问后），真实外部推理 0；浏览器拦截非允许来源请求 6 次。运行回执 `/private/tmp/betterme-inventory-voice.YfdHuEwS/acceptance.log`，界面截图 `/private/var/folders/hj/dq9kl7md40l2hhdwppqsbc_r0000gn/T/betterme-inventory-qa-zMwbve/captures`。
- 盘点/资源定向 7/7，桌面 23/23，类型检查 16/16，构建 9/9，lint 零警告。完整 `pnpm test` 的普通部分 4,947 项（4,927 通过、20 跳过、0 失败）；独立简历质量套件首跑 63/64，“观察截止后保留原 ID”用例断言 0≠1，导致该次全量命令非零。未更改这项测试或业务代码，单独重跑整个 `pnpm test:resume-quality` 为 64/64。资源完整性用例在全量启动后新增，已单独通过，不冒称包含在 4,947 项中。
- 已同步相邻源码绑定 BetterMe.app，626 个文件，整树 SHA-256 `261ff0eea21952baa735092ade9ee06b4aeadaf4537bc245e2b79be8949b62e4`，上一版完整保留在应用旁 `.unified-agent-app-CuNzGE/previous-dist`（`b85237ee52125a3f781fe298c65515056806ea9e9672f2de7b63eb32da3cbc59`）。该树含共享工作区当时的并行改动，不是新发行包。未提交/推送，未重启日常 Web/Host、接管原浏览器配置或使用个人求职资料。
- 原生主窗口隔离单跑退出 0：生产主程序的首次导航完整完成后，键盘和指针均可收音、松手停轨，丢弃、关闭重开、确认后保存、导出不泄露均通过；整个原生单跑 0 次语言模型请求。独立原始记录在 `/private/tmp/betterme-inventory-voice.YfdHuEwS/native-ready.log`。全程未用真实麦克风、真实外部强模型或个人口述。Windows/macOS 实物麦克风、方言、专业术语、数字与长段平均准确率均不由此证明。
