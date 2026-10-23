# dsh-chatbox-compat

**给从 Chatbox / Cherry Studio 迁到 DeepSeek Harness 的人，补回三样东西。**

Chatbox 用户换到 DSH 之后，最不习惯的通常是这三件事：

1. 记忆看不见、删不掉
2. 不知道自己开了哪些能力
3. 长对话没法带进新对话

这个插件把这三件事按 Chatbox 的交互补回来。

> Status: **0.1.0 · Windows 优先 · 适配 DSH Desktop 0.2.x**
> 用到的是 DSH 的内部插件契约（slot / tool / session log），不是稳定的公开 API，跨小版本可能需要适配。

---

## 功能

| 功能 | 说明 |
|---|---|
| **记忆管理页** | 在输入框上方点「⚙ 工作模式 → 记忆」，能看到全部条目、逐条删除、一键关掉全局注入。AI 也能用 `memory_save` / `memory_delete` / `memory_search` / `memory_list` 增删查 |
| **模式面板** | 对话模式 / 工作模式切换；Skills 与 MCP 每条独立开关（真实生效，不是摆设） |
| **压缩对话** | 「打包到新对话」→ 自定义压缩提示词 + 附加要求 → 生成 handoff 摘要，复制后贴到新会话 |
| **温度 HUD** | Windows 下显示 CPU（ACPI 热区）与 GPU（nvidia-smi）温度，无需管理员、不装第三方工具 |
| **本地知识库** | SQLite + FTS5，中文按二元组切分。索引目录后模型可用 `kb_search` 检索 |

## 安装

DSH Desktop 没有 `dsh plugin add` CLI，所以用附带脚本完成同样的动作（建目录联接 + 写 `cordis.patch.yml`，改前自动备份）：

```powershell
# 1. 下载并解压到任意目录，例如 D:\tools\dsh-chatbox-compat
cd D:\tools\dsh-chatbox-compat
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

脚本会：

1. 探测 `%APPDATA%\dsh-desktop\harness`
2. 把本目录 link 到 `profiles\web\node_modules\dsh-chatbox-compat`
3. 往 `profiles\web\cordis.patch.yml` 追加一条 `insert` 记录（备份到 `harness\backups\`）
4. 初始化 `memory\MEMORY.md` 与 `chatbox-compat\settings.json`

然后**完全重启 DSH Desktop**。

卸载：

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

记忆、设置、知识库都会保留。

## 首次使用

1. **记忆是空的** —— 对 AI 说「记住：…」就会写入，或直接在面板里看。
2. **知识库是空的** —— 面板 → 知识库 → 填一个目录 → 点「索引」。默认根目录是 `%USERPROFILE%\kb`。
3. **压缩需要 API key** —— 从 `harness\.credentials.yaml` 的 `DEEPSEEK_API_KEY` 读取（在 DSH 里登录过就会有）。没有 key 时按钮会提示而不是静默失败。

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `DSH_HOME` | `%APPDATA%\dsh-desktop\harness` | Harness 主目录 |
| `DSH_COMPAT_PORT` | `43210` | HTTP 端口，被占用时自动 +1（最多试 12 次） |
| `DSH_KB_DIR` | `%USERPROFILE%\kb` | 知识库默认根目录 |
| `DSH_HANDOFF_MODEL` | `deepseek-chat` | 压缩用的模型 |
| `DSH_HANDOFF_ENDPOINT` | `https://api.deepseek.com/chat/completions` | 压缩用的接口（可指向自建/代理） |

## 已知限制

- **只测过 DSH Desktop 0.2.1-rc.2**。slot 名（`conversation.input.dock`）和各服务的结构属于内部契约，0.1.x / 0.3.x 可能不兼容。
- **温度只支持 Windows**。其他平台会自动隐藏温度那一行。
- **压缩后不会自动新建会话**。SDK 里 `sessions.create` + `session.prompt` 还没验证稳定，所以现在是「复制 → Ctrl+Alt+N → 粘贴」。
- **知识库是关键词检索，不是向量检索**。中文靠二元组，语义相近但用词不同的内容会漏。
- **不是一个进程隔离的插件**。它跑在 harness 进程里，崩溃会影响 DSH（已做大量 try/catch，但没有沙箱）。

## 目录结构

```
lib/index.js     host：记忆、知识库、温度、压缩、HTTP 与工具注册
lib/client.js    浏览器侧：HUD、模式面板、压缩弹窗
install.ps1      安装（junction + patch）
uninstall.ps1    卸载（保留数据）
```

## License

MIT
