# BetterMe：模型朗读、文档识别与英译、长期职业学习

核对日期：2026-11-12。依据为上游一手文档和本机 `agent-os` 工作树（HEAD `cafe1d0`）。部分任务运行时和最终文件导出是本机尚未提交的源码，不代表远端、已安装客户端或线上已经发布。以下“建议”均未实现或实测，本次没有调用模型、上传文档或读取个人业务记录。

## 建议选型

| 用户要完成的事 | BetterMe 应保留的主流程 | 外部能力的位置 |
| --- | --- | --- |
| 听任意模型的回答 | 对已经显示的最终答复点“朗读” | 先用本机合成；云端语音另选、另授权 |
| 导出自己的英文简历 | 同一事实生成英文候选 → 对照 → 英文模板导出 | 一般不需要 OCR 或翻译已排好的 PDF |
| 翻译已有中文 PDF、尽量保留版式 | 先检查每页文字层和阅读顺序，原件保持不动 | 带文字层的排版文档试 PDFMathTranslate；扫描/混排页另走识别 |
| 识别截图或扫描材料 | 保持原件、页码与不确定项可核查，转录只作候选 | 将 OXR 放在可选的文档解析服务后面，不替换任务内核 |
| 从目标岗位到长期提升 | BetterMe 持有目标、时间预算、授权、学习历史和练习回执 | DeepTutor 只承担指定主题的教学、练习和可复核反馈 |

## 1. 语音：换读者，不换负责回答的模型

