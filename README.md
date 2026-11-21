<div align="center">
  <img src="apps/web/public/brand/betterme-icon.png" alt="BetterMe" width="88" />

  <h1>BetterMe</h1>

  <p>
    <strong>Local-First Career OS &amp; Evidence-Grounded AI Agent Workspace</strong><br/>
    Turn real experience into structured career assets, explore real employers in 3D, and stay in full control of your data.
  </p>

  <p>
    <strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a>
  </p>

  <p>
    <a href="https://nanfengovo.github.io/better-me/"><strong>🌐 Live Web Preview</strong></a> ·
    <a href="https://github.com/nanfengovo/better-me/releases/latest"><strong>📦 Download Desktop App</strong></a> ·
    <a href="#-quick-start"><strong>🚀 Quick Start</strong></a> ·
    <a href="CONTEXT.md"><strong>📐 Product Boundaries</strong></a> ·
    <a href="docs/ROADMAP.md"><strong>🗺️ Roadmap</strong></a>
  </p>

  <p>
    <a href="https://github.com/nanfengovo/better-me/actions/workflows/ci-pages.yml"><img src="https://github.com/nanfengovo/better-me/actions/workflows/ci-pages.yml/badge.svg?branch=main" alt="CI" /></a>
    <a href="https://github.com/nanfengovo/better-me/releases/latest"><img src="https://img.shields.io/github/v/release/nanfengovo/better-me?color=1b5147" alt="Latest Release" /></a>
    <img src="https://img.shields.io/badge/Local--First-SQLite%20%2B%20IndexedDB-0f766e" alt="Local-First" />
    <img src="https://img.shields.io/badge/Desktop-macOS%20%7C%20Windows%20%7C%20Linux-334155" alt="Cross-Platform" />
    <img src="https://img.shields.io/badge/3D%20Atlas-MapLibre%20%2B%20Cesium-0284c7" alt="3D Atlas" />
  </p>
</div>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/media/showcase-20261121/02-resume-studio-dark-hd.png" />
    <source media="(prefers-color-scheme: light)" srcset="docs/media/showcase-20261121/04-resume-studio-en-hd.png" />
    <img src="docs/media/showcase-20261121/04-resume-studio-en-hd.png" alt="BetterMe Resume Studio — Calm Craft OS with live A4 preview" width="100%" />
  </picture>
</p>

---

## Why BetterMe?

Most "AI resume builders" are single-shot prompt wrappers: models invent metrics out of thin air, switching templates scatters your edits, and job applications disappear into disconnected tabs.

**BetterMe separates Career Assets from Controlled Agent Execution:**

| Capability | Typical AI Resume Tools | **BetterMe** |
| :--- | :--- | :--- |
| **Data Ownership** | Cloud lock-in, opaque retention | **100% Local-First** — SQLite + IndexedDB, standard JSON Resume, checkpoints & local **MCP Server** |
| **Factual Integrity** | Hallucinated numbers & silent rewrites | **Evidence-Grounded + Rewrite Guard** — unverified metrics stay isolated; novel numbers in AI rewrites are blocked |
| **Templates & Export** | A handful of rigid layouts | **119 layouts** → PDF, DOCX, Markdown, RenderCV YAML, **JSON Resume**, & **Dual-Mode Interactive HTML Portfolio** |
| **Job Exploration** | Flat lists with stale links | **3D Job Atlas** + Official ATS discovery (Workday, Eightfold, Workable, SmartRecruiters) + **Zero-Auth ATS Diagnostics** |
| **Desktop Craft** | Generic web forms | **Calm Craft OS** — `⌘ K` Command Palette, Skill-to-Evidence Atlas, A4 page-break guides, customizable shortcuts & Undo/Redo |

---

## ✨ Key Features

### 1. Evidence-Grounded Resume Studio (`Calm Craft OS`)
- **Single Source of Truth (`FactBase`)**: Maintain experiences, verified metrics, causal context, and bilingual fields once; project into multiple role-targeted resume views without duplicating edits.
- **Tactile Desktop Editing & Live ATS View**: 60fps pointer drag-and-drop sorting, inline selection writing bubble (with non-fabricating `[X]` metric scaffolds), real-time A4 page counter & dashed page-break guides, click-to-edit directly from the A4 paper, and a **Visual | ATS Parser** preview switcher.
- **Skill-to-Evidence Atlas & Dual-Mode Interactive HTML Export**: Explore skills as tactile CSS-3D keycaps linked to verified experience claims, toggle inclusion per resume view, and export a 100% self-contained single-file `.html` portfolio (interactive atlas + classic print-ready CV, contact PII redacted by default, zero external CDNs).
- **119 Templates & Multi-Format Export**: Switch seamlessly across curated, RenderCV, and JSON Resume themes; export print-ready **PDF**, editable **DOCX** (with optional photo), **Markdown**, **RenderCV YAML**, and bidirectional standard **JSON Resume (`jsonresume.org`)**.

