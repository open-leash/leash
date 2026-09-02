<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:6366F1,45:14B8A6,100:111827&height=230&section=header&text=Leash&fontSize=68&fontColor=ffffff&fontAlignY=38&desc=Control%20your%20AI.&descSize=22&descAlignY=59" alt="Leash: Control your AI" width="100%" />

<img src="assets/openleash-icon.png" alt="Leash" width="76" />

<h2>The open-source safety layer for AI agents.</h2>

<p>
  Monitor every action. Ask when it matters.<br />
  <strong>Stop damage before it happens.</strong>
</p>

<p>
  <a href="https://github.com/open-leash/leash/releases"><img src="https://img.shields.io/badge/Download-Leash-6366F1?style=for-the-badge&logo=github&logoColor=white" alt="Download Leash" /></a>
  <a href="https://docs.openleash.com"><img src="https://img.shields.io/badge/Read-the%20docs-14B8A6?style=for-the-badge&logo=readthedocs&logoColor=white" alt="Read the docs" /></a>
  <a href="https://openleash.com"><img src="https://img.shields.io/badge/Visit-openleash.com-111827?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Visit openleash.com" /></a>
</p>

<p>
  <a href="https://github.com/open-leash/leash/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/open-leash/leash/ci.yml?branch=main&style=flat-square&label=build" alt="Build status" /></a>
  <a href="https://github.com/open-leash/leash/stargazers"><img src="https://img.shields.io/github/stars/open-leash/leash?style=flat-square&logo=github&label=stars&color=F59E0B" alt="GitHub stars" /></a>
  <a href="https://github.com/open-leash/leash/releases"><img src="https://img.shields.io/github/v/release/open-leash/leash?display_name=tag&sort=semver&style=flat-square&color=6366F1" alt="Latest release" /></a>
  <img src="https://img.shields.io/badge/macOS-supported-111111?style=flat-square&logo=apple&logoColor=white" alt="macOS supported" />
  <img src="https://img.shields.io/badge/Windows-supported-2774CA?style=flat-square&logo=windows&logoColor=white" alt="Windows supported" />
</p>

</div>

---

<div align="center">
  <img src=".github/readme/control-your-ai.gif" alt="Leash Security, Cost, Activity, and Rules controls" width="100%" />
  <br />
  <sub>Security, Cost, Activity, and Rules. One control layer for every agent.</sub>
</div>

<br />

<p align="center"><strong>Works with the agents you already use.</strong></p>

<p align="center">
  <img src="assets/agents/claude.png" alt="Claude Code" title="Claude Code" width="42" />&nbsp;&nbsp;
  <img src="assets/agents/codex.png" alt="OpenAI Codex" title="OpenAI Codex" width="42" />&nbsp;&nbsp;
  <img src="assets/agents/googlegemini.png" alt="Gemini CLI" title="Gemini CLI" width="42" />&nbsp;&nbsp;
  <img src="assets/agents/cursor.png" alt="Cursor" title="Cursor" width="42" />&nbsp;&nbsp;
  <img src="assets/agents/githubcopilot.png" alt="GitHub Copilot" title="GitHub Copilot" width="42" />&nbsp;&nbsp;
  <img src="assets/agents/opencode.png" alt="OpenCode" title="OpenCode" width="42" />&nbsp;&nbsp;
  <img src="assets/agents/cline.png" alt="Cline" title="Cline" width="42" />&nbsp;&nbsp;
  <img src="assets/agents/windsurf.png" alt="Windsurf" title="Windsurf" width="42" />
</p>

---

## 🛡️ AI moves fast. Leash checks first.

Leash sits between your AI agents and the actions they take. Safe work keeps moving; sensitive work becomes a clear decision you can understand and control.

| 🛡️ **Security** | 💸 **Cost** | 📡 **Activity** | 📏 **Rules** |
| :--- | :--- | :--- | :--- |
| Stop destructive commands, secret exposure, prompt injection, and unsafe tools. | Remove repeated context automatically with Token Saver. | Follow agents, commands, files, tools, and approvals in one live view. | Protect important folders and require approval for actions you choose. |

