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
| `memory_review` | v0.2 — formalize an incident into a lesson with root cause; similar lessons are auto-merged (dedupe + hit counter) |
| `memory_export` | v0.2 — export the full memory + changelog to a Markdown file for review/backup |
| `knowledge_add` | v0.3 — add a knowledge entry (title/content/tags/source); similar titles auto-merge |
| `knowledge_search` | v0.3 — keyword retrieval (title ×3 / tags ×2 / content ×1 scoring) |
| `knowledge_list` / `knowledge_remove` | v0.3 — browse / delete knowledge entries |

## Storage & auditability

- Location: `<workspace>/.dsh-memory-setup/memory.json` — plain JSON, easy to read/back up
- Every mutation appends to `changelog` (when / what / why) — memory is **auditable by design**
- Lessons carry an optional `evidence` field (file/command/observation) — no evidence, no lesson
- Local-first: nothing leaves your machine

## Config (optional)

| Field | Default | Description |
|---|---|---|
| memoryDir | .dsh-memory-setup | memory dir relative to the session workspace |
| injectOnBoot | true | inject live memory into the system prompt (dynamic context, refreshed on save) |
| maxMemoryChars | 6000 | cap for rendered memory text |

## Roadmap

- v0.2 ✅: incident review with dedupe (`memory_review`), lesson/convention expiry + changelog cap (auto-pruned on save), `memory.json.bak` backup on every save, Markdown export (`memory_export`)
- v0.3 ✅: personal knowledge base (`knowledge_*`, keyword retrieval, title-merge dedupe); dynamic memory injection via a live `systemPrompt.context()` section — refreshed at boot (from the workspace path) and after every memory save (throttled 30s), with static guidance as fallback
- v0.4: embeddings-based KB retrieval, memory diff export, lesson auto-detection from failed tool calls (pending event API)

## Security

Memory plugins are the highest-trust plugin type — see SECURITY.md for the audit posture.
