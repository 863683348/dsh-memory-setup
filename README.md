# dsh-memory-setup

Solve the AI goldfish brain 🐠 — a local, auditable personal memory layer for DeepSeek Harness. Remembers your **preferences, project conventions, workflows, and error lessons**, and injects them back into every session.

解决 AI 的"金鱼脑"：本地、可审计的个人记忆层——偏好、项目约定、工作方式、纠错教训，会话间自动继承。

## Install

```bash
dsh plugin --profile <profile> add dsh-memory-setup
```

## Tools

| Tool | What it does |
|---|---|
| `memory_setup` | One-time onboarding: language, code style, tools, conventions, workflows |
| `memory_status` | Read current memory + changelog (also auto-injected guidance at boot) |
| `memory_update` | Update one memory path (e.g. `preferences.codeStyle`) with a changelog entry |
| `memory_project` | Auto-extract project conventions from workspace files (README / package.json / configs), preview or apply |
| `memory_lesson` | Record an error lesson (error → fix → evidence) so the same mistake is not repeated |

## Storage & auditability

- Location: `<workspace>/.dsh-memory-setup/memory.json` — plain JSON, easy to read/back up
- Every mutation appends to `changelog` (when / what / why) — memory is **auditable by design**
- Lessons carry an optional `evidence` field (file/command/observation) — no evidence, no lesson
- Local-first: nothing leaves your machine

## Config (optional)

| Field | Default | Description |
|---|---|---|
| memoryDir | .dsh-memory-setup | memory dir relative to the session workspace |
| injectOnBoot | true | add the memory guidance section to the system prompt |
| maxMemoryChars | 6000 | cap for rendered memory text |

## Roadmap

- v0.2: dynamic memory injection per session (context()), lesson auto-detection from failed tool calls, memory rotation/expiry
- v0.3: knowledge-base module (direction 3), memory diff export

## Security

Memory plugins are the highest-trust plugin type — see SECURITY.md for the audit posture.
