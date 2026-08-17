# Security posture of dsh-memory-setup

Memory plugins hold preferences, project conventions and lessons — high-trust content that
other plugins might want to read or tamper with. This plugin's posture:

1. **Local-first, transparent**: the entire memory is one readable JSON file in the session
   workspace. Nothing is sent anywhere.
2. **Audit trail**: every mutation appends to `changelog` (timestamp + action + path + summary).
   A tampered memory shows up in the changelog.
3. **Evidence rule for lessons**: `memory_lesson` requires `error` and `fix`; `evidence` is
   recommended but the tool never fabricates it.
4. **No network access**: this plugin performs no outbound requests.
5. **Containment**: all reads/writes resolve relative to the session workspace through
   `ctx.fs`, so the sandbox policy applies.

To audit your memory: read `.dsh-memory-setup/memory.json` and check `changelog` for
entries you did not make. If you see unexpected entries, your session may have been
manipulated — remove the entries and consider which plugins can write to your workspace.
