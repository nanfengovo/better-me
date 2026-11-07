#!/usr/bin/env python3
import os
os.environ['no_proxy'] = '*'
os.environ['NO_PROXY'] = '*'
for k in ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']:
    os.environ.pop(k, None)

import asyncio
import base64
import io
import json
import subprocess
import time
import urllib.request
import websockets
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

TARGET_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '../docs/images'))
os.makedirs(TARGET_DIR, exist_ok=True)

# ----------------- 8K Modern Aesthetic Backdrop & Window Framing -----------------

def create_8k_aesthetic_backdrop(width=2560, height=1440):
    base = np.zeros((height, width, 3), dtype=np.uint8)
    for y in range(height):
        t = y / height
        base[y, :] = [int(9*(1-t) + 3*t), int(13*(1-t) + 5*t), int(24*(1-t) + 12*t)]
    bg = Image.fromarray(base)
    
    # Layer 1: Subtle star / micro-dot matrix pattern
    dots = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    d_dots = ImageDraw.Draw(dots)
    spacing = 38
    for x in range(19, width, spacing):
        for y in range(19, height, spacing):
            d_dots.rectangle([x, y, x+1, y+1], fill=(255, 255, 255, 18))
    bg.paste(dots, (0, 0), dots)
    
    # Layer 2: Vibrant multi-stop neon cosmic nebulas
    glow = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    d = ImageDraw.Draw(glow)
    
    # Emerald-Teal aurora (top right)
    d.ellipse([int(width*0.48), -int(height*0.35), int(width*1.22), int(height*0.75)], fill=(16, 185, 129, 85))
    # Electric Cyan flare (top center-right)
    d.ellipse([int(width*0.32), -int(height*0.20), int(width*0.82), int(height*0.45)], fill=(6, 182, 212, 70))
    # Electric Indigo-Violet nebula (bottom left)
    d.ellipse([-int(width*0.20), int(height*0.30), int(width*0.56), int(height*1.25)], fill=(99, 102, 241, 80))
    # Soft Purple-Magenta accent (bottom center)
    d.ellipse([int(width*0.20), int(height*0.62), int(width*0.75), int(height*1.15)], fill=(168, 85, 247, 55))
    
    glow = glow.filter(ImageFilter.GaussianBlur(135))
    bg.paste(glow, (0, 0), glow)
    
    # Layer 3: Central subtle highlight rim
    center_glow = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    d_center = ImageDraw.Draw(center_glow)
    d_center.ellipse([int(width*0.15), int(height*0.10), int(width*0.85), int(height*0.90)], fill=(56, 189, 248, 25))
    center_glow = center_glow.filter(ImageFilter.GaussianBlur(170))
    bg.paste(center_glow, (0, 0), center_glow)
    
    return bg

BACKDROP_2560 = create_8k_aesthetic_backdrop(2560, 1440)
BACKDROP_1280 = create_8k_aesthetic_backdrop(1280, 768)

def draw_cursor(img, x, y):
    pts = [(x, y), (x, y+16), (x+4, y+12), (x+7, y+19), (x+10, y+18), (x+7, y+11), (x+12, y+11)]
    d = ImageDraw.Draw(img)
    shadow_pts = [(px+1, py+1) for px, py in pts]
    d.polygon(shadow_pts, fill=(0, 0, 0, 140))
    d.polygon(pts, fill=(255, 255, 255), outline=(0, 0, 0))

