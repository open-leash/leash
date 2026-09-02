<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:22C55E,45:0EA5E9,100:111827&height=220&section=header&text=Mobile%20Client&fontSize=54&fontColor=ffffff&fontAlignY=38&desc=Approvals%20in%20your%20pocket.&descSize=18&descAlignY=58" width="100%" />

<p>
  <img src="https://img.shields.io/badge/Flutter-iOS%20%2B%20Android-02569B?style=for-the-badge&logo=flutter&logoColor=white" />
  <img src="https://img.shields.io/badge/Approvals-fast%20decisions-22C55E?style=for-the-badge" />
  <img src="https://img.shields.io/badge/Auth-existing%20users-111827?style=for-the-badge" />
</p>

<h3>📱 Approve, deny, and stay aware away from the desktop.</h3>

</div>

---

## ✨ What this app is

Leash Mobile is the iOS/Android companion app for per-user Leash attention.

It connects to Leash Cloud or a customer-hosted API, signs existing users in through the configured identity provider, registers the phone, and lets users approve or deny held agent actions.

Mobile is sign-in only. Account creation happens from desktop or web.

---

## 🔥 What it does

- Discovers the selected API and organization
- Starts OAuth/SSO sign-in
- Registers mobile devices
- Shows approvals, agent questions, and plan reviews that need a response
- Shows blocked, completed, and subagent-completed updates
- Sends approvals, denials, question answers, and plan feedback
- Supports approval flows when users are away from the desktop

## 🔔 Notification types

| Type | What mobile shows | Available response |
| --- | --- | --- |
| `approval` | A sensitive action waiting for permission | Allow or deny, with optional guidance |
| `question` | The agent's native questions and choices | Answer each question |
| `plan_review` | The proposed plan | Approve it or request changes |
| `blocked` | A policy stopped an action | Informational |
| `completed` | An agent turn or session finished | Informational |
| `subagent_completed` | A delegated agent finished | Informational |

The signed-in app keeps an authenticated live event stream open and refreshes
these records immediately, with periodic polling only as recovery. Foreground
events also create native local notifications.

Production background delivery uses the same device-registration API and is
enabled once the store build can register a real Expo/APNs/FCM push token.
Until those provider credentials and tokens exist, a suspended or terminated
app cannot receive a background push; the live stream and local notifications
work while the app is running.

Responses are stored by Engine, then consumed by the request that
originally paused. A desktop hook or proxy therefore resumes only its own local
agent. A cloud or SaaS agent is resumed by its own server-side request. Mobile
never sends an executable command to an unrelated desktop.

Business membership does not turn Mobile into an admin console. Employees and
administrators see only their own activity, approvals, and permitted settings;
organization-wide people, cost, identity, policy, billing, and audit remain on
the private web dashboard.

---

## 🛠 Run locally

Start a local cloud simulation first:

```bash
python3 run.py
```

Choose **Leash Cloud**.

Then:

```bash
cd apps/mobile
flutter pub get
flutter run
```

iOS simulator:

```bash
flutter run -d ios \
  --dart-define=OPENLEASH_CLOUD_API_URL=http://localhost:9318 \
  --dart-define=OPENLEASH_DASHBOARD_URL=http://localhost:9302
```

Android emulator:

```bash
flutter run -d android \
  --dart-define=OPENLEASH_CLOUD_API_URL=http://10.0.2.2:9318 \
  --dart-define=OPENLEASH_DASHBOARD_URL=http://10.0.2.2:9302
```

---

## 🧠 Local API tips

- iOS Simulator can usually reach `http://localhost:9318`.
- Android Emulator may need `http://10.0.2.2:9318`.
- Physical devices need your laptop's LAN IP.
- Real OAuth requires matching provider redirect setup.
- Local dev auth is easiest for quick app testing.

---

## 🎨 UX rule

Approvals should be fast, readable, and hard to misunderstand.

This is not where users debug policy theory. This is where they make a crisp allow/deny decision.

<div align="center">

### The right human, at the right moment, with the right context.

</div>
