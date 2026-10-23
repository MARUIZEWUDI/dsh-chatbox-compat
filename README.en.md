# dsh-chatbox-compat

[简体中文](README.md) · **English**

**Chatbox-style UX for DeepSeek Harness.**

People moving from Chatbox / Cherry Studio to DeepSeek Harness usually miss three things:

1. memory you can see and delete
2. not knowing which capabilities are switched on
3. no way to carry a long conversation into a new one

This plugin brings those three back, with Chatbox's interaction model.

> **Status: 0.1.0 · Windows-first · built against DSH Desktop 0.2.x**
> It hooks into internal plugin contracts (slots, tool registry, session logs), not a stable public API. Expect breakage between `rc` releases — see [Compatibility](#compatibility).

---

## Features

| Feature | What it does |
|---|---|
| **Memory panel** | `⚙ 工作模式 → 记忆`: list every entry, delete one by one, toggle global injection. The model also gets `memory_save` / `memory_delete` / `memory_search` / `memory_list` |
| **Mode panel** | Chat/Work switch; per-skill and per-MCP toggles that actually apply |
| **Compress chat** | `打包到新对话` → custom compression prompt + extra requirements → handoff briefing you paste into a new session |
| **Temperature HUD** | CPU (ACPI thermal zone) and GPU (`nvidia-smi`) on Windows. No admin rights, no third-party tools |
| **Local knowledge base** | SQLite + FTS5 with a CJK bigram tokenizer; the model searches it with `kb_search` |

## Install

DSH Desktop ships no `dsh plugin add` CLI, so the bundled script does the same work (junction + `cordis.patch.yml` entry, with a backup):

```powershell
# 1. download and extract anywhere, e.g. D:\tools\dsh-chatbox-compat
cd D:\tools\dsh-chatbox-compat
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

The script will:

1. locate `%APPDATA%\dsh-desktop\harness`
2. link this folder into `profiles\web\node_modules\dsh-chatbox-compat`
3. append an `insert` entry to `profiles\web\cordis.patch.yml` (backup in `harness\backups\`)
4. seed `memory\MEMORY.md` and `chatbox-compat\settings.json`

Then **restart DSH Desktop completely**.

Uninstall:

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

Your memory, settings and knowledge base are kept.

## First run

1. **Memory starts empty** — say "remember: …" and it is written, or manage it in the panel.
2. **Knowledge base starts empty** — panel → 知识库 → enter a folder → `索引`. Default root is `%USERPROFILE%\kb`.
3. **Compression needs an API key** — read from `harness\.credentials.yaml` (`DEEPSEEK_API_KEY`, written after you sign in to DSH). Without a key the button reports the problem instead of failing silently.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `DSH_HOME` | `%APPDATA%\dsh-desktop\harness` | Harness home |
| `DSH_COMPAT_PORT` | `43210` | HTTP port; auto-increments (up to 12) when taken |
| `DSH_KB_DIR` | `%USERPROFILE%\kb` | Default knowledge-base root |
| `DSH_HANDOFF_MODEL` | `deepseek-chat` | Model used for compression |
| `DSH_HANDOFF_ENDPOINT` | `https://api.deepseek.com/chat/completions` | Endpoint used for compression |

## Compatibility

| Item | Value |
|---|---|
| Tested on | **DSH Desktop `0.2.1-rc.2`** (Windows 11) |
| Declared range | `>=0.2.0 <0.3.0` |
| Not tested | `0.1.x`, `0.3.x`, macOS, Linux |

**Why this matters.** Everything here except the HTTP endpoints touches DSH internals:

- UI slot name `conversation.input.dock` — renamed slots mean the buttons silently disappear
- tool contract (`ctx.tools.register` with `output.schema` / `output.render`)
- system prompt injection (`ctx.systemPrompt.variable` / `.section`)
- session log layout (`session.v4.jsonl.zstd`, multi-frame zstd)

A new `rc` can change any of these. If the panel or buttons vanish after an update, that is the first thing to check.

**How to check your version:** DSH Desktop → 设置 → 关于，或看 `%APPDATA%\dsh-desktop\harness\.desktop-install-state.json` 里的 `harnessVersion`.

**Before filing a bug**, please include the output of:

```powershell
Get-Content "$env:APPDATA\dsh-desktop\harness\.desktop-install-state.json"
Get-Content "$env:APPDATA\dsh-desktop\logs\harness.log" -Tail 80
```

## Known limitations

- **Windows only for temperature.** Other platforms hide the temperature row automatically.
- **Compression does not create the new session.** `sessions.create` + `session.prompt` are not verified stable yet, so the flow is copy → `Ctrl+Alt+N` → paste.
- **Keyword search, not vector search.** CJK uses bigrams; semantically similar but differently worded content will be missed.
- **Not process-isolated.** The plugin runs inside the harness process; a crash can take DSH down (defensive `try/catch` everywhere, but no sandbox).
- **Chat mode only disables memory injection.** DSH has no per-session tool switch, so tools stay available.

## Layout

```
lib/index.js     host: memory, knowledge base, temperature, compression, HTTP + tools
lib/client.js    browser: HUD, mode panel, compression modal
install.ps1      install (junction + patch)
uninstall.ps1    uninstall (keeps data)
```

## License

MIT