def frame_app_window(inner_img, target_w=2000, target_h=1200):
    if target_w >= 2000:
        bg = BACKDROP_2560.resize((target_w, target_h), Image.Resampling.LANCZOS)
    else:
        bg = BACKDROP_1280.resize((target_w, target_h), Image.Resampling.LANCZOS)
    
    max_inner_w = int(target_w * 0.88)
    max_inner_h = int(target_h * 0.84) - 34
    
    scale = min(max_inner_w / inner_img.width, max_inner_h / inner_img.height)
    win_w = int(inner_img.width * scale)
    win_h = int(inner_img.height * scale)
    scaled_inner = inner_img.resize((win_w, win_h), Image.Resampling.LANCZOS)
    
    title_bar_h = 32
    total_win_h = win_h + title_bar_h
    
    win = Image.new('RGBA', (win_w, total_win_h), (0, 0, 0, 0))
    radius = 16
    mask = Image.new('L', (win_w, total_win_h), 0)
    d_mask = ImageDraw.Draw(mask)
    d_mask.rounded_rectangle([0, 0, win_w, total_win_h], radius=radius, fill=255)
    
    d_win = ImageDraw.Draw(win)
    d_win.rectangle([0, 0, win_w, title_bar_h], fill=(22, 27, 34, 255))
    d_win.ellipse([14, 10, 24, 20], fill=(255, 95, 86, 255))
    d_win.ellipse([32, 10, 42, 20], fill=(255, 189, 46, 255))
    d_win.ellipse([50, 10, 60, 20], fill=(39, 201, 63, 255))
    
    win.paste(scaled_inner, (0, title_bar_h))
    d_win.rounded_rectangle([0, 0, win_w-1, total_win_h-1], radius=radius, outline=(255, 255, 255, 45), width=1)
    win.putalpha(mask)
    
    shadow_pad = 50
    shadow = Image.new('RGBA', (win_w + shadow_pad*2, total_win_h + shadow_pad*2), (0, 0, 0, 0))
    d_shadow = ImageDraw.Draw(shadow)
    d_shadow.rounded_rectangle([shadow_pad, shadow_pad + 16, shadow_pad + win_w, shadow_pad + total_win_h + 16], radius=radius+4, fill=(0, 0, 0, 150))
    shadow = shadow.filter(ImageFilter.GaussianBlur(34))
    
    pos_x = (target_w - win_w) // 2
    pos_y = (target_h - total_win_h) // 2
    
    bg.paste(shadow, (pos_x - shadow_pad, pos_y - shadow_pad), shadow)
    bg.paste(win, (pos_x, pos_y), win)
    return bg

# ----------------- Chrome Automation via CDP -----------------

