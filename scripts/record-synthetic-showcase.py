#!/usr/bin/env python3
import os
os.environ['no_proxy'] = '*'
os.environ['NO_PROXY'] = '*'
for k in ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']:
    os.environ.pop(k, None)

import asyncio
import base64
import json
import urllib.request
import websockets
from PIL import Image

TARGET_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '../docs/images'))
os.makedirs(TARGET_DIR, exist_ok=True)

async def main():
    pages = json.loads(urllib.request.urlopen('http://127.0.0.1:9222/json').read())
    target = next(p for p in pages if p['type'] == 'page' and 'localhost:5173' in p['url'])
    ws_url = target['webSocketDebuggerUrl']
    print('Connecting to Chrome CDP:', ws_url)

    async with websockets.connect(ws_url, max_size=50*1024*1024) as ws:
        msg_id = 1
        async def send(method, params=None):
            nonlocal msg_id
            i = msg_id
            msg_id += 1
            await ws.send(json.dumps({'id': i, 'method': method, 'params': params or {}}))
            while True:
                res = json.loads(await ws.recv())
                if res.get('id') == i:
                    return res.get('result', {})

        await send('Page.enable')
        await send('Runtime.enable')
        await send('Emulation.setDeviceMetricsOverride', {
            'width': 1440,
            'height': 900,
            'deviceScaleFactor': 1.6,
            'mobile': False
        })

        async def eval_js(code):
            res = await send('Runtime.evaluate', {'expression': code, 'awaitPromise': True, 'returnByValue': True})
            return res.get('result', {}).get('value')

        async def save_shot(name, quality=90):
            shot = await send('Page.captureScreenshot', {'format': 'jpeg', 'quality': quality})
            path = os.path.join(TARGET_DIR, name)
            with open(path, 'wb') as f:
                f.write(base64.b64decode(shot['data']))
            print(f'Saved: {path} ({os.path.getsize(path)/1024:.1f} KB)')
            return shot['data']

        # Step 1: Inject rich, 100% synthetic/fictional demo document into localStorage
        print('Injecting clean synthetic demo document...')
        await eval_js('''
            (() => {
                const syntheticDoc = {
                    documentId: "synthetic-demo-doc",
                    schemaVersion: 1,
                    updatedAt: new Date().toISOString(),
                    factBase: {
                        schemaVersion: 1,
                        updatedAt: new Date().toISOString(),
                        profile: {
                            displayName: { zh: "陈默", en: "Chen Mo" },
                            headline: { zh: "高级后端架构师 · 分布式系统与工业云原生", en: "Senior Backend Architect" },
                            yearsOfExperience: 5,
                            education: { zh: "华东理工大学 · 计算机科学与技术 (2016-2020)", en: "Computer Science" },
                            location: { zh: "上海", en: "Shanghai" },
                            email: "chenmo.architect@example.com",
                            phone: "+86 138-0000-8888",
                            traits: ["高并发治理", "分布式调度", "DDD领域驱动设计"],
                            targetRoles: [{ zh: "高级后端工程师" }, { zh: "系统架构师" }],
                            links: [{ label: "GitHub", url: "https://github.com/example/chenmo" }]
                        },
                        experiences: [
                            {
                                id: "exp-synthetic-1",
                                type: "work",
                                org: { zh: "星汉智能科技（示例企业）" },
                                title: { zh: "后端技术专家 · 核心调度平台" },
                                start: "2023-01",
                                end: null,
                                techStack: ["C#", ".NET 8", "Go", "Docker", "Redis", "Kafka"],
                                claims: [
                                    { id: "c1", kind: "action", text: { zh: "核心项目：面向智能工厂的分布式设备调度中台（RCS）" }, tags: [] },
                                    { id: "c2", kind: "action", text: { zh: "项目背景：为高精制造车间提供异构机器人集群协同调度，实现任务下发、状态实时闭环与异常熔断。" }, tags: [] },
                                    { id: "c3", kind: "action", text: { zh: "个人职责：" }, tags: [] },
                                    { id: "c4", kind: "action", text: { zh: "主导调度核心状态机设计，采用事件驱动与内存流水线架构，支撑单集群 100+ 机器人并发作业。" }, tags: [] },
                                    { id: "c5", kind: "action", text: { zh: "设计可插拔的 Adapter 设备适配层，打通与 MES/WCS 系统的双向通信协议，提升外部系统接入扩展能力。" }, tags: [] },
                                    { id: "c6", kind: "action", text: { zh: "构建全链路分布式追踪与集中式日志治理方案，秒级定位现场指令丢包与重发异常。" }, tags: [] },
                                    { id: "c7", kind: "action", text: { zh: "业绩：" }, tags: [] },
                                    { id: "c8", kind: "action", text: { zh: "新设备接入与联调周期缩短 40%，核心调度引擎可用性达到 99.99%。" }, tags: [], metric: { value: 40, unit: "%", confirmed: true } },
                                    { id: "c9", kind: "action", text: { zh: "通过精细化内存池与连接复用，调度系统高峰吞吐量提升 30%。" }, tags: [], metric: { value: 30, unit: "%", confirmed: true } }
                                ]
                            },
                            {
                                id: "exp-synthetic-2",
                                type: "work",
                                org: { zh: "普罗米修斯软件（示例企业）" },
                                title: { zh: "高级开发工程师" },
                                start: "2020-07",
                                end: "2022-12",
                                techStack: ["C#", "ASP.NET Core", "SQL Server", "RabbitMQ"],
                                claims: [
                                    { id: "c10", kind: "action", text: { zh: "核心项目：工业产线协同与数据采集平台" }, tags: [] },
                                    { id: "c11", kind: "action", text: { zh: "个人职责：" }, tags: [] },
                                    { id: "c12", kind: "action", text: { zh: "负责多协议设备采集服务重构，封装统一的数据清洗与批处理入库流水线。" }, tags: [] },
                                    { id: "c13", kind: "action", text: { zh: "业绩：" }, tags: [] },
                                    { id: "c14", kind: "action", text: { zh: "实现日均千万级点位数据的高效采集，落库延迟控制在 50ms 以内。" }, tags: [], metric: { value: 50, unit: "ms", confirmed: true } }
                                ]
                            }
                        ],
                        importSource: {
                            fileName: "陈默-高级后端架构师.pdf",
                            rawText: "个人项目：开源工业 Agent 工作台\\n技术栈：React, FastAPI, Ollama\\n项目内容：搭建企业知识库与问答助手。",
                            unparsedLines: [
                                "面向工业现场的开源 AI Agent 工作台 | 个人项目 | 2026 - 至今",
                                "代码库：https://github.com/example/industrial-agent",
                                "技术栈：React, FastAPI, Ollama, LangChain",
                                "项目内容：探索大语言模型在工控运维场景的应用，搭建现场设备异常排查知识库问答助手。"
                            ]
                        }
                    },
                    resumeViews: [
                        {
                            id: "default-view",
                            name: "Default",
                            locale: "zh",
                            templateId: "formal",
                            themeId: "modern-teal",
                            sectionOrder: ["profile", "experiences", "skills"],
                            visibleExperiences: ["exp-synthetic-1", "exp-synthetic-2"],
                            textStyles: {}
                        }
                    ],
                    activeResumeId: "default-view"
                };

                // Inject writing session with active note & applied note showing diff
                const sessionKey = "betterme.writing.v1:synthetic-demo-doc:default-view:";
                const syntheticNotes = {
                    version: 1,
                    mode: "quiet",
                    notes: [
                        {
                            id: "note-applied-1",
                            state: "applied",
                            source: {
                                targetRef: { kind: "claim_text", experienceId: "exp-synthetic-1", claimId: "c6", locale: "zh" },
                                text: "负责写日志模块，排查线上出现的问题。",
                                label: "星汉智能科技 · 要点 6"
                            },
                            answer: "基于 OpenTelemetry 与 Serilog 构建了统一日志和链路追踪，用 TraceId 串联分布式调用，现场出问题不用跨机器翻文件，定位时间从 2 小时缩短到 5 分钟。",
                            proposedText: "构建全链路分布式追踪与集中式日志治理方案，秒级定位现场指令丢包与重发异常。",
                            updatedAt: Date.now() - 3600000
                        },
                        {
                            id: "note-active-2",
                            state: "open",
                            source: {
                                targetRef: { kind: "claim_text", experienceId: "exp-synthetic-1", claimId: "c4", locale: "zh" },
                                text: "主导调度核心状态机设计，采用事件驱动与内存流水线架构，支撑单集群 100+ 机器人并发作业。",
                                label: "星汉智能科技 · 要点 4"
                            },
                            issue: {
                                kind: "duties",
                                title: "动作很具体，可以再说明如何保障状态一致性",
                                question: "机器人出现通信超时或掉电异常时，状态机如何进行状态对齐与任务幂等重试？"
                            },
                            answer: "设计了本地轻量级事务日志（WAL）与心跳租约机制，断网恢复后由调度中台主动发起一致性协商，避免状态脑裂和指令重复执行。",
                            proposedText: "主导状态机与心跳租约机制设计，断网恢复后自动协商一致性，有效杜绝任务重复派发与状态脑裂。",
                            evidenceQuotes: [
                                "主导调度核心状态机设计",
                                "设计了本地轻量级事务日志（WAL）与心跳租约机制"
                            ],
                            updatedAt: Date.now()
                        }
                    ]
                };

                localStorage.setItem("betterme:document:v1", JSON.stringify(syntheticDoc));
                localStorage.setItem(sessionKey, JSON.stringify(syntheticNotes));
                window.location.reload();
            })()
        ''')
        print('Reloading page...')
        await asyncio.sleep(3.5)

        # Shot 1: Dual-column workbench (overview)
        print('Capturing Shot 1: dual-column-workbench...')
        await eval_js('''
            (() => {
                const copilot = document.querySelector('.writing-shell');
                // Ensure workbench tab is content
            })()
        ''')
        await asyncio.sleep(1.0)
        await save_shot('dual-column-workbench-20261108.jpg')

        # Shot 2: Resume Hierarchical Typography
        print('Capturing Shot 2: resume-refactored-hierarchy...')
        await save_shot('resume-refactored-hierarchy-20261108.jpg')

        # Shot 3: Agent Copilot Diff & History
        print('Capturing Shot 3: agent-copilot-diff...')
        await eval_js('''
            (() => {
                // Open writing copilot
                const checkBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('检查当前简历') || b.innerText.includes('写作助手'));
                if (checkBtn) checkBtn.click();
                const refineBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('一起完善这条经历') || b.innerText.includes('一起完善'));
                if (refineBtn) refineBtn.click();
            })()
        ''')
        await asyncio.sleep(1.5)
        await save_shot('agent-copilot-diff-20261108.jpg')

        # Shot 4: Project Understanding Flow
        print('Capturing Shot 4: project-understanding-flow...')
        await eval_js('''
            (() => {
                const alignBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('先对齐项目理解'));
                if (alignBtn) alignBtn.click();
            })()
        ''')
        await asyncio.sleep(1.5)
        await save_shot('project-understanding-flow-20261108.jpg')

        # Shot 5: Import Supplement Review
        print('Capturing Shot 5: import-supplement-review...')
        await eval_js('''
            (() => {
                // Return to copilot
                const backBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('返回伴写建议'));
                if (backBtn) backBtn.click();
                // Ensure import details is open
                const details = document.querySelector('details.no-print');
                if (details) details.open = true;
            })()
        ''')
        await asyncio.sleep(1.2)
        await save_shot('import-supplement-review-20261108.jpg')

        # Shot 6: Version History Time Machine
        print('Capturing Shot 6: version-history-timemachine...')
        await eval_js('''
            (() => {
                const moreBtn = document.querySelector('.document-menu button');
                if (moreBtn) moreBtn.click();
            })()
        ''')
        await asyncio.sleep(0.5)
        await eval_js('''
            (() => {
                const histBtn = Array.from(document.querySelectorAll('.document-dropdown button')).find(b => b.innerText.includes('历史版本'));
                if (histBtn) histBtn.click();
            })()
        ''')
        await asyncio.sleep(1.5)
        await save_shot('version-history-timemachine-20261108.jpg')

        # Close history modal
        await eval_js('''
            (() => {
                const closeBtn = Array.from(document.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === '关闭' || b.innerText.includes('✕') || b.querySelector('svg'));
                if (closeBtn) closeBtn.click();
            })()
        ''')
        await asyncio.sleep(1.0)

        # Step 7: Record synthetic demo GIF (Clicking note -> Typing -> Diff generated)
        print('Recording synthetic demo GIF...')
        gif_frames = []
        
        # Setup clean state for GIF
        await eval_js('''
            (() => {
                window.location.reload();
            })()
        ''')
        await asyncio.sleep(3.0)

        # Frame sequence
        # Phase 1: Idle workbench
        for _ in range(8):
            data = await send('Page.captureScreenshot', {'format': 'jpeg', 'quality': 85})
            gif_frames.append(data)
            await asyncio.sleep(0.12)

        # Phase 2: Click note
        await eval_js('''
            (() => {
                const checkBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('检查当前简历') || b.innerText.includes('写作助手'));
                if (checkBtn) checkBtn.click();
            })()
        ''')
        for _ in range(12):
            data = await send('Page.captureScreenshot', {'format': 'jpeg', 'quality': 85})
            gif_frames.append(data)
            await asyncio.sleep(0.12)

        # Phase 3: Click "一起完善这条经历"
        await eval_js('''
            (() => {
                const refineBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('一起完善这条经历') || b.innerText.includes('一起完善'));
                if (refineBtn) refineBtn.click();
            })()
        ''')
        for _ in range(15):
            data = await send('Page.captureScreenshot', {'format': 'jpeg', 'quality': 85})
            gif_frames.append(data)
            await asyncio.sleep(0.12)

        # Phase 4: Type supplement in textarea
        await eval_js('''
            (() => {
                const ta = document.querySelector('#writing-answer');
                if (ta) {
                    ta.value = "设计心跳租约与自适应避障重试机制，断网后自动协商一致性。";
                    ta.dispatchEvent(new Event('input', { bubbles: true }));
                }
            })()
        ''')
        for _ in range(15):
            data = await send('Page.captureScreenshot', {'format': 'jpeg', 'quality': 85})
            gif_frames.append(data)
            await asyncio.sleep(0.12)

        # Phase 5: Confirm and show draft diff
        await eval_js('''
            (() => {
                const chk = document.querySelector('.writing-review-compose input[type="checkbox"]');
                if (chk) chk.click();
                const genBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('用我的补充作为可编辑草稿') || b.innerText.includes('整理候选表达'));
                if (genBtn) genBtn.click();
            })()
        ''')
        for _ in range(25):
            data = await send('Page.captureScreenshot', {'format': 'jpeg', 'quality': 85})
            gif_frames.append(data)
            await asyncio.sleep(0.12)

        print(f'Total GIF frames captured: {len(gif_frames)}')
        
        # Compile GIF
        pil_images = []
        for d in gif_frames:
            raw = base64.b64decode(d['data'])
            import io
            im = Image.open(io.BytesIO(raw)).convert('RGB')
            resized = im.resize((880, 550), Image.Resampling.LANCZOS)
            quantized = resized.convert('P', palette=Image.Palette.ADAPTIVE, colors=128)
            pil_images.append(quantized)

        gif_out = os.path.join(TARGET_DIR, 'betterme-demo.gif')
        pil_images[0].save(
            gif_out,
            save_all=True,
            append_images=pil_images[1:],
            duration=120,
            loop=0,
            optimize=True
        )
        print(f'Saved synthetic demo GIF: {gif_out} ({os.path.getsize(gif_out)/(1024*1024):.2f} MB)')

if __name__ == '__main__':
    asyncio.run(main())
