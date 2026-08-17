# Release checklist (dsh-memory-setup)

1. **Write** — package.json (dsh.bundle) + cordis.patch.yml + lib/{index,memory,scanner}.js.
2. **Verify** — node --check lib/*.js; node test/memory.test.mjs; node test/scanner.test.mjs; node test/smoke-import.mjs.
3. **Publish npm** — node scripts/publish-v5.mjs (raw-HTTP publish; token from $DSH_HOME/secrets/npm-token.txt).
4. **Topic** — add dsh-plugin / deepseek-harness / memory to the GitHub repo.
5. **awesome PR** — data/plugins/<owner>__<repo>.yml (category: memory); meet 1-day / 10-commit bar; re-run CI after 24h.