```text
  agent proposes an action
              │
              ▼
     ╭───────────────────╮       safe       ─────────▶ continue
     │       LEASH       │
     │ observe · evaluate│       sensitive  ─────────▶ ask you
     │ ask · stop        │
     ╰───────────────────╯       dangerous  ─────────▶ stop
```

---

## ✨ See Leash in action

<table>
  <tr>
    <td width="50%" align="center">
      <img src=".github/readme/island.png" alt="Leash Island approval" width="92%" />
      <br /><strong>Answer the exact decision</strong><br />
      <sub>The Island shows approvals and live agents without breaking your flow.</sub>
    </td>
    <td width="50%" align="center">
      <img src=".github/readme/desktop-setup.png" alt="Leash desktop Island setup" width="100%" />
      <br /><strong>Desktop protection that feels native</strong><br />
      <sub>Install once, choose your agents, and keep protection close.</sub>
    </td>
  </tr>
</table>

<div align="center">
  <img src=".github/readme/cloud-dashboard.png" alt="Leash Cloud cost intelligence dashboard" width="100%" />
  <br /><strong>Understand AI usage across projects and providers</strong><br />
  <sub>Leash Cloud adds personal web access and Business administration on top of the same public runtime.</sub>
</div>

<p align="center"><sub>The Business control plane shown above is a hosted Leash Cloud service and is not included in this public repository.</sub></p>

---

## ⚙️ One Engine. Every agent.

```text
AI agent hooks + provider traffic
                │
                ▼
        ┌────────────────┐
        │  Leash Engine  │──▶ first-party Features
        │                │──▶ approvals + history
        │                │──▶ local Postgres
        └───────┬────────┘
                │
         Desktop · Mobile
```

The public repository ships the complete personal runtime. Features are reviewed TypeScript handlers that run in process. There is no marketplace code, per-feature container, or hidden local backend.

Safe actions stay invisible and fast. When something needs attention, Leash gives you the exact agent, command, project, reason, and decision instead of a generic warning.

---

## 🚀 Run Leash locally

Personal Open Source (BYOK) runs on your computer with your own model-provider key. It does not require a Leash account or Leash Cloud.

```bash
git clone https://github.com/open-leash/leash.git
cd leash
npm install
npm run dev:mode:individual-open-source
```

Docker is used for the local Postgres/API stack. Leash Features themselves always run in-process inside Engine.

<details>
<summary><strong>🧱 Explore the complete public runtime</strong></summary>

| Path | What lives there |
| :--- | :--- |
| `apps/engine` | Personal event API, decisions, approvals, Features, and migrations |
| `apps/desktop` | macOS and Windows app, tray, Island, hooks, and proxy management |
| `apps/mobile` | Optional iOS and Android companion |
| `apps/local-proxy` | Native provider-traffic enforcement edge |
| `apps/provider-sync-worker` | Optional provider activity scheduler |
| `apps/flow-viewer` | Local trace and decision viewer |
| `packages/shared` | Versioned contracts shared across clients and runtime |

Useful checks:

```bash
npm run typecheck
npm test -w @openleash/client-api
npm test -w @openleash/desktop-client
npm run test:deployment
```

Package names retain `openleash` and `client-api` where changing them would break existing installations. The product UI and new documentation use **Leash** and **Engine**.

</details>

---

## 💜 Built in the open

Leash is for people who want powerful agents without giving up the final say. If that matters to you, try it, open an issue, or give the project a star. It genuinely helps more people find it.

<div align="center">

**Fast agents. Human boundaries.**

<p>
  <a href="https://github.com/open-leash/leash"><img src="https://img.shields.io/badge/⭐_Star-Leash-F59E0B?style=for-the-badge" alt="Star Leash" /></a>
  <a href="https://github.com/open-leash/leash/issues/new"><img src="https://img.shields.io/badge/Report-a%20bug-EC4899?style=for-the-badge&logo=github&logoColor=white" alt="Report a bug" /></a>
</p>

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:111827,55:14B8A6,100:6366F1&height=120&section=footer" width="100%" />

</div>
