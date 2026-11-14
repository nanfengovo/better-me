# PDF 中译英：本机排版与可选的云端文本翻译

本说明用于可信操作者准备可选转换器，不是网页自动安装功能。正式 Host 缺少配置时保持禁用。下文 5338 的旧验收为纯本机、合成账号。不得通过客户端指定 Python、资源目录、供应商 URL；例外仅为下述受保护的一次性云凭据，不接受通用代理请求。

## 适用范围

- 固定 PDF2zh-next 2.10.2 / BabelDOC 0.7.1；Python 3.10–3.13。
- 已冻结的依赖锁文件仅适用于 **macOS 14+、ARM64、Python 3.12**。实际验证版本为 Python 3.12.14；不是 Windows/Linux/Intel Mac 的依赖或实机验收结论。
- 文字 PDF、中文到英文、最多 10 页。扫描件/未校对多栏仍拒绝，不自动接 OCR。单语候选及逐页双语候选各不超过 8 MiB。
- 默认本机通道仅从 Ollama 已安装模型中明确选择，逐次核对名称、digest、remote 标志和 API 版本；本机无云端回退。云端是手选的独立通道，不要求运行 Ollama。
- 本机每个作业至多 32 次；云端由本人在 1–12 次内选更小上限。两者最多 10 分钟。SDK 的模型探测也占请求数。产物只到待审，不等于英文质量合格。

## 如何只为一份 PDF 使用强模型

1. 在 Agent → 成长闭环 → 资料与隔时复测选中已授权导入的文字 PDF，展开「PDF 中译英」。导入不授权外发。受信 Host 须已配置下文的两条运行时路径。
2. 把「翻译通道」从本机改为「云端 · DeepSeek」，单独选 `deepseek-v4-pro`（另可选 Flash），核对原件版本、术语、双语选项及本作业请求上限。这不会改变聊天模型。在已有官方 DeepSeek 配置时用其密钥；否则可在密码框中只为本次作业输入，不保存、不需在聊天中贴密钥。
3. 核对接收方 `https://api.deepseek.com` 并同意本作业文字外发，再单独确认启动。可能发送全部正文、必要的标题/上下文和本作业术语；不上传 PDF、图片、其他原件、文件名、账号或简历记录。该通道不是脱敏器。只有已认证的 HTTPS/本机回环 Host 接收本次凭据；供应商密钥不会进入 PDF 工具子进程、作业数据库或恢复记录。
4. 每次模型请求发出前记一次预算，每次回复至多 4096 tokens。上限是请求数，不是金额或扣费证明。撤权、用尽上限、无法确认模型/完整性或网络错误均会停止，不切模型或自动重发；已送出的请求不能撤回。若创建回执丢失，使用「只读核对上次翻译动作」；重开不会恢复外发授权。
5. 实际渲染与可提取文本分别检查。云端候选须额外检查术语与专有名词，填了术语表不能选“不涉及”；须独立核对公式**运算含义和操作数**，不只检查符号。失败就保留拒绝原因，不拿模拟件或新提示词替代原对照。

接口契约参见 [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion)。工程验收和仍待授权的实云对照见[云通道报告](../reports/learning-translation-cloud-2026-11-14.md)。

## 独立安装

先确认位置未用于其他 Python 环境，并为依赖、公开资源和一次私有副本预留空间。不要覆盖默认 Python、改系统 PATH 或复用个人 BabelDOC/PDF2zh 缓存。

以下从仓库根目录执行，`pdf2zh_runtime` 是本次工具专用变量：

```sh
pdf2zh_runtime="$PWD/../.betterme-pdf2zh-runtime"
UV_CACHE_DIR="$pdf2zh_runtime/uv-cache" \
UV_PYTHON_INSTALL_DIR="$pdf2zh_runtime/python" \
uv venv --no-config --no-project --system-certs --managed-python \
  --python 3.12.14 "$pdf2zh_runtime/venv"

UV_CACHE_DIR="$pdf2zh_runtime/uv-cache" \
uv pip sync --no-config --system-certs --require-hashes --only-binary :all: \
  --python "$pdf2zh_runtime/venv/bin/python" \
  scripts/pdf2zh-runtime-macos14-arm64-py312.lock
```

也可由操作者明确指定已有可信 Python 3.12.14 作为 venv 的 base，而不下载/更换默认 Python。本轮实际采用工具运行时自带的 3.12.14，依赖放在上述独立 venv；其 base 仍依赖该工具运行时目录，不能把 venv 当便携包复制分发。引擎探针会拒绝版本漂移。

先执行真实库导入的**离线**验收（不打开 PDF、不调用模型）：

```sh
pnpm exec tsx apps/agent-host/scripts/verify-pdf2zh-runtime.ts \
  "$pdf2zh_runtime/venv/bin/python"
```

必须报告固定版本、`privateConfig=true`、`privateTemp=true`、`offline=true`、`modelRequests=0`。它验证 `Path.home()`、`expanduser()`、配置/翻译缓存及临时路径，且拒绝越界 home 展开；还检查系统代理不会截走本次本机连接。首次原生库导入有冷启动开销，命令最长 90 秒；超时不意味着引擎可用。

实际桥接的两个无模型回归：第一条用本机拒绝代理确认真实库能抵达指定端口，第一条请求即停止；第二条以事件替身验证消费者收到 finish 就退出，不等待不存在的下一条事件。两者均不生成可交付译文。

```sh
pnpm exec tsx apps/agent-host/scripts/verify-pdf2zh-bridge.ts \
  "$pdf2zh_runtime/venv/bin/python" "$pdf2zh_runtime/assets"
pnpm exec tsx apps/agent-host/scripts/verify-pdf2zh-bridge.ts \
  "$pdf2zh_runtime/venv/bin/python" "$pdf2zh_runtime/assets" --events-only
```