<p align="center">
  <img src="docs/media/showcase-20261116/showcase-resume-copilot.gif" alt="BetterMe Resume Studio, 119 templates, and evidence-anchored AI copilot" width="900" />
</p>

### 2. Command Palette, Customizable Shortcuts & Document Undo/Redo
- **Global Command Palette (`⌘/Ctrl + K`)**: Jump across workspaces, toggle themes/focus mode, switch templates, export JSON Resume or Interactive HTML Portfolio, and open MCP setup without lifting your hands off the keyboard.
- **Built-in Desktop Shortcuts**: `⌘/Ctrl + K` Command Palette, `⌘/Ctrl + J` Find Jobs, `⌘/Ctrl + Z` Undo, `⇧ ⌘ Z / Ctrl + Y` Redo, `⌘/Ctrl + S` Save, `⇧ ⌘ S` Version History, `⇧ ⌘ F` Focus Mode, `⇧ ⌘ D` Content/Design toggle, `⌘/Ctrl + ,` Settings, and `⌥/Alt + 1–4` Workspace switching.
- **Live Keycap Recorder**: Rebind any shortcut inside **Settings → Keyboard Shortcuts** with instant conflict detection and global effect.

<p align="center">
  <img src="docs/media/showcase-20261121/03-shortcuts-settings-hd.png" alt="BetterMe System Settings — Customizable Keyboard Shortcuts" width="900" />
</p>

### 3. 3D Job Atlas & Official Employer Discovery
- **Multi-Scale 3D Rendering**: Seamless zoom from global/national clusters to street-level 3D buildings powered by **MapLibre GL WebGL2** and **Cesium**, with offline Natural Earth fallback.
- **Official Career Discovery & Background Watch**: Discover real openings directly from employer ATS platforms (**Workday, Eightfold PCS, Workable, SmartRecruiters**) using your resume's skills, role, and location—with background watch notifications and zero silent auto-apply.

<p align="center">
  <img src="docs/media/showcase-20261116/showcase-atlas-3d-radar.gif" alt="BetterMe 3D Job Atlas and Nearby Company Radar" width="900" />
</p>

### 4. Controlled Career Agent, Rewrite Guard & Local MCP Server
- **Unified `AgentTaskKernel` & Rewrite Fact-Preservation Guard**: JD breakdown, resume alignment, mock interviews, and multi-role review committees share one auditable task protocol. Every AI rewrite proposal passes through a deterministic numeric fact-preservation guard that blocks ungrounded numbers before they can enter your `FactBase`.
- **BetterMe Local MCP Server**: Expose your local `FactBase`, verified claims, ATS scorer, and rewrite grounding guard to **Claude Desktop**, **Cursor**, or **Antigravity** over stdio (`pnpm mcp:start`), with PII redacted by default and copy-ready setup inside **Settings → MCP Connector** ([docs/guides/mcp-server.md](docs/guides/mcp-server.md)).
- **On-Demand Practice Workshop & 20-Node Autopilot**: Turn real JD gaps into targeted exercises (writing, tradeoffs, scheduling, or sandboxed QuickJS coding tasks) with 24-hour transfer retests (works with local Ollama models), and orchestrate reviewable opportunity workflows while keeping login, CAPTCHAs, and final submissions strictly under human control.

<p align="center">
  <img src="docs/media/showcase-20261116/showcase-agent-autopilot.gif" alt="AI Career Advisor, Career Studio, 3D Opportunities, and Autopilot Studio" width="900" />
</p>

<details>
<summary>📸 View More High-Resolution Screenshots (Light / Dark / Modules)</summary>
<br/>

| Light Mode (ZH) | Dark Mode |
| :---: | :---: |
| <img src="docs/media/showcase-20261121/01-resume-studio-light-hd.png" alt="Resume Studio Light" width="440" /> | <img src="docs/media/showcase-20261121/02-resume-studio-dark-hd.png" alt="Resume Studio Dark" width="440" /> |

| 3D Atlas Panorama | Nearby Company Radar |
| :---: | :---: |
| <img src="docs/media/showcase-20261116/05-atlas-panorama.png" alt="3D Atlas Panorama" width="440" /> | <img src="docs/media/showcase-20261116/06-atlas-3d-nearby-radar.png" alt="Nearby Company Radar" width="440" /> |

| AI Career Advisor | Autopilot 20-Node DAG Studio |
| :---: | :---: |
| <img src="docs/media/showcase-20261116/07-ai-advisor.png" alt="AI Career Advisor" width="440" /> | <img src="docs/media/showcase-20261116/10-autopilot-studio.png" alt="Autopilot Studio" width="440" /> |

</details>

---

## 📦 Download & Try Now

