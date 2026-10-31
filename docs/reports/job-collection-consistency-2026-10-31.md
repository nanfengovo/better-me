# 岗位采集与地图口径验收

本轮在现有 agent-os 分支修改，基线7391ea970c251a96b9e7ef7a056a555adc139914，未新开分支。实现验收完成后，按用户授权仅提交本轮相关代码、测试和本报告；对应提交与远端CI状态以Git记录及Actions为准，早先的开源来源调研文档不纳入本次提交。

## 实现

- 国内全国采集明确传递中国；全球选择的国家即使没有城市也进入来源范围。平台未配置地区映射时明确披露默认读取范围。
- 按卡片披露地点分为匹配、范围外、未知；不依赖公司名称、总部或搜索意图补造地点。后两类保留原始回执，不进入本轮自动导入。
- 普通采集、实时重抓与恢复使用相同地区范围。回执包含市场、国家和行政区身份，切换范围不会沿用旧回执。
- 实时模式的索引、地图和统计只关联本轮匹配卡片的来源URL；历史索引通过独立入口查看。
- 已关联卡片可进入现有地址详情核对；未知地点不造点，城市与远程资格不充当办公地址。
- 双休、日工时、远程及加班分别提取原文声明，保留原句和来源，否定与不确定表述不变为承诺。社区955/996名单没有自动导入或覆盖岗位。

## 实际浏览器

使用独立5196端口、专用浏览器和5000条内存合成岗位。未操作真实简历、岗位数据库、凭据、现有浏览器或运行服务。隔离服务没有真实API代理回退，写入和真实平台访问被拒绝。

实际点击采集和确认，提供合成SSE回执：捕获4张，国内匹配2张、范围外1张、地点未知1张；索引关联2岗、2企业、地图1坐标点、1无精确位置岗位。切换历史索引为2500岗，再切回实时恢复本轮2岗。390px窄屏无文档横向溢出，切换国家不沿用旧回执、不自动采集。地址详情入口已点击验证，未保存地址。本次pageerror为0；隔离服务拒绝真实Chrome探测的401是预期保护。

合成URL刻意不满足猎聘导入合同以检查失败路径，界面正确保留未完成状态，不声称本轮入库成功；两个合成URL已在内存索引中，因此可以验证关联与地图统计。这不代表实际招聘平台可用性或真实写入验收。成功导入、恢复与地址确认另由合成自动化测试覆盖，地址HTTP集成使用内存SQLite。

复现脚本：apps/web/tests/ui-lab/collection-scope.browser.js。截图：output/playwright/collection-scope-desktop.png、collection-scope-address-detail.png、collection-scope-mobile.png。脚本仅允许5196独立lab，并仅清理该专用浏览器的合成存储。

独立服务启动：pnpm --filter @better-me/web exec vite --config tests/ui-lab/vite.config.ts --port 5196。通过专用playwright-cli会话打开 /tests/ui-lab/index.html?size=5000，再执行 run-code --filename apps/web/tests/ui-lab/collection-scope.browser.js。

本轮仅验收相关回归，不冒充全仓CI；工作制度是来源声明而非实际执行保证。未复制第三方开源采集代码，955/996社区接入仍需授权、时效和实体核对。

## 自动化结果

- 工作区85/85、其他相关回归250/250，共335项，0失败、0跳过。另补测地理边界与流式导入15/15通过（包含在上述相关模块中，不重复累计）。
- Web typecheck、Web生产构建、修改的TS/TSX文件ESLint（max-warnings=0）及git diff --check通过。
- 构建仍有大包警告和既有admin-boundary-service中的Node模块浏览器外部化提示，未调整阈值、删测试或降低门禁。
- 工作区中原有测试的美国全国来源请求断言增加countryCodes=[US]，确保只有国家、没有城市时也发送国家范围；取消/市场切换的合成卡片补上明确地点，不以未知地点绕过新过滤。

可复现命令（从仓库根目录）：

```sh
pnpm exec tsx --test apps/web/tests/atlas-workspace.test.tsx
pnpm exec tsx --test apps/web/tests/harvest*.test.* apps/web/tests/atlas-live-harvest*.test.* apps/web/tests/jd-live*.test.* apps/web/tests/job-working-conditions.test.ts apps/web/tests/opportunity-harvest-pipeline.test.ts apps/web/tests/atlas-job-detail.test.tsx apps/web/tests/atlas-detail-locations.test.tsx apps/web/tests/atlas-office-address*.test.tsx apps/web/tests/atlas-location-confirmation.test.tsx apps/web/tests/jd-detail-locations.test.tsx apps/web/tests/live-platform-location-refresh.test.ts
pnpm --filter @better-me/web typecheck
pnpm --filter @better-me/web build
git diff --check
```