## 公开离线资源

准备器只读取固定包中的资源元数据，不导入转换器、不接收 PDF，也不接触个人缓存。先查看离线计划，再由操作者明确下载：

```sh
"$pdf2zh_runtime/venv/bin/python" -I -B scripts/prepare-pdf2zh-assets.py \
  --assets "$pdf2zh_runtime/assets"

"$pdf2zh_runtime/venv/bin/python" -I -B scripts/prepare-pdf2zh-assets.py \
  --assets "$pdf2zh_runtime/assets" --download --parallel-model \
  --model-upstream modelscope
```

资源目录必须是绝对、规范的专用目录，根下只允许 fonts/models/cmap/tiktoken。文件不得是软链/多硬链，完整目录最多 3,000 文件、512 MiB。0.7.1 会向英文追加 CJK 回退字体：仅字体就有 265,807,784 字节，不能沿用原先 256 MiB 假设。本轮实际全部 182 文件共 352,451,566 字节，已逐项核验固定 SHA3-256；来源的 URL 分支变化也不能改变该标准。

`--model-upstream` 只允许固定上游清单列出的 Hugging Face、ModelScope、hf-mirror，不接受任意 URL。`--parallel-model` 只对公开布局模型使用至多 8 个精确 HTTPS 分段，逐段检查状态、范围、长度，最后再核完整哈希。普通资源最多 6 个 worker。任何短包、错误范围、资源超限或哈希失败都不能成为可用模型；已有错误文件不会被静默覆盖。下载过程中不要启动私有转换；检查成功后移除本次已停止下载遗留的 `.betterme-download-*` 精确文件，不能扫删未知缓存。

离线准备器回归：

```sh
"$pdf2zh_runtime/venv/bin/python" -I -B scripts/tests/test_prepare_pdf2zh_assets.py
```

资源许可分开核对：[PDF2zh-next 固定版本](https://github.com/PDFMathTranslate-next/PDFMathTranslate-next/blob/v2.10.2/pyproject.toml)、[BabelDOC 资源与字体许可索引](https://github.com/funstory-ai/BabelDOC-Assets#fonts-and-licenses)、[ONNX 转换权重声明](https://huggingface.co/wybxc/DocLayout-YOLO-DocStructBench-onnx)、[原始布局模型](https://huggingface.co/juliozhao/DocLayout-YOLO-DocStructBench)。本轮不将 Python、字体或权重打入 BetterMe 发行包；未来服务/分发组合仍须评估，独立进程不提供许可豁免。

## 隔离验收入口

```sh
NODE_OPTIONS='--import tsx' \
BETTERME_PDF2ZH_PYTHON="$pdf2zh_runtime/venv/bin/python" \
BETTERME_PDF2ZH_ASSETS="$pdf2zh_runtime/assets" \
pnpm --filter @better-me/web exec vite \
  --config tests/ui-lab/learning-translation-real.config.ts
```

打开 `http://127.0.0.1:5338/tests/ui-lab/learning-path.html`。该入口只允许临时 identity/growth 接口，记录实际本机 generate 次数，并强制原件 hash 为仓库的原创 `checkpoint-notes-v1.pdf`。只对这份不含个人资料的固定夹具，在 `output/translation-real/model-trace-*.ndjson` 记录模型输入输出，用于定位公式/标题错误；正式 Host 没有此日志或夹具限制。关闭后清理自己创建的临时 Host，勿将 QA 重启接口部署到正式服务。5337 始终是模拟转换，不产生英文质量证据。

选原创讲义→单独同意导入→展开 PDF 试点→只读刷新→选择本机模型和本作业术语→明确单次同意→启动。下载/预览候选后，逐页核对页数、数字单位、否定词、公式、阅读顺序和英文溢出；提取文本和实际画布分别检查。只有实际检查后才能接受，不能以出文件、模型成功返回或模拟件代替。

从 Web 导出真实作业回执后，桌面恢复验收命令只读取已有作业，不派送新的翻译：

```sh
node apps/desktop/tests/learning-translation-real-acceptance.cjs /absolute/path/to/receipt.json
```

它验证真实 Electron/built preload、原件/候选画布、两次新进程及专用 Host 重启后的 GET-only、计量不增、同意不恢复和静音。正式安装的 actual main/preload/React 离线 smoke 是另一层验收，不能把其合成健康响应说成正式服务已启动。

## 正式使用与边界

上述两条 `BETTERME_PDF2ZH_*` 仅可由操作者在受信 Host 启动配置中设置。本轮不会写用户 `.env`、自动切换已有服务或让网页选择可执行文件；正式启用时按原 Host 账号/owner 隔离使用，不迁移简历和求职资料。

每次作业使用私有目录、空继承环境、私有 home 展开/配置/缓存/临时目录和能力令牌代理；只在该子进程设置 `NO_PROXY=*`，不改机器代理。公开资源采用 APFS/reflink 私有副本，不支持时普通复制，绝非可修改操作者资源的硬链接。转换器的 Python socket 只允许本次代理。桥接直接使用固定 SDK 的配置构造器与 BabelDOC 生成器，保留一个受管子进程而不开调试排版，收到 finish 即退出；不会把调试框/段落标签绘进 PDF。JSON 段落输出校验同组编号、长度及 `{vN}` 公式占位符的顺序/次数，失败不交给排版；此为结构守卫，不是语义认证。

退出/取消先停止拥有的进程组，结束后才清理；Windows 原生隔离尚未验证，必须保持不可启动。Python 路径/socket 限制不是 OS 沙箱，也不保证隔离恶意的原生依赖；可信运行时、本机模型服务或单次选择的云供应商均为相应通道的信任边界。
