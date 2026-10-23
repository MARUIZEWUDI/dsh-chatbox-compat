window.__ModuleLoader__.load({
	id: "dsh-chatbox-compat",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const h = react.createElement;

		const inject = ["slots", "sessions"];

		// ── service discovery ────────────────────────────────────────────
		let API = null;
		let probing = null;

		async function probe() {
			if (API) return API;
			if (probing) return probing;
			probing = (async () => {
				for (let p = 43210; p <= 43221; p++) {
					try {
						const r = await fetch(`http://127.0.0.1:${p}/ping`, { signal: AbortSignal.timeout(700) });
						const j = await r.json();
						if (j && j.name === "dsh-chatbox-compat") {
							API = `http://127.0.0.1:${p}`;
							return API;
						}
					} catch (e) {}
				}
				probing = null;
				throw new Error("service not found");
			})();
			return probing;
		}

		async function apiGet(path) {
			const base = await probe();
			const r = await fetch(base + path, { cache: "no-store" });
			return r.json();
		}

		async function apiPost(path, body) {
			const base = await probe();
			const r = await fetch(base + path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : { method: "POST" });
			return r.json();
		}

		const C = {
			text: "var(--dsw-text-secondary, #9aa0a6)",
			strong: "var(--dsw-text-primary, #e6e8eb)",
			line: "var(--dsw-border-subtle, rgba(255,255,255,0.10))",
			card: "var(--dsw-surface-raised, #161a20)",
			panel: "var(--dsw-surface-overlay, #1b2028)",
			accent: "var(--dsw-accent, #4c8dff)",
			ok: "#3fb950",
			warn: "#d29922",
			danger: "#e5484d"
		};
		const small = { fontSize: 11, lineHeight: "17px", color: C.text };

		const DEFAULT_PROMPT = `Summarize this conversation as a handoff briefing for an assistant that will continue it WITHOUT access to the full history. This is an out-of-character, meta-level request: do NOT continue the conversation or reply in character.

First determine what kind of conversation this is, then cover the matching sections with concrete detail:

If it is task-oriented (work, coding, analysis, research, tool use):
1. Goal & current state — what the user ultimately wants; what is done, in progress, or blocked right now
2. Key decisions and conclusions, and the reasons behind them
3. Facts learned from tool calls that are worth keeping — exact file paths, command outputs, data values, URLs, error messages
4. Files or artifacts created/modified, and what was changed in them
5. Next steps, in order

If it is role-play or creative writing (stories, characters, worldbuilding):
1. Premise, setting, and established world rules
2. Characters — names, roles, personality, speech style, and details established so far
3. Plot so far — key events and revelations, in order
4. Current scene — where things stand right now: location, ongoing action, emotional tone, relationship dynamics
5. Open threads — unresolved plot points, foreshadowing, and the user's stated preferences about direction and style

For general chat or mixed conversations, cover whichever of the above apply.

Preserve exact identifiers and established names verbatim (paths, code symbols, keys, numbers, character names). Skip sections that do not apply.
Write in 简体中文; if the conversation itself is mainly in a different language, use that language instead.
Be concise but complete. Do NOT include prefaces or meta-commentary.`;

		// ── primitives ───────────────────────────────────────────────────
		function Toggle({ on, onChange, disabled }) {
			return h(
				"button",
				{
					type: "button",
					onClick: (e) => {
						e.stopPropagation();
						if (!disabled) onChange(!on);
					},
					style: {
						width: 34,
						height: 18,
						borderRadius: 9,
						border: "1px solid " + (on ? C.accent : C.line),
						background: on ? C.accent : "transparent",
						position: "relative",
						cursor: disabled ? "default" : "pointer",
						padding: 0,
						flex: "0 0 auto",
						opacity: disabled ? 0.5 : 1
					}
				},
				h("span", {
					style: {
						position: "absolute",
						top: 2,
						left: on ? 18 : 2,
						width: 12,
						height: 12,
						borderRadius: 6,
						background: on ? "#fff" : C.text,
						transition: "left .15s"
					}
				})
			);
		}

		function Row({ icon, title, subtitle, badge, right, onClick }) {
			return h(
				"div",
				{
					onClick,
					style: { display: "flex", alignItems: "center", gap: 10, padding: "9px 4px", borderTop: "1px solid " + C.line, cursor: onClick ? "pointer" : "default" }
				},
				h("span", { style: { width: 18, textAlign: "center", opacity: 0.9, fontSize: 13 } }, icon || ""),
				h(
					"div",
					{ style: { flex: 1, minWidth: 0 } },
					h(
						"div",
						{ style: { display: "flex", alignItems: "center", gap: 6 } },
						h("span", { style: { fontSize: 12, color: C.strong } }, title),
						badge ? h("span", { style: { ...small, color: C.accent } }, badge) : null
					),
					subtitle ? h("div", { style: { ...small, opacity: 0.72, marginTop: 1, wordBreak: "break-all" } }, subtitle) : null
				),
				right || null
			);
		}

		function Btn({ children, onClick, primary, danger, disabled }) {
			return h(
				"button",
				{
					type: "button",
					onClick,
					disabled,
					style: {
						height: 22,
						padding: "0 9px",
						borderRadius: 6,
						border: "1px solid " + (danger ? C.danger : primary ? C.accent : C.line),
						background: primary ? C.accent : "transparent",
						color: primary ? "#fff" : danger ? C.danger : C.strong,
						fontSize: 11,
						cursor: disabled ? "default" : "pointer",
						opacity: disabled ? 0.5 : 1,
						flex: "0 0 auto"
					}
				},
				children
			);
		}

		function Field(props) {
			return h("input", {
				...props,
				style: {
					flex: 1,
					height: 26,
					borderRadius: 6,
					border: "1px solid " + C.line,
					background: "transparent",
					color: C.strong,
					fontSize: 11,
					padding: "0 8px",
					outline: "none",
					minWidth: 0,
					...(props.style || {})
				}
			});
		}

		// ── handoff modal ────────────────────────────────────────────────
		function Handoff({ sessionId, onClose }) {
			const [prompt, setPrompt] = react.useState(DEFAULT_PROMPT);
			const [extra, setExtra] = react.useState("");
			const [busy, setBusy] = react.useState(false);
			const [info, setInfo] = react.useState("");
			const [result, setResult] = react.useState(null);

			const run = react.useCallback(async () => {
				setBusy(true);
				setInfo("压缩中…（读取会话 → 调模型，可能要 30–90 秒）");
				try {
					const v = await apiPost("/handoff", { session: sessionId, prompt, extra });
					if (!v.ok) setInfo(v.message || "压缩失败");
					else {
						setResult(v);
						setInfo("摘要已生成。点「复制摘要」，然后 Ctrl+Alt+N 新建会话、Ctrl+V 粘贴。");
					}
				} catch (e) {
					setInfo("请求失败：本地服务没响应（可能是 DSH 刚重启，等几秒再试）。");
				} finally {
					setBusy(false);
				}
			}, [sessionId, prompt, extra]);

			const fieldStyle = {
				width: "100%",
				borderRadius: 8,
				border: "1px solid " + C.line,
				background: "rgba(0,0,0,0.18)",
				color: C.strong,
				fontSize: 11,
				padding: "8px 10px",
				outline: "none",
				resize: "vertical",
				boxSizing: "border-box",
				lineHeight: "16px",
				fontFamily: "inherit"
			};

			const copy = async () => {
				try {
					await navigator.clipboard.writeText(result.summary);
					setInfo("已复制摘要。按 Ctrl+Alt+N 新建会话，Ctrl+V 粘贴发送。");
				} catch (e) {
					setInfo("复制失败，请手动选中上方文本复制。");
				}
			};

			return h(
				"div",
				{
					style: { position: "fixed", inset: 0, zIndex: 10000, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: 60 },
					onMouseDown: (e) => {
						if (e.target === e.currentTarget) onClose();
					}
				},
				h(
					"div",
					{ style: { width: "min(620px, 94vw)", maxHeight: "84vh", overflow: "auto", borderRadius: 14, border: "1px solid " + C.line, background: C.panel, padding: "16px 18px", boxShadow: "0 18px 48px rgba(0,0,0,0.45)" } },
					h(
						"div",
						{ style: { display: "flex", alignItems: "center", marginBottom: 6 } },
						h("div", { style: { fontSize: 14, fontWeight: 650, color: C.strong } }, "压缩对话"),
						h("span", { style: { flex: 1 } }),
						h("button", { type: "button", onClick: onClose, style: { background: "transparent", border: "none", color: C.text, cursor: "pointer", fontSize: 15 } }, "\u00d7")
					),
					h("div", { style: { ...small, marginBottom: 12 } }, "将较早的消息汇总为摘要，减少上下文占用。原始对话记录仍可查看。"),
					h("div", { style: { fontSize: 11, color: C.strong, marginBottom: 4 } }, "压缩提示词"),
					h("div", { style: { fontSize: 10, opacity: 0.6, ...small, marginBottom: 6 } }, "此处修改仅对本次压缩生效。"),
					h("textarea", { value: prompt, onChange: (e) => setPrompt(e.target.value), rows: 10, style: fieldStyle }),
					h("div", { style: { fontSize: 11, color: C.strong, margin: "12px 0 6px" } }, "附加要求"),
					h("textarea", { value: extra, onChange: (e) => setExtra(e.target.value), rows: 3, placeholder: "例如：保留所有文件路径和未完成的任务。", style: fieldStyle }),
					info ? h("div", { style: { fontSize: 11, color: result ? C.ok : C.warn, marginTop: 10, lineHeight: "17px" } }, info) : null,
					result
						? h(
								"div",
								{ style: { marginTop: 10 } },
								h("div", { style: { ...small, marginBottom: 4 } }, `摘要 ${result.summary.length} 字 · 原文 ${result.transcriptChars} 字 · ${result.turns} 轮 · ${(result.ms / 1000).toFixed(1)}s`),
								h(
									"div",
									{ style: { maxHeight: 220, overflow: "auto", border: "1px solid " + C.line, borderRadius: 8, padding: "8px 10px", fontSize: 11, lineHeight: "17px", color: C.strong, whiteSpace: "pre-wrap", background: "rgba(0,0,0,0.18)" } },
									result.summary
								),
								h(
									"div",
									{ style: { display: "flex", gap: 8, marginTop: 8 } },
									h(Btn, { onClick: copy }, "复制摘要"),
									h(Btn, {
										primary: true,
										onClick: async () => {
											try {
												await navigator.clipboard.writeText(result.summary);
											} catch (e) {}
											onClose();
										}
									}, "复制并关闭")
								)
							)
						: null,
					h(
						"div",
						{ style: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 } },
						h(Btn, { onClick: onClose }, "取消"),
						h(Btn, { onClick: run, primary: true, disabled: busy }, busy ? "压缩中…" : "确认")
					)
				)
			);
		}

		// ── temp hud ────────────────────────────────────────────────────
		function useTemps() {
			const [t, setT] = react.useState(null);
			react.useEffect(() => {
				let alive = true;
				let timer = 0;
				const tick = () => {
					apiGet("/temp")
						.then((d) => {
							if (alive) setT(d);
						})
						.catch(() => {});
				};
				tick();
				timer = setInterval(tick, 4000);
				return () => {
					alive = false;
					clearInterval(timer);
				};
			}, []);
			return t;
		}

		const tone = (c) => (c == null ? C.text : c >= 90 ? C.danger : c >= 80 ? C.warn : C.strong);

		function chip(label, v) {
			return h(
				"span",
				{ key: label, style: { display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, lineHeight: "16px", color: C.text, fontVariantNumeric: "tabular-nums" } },
				label,
				h("b", { style: { color: tone(v), fontWeight: 600 } }, v == null ? "--" : v + "\u00B0")
			);
		}

		function Hud({ sessionId }) {
			const temps = useTemps();
			const [handoff, setHandoff] = react.useState(false);
			const supported = !temps || temps.supported !== false;

			return h(
				react.Fragment,
				null,
				h(
					"div",
					{ style: { display: "flex", alignItems: "center", gap: 10, padding: "0 2px 6px", fontSize: 11, color: C.text, userSelect: "none" } },
					supported ? chip("CPU", temps ? temps.cpu : null) : null,
					supported ? h("span", { style: { width: 1, height: 10, background: C.line } }) : null,
					supported ? chip("GPU", temps ? temps.gpu : null) : null,
					h("span", { style: { flex: 1 } }),
					h(
						"button",
						{
							type: "button",
							id: "chatbox-compat-pack",
							onClick: () => setHandoff(true),
							title: "压缩当前对话，生成交接摘要并带到新对话",
							style: { height: 22, padding: "0 8px", borderRadius: 6, border: "1px solid " + C.line, background: C.card, color: C.strong, fontSize: 11, cursor: "pointer" }
						},
						"\u6253\u5305\u5230\u65b0\u5bf9\u8bdd"
					)
				),
				handoff ? h(Handoff, { sessionId, onClose: () => setHandoff(false) }) : null
			);
		}

		// ── mode panel ──────────────────────────────────────────────────
		function Panel({ sessionId }) {
			const [open, setOpen] = react.useState(false);
			const [view, setView] = react.useState("root");
			const [data, setData] = react.useState(null);
			const [mem, setMem] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [err, setErr] = react.useState("");
			const [note, setNote] = react.useState("");
			const [q, setQ] = react.useState("");
			const [hits, setHits] = react.useState(null);
			const [dir, setDir] = react.useState("");

			const load = react.useCallback(async () => {
				setBusy(true);
				setErr("");
				try {
					setData(await apiGet("/summary?session=" + encodeURIComponent(sessionId || "")));
					setMem(await apiGet("/memory/list"));
				} catch (e) {
					setErr("本地服务没响应（127.0.0.1:43210 起）。DSH 重启后需要几秒。");
				} finally {
					setBusy(false);
				}
			}, [sessionId]);

			react.useEffect(() => {
				if (open && !data) load();
			}, [open, data, load]);

			react.useEffect(() => {
				if (!open) return;
				const t = data && data.kb && data.kb.task;
				if (!t || !t.running) return;
				const id = setInterval(load, 2000);
				return () => clearInterval(id);
			}, [open, data, load]);

			react.useEffect(() => {
				if (!open) return;
				const onKey = (e) => {
					if (e.key === "Escape") setOpen(false);
				};
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [open]);

			const memoryOn = !!(mem && mem.enabled);

			const setMemory = async (on) => {
				await apiPost("/memory/toggle?enabled=" + (on ? 1 : 0));
				setMem((p) => (p ? { ...p, enabled: on } : p));
				setNote(on ? "全局记忆已开启" : "全局记忆已关闭");
			};

			const removeMem = async (id) => {
				if (!window.confirm(`删除记忆 ${id}？不可撤销。`)) return;
				const v = await apiPost("/memory/delete?id=" + encodeURIComponent(id));
				setNote(v.message || "已删除");
				setMem(await apiGet("/memory/list"));
			};

			const toggleSkill = async (name, on) => {
				const v = await apiPost("/skills/toggle?name=" + encodeURIComponent(name) + "&enabled=" + (on ? 1 : 0));
				setNote(v.message || "");
				setData(await apiGet("/summary"));
			};

			const toggleMcp = async (id, on) => {
				const v = await apiPost("/mcp/toggle?id=" + encodeURIComponent(id) + "&enabled=" + (on ? 1 : 0));
				setNote(v.message || "");
				setData(await apiGet("/summary"));
			};

			const searchKb = async () => {
				if (!q.trim()) return;
				setBusy(true);
				setHits(await apiGet("/kb/search?q=" + encodeURIComponent(q.trim()) + "&limit=6"));
				setBusy(false);
			};

			const reindex = async () => {
				setBusy(true);
				const v = await apiPost("/kb/reindex");
				setNote(v.message || "");
				await load();
				setBusy(false);
			};

			const addDir = async () => {
				if (!dir.trim()) return;
				setBusy(true);
				const v = await apiPost("/kb/add?path=" + encodeURIComponent(dir.trim()));
				setNote(v.message || "");
				await load();
				setBusy(false);
			};

			if (!open) {
				return h(
					"div",
					{ style: { display: "flex", justifyContent: "flex-end", padding: "0 2px 4px" } },
					h(
						"button",
						{
							type: "button",
							onClick: () => setOpen(true),
							style: { height: 22, padding: "0 9px", borderRadius: 6, border: "1px solid " + C.line, background: C.card, color: C.strong, fontSize: 11, cursor: "pointer" }
						},
						"\u2699 工作模式"
					)
				);
			}

			const m = data && data.memory;
			const s = data && data.skills;
			const mcp = data && data.mcp;
			const ex = data && data.exec;
			const kb = data && data.kb;

			const head = (title, back) =>
				h(
					"div",
					{ style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 4 } },
					back ? h("button", { type: "button", onClick: () => setView("root"), style: { background: "transparent", border: "none", color: C.text, cursor: "pointer", fontSize: 13, padding: 0 } }, "\u2190") : null,
					h("div", { style: { fontSize: 14, fontWeight: 650, color: C.strong } }, title),
					h("span", { style: { flex: 1 } }),
					busy ? h("span", { style: { ...small, color: C.warn } }, "\u2026") : null,
					h(Btn, { onClick: load }, "刷新"),
					h(Btn, { onClick: () => setOpen(false), primary: true }, "关闭")
				);

			let body = null;

			if (view === "root") {
				body = h(
					"div",
					null,
					h(
						"div",
						{ style: { display: "flex", gap: 8, margin: "6px 0 2px" } },
						["chat", "work"].map((k) => {
							const active = k === "work" ? memoryOn : !memoryOn;
							return h(
								"button",
								{
									key: k,
									type: "button",
									onClick: () => setMemory(k === "work"),
									style: { flex: 1, height: 30, borderRadius: 15, border: "1px solid " + (active ? C.accent : C.line), background: active ? C.accent : "transparent", color: active ? "#fff" : C.text, fontSize: 12, cursor: "pointer" }
								},
								k === "work" ? "\ud83d\udcbc 工作模式" : "\ud83d\udcac 对话模式"
							);
						})
					),
					h("div", { style: { ...small, margin: "6px 0 10px", opacity: 0.8 } }, memoryOn ? "工作模式：注入全部长期记忆，工具 / MCP / 技能 / 知识库全部可用。" : "对话模式：不注入长期记忆（工具仍可用，DSH 暂不支持会话级关工具）。"),
					h("div", { style: { ...small, opacity: 0.6, margin: "8px 0 2px" } }, "内置"),
					h(Row, { icon: "\ud83c\udf10", title: "联网搜索", subtitle: "DeepSeek 服务端搜索（内置）", right: h("span", { style: { ...small, color: C.ok } }, "已启用") }),
					h(Row, {
						icon: "\ud83e\udde0",
						title: "记忆",
						badge: (mem ? mem.count : m ? m.count : "?") + " 条",
						subtitle: memoryOn ? "全局记忆 · 已注入" : "全局记忆 · 未注入",
						right: h("div", { style: { display: "flex", alignItems: "center", gap: 8 } }, h(Toggle, { on: memoryOn, onChange: setMemory }), h("span", { style: { color: C.text } }, "\u203a")),
						onClick: () => setView("memory")
					}),
					h(Row, { icon: "</>", title: "代码执行", badge: "完全访问", subtitle: ex ? ex.shell : "", right: h("span", { style: { color: C.text } }, "\u203a"), onClick: () => setView("exec") }),
					h("div", { style: { ...small, opacity: 0.6, margin: "12px 0 2px" } }, "扩展"),
					h(Row, { icon: "\ud83d\udee0", title: "Skills", badge: s ? s.count + " 个" : "\u2026", subtitle: s && s.disabled && s.disabled.length ? `已停用 ${s.disabled.length} 个` : "", right: h("span", { style: { color: C.text } }, "\u203a"), onClick: () => setView("skills") }),
					h(Row, { icon: "\ud83d\udd0c", title: "MCP", badge: mcp ? mcp.count + " 个" : "\u2026", right: h("span", { style: { color: C.text } }, "\u203a"), onClick: () => setView("mcp") }),
					h(Row, { icon: "\ud83d\udcda", title: "知识库", badge: kb ? kb.docs + " 文档" : "\u2026", subtitle: kb ? `${kb.chunks} 片段 · ${(kb.bytes / 1024 / 1024).toFixed(1)} MB` : "", right: h("span", { style: { color: C.text } }, "\u203a"), onClick: () => setView("kb") }),
					h(Row, { icon: "\ud83d\udcc1", title: "工作目录", subtitle: (data && data.cwd) || "", right: h("span", { style: { color: C.text } }, "\u203a"), onClick: () => setView("dirs") })
				);
			} else if (view === "memory") {
				body = h(
					"div",
					null,
					head("记忆", true),
					h(Row, { icon: "\ud83e\udde0", title: "全局记忆", subtitle: "所有对话共享；关闭后新请求不再注入", right: h(Toggle, { on: memoryOn, onChange: setMemory }) }),
					h(
						"div",
						{ style: { display: "flex", alignItems: "center", gap: 8, margin: "10px 0 6px" } },
						h("div", { style: { ...small, color: C.strong } }, `已保存 ${mem ? mem.count : "?"} 条`),
						h("span", { style: { flex: 1 } }),
						h("span", { style: { ...small, opacity: 0.7 } }, mem ? (mem.bytes / 1024).toFixed(1) + " KB" : "")
					),
					h(
						"div",
						{ style: { maxHeight: 340, overflow: "auto", borderTop: "1px solid " + C.line } },
						(mem && mem.entries ? mem.entries : []).map((e) =>
							h(
								"div",
								{ key: e.id, style: { display: "flex", alignItems: "flex-start", gap: 8, padding: "8px 2px", borderBottom: "1px solid " + C.line } },
								h(
									"div",
									{ style: { flex: 1, minWidth: 0 } },
									h("div", { style: { ...small, color: C.strong } }, `${e.id} · ${e.date} · ${e.title}`),
									h("div", { style: { ...small, opacity: 0.7, marginTop: 2, wordBreak: "break-word" } }, e.preview)
								),
								h(Btn, { danger: true, onClick: () => removeMem(e.id) }, "删除")
							)
						),
						mem && !mem.entries.length ? h("div", { style: { ...small, padding: 12 } }, "还没有记忆。对 AI 说「记住：…」即可新增。") : null
					)
				);
			} else if (view === "skills") {
				body = h(
					"div",
					null,
					head("Skills", true),
					(s && s.items ? s.items : []).map((it) =>
						h(Row, { key: it.path, icon: "\ud83d\udee0", title: it.name, subtitle: it.description || "（无描述）", badge: "[" + it.scope + "]", right: h(Toggle, { on: true, onChange: (on) => toggleSkill(it.name, on) }) })
					),
					s && s.disabled && s.disabled.length
						? h(
								"div",
								null,
								h("div", { style: { ...small, opacity: 0.6, margin: "12px 0 2px" } }, "已停用"),
								s.disabled.map((n) => h(Row, { key: n, icon: "\ud83d\udee0", title: n, subtitle: "已移到 disabled-skills", right: h(Toggle, { on: false, onChange: (on) => toggleSkill(n, on) }) }))
							)
						: null
				);
			} else if (view === "mcp") {
				body = h(
					"div",
					null,
					head("MCP", true),
					(mcp && mcp.servers ? mcp.servers : []).map((sv) => h(Row, { key: sv.id, icon: "\ud83d\udd0c", title: sv.serverName, subtitle: (sv.transport || "stdio") + " · " + sv.id, right: h(Toggle, { on: !sv.disabled, onChange: (on) => toggleMcp(sv.id, on) }) })),
					h("div", { style: { ...small, opacity: 0.7, marginTop: 10 } }, "开关会改写 cordis.patch.yml 并备份，重启 DSH 后生效。")
				);
			} else if (view === "kb") {
				body = h(
					"div",
					null,
					head("知识库", true),
					h(
						"div",
						{ style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 6 } },
						h("div", { style: { ...small, color: C.strong } }, kb ? `${kb.docs} 文档 · ${kb.chunks} 片段 · ${(kb.bytes / 1024 / 1024).toFixed(1)} MB` : "\u2026"),
						h("span", { style: { flex: 1 } }),
						h(Btn, { onClick: reindex, disabled: busy }, "重建索引")
					),
					kb && kb.task && kb.task.running ? h("div", { style: { ...small, color: C.warn, marginBottom: 6 } }, `索引中 ${kb.task.done}/${kb.task.total}`) : null,
					h("div", { style: { display: "flex", gap: 6, marginBottom: 6 } }, h(Field, { value: dir, onChange: (e) => setDir(e.target.value), onKeyDown: (e) => e.key === "Enter" && addDir(), placeholder: "加目录进库，例如 D:\\docs" }), h(Btn, { onClick: addDir, disabled: busy }, "索引")),
					h("div", { style: { display: "flex", gap: 6 } }, h(Field, { value: q, onChange: (e) => setQ(e.target.value), onKeyDown: (e) => e.key === "Enter" && searchKb(), placeholder: "在知识库里搜…" }), h(Btn, { onClick: searchKb, disabled: busy }, "搜索")),
					hits
						? h(
								"div",
								{ style: { marginTop: 8, maxHeight: 260, overflow: "auto" } },
								hits.hits && hits.hits.length
									? hits.hits.map((x, i) => h("div", { key: i, style: { padding: "6px 0", borderBottom: "1px solid " + C.line } }, h("div", { style: { ...small, color: C.accent } }, x.doc), h("div", { style: { ...small, opacity: 0.8, marginTop: 2 } }, x.text.slice(0, 160) + (x.text.length > 160 ? "\u2026" : ""))))
									: h("div", { style: { ...small } }, "没有命中")
							)
						: null,
					h("div", { style: { ...small, opacity: 0.6, marginTop: 10 } }, "根目录：" + ((kb && kb.root) || "-"))
				);
			} else if (view === "exec") {
				body = h("div", null, head("代码执行", true), h(Row, { icon: ">", title: "权限", subtitle: "完全访问（DSH 会话权限预设）", right: h("span", { style: { ...small } }, ex ? ex.platform : "") }), h(Row, { icon: ">", title: "解释器", subtitle: ex ? ex.shell : "-" }), h("div", { style: { ...small, marginTop: 8 } }, "可用工具：" + (ex ? ex.tools.join(" · ") : "-")));
			} else {
				body = h(
					"div",
					null,
					head("工作目录", true),
					h(Row, { icon: "\ud83d\udcc1", title: "当前", subtitle: (data && data.cwd) || "-" }),
					h("div", { style: { display: "flex", gap: 6, marginTop: 10 } }, h(Btn, { onClick: () => { if (data && data.cwd) navigator.clipboard.writeText(data.cwd); setNote("已复制路径"); } }, "复制路径")),
					h("div", { style: { ...small, opacity: 0.7, marginTop: 10 } }, "会话读写与命令执行以该目录为根；切换工作区后重新打开本面板即可刷新。")
				);
			}

			return h(
				"div",
				{ style: { position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: 70 }, onMouseDown: (e) => { if (e.target === e.currentTarget) setOpen(false); } },
				h(
					"div",
					{ style: { width: "min(480px, 94vw)", maxHeight: "82vh", overflow: "auto", borderRadius: 14, border: "1px solid " + C.line, background: C.panel, padding: "14px 16px 16px", boxShadow: "0 18px 48px rgba(0,0,0,0.45)" } },
					view === "root" ? head("模式") : null,
					err ? h("div", { style: { ...small, color: C.warn, marginBottom: 6 } }, err) : null,
					note ? h("div", { style: { ...small, color: C.ok, marginBottom: 6 } }, note) : null,
					body
				)
			);
		}

		function apply(ctx) {
			ctx.slots.inject("conversation.input.dock", () =>
				ctx.slots.register({ name: "conversation.input.dock", id: "chatbox-compat-mode", order: 4, inject: (sessionId) => ({ sessionId, sessions: ctx.sessions }) }, Panel)
			);
			ctx.slots.inject("conversation.input.dock", () =>
				ctx.slots.register({ name: "conversation.input.dock", id: "chatbox-compat-hud", order: 5, inject: (sessionId) => ({ sessionId, sessions: ctx.sessions }) }, Hud)
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