现有自由对话先检查是否收到当前回合的完整 `reply`，再将 `reply.content` 放进聊天视图；错误提示也可能使用 `role: "assistant"`。因此挂载点是**成功选中的回复正文**，不是“最后一条 assistant 消息”，也不是原始推理流。前端打字动画完成与否不应该重复触发播放。见[任务客户端](../../apps/web/src/services/free-chat-task-client.ts#L85)、[对话成功与失败分支](../../apps/web/src/components/AgentCompanion.tsx#L445)、[模型协议对思考字段的处理](../../apps/agent-host/src/model.ts#L55)。[DeepSeek 流式示例](https://api-docs.deepseek.com/guides/thinking_mode_api_example_streaming/)和 [Ollama 流式协议](https://docs.ollama.com/capabilities/streaming)也将可见文本和思考/工具等数据区分开。

- **本机点播先行。** 聊天模型仍可选 DeepSeek、Ollama、OpenAI 或 Gemini；用户点某条消息 → 提取可见正文（不读隐藏推理、工具 JSON、错误、历史或附件）→ 按中英文、句子切段 → 选择本机音色。Web 和 Electron 的共享前端用 `speechSynthesis.getVoices()` 并监听 `voiceschanged`，仅显式选用 `localService === true` 且语言可用的 voice；取消、报错、无声库都保留文字。引擎、设备和已安装语言包须分别实测，不能把“浏览器提供”当作“保证离线”。[Web Speech 草案：声音与本地标记](https://webaudio.github.io/web-speech-api/#dom-speechsynthesisvoice-localservice)
- **云合成可选。** 独立的语音配置保存“谁读、哪种音色、语言、允许发送什么”，不能继承文本模型的密钥、账号订阅或发送授权。云端仅收当次选中的正文，密钥不下发播放器；标明提供方、合成声音与可能计费，可取消且不静默重试或换云。Google 提供专用的[文本转语音](https://ai.google.dev/gemini-api/docs/speech-generation)，与用于双向对话的 Live 不同。OpenAI [TTS 指南](https://developers.openai.com/api/docs/guides/text-to-speech)及[弃用表](https://developers.openai.com/api/docs/deprecations#2026-10-01-text-to-speech-models)列明旧 `tts-1`、`tts-1-hd`、`gpt-4o-mini-tts` 系列于 2027-01-06 关闭，替代为 Realtime 路线的 `gpt-realtime-2.1-mini`；新集成不要在旧 `/audio/speech` 里只替换模型名。云端生成的音频不得反向改写已确认的文字。
- **建议的最小接口**：`listVoices()`、`speak({messageId, text, lang, voiceId, signal})`、`stop()`。默认点一次读一次；明确启用后才自动读后续成功回复。快速换消息、停止、切账号、撤销授权、离开会话时清空队列，忽略旧回调。只做输出不取麦克风、不保存录音；若要练口语，再拆成按键说话/STT → 供本人改正并确认的转写 → 原模型 → TTS。实时插话、录音保留与实时音频模型是另一项工程，并非跨模型朗读的前提。

若以后需要 macOS、Windows 使用同一离线音色，不必强依赖操作系统声库，可给 Agent Host 加可选本地 TTS 服务，例如 [sherpa-onnx 官方离线 VITS 兼容模型](https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/vits.html)中的中英文候选。运行时许可、具体音色权重许可、下载体积、CPU 延迟须分别核定；不是 MVP 依赖。

## 2. 文档：先判断源文件，识别、翻译和导出各司其职

**BetterMe 内的简历。** 工程里同一 `LocalizedString` 保存 `zh` 与可选 `en`，缺少英文便显示中文；“仅英文”字段切换不会翻译，核心优势等共享字符串也不是双语字段。简历投影还会排除不应输出的条目和未经确认的量化指标。[语言选择](../../packages/core/src/schema/locale.ts#L14) · [投影与筛选](../../packages/core/src/project/resume-projection.ts#L116) · [编辑器说明](../../apps/web/src/components/FactEditor.tsx#L430) · [共享字段示例](../../apps/web/src/components/FactEditor.tsx#L725)

建议在当前获准导出的视图内，为缺失英文的字段生成 `{fieldId, sourceRevision, sourceText, candidateEn}` 草稿；复核已有译文、品牌和人名的惯用拼法、数值单位、日期、否定词、任职范围，保留链接和项目名，未确认不写回。共享字段也要做覆盖率检查：保留的原文专名与意外漏译需分开。审核后导出英文衍生版本，源中文和已有英文不被覆盖。现有[打印预览](../../apps/web/src/components/ResumePreview.tsx#L289)与工作树中的[绑定输入版本、模板和渲染回执的 PDF/DOCX 导出](../../apps/web/src/services/career-final-export.tsx#L25)可复用。不要仅凭文件名带 `en` 就宣布全篇英译完成。

**外部 PDF 或图片。** 现有 PDF.js 读取每页 `getTextContent()` 并生成页图，但按**整份**少于 50 个非空白字符估计是否扫描；有文字封面的扫描件、多页混排可能被漏判。[文件解析](../../apps/web/src/lib/file-parsers.ts#L302) · [扫描判定](../../apps/web/src/lib/file-parsers.ts#L350)。简历导入遇到扫描/图片会走视觉解析，OCR 原文不是已核实事实，确认替换事实库是另一步；岗位截图另有 `jd_ocr`：任务先冻结有序图片清单、哈希、运行时和授权，当前用视觉 reasoner 产出供复核的转录，既不翻译也不采用岗位。[导入分流](../../apps/web/src/components/ResumeImportModal.tsx#L233) · [识别与事实的边界](../../packages/core/src/ai/resume-parser.ts#L74) · [任务协议](../../packages/agent-contracts/src/jd-ocr.ts#L14) · [访问与启动检查](../../apps/web/src/services/jd-ocr-task-client.ts#L30) · [Host 执行与回执](../../apps/agent-host/src/kernel/service.ts#L564)

### OXR：适合识别，不负责翻译、事实认证或原版 PDF 导出

OXR-1.0 是偏向中文和英文文档的 1.3B 解析方案，接收 PDF/图片，给 Markdown 或含元素类型、坐标与阅读顺序的 JSON。它不是按任意业务字段抽取信息的接口，不会自动合并跨页表格；手机斜拍也不是官方主打场景。[固定版本 README](https://github.com/SoMarkAI/OXR/tree/b2ee4ac12ed220bf7fefa74951babf0d3b05e766) · [官方能力、语言与限制 FAQ](https://github.com/SoMarkAI/OXR/blob/b2ee4ac12ed220bf7fefa74951babf0d3b05e766/docs/FAQ.md)。默认 `keep_header_footer=false`，简历与岗位材料首轮应显式保留页眉页脚，否则可能遗漏联系方式；保留原页图与页号供人核对。[上游解析配置](https://github.com/SoMarkAI/OXR/blob/b2ee4ac12ed220bf7fefa74951babf0d3b05e766/oxr/server/routes.py#L44-L56)

**接入方式。** 用 `DocumentParser` 适配独立服务，从 Agent Host 传入获准的文件或页图，固定字节指纹和引擎；返回 `page, blockId, bbox, order, text, warnings`。若引擎没有可信置信度，字段留空；不可猜测。简历导入消费这些块生成待核对的字段，JD 截图则维持原有的清单、顺序、结果和采纳授权；不把这个 PDF 接口硬塞进现有 `jd_ocr` 的六张图合同。官方自托管示例为 Linux、NVIDIA BF16 与兼容 CUDA 13.0 的驱动；FAQ 建议单卡从 24 GB 显存开始，Mac 搭建要额外工作，没有官方 Ollama 支持。可在预置权重后离线运行；没有合适环境时保留现有路径。**免费 API 会用在线数据改进模型，不能拿真实简历作默认测试。** [官方部署示例](https://github.com/SoMarkAI/OXR/tree/b2ee4ac12ed220bf7fefa74951babf0d3b05e766#quick-start) · [硬件、离线与数据政策](https://github.com/SoMarkAI/OXR/blob/b2ee4ac12ed220bf7fefa74951babf0d3b05e766/docs/FAQ.md)

**商用闸门。** 不要把仓库概括成普通 Apache-2.0。2026-11-06 调整后的[代码许可证](https://github.com/SoMarkAI/OXR/blob/b2ee4ac12ed220bf7fefa74951babf0d3b05e766/LICENSE)规定：自己及关联方合并的累计融资或年度总收入任一超过 200 万美元，使用前须另获书面商业许可（个人使用与非商业研究的规模条款例外）；按该许可对第三方提供服务还有显著署名链接要求。[NOTICE](https://github.com/SoMarkAI/OXR/blob/b2ee4ac12ed220bf7fefa74951babf0d3b05e766/NOTICE)明确代码许可不授权权重。[OXR-1.0 固定权重许可](https://huggingface.co/SoMarkAI/OXR-1.0/blob/c708407f9d2b4df658f2543d9132b62bb7221df4/LICENSE)另有针对竞争性托管文档解析/OCR API 的书面授权条款，不能因代码去掉了原竞业条款就推定权重也去掉。以上是条款提示，不是对特定商业分发方式的许可认定；随包、SaaS 或白标前逐件核对版本与许可，必要时向上游书面确认。

### PDFMathTranslate：为外部文档产出英文单语与中英对照两份文件

**可行，但“可选英文”不等于“原版式一比一、所有简历都能投递”。** 原仓 [1.x 中文说明](https://github.com/PDFMathTranslate/PDFMathTranslate/blob/603617c05c0d6b360fd302736137262eb8cdac21/docs/README_zh-CN.md)支持分别指定源语言、目标语言、翻译后端，并导出 `-mono.pdf`（仅译文）和 `-dual.pdf`（双语）。例如，显式配置好本地 Ollama 地址与翻译模型后，1.x 测试命令为 `pdf2zh input.pdf -li zh -lo en -s ollama`；不省略服务参数，以免走默认在线翻译。固定主线源码[声明 1.9.12](https://github.com/PDFMathTranslate/PDFMathTranslate/blob/603617c05c0d6b360fd302736137262eb8cdac21/pyproject.toml)，与[已发布的 v1.9.11](https://github.com/PDFMathTranslate/PDFMathTranslate/releases/tag/v1.9.11)有别：不要把主线特性当作安装稳定包即有。

- **工程上优先试单独的 2.x。** [PDFMathTranslate-next v2.10.2](https://github.com/PDFMathTranslate-next/PDFMathTranslate-next/releases/tag/v2.10.2)提供有[进度事件、结果与取消的 Python API](https://pdf2zh-next.com/advanced/API/python.html)，可包装成后台任务而不是让渲染进程执行命令。其[翻译服务配置](https://github.com/PDFMathTranslate-next/PDFMathTranslate-next/blob/v2.10.2/pdf2zh_next/config/translate_engine_model.py)分别提供 Ollama、DeepSeek、OpenAI、Gemini 与 OpenAI-compatible；普通 Google 翻译也与 Gemini 不同。要绑定明确的引擎、端点和模型，而不是重用所有聊天凭据。若启用独立[术语抽取引擎](https://github.com/PDFMathTranslate-next/PDFMathTranslate-next/blob/v2.10.2/pdf2zh_next/config/model.py#L286-L324)，它同样在本次授权范围内，不能暗转另一云端。2.x 的底层 [BabelDOC 语言说明](https://github.com/funstory-ai/BabelDOC#language-options)明确主要关注英译中，目标英文仅基础支持；中译英简历的质量和版面须验，不是上游承诺。
- **按页分流。** 原生可选中文字且文字顺序合格的 PDF 直接用**原 PDF** 做版式翻译，勿先全篇 OCR。1.x 当前主线 fast 的[实验 OCR](https://github.com/PDFMathTranslate/PDFMathTranslate/blob/603617c05c0d6b360fd302736137262eb8cdac21/README.md#experimental-automatic-ocr-fast-mode)针对纯图白底页，页面已有文本会跳过图像部分；彩底、手写和行内公式均需专测，`--ultrafast` 跳过 OCR。对纯扫描/混排，可选 OXR 做识别与逐页复核；OXR 的 JSON/Markdown **不是** PDFMathTranslate 的原 PDF 输入。需要保原外观时，另验证生成带位置的可检索文字层再翻译；若不可靠，选择“英文重排版”并明示失去原排版。无法译的页标注并交给用户，不生成看似全译的结果。
- **产物与留存。** 输入原件只读；英文单语与中英对照分别保存，附源文件哈希、引擎/版本、页数、警告和回执。导出前用英文抽文和实际渲染图检查阅读顺序、漏字、字体溢出/截断、双栏、人名/链接、日期和指标。若用于投递再做 ATS 文本层检查，不能用“可打开 PDF”代替。后台进程仅获得本任务文件、临时目录和被准许的翻译端点，不继承用户主目录或其他密钥。本地运行的 Python 程序仍可调用云引擎，且 [1.x 有缓存和服务配置写入](https://github.com/PDFMathTranslate/PDFMathTranslate/blob/603617c05c0d6b360fd302736137262eb8cdac21/pdf2zh/translator.py#L49-L103)；隔离缓存与配置、设置保留期，不把内容带入永久共享缓存。
- **授权。** 两个代码系均标示 AGPL-3.0：[1.x 声明](https://github.com/PDFMathTranslate/PDFMathTranslate/blob/603617c05c0d6b360fd302736137262eb8cdac21/pyproject.toml#L6)、[2.x 声明](https://github.com/PDFMathTranslate-next/PDFMathTranslate-next/blob/v2.10.2/pyproject.toml#L11)。把它拆为独立进程有利于隔离资源与故障，不自动免除分发或修改后通过网络提供服务等场景的义务；公开交付前按实际组合和部署核对许可证，并盘点字体和模型权重。

## 3. 长期成长：BetterMe 掌管职业档案，教学引擎可替换

项目已有[目标和材料授权确认](../../apps/web/src/lib/career-coach/journey.ts#L4)、[计划采纳、旧版留存与证据提交](../../apps/web/src/lib/career-coach/state.ts#L57)、[登录主体的成长记录与修订号](../../apps/web/src/lib/career-coach/storage.ts#L99)、[成长任务与本次授权绑定](../../apps/web/src/services/coach-guidance-task-client.ts#L15)。[模拟面试评价](../../apps/agent-host/src/kernel/mock-interview.ts#L21)要求对本次回答逐条引用，[本地练习回执](../../apps/web/src/lib/career-coach/practice.ts#L36)也明确通过测试不代表完整生产能力。[11 月 1 日同仓研究](career-learning-interview-open-source-2026-11-01.md)已将 DeepTutor 定位为学习状态与证据闭环的参考；本次优先验证能否复用教学能力，不再引入第二个账号或职业事实库。

**值得复用什么。** [DeepTutor v1.7.2](https://github.com/HKUDS/DeepTutor/releases/tag/v1.7.2)（[代码 Apache-2.0](https://github.com/HKUDS/DeepTutor/blob/v1.7.2/LICENSE)）是辅导学习者的系统，不是训练 BetterMe 模型权重的框架。[Mastery Path](https://docs.deeptutor.info/explore/mastery-path/)将目标拆成模块和知识点，并区分自报掌握、测验通过和间隔复习；[Practice](https://docs.deeptutor.info/explore/practice/)可围绕资料安排练习。其[主题 API](https://github.com/HKUDS/DeepTutor/blob/v1.7.2/deeptutor/api/routers/mastery_path.py#L549)可先生成草案，再在确认后创建主题；[模块清单](https://github.com/HKUDS/DeepTutor/blob/v1.7.2/deeptutor/modules/manifests/mastery.json)显示 `mastery` 依赖 `knowledge`，并非拷贝一个 React 组件就能运行。v1.7.2 亦已提供选中聊天/学习内容朗读：可以借鉴点选交互，不需要为这个按钮引入整个系统。

**如何结合。** 例如给一个合成“后端岗位”演示：选定 JD 后，本人确认要提高“解释慢查询”这个技能及每周可用时间；BetterMe 只传技能、预算与获准的教材片段给教学服务，先生成可审阅的小纲要。完成一次解释执行计划的练习后保存原答/练习产物、评分依据、模型版本；下一周用不同题复测，BetterMe 再展示计划差异，用户决定是否调整。区分“我认为会了”“模型就此回答给的意见”“此练习有可重现回执”，都不是已证明的工作资历。学习完成不自动写履历、发起投递或向第三方发送资料。

**服务边界。** 第一阶段可只借教学设计；若真实需要上游服务，由 Agent Host 映射 `owner + workspace + task` 到隔离实例或有验证的租户/工作区，只给最少的授权材料和短期访问凭据。不要用全局共用账号、打开全工作区搜索或挂载本机原始简历。DeepTutor [默认是单用户，启用认证后才进入多用户](https://docs.deeptutor.info/get-started/multi-user/)；该版[工作区说明](https://github.com/HKUDS/DeepTutor/blob/v1.7.2/docs-for-dev/workspaces.md)显示会话/资料/进度可分工作区，个人记忆、设置、凭据仍属账号级。先禁用不必要的联网检索、文件工具、代码执行、共享知识库与外部消息通道；必须验证隔离、删除与撤权，并区分“上游有多用户选项”和“已经与 BetterMe 的账号安全互通”。

## 4. 实施顺序与放行条件（均为建议）

1. **点播 + 原生英文简历。** 先用四种模型的合成回复或回执测中英文点播、打断、快速切换、无声音包、断网与切账号；Web 和桌面均可回到文字，绝不启动麦克风或暗切云。合成简历先试原生英文草稿与模板导出，姓名、日期、数值、链接与源稿比对，不变更真实默认简历。
2. **外部文件双路小样。** 准备不含个人数据的原生文字 PDF、双栏简历、纯扫描和混合页（含页眉联系方式、公式或表格）；先对照现有 OCR 与 OXR 的转录错误、遗漏字段、阅读顺序，再对照两种译稿的漏译页、数字/单位、溢出、文本可提取性，同时记录耗时、峰值显存和云费用。按目标版面给“可用/需校对/不支持”的结果；没有硬件或许可证未确认时让该选项保持关闭。
3. **单技能学习试点。** 两个合成账号/工作区验证历史与教材不会串，分别覆盖自报、提交、评分和复测。断线或撤权可停止，本人批准后才保存计划改动；达不到就保留现有 Career Coach，不需引入整个教学平台。

三个方向共同遵守：模型或工具只能产出**回复、候选或教学反馈**；有明确用户动作才外发或采用。可借用现有[资料分类](../../apps/agent-host/src/privacy/types.ts#L8)与[排除仅限本机资料的草案筛选](../../apps/agent-host/src/privacy/hybrid-pipeline.ts#L126)，但原授权不会自动延伸到语音、翻译或教学服务。选了聊天模型不等于选了语音/翻译收费服务，识别文档不等于同意存为事实，完成练习不等于已经获得履历资质。