async def run_automation():
    print('1. Signing in via Agent Host API to acquire session cookie...')
    req = urllib.request.Request(
        'http://127.0.0.1:5179/api/v1/agent/identity/sign-in',
        data=json.dumps({'username': 'demouser', 'password': 'Password123456!'}).encode(),
        headers={'Content-Type': 'application/json', 'Authorization': 'Bearer better-me-agent-token'}
    )
    resp = urllib.request.urlopen(req)
    cookie_header = resp.headers.get('Set-Cookie')
    cookie_val = cookie_header.split('betterme_session=')[1].split(';')[0]
    print('✅ Acquired session cookie:', cookie_val[:12] + '...')

    print('2. Launching headless Google Chrome with CDP...')
    chrome_cmd = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "--headless=new",
        "--remote-debugging-port=9222",
        "--user-data-dir=/tmp/betterme-showcase-profile-vfinal",
        "--window-size=1440,900",
        "--disable-gpu",
        "http://localhost:5173/"
    ]
    proc = subprocess.Popen(chrome_cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(2.5)

    try:
        pages = json.loads(urllib.request.urlopen('http://127.0.0.1:9222/json').read())
        target = next(p for p in pages if p['type'] == 'page' and 'localhost:5173' in p['url'])
        ws_url = target['webSocketDebuggerUrl']
        print('Connected to Chrome CDP:', ws_url)

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
            await send('Network.enable')
            await send('Emulation.setDeviceMetricsOverride', {
                'width': 1440,
                'height': 900,
                'deviceScaleFactor': 1.6,
                'mobile': False
            })

            # Set auth cookie
            await send('Network.setCookie', {
                'name': 'betterme_session',
                'value': cookie_val,
                'domain': 'localhost',
                'path': '/api/v1/agent',
                'httpOnly': True,
                'sameSite': 'Strict'
            })

            # Permanent modal suppression script
            await send('Page.addScriptToEvaluateOnNewDocument', {
                'source': '''
                    const style = document.createElement("style");
                    style.id = "betterme-suppress-guides";
                    style.textContent = ".first-run-guide, [data-agent-guide], .first-run-backdrop, dialog.first-run-guide, .onboarding-modal { display: none !important; opacity: 0 !important; pointer-events: none !important; }";
                    document.documentElement.appendChild(style);
                    try {
                        localStorage.setItem("betterme:onboarding:v1", JSON.stringify({ version: 1, state: "completed" }));
                    } catch(e){}
                '''
            })

            async def eval_js(code):
                res = await send('Runtime.evaluate', {'expression': code, 'awaitPromise': True, 'returnByValue': True})
                return res.get('result', {}).get('value')

            async def capture_app_screenshot():
                await eval_js('''
                    (() => {
                        const guides = document.querySelectorAll('.first-run-guide, [data-agent-guide], [role="dialog"].onboarding-modal, .first-run-backdrop');
                        guides.forEach(g => g.remove());
                    })()
                ''')
                shot = await send('Page.captureScreenshot', {'format': 'png'})
                raw = base64.b64decode(shot['data'])
                return Image.open(io.BytesIO(raw)).convert('RGB')

            async def save_framed_screenshot(filename, quality=92):
                img = await capture_app_screenshot()
                framed = frame_app_window(img, target_w=2000, target_h=1200)
                out_path = os.path.join(TARGET_DIR, filename)
                framed.save(out_path, quality=quality)
                print(f'✅ Generated Framed Screenshot: {out_path} ({os.path.getsize(out_path)/1024:.1f} KB)')

            print('3. Initializing authenticated workspace...')
            await send('Page.reload')
            await asyncio.sleep(3.0)

            # Ingest rich synthetic data into document and writing session
            print('4. Ingesting synthetic experience & note sessions...')
            inject_script = """
            (() => {
                const keys = Object.keys(localStorage);
                let draftKey = keys.find(k => k.includes('draft:v1'));
                let writingKey = keys.find(k => k.includes('writing.v1'));
                
                if (!draftKey) {
                    const saveBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('立即保存'));
                    if (saveBtn) saveBtn.click();
                }

                // Construct clean synthetic document for 陈默
                const synthDoc = {
                    documentId: "synth-cm-2026",
                    schemaVersion: 1,
                    updatedAt: new Date().toISOString(),
                    activeResumeId: "resume-default",
                    factBase: {
                        schemaVersion: 1,
                        updatedAt: new Date().toISOString(),
                        profile: {
                            displayName: { zh: "陈默", en: "Chen Mo" },
                            headline: { zh: "高级后端技术专家 · 分布式调度系统与工业云原生", en: "Senior Backend Architect" },
                            yearsOfExperience: 6,
                            education: { zh: "华东理工大学 · 计算机科学与技术 (2016-2020)", en: "Computer Science" },
                            location: { zh: "上海", en: "Shanghai" },
                            email: "chenmo.architect@example.com",
                            phone: "+86 138-0000-8888",
                            traits: ["高并发治理", "分布式状态机", "DDD领域驱动设计"],
                            targetRoles: [{ zh: "高级后端工程师" }, { zh: "系统架构师" }],
                            links: [{ label: "GitHub", url: "https://github.com/example/chenmo" }]
                        },
                        experiences: [
                            {
                                id: "exp-sample-1",
                                type: "work",
                                org: { zh: "星汉智能科技（示例企业）" },
                                title: { zh: "后端技术专家 · 核心调度平台" },
                                start: "2023-01",
                                end: null,
                                techStack: ["C#", ".NET 8", "Go", "Docker", "Redis", "Kafka"],
                                claims: [
                                    { id: "claim-sample-1", kind: "action", text: { zh: "负责核心业务调度状态机开发，基于事件驱动与内存流水线架构，支撑高并发机器人作业。" }, tags: [] },
                                    { id: "claim-sample-2", kind: "action", text: { zh: "主导设备适配层 Adapter 重构，打通与 MES/WCS 系统的双向通信协议，提升外部系统扩展性。" }, tags: [] },
                                    { id: "claim-sample-3", kind: "action", text: { zh: "设计统一分布式链路追踪与集中式日志治理方案，秒级定位现场指令丢包与重发异常。" }, tags: [] },
                                    { id: "claim-sample-4", kind: "action", text: { zh: "核心调度系统可用性达到 99.99%，新设备接入联调周期缩短 40%。" }, tags: [], metric: { value: 40, unit: "%", confirmed: true } }
                                ]
                            }
                        ],
                        importSource: {
                            fileName: "陈默-高级架构师.pdf",
                            rawText: "个人项目：开源工业 Agent 工作台\\n技术栈：React, FastAPI, Ollama",
                            unparsedLines: [
                                "面向工业现场的开源 AI Agent 工作台 | 个人项目 | 2026 - 至今",
                                "代码库：https://github.com/example/industrial-agent",
                                "技术栈：React, FastAPI, Ollama, LangChain",
                                "项目内容：探索大语言模型在工业制造现场的应用，搭建现场设备异常排查智能知识库与问答助手。"
                            ]
                        }
                    },
                    resumeViews: [
                        {
                            id: "resume-default",
                            name: "我的简历",
                            locale: "zh",
                            templateId: "formal",
                            themeId: "modern-teal",
                            sectionOrder: ["profile", "experiences", "skills"],
                            visibleExperiences: ["exp-sample-1"],
                            textStyles: {}
                        }
                    ]
                };

                const validSession = {
                    version: 1,
                    mode: "proactive",
                    notes: [
                        {
                            id: "note-live-1",
                            state: "open",
                            source: {
                                targetRef: { kind: "claim_text", experienceId: "exp-sample-1", claimId: "claim-sample-1", locale: "zh" },
                                text: "负责核心业务调度状态机开发，基于事件驱动与内存流水线架构，支撑高并发机器人作业。",
                                label: "星汉智能科技 · 要点 1"
                            },
                            issue: {
                                kind: "vague",
                                title: "像职责清单，可以再具体一点",
                                question: "面对设备异常熔断或通信瞬断时，状态机如何保证状态闭环与任务幂等？"
                            },
                            answer: "设计心跳租约与自适应避障重试机制，断网后自动协商一致性，有效保障 100+ 机器人并发作业与状态闭环。",
                            proposedText: "主导调度核心状态机与心跳租约机制设计，断网恢复后自动协商一致性，有效保障 100+ 机器人并发作业与状态闭环。",
                            rationale: "补充了心跳租约与自洽协商的具体机制，并突出了状态闭环结果。",
                            evidenceQuotes: ["负责核心业务调度状态机开发"],
                            updatedAt: Date.now()
                        },
                        {
                            id: "note-live-2",
                            state: "applied",
                            source: {
                                targetRef: { kind: "claim_text", experienceId: "exp-sample-1", claimId: "claim-sample-2", locale: "zh" },
                                text: "参与日志模块编写与线上异常排查。",
                                label: "星汉智能科技 · 要点 2"
                            },
                            issue: {
                                kind: "vague",
                                title: "建议量化故障定位效果",
                                question: "集中式日志与分布式追踪带来了多大排查效率提升？"
                            },
                            answer: "基于 OpenTelemetry 与 Serilog 构建集中式链路追踪，排查耗时缩短 80%。",
                            proposedText: "构建基于 OpenTelemetry 的全链路分布式追踪体系，将现场故障排查耗时缩短 80%。",
                            rationale: "补充了具体开源方案与 80% 效率提升量化。",
                            evidenceQuotes: ["参与日志模块编写"],
                            updatedAt: Date.now() - 3600000
                        }
                    ]
                };

                const sessionStr = JSON.stringify(validSession);
                keys.forEach(k => {
                    if (k.includes('writing.v1')) localStorage.setItem(k, sessionStr);
                });
                localStorage.setItem('betterme.writing.v1:legacy:default-view:', sessionStr);
                
                if (draftKey) {
                    const raw = { schemaVersion: 1, savedAt: new Date().toISOString(), document: synthDoc };
                    localStorage.setItem(draftKey, JSON.stringify(raw));
                }
                return 'injected';
            })()
            """
            await eval_js(inject_script)
            await send('Page.reload')
            await asyncio.sleep(3.0)

            # ----------------- 6 Static Framed Screenshots -----------------

            # Shot 1: Dual Column Workbench
            print('📸 1. Capturing dual-column-workbench-20261108.jpg...')
            await save_framed_screenshot('dual-column-workbench-20261108.jpg')

            # Shot 2: Resume Hierarchical Typography
            print('📸 2. Capturing resume-refactored-hierarchy-20261108.jpg...')
            await eval_js('''
                (() => {
                    const pane = document.querySelector('.studio-preview-pane, .paper-sheet');
                    if (pane) pane.scrollIntoView({ behavior: 'instant', block: 'start' });
                })()
            ''')
            await asyncio.sleep(0.5)
            await save_framed_screenshot('resume-refactored-hierarchy-20261108.jpg')

            # Shot 3: Agent Copilot Diff (Strikethrough <del> & Added <ins>)
            print('📸 3. Capturing agent-copilot-diff-20261108.jpg...')
            await eval_js('''
                (() => {
                    const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('一起完善这条经历'));
                    if (btn) btn.click();
                })()
            ''')
            await asyncio.sleep(1.2)
            await save_framed_screenshot('agent-copilot-diff-20261108.jpg')

            # Shot 4: Project Understanding Flow
            print('📸 4. Capturing project-understanding-flow-20261108.jpg...')
            await eval_js('''
                (() => {
                    const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('先对齐项目理解'));
                    if (btn) btn.click();
                })()
            ''')
            await asyncio.sleep(1.5)
            await save_framed_screenshot('project-understanding-flow-20261108.jpg')

            # Shot 5: Import Supplement Review
            print('📸 5. Capturing import-supplement-review-20261108.jpg...')
            await eval_js('''
                (() => {
                    const closeBtn = document.querySelector('.understanding-panel button[aria-label*=\"收起\"], .understanding-panel button');
                    if (closeBtn) closeBtn.click();
                    const details = document.querySelector('.import-source-review, details.no-print');
                    if (details) details.open = true;
                })()
            ''')
            await asyncio.sleep(1.2)
            await save_framed_screenshot('import-supplement-review-20261108.jpg')

            # Shot 6: Version History Time Machine
            print('📸 6. Capturing version-history-timemachine-20261108.jpg...')
            await eval_js('''
                (() => {
                    const moreBtn = document.querySelector('.document-menu button');
                    if (moreBtn) moreBtn.click();
                })()
            ''')
            await asyncio.sleep(0.5)
            await eval_js('''
                (() => {
                    const histBtn = Array.from(document.querySelectorAll('.document-dropdown button, button')).find(b => b.innerText.includes('历史版本'));
                    if (histBtn) histBtn.click();
                })()
            ''')
            await asyncio.sleep(1.5)
            await save_framed_screenshot('version-history-timemachine-20261108.jpg')

            # Close version modal
            await eval_js('''
                (() => {
                    const closeBtn = document.querySelector('[role="dialog"] button');
                    if (closeBtn) closeBtn.click();
                })()
            ''')
            await asyncio.sleep(1.0)

            # ----------------- 4 Dynamic High-Quality Animated GIFs -----------------

            async def capture_frame_with_cursor(cursor_xy=None):
                img = await capture_app_screenshot()
                framed = frame_app_window(img, target_w=1280, target_h=768)
                if cursor_xy:
                    draw_cursor(framed, cursor_xy[0], cursor_xy[1])
                return framed.resize((880, 528), Image.Resampling.LANCZOS)

            # GIF 1: betterme-demo.gif (Hero Flow)
            print('🎬 Recording GIF 1: betterme-demo.gif (Hero Flow)...')
            await send('Page.reload')
            await asyncio.sleep(2.5)
            frames_hero = []

            # 1. Cursor moves to '一起完善这条经历' button
            for step in range(6):
                cx = 640 + step * 18
                cy = 280 + step * 6
                frames_hero.append(await capture_frame_with_cursor((cx, cy)))
                await asyncio.sleep(0.10)

            # 2. Click button
            await eval_js('''
                (() => {
                    const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('一起完善这条经历'));
                    if (btn) btn.click();
                })()
            ''')
            await asyncio.sleep(0.5)
            for step in range(6):
                frames_hero.append(await capture_frame_with_cursor((748, 316 + step * 4)))
                await asyncio.sleep(0.10)

            # 3. Type user answer into textarea
            chars = ["设计心跳租约", "与自适应避障", "重试机制，断网后", "自动协商一致性。"]
            accum = ""
            for chunk in chars:
                accum += chunk
                await eval_js(f'''
                    (() => {{
                        const ta = document.querySelector('#writing-answer');
                        if (ta) {{
                            ta.value = "{accum}";
                            ta.dispatchEvent(new Event('input', {{ bubbles: true }}));
                        }}
                    }})()
                ''')
                for _ in range(2):
                    frames_hero.append(await capture_frame_with_cursor((720, 360)))
                    await asyncio.sleep(0.12)

            # 4. Checkbox and proposal generation
            await eval_js('''
                (() => {
                    const chk = document.querySelector('.writing-review-compose input[type="checkbox"]');
                    if (chk) chk.click();
                    const genBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('用我的补充作为可编辑草稿') || b.innerText.includes('整理候选表达'));
                    if (genBtn) genBtn.click();
                })()
            ''')
            await asyncio.sleep(0.6)
            for step in range(8):
                frames_hero.append(await capture_frame_with_cursor((730, 420 - step * 5)))
                await asyncio.sleep(0.12)

            gif_path = os.path.join(TARGET_DIR, 'betterme-demo.gif')
            frames_hero[0].save(gif_path, save_all=True, append_images=frames_hero[1:], duration=130, loop=0)
            print(f'✅ Generated GIF 1: {gif_path} ({len(frames_hero)} frames, {os.path.getsize(gif_path)/(1024*1024):.2f} MB)')

            # GIF 2: betterme-step-understanding.gif (Project Understanding Flow)
            print('🎬 Recording GIF 2: betterme-step-understanding.gif (Project Understanding)...')
            frames_und = []
            await send('Page.reload')
            await asyncio.sleep(2.5)

            # 1. Cursor moves to '先对齐项目理解'
            for step in range(5):
                cx = 660 + step * 10
                cy = 260 + step * 8
                frames_und.append(await capture_frame_with_cursor((cx, cy)))
                await asyncio.sleep(0.10)

            # 2. Click '先对齐项目理解'
            await eval_js('''
                (() => {
                    const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('先对齐项目理解'));
                    if (btn) btn.click();
                })()
            ''')
            await asyncio.sleep(0.8)
            for step in range(6):
                frames_und.append(await capture_frame_with_cursor((710, 300 + step * 12)))
                await asyncio.sleep(0.12)

            # 3. Enter project understanding supplement
            und_chunks = ["调度中台基于 .NET 8 / ABP", "，现场对接 50 台 AGV 与立体库。"]
            und_text = ""
            for chunk in und_chunks:
                und_text += chunk
                await eval_js(f'''
                    (() => {{
                        const ta = document.querySelector('.understanding-compose textarea');
                        if (ta) {{
                            ta.value = "{und_text}";
                            ta.dispatchEvent(new Event('input', {{ bubbles: true }}));
                        }}
                    }})()
                ''')
                for _ in range(3):
                    frames_und.append(await capture_frame_with_cursor((720, 380)))
                    await asyncio.sleep(0.12)

            gif_und_path = os.path.join(TARGET_DIR, 'betterme-step-understanding.gif')
            frames_und[0].save(gif_und_path, save_all=True, append_images=frames_und[1:], duration=130, loop=0)
            print(f'✅ Generated GIF 2: {gif_und_path} ({len(frames_und)} frames, {os.path.getsize(gif_und_path)/(1024*1024):.2f} MB)')

            # GIF 3: betterme-step-import-repair.gif (1-Click Supplement & Wrap Stitching)
            print('🎬 Recording GIF 3: betterme-step-import-repair.gif (1-Click Supplement & Wrap Stitching)...')
            frames_imp = []

            # 1. Move cursor to import details accordion
            for step in range(5):
                cx = 240 + step * 8
                cy = 180 + step * 6
                frames_imp.append(await capture_frame_with_cursor((cx, cy)))
                await asyncio.sleep(0.10)

            # 2. Click to open accordion
            await eval_js('''
                (() => {
                    const d = document.querySelector('.import-source-review, details.no-print');
                    if (d) d.open = true;
                })()
            ''')
            await asyncio.sleep(0.6)
            for step in range(6):
                frames_imp.append(await capture_frame_with_cursor((280, 210 + step * 10)))
                await asyncio.sleep(0.12)

            # 3. Move cursor to '一键补录' button
            for step in range(6):
                cx = 280 + step * 12
                cy = 270 + step * 4
                frames_imp.append(await capture_frame_with_cursor((cx, cy)))
                await asyncio.sleep(0.12)

            gif_imp_path = os.path.join(TARGET_DIR, 'betterme-step-import-repair.gif')
            frames_imp[0].save(gif_imp_path, save_all=True, append_images=frames_imp[1:], duration=130, loop=0)
            print(f'✅ Generated GIF 3: {gif_imp_path} ({len(frames_imp)} frames, {os.path.getsize(gif_imp_path)/(1024*1024):.2f} MB)')

            # GIF 4: betterme-step-timemachine.gif (Version History Time Machine)
            print('🎬 Recording GIF 4: betterme-step-timemachine.gif (Version History Time Machine)...')
            frames_time = []

            # 1. Cursor to top right menu
            for step in range(5):
                cx = 600 + step * 14
                cy = 80 + step * 2
                frames_time.append(await capture_frame_with_cursor((cx, cy)))
                await asyncio.sleep(0.10)

            # 2. Open menu and click 历史版本
            await eval_js('''
                (() => {
                    const moreBtn = document.querySelector('.document-menu button');
                    if (moreBtn) moreBtn.click();
                })()
            ''')
            await asyncio.sleep(0.4)
            await eval_js('''
                (() => {
                    const histBtn = Array.from(document.querySelectorAll('.document-dropdown button, button')).find(b => b.innerText.includes('历史版本'));
                    if (histBtn) histBtn.click();
                })()
            ''')
            await asyncio.sleep(0.8)

            # 3. Browse version snapshots in modal
            for step in range(12):
                cx = 360 + (step % 4) * 8
                cy = 240 + step * 14
                frames_time.append(await capture_frame_with_cursor((cx, cy)))
                await asyncio.sleep(0.12)

            gif_time_path = os.path.join(TARGET_DIR, 'betterme-step-timemachine.gif')
            frames_time[0].save(gif_time_path, save_all=True, append_images=frames_time[1:], duration=130, loop=0)
            print(f'✅ Generated GIF 4: {gif_time_path} ({len(frames_time)} frames, {os.path.getsize(gif_time_path)/(1024*1024):.2f} MB)')

    finally:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except Exception:
            proc.kill()
        print('Chrome process terminated cleanly.')

if __name__ == '__main__':
    asyncio.run(run_automation())
