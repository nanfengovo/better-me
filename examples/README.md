# BetterMe 示例数据与隐私说明

本目录提供虚构或泛化的简历与 JD，用于体验导入、预览和 AI 诊断。示例中的姓名、`example.com` 邮箱、电话、企业、项目和量化结果不是使用者的真实履历，不应直接作为自己的求职事实。

## 示例文件清单

| 文件 | 内容 | 使用入口 |
|---|---|---|
| [sample-fact-base.json](sample-fact-base.json) | 包含 `factBase`、`resumeViews`、`activeResumeId` 的完整 BetterMe 文档，已有双语示例字段 | 顶部 **恢复**，会替换当前文档；使用前先备份 |
| [sample-job-description.txt](sample-job-description.txt) | 虚构的技术岗位招聘需求 | 在 **JD 匹配 / AI 诊断** 中粘贴；需要配置模型 |
| [sample-resume.md](sample-resume.md) | 中文 Markdown 简历示例 | **导入简历**，查看提取文字后选择解析方式 |
| [sample-resume.html](sample-resume.html) | 另一份虚构 HTML 简历，包含教育、工作和技能段落 | **导入简历**，核对文字提取与解析结果 |

Markdown/HTML 用于测试非结构化简历解析，不能替代完整文档 JSON 恢复。当前输出语言决定 Markdown 的内容，切换中英使用已有字段，不会自动翻译。

## 体验与核对

1. 第一次打开使用内置演示数据，或用 **恢复** 读取 `sample-fact-base.json`。
2. 在编辑器修改一条事实或新增经历，观察预览；分别切换三套模板与中英输出。
3. 导入 Markdown/HTML 时，检查原文、解析警告及未解析项，再确认替换。离线规则无法处理某些版式时会显示诊断，AI 失败不会自动伪装成离线解析成功。
4. 新解析出来的结构化量化默认未核实，需要逐条核对后确认；示例 JSON 中已有的确认状态仅用于演示，不代表新导入文字已经核实。
5. 用 **导出 PDF / 打印** 检查浏览器打印预览，或下载当前语言的 Markdown。

## 保存自己的数据

真实数据与 API Key 保存在本机浏览器 `localStorage`。浏览器存储失败会显示提示；更换浏览器、端口、设备或清理站点数据后，不会自动恢复。

编辑后点击 **备份**，将 `better-me-backup-日期.json` 保存到仓库外的私人目录；用 **恢复** 读取该 JSON 可恢复事实库与简历视图。备份不包含 API Key/AI 配置，恢复后需要重新设置模型。不要把真实备份覆盖到本目录的样例文件上。

`.gitignore` 默认忽略私人 `.agent-memory/factBase.md`、`careerObjectives.md`、`resumeGuidelines.md`、`careerStrategy.md`、本地数据库和指定命名的备份/私有文件；它不会阻止强制添加，也无法自动保护任意重命名文件，提交前仍须检查暂存内容。

## 模型请求与隐私

离线规则解析不调用模型。选择云模型进行结构化解析、视觉 OCR 或 JD 分析时，相关简历文字、JD 或页面图片会直接发送给所选模型提供商，Key 用于该服务鉴权；本项目没有自建中转服务器。使用本机 Ollama 时，请确认地址确实指向自己的本机服务。

“本地保存”不等于“云模型推理全程离线”。在发送真实资料前，先确认服务商、所用模型和该次请求内容。