### 🌐 Online Preview & Zero-Auth Tools
Try the Agent OS UI, 119 resume templates, and zero-login browser tools directly (static build, no local backend):
- **Agent OS Workspace**: 👉 **[https://nanfengovo.github.io/better-me/](https://nanfengovo.github.io/better-me/)**
- **Zero-Auth ATS & JD Diagnostics**: 👉 **[https://nanfengovo.github.io/better-me/?view=ats](https://nanfengovo.github.io/better-me/?view=ats)** (pure browser deterministic scoring, no upload, no API key)
- **Editorial Product Overview**: 👉 **[https://nanfengovo.github.io/better-me/?view=landing](https://nanfengovo.github.io/better-me/?view=landing)**

### 💻 Desktop Installers (macOS / Windows / Linux)
Pre-built native Electron installers with bundled local services (`agent-host` + `job-service`) and verified `SHA256SUMS` are published on **[GitHub Releases](https://github.com/nanfengovo/better-me/releases/latest)**:

| Platform | Architecture | Installer / Archive | Checksums |
| :--- | :--- | :--- | :--- |
| **macOS** | Apple Silicon (`arm64`) | [`.dmg`](https://github.com/nanfengovo/better-me/releases/latest) · [`.zip`](https://github.com/nanfengovo/better-me/releases/latest) | `SHA256SUMS-darwin-arm64.txt` |
| **macOS** | Intel (`x64`) | [`.dmg`](https://github.com/nanfengovo/better-me/releases/latest) · [`.zip`](https://github.com/nanfengovo/better-me/releases/latest) | `SHA256SUMS-darwin-x64.txt` |
| **Windows** | `x64` | [`-setup.exe`](https://github.com/nanfengovo/better-me/releases/latest) | `SHA256SUMS-win32-x64.txt` |
| **Linux** | `x64` (glibc ≥ 2.34) | [`.AppImage`](https://github.com/nanfengovo/better-me/releases/latest) | `SHA256SUMS-linux-x64.txt` |

> **Note**: macOS builds use ad-hoc signing and Windows builds are currently unsigned. Verify the published SHA-256 checksums before installation.

---

## 🚀 Quick Start

### Option 1: Run from Source (Recommended for Developers)

Requirements: **Node.js `^24.15.0 || >=26`** and **pnpm `11.9.0`**.

```bash
git clone https://github.com/nanfengovo/better-me.git
cd better-me
pnpm install --frozen-lockfile
pnpm dev
```

Open `http://localhost:5173/`. The dev entrypoint automatically launches the Web Studio (`5173`), `agent-host` (`5179`), and `job-service` (`5178`).

### Option 2: Docker Compose (Self-Hosted)

```bash
git clone https://github.com/nanfengovo/better-me.git
cd better-me
docker compose up -d --build --wait
```

Open `http://127.0.0.1:8080/`. See [docs/deployment.md](docs/deployment.md) for persistent volume and OIDC options.

---

## 📐 Architecture

```mermaid
flowchart LR
  subgraph Client["Desktop (Electron) & Web Studio (React 19 + Vite)"]
    DS["design-system<br/>Calm Craft OS Primitives"]
    RS["Resume Studio &<br/>119 Templates"]
    AT["3D Job Atlas<br/>MapLibre + Cesium"]
    AG["Career Agent &<br/>Practice Workshop"]
  end

  subgraph Core["Shared Workspace Packages"]
    PC["@better-me/core<br/>FactBase & Projection"]
    PS["@better-me/storage<br/>Checkpoints & Diff"]
    PO["@better-me/opportunities<br/>Pipeline & Scoring"]
    PA["@better-me/source-adapters<br/>Workday / Eightfold / Workable"]
  end

  subgraph LocalServices["Local-First Runtime (Loopback Only)"]
    AH["agent-host :5179<br/>AgentTaskKernel + QuickJS Sandbox"]
    JS["job-service :5178<br/>SQLite Index + Background Watch"]
  end

  Client --> Core
  Client <--> LocalServices
  LocalServices --> Core
```

### Verification Commands

```bash
pnpm lint               # ESLint (--max-warnings 0)
pnpm typecheck          # Full Turborepo TypeScript check
pnpm test               # Complete unit & resume-quality suites
pnpm desktop:build      # Build & sync native Electron desktop runtime
```

---

## 🛡️ Privacy & Safety Boundaries

- **Local by Default**: Resumes, checkpoints, job indices, and learning logs stay on your machine—zero telemetry, zero forced cloud sync.
- **No Silent Fabrication**: Unverified metrics are visually flagged and filtered out of exported resumes until explicitly confirmed.
- **Human-in-the-Loop**: External logins, CAPTCHAs, final submissions, and sandboxed tools always require explicit user confirmation.
- **Isolated Local Bridge**: Development bridge routes bind to loopback with one-time expiring bearer grants and custom origin checks.

---

## 📄 Documentation & Releases

- [简体中文 README](README.zh-CN.md)
- [Product Boundaries (`CONTEXT.md`)](CONTEXT.md)
- [Roadmap (`docs/ROADMAP.md`)](docs/ROADMAP.md)
- [Docker Deployment (`docs/deployment.md`)](docs/deployment.md)
- [Release Notes (`docs/releases/v1.3.0.md`)](docs/releases/v1.3.0.md)
