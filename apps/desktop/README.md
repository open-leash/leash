<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:F59E0B,45:10B981,100:111827&height=220&section=header&text=Leash%20Desktop&fontSize=52&fontColor=ffffff&fontAlignY=38&desc=Engine-backed%20agent%20hooks%20and%20approvals.&descSize=18&descAlignY=58" width="100%" />

<p>
  <img src="https://img.shields.io/badge/Electron-desktop-47848F?style=for-the-badge&logo=electron&logoColor=white" />
  <img src="https://img.shields.io/badge/Local%20Relay-hooks-F59E0B?style=for-the-badge" />
  <img src="https://img.shields.io/badge/Backend-required-10B981?style=for-the-badge" />
</p>

<h3>🖥 Control your agents with a local control point.</h3>

</div>

---

## ✨ What this app is

Leash Desktop is the installed client: tray app, local helper API, approval UI, hook installer, update checks, and deployment CLI. Its source lives at `apps/desktop` in the [Leash monorepo](https://github.com/open-leash/leash).

The attention Island is an optional, non-activating, top-center overlay for the moments
when an agent needs a person. Setup shows a real preview and asks whether to
enable it. The tray is always installed, and Island visibility can be changed
later in Settings. It presents Leash policy approvals, native
agent questions and plan reviews, blocked actions, and completion notices
without opening the main window or stealing focus from the terminal.

Native interaction support is capability-based:

| Agent adapter | Policy approvals | Native questions | Plan review | Completion |
| --- | --- | --- | --- | --- |
| Claude Code / NanoClaw | Yes | Yes, answers resume the hook | Yes | Yes |
| OpenCode | Yes | Yes, answers use OpenCode's question API | Agent-dependent | Yes |
| Codex / Copilot / Gemini and other installed hooks | Yes | When their stable hook contract exposes structured answers | When exposed | When their stop hook is available |

The overlay is implemented with Electron primitives available on macOS and
Windows (`showInactive`, frameless transparent windows, skip-taskbar, and
always-on-top). "Open agent" activates a likely host application; it is not
described as an exact session jump unless that agent publishes a stable deep
link.

Enabled built-in Features can contribute typed, expiring annotations, activity, progress,
and ambient status to Live Sessions through the shared Island API. Leash
owns layout, accessibility, truncation, animation, and safe navigation. Features
cannot inject HTML, CSS, JavaScript, arbitrary URLs, shell commands, or custom
Electron IPC.

Installed hooks call the configured managed Leash API (the URL retains its
OpenLeash compatibility hostname):

```text
https://api.openleash.com/v1/hooks/:agent/:event
```

Personal Open Source installs use the locally running Leash Engine URL. The desktop local API still exists for setup, tray state, OAuth callbacks, local cache, local development, and compatibility relay behavior. If the configured Engine is unavailable, enforcement fails closed.

---

## 🚀 Modes

| Mode | Behavior |
| --- | --- |
| 🧑‍💻 Personal Open Source | Desktop uses the locally running public Leash Engine and Postgres; hooks target that local API. |
| ☁️ Leash Cloud | Hooks target Leash-hosted cloud APIs; desktop receives personal state and approvals from Leash Cloud. |

---

## 🧩 Feature settings

Personal users can configure the first-party Features shipped with Leash.
There is no public marketplace, uploader, publisher profile, or organization
policy surface.

Desktop and the signed-in person's personal web surface share the same view
model: Overview, Agents, Features, approvals, history, notifications, and
permitted settings. Overview leads with the current device and relative sync
state. Agent enablement lives on Agents. Business roles never unlock employee,
cost, identity, billing, or organization-policy administration in Desktop.

Settings can also exclude explicit project folders on one Mac. Exclusions are
stored in Leash's local application data, apply to every nested folder, and
bypass evaluation, history, notifications, and tool gating before an event is
forwarded to the configured Engine. Full-proxy provider traffic still transits
the local Leash process, but it is forwarded unchanged when the agent reports
an excluded working directory.

---

## 🛠 Run locally

Best path:

```bash
python3 run.py
```

Direct app run:

```bash
npm install
npm run desktop
```

CLI examples:

```bash
npm run desktop-cli -- discover
npm run desktop-cli -- install-hooks --all
npm run desktop-cli -- plugins list --search token
npm run desktop-cli -- plugins install token-saver sec-evaluator
npm run desktop-cli -- plugins uninstall token-saver sec-evaluator
npm run desktop-cli -- configure --token "$OPENLEASH_TOKEN" --remote-api-url https://api.openleash.com
```

The `plugins` CLI name is a compatibility surface. It lists and toggles the
closed catalog of built-in Features; it does not download third-party code.

---

## 🪝 Hook philosophy

- Hooks enter through the managed OpenLeash API so local and provider-cloud agent runs use the same URL.
- Install changes are explicit and reversible.
- Backend outages fail closed with a clear reason.
- Users should see what changed and how to undo it.
- Risky actions should feel clear, not spooky.

---

## 🛡 Security notes

The Electron renderer uses context isolation, sandboxing, no Node integration, and guarded external URL opening.

Keep it that way.

<div align="center">

### Fast agents. Local relay. Human confidence.

</div>
