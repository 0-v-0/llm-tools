# img-cleanup-web

`img-cleanup` 的本地 Web UI：在浏览器中完成完整清理流程（配置 → 批次比较 → 移除清单预览 → 移动），**批次比较支持手动选择与自动选择（LLM）逐批切换**。

## 技术栈

与 [mirror-boost](https://github.com/0-v-0/mirror-boost) 一致的前端栈：

- **Cydon + @cydon/ui**（本地 `link:` 依赖，需 `D:\Documents\cydon` 仓库存在）
- **UnoCSS** + **daisyUI 5**（`unocss-preset-daisyui-next`）
- **Vite 8**（Rolldown）、TypeScript（ESM）、Vitest、oxlint

后端为 **Hono**（`@hono/node-server`），复用 `img-cleanup/api`（分组、切批、批次选择、锦标赛、移动、checkpoint 裁决缓存）的全部核心函数。

## 启动

```bash
# 开发模式（server :5176 + vite dev，/api 自动代理）
pnpm dev

# 生产模式
pnpm build && pnpm start   # http://127.0.0.1:5176
```

前置条件与 CLI 相同：`imgval.db`（由 img-val 生成）、`~/.img-data/imgcleanup.toml`（可选）。`OPENAI_API_KEY` 等 LLM 密钥**可选**：未配置时以手动模式启动（自动选择、LLM 建议与锦标赛淘汰不可用，逐批手动挑选照常可用），见 ADR 第 8 条。

## 使用流程

1. **配置**：填 m（绝对数/百分比）、目标目录、批次大小 n、估值标准、路径过滤、dry-run、同名冲突策略。目标目录可点「选择文件夹…」由后端调出系统对话框；估值标准为可筛选输入框（datalist 候选，留空 = 全部）。
2. **批次比较**：每批展示 n 张缩略图。点击图片或「原图」按钮可查看原图（手动挑选时点击仍是选择，用「原图」按钮查看）。
   - 「自动选择（LLM）」：调用 LLM 选保留者（缓存命中则直接返回）。
   - 「手动挑选」：进入手动态，先展示 LLM 建议（不写缓存）及理由，点击图片可采纳或改选。
   - 「自动完成剩余批次」：后台顺序跑完，页面轮询进度。
   - 单张批次自动保留；历史裁决（缓存命中）直接显示。
3. **预览移除清单**：落选者 ≤ m 直接全部移走；否则锦标赛淘汰（LLM 自动执行，展示各轮详情；**LLM 未配置时进入手动加赛**，逐对保留更好的一张直到候选 ≤ m）。确认后移动（支持 dry-run 预演）。
4. **结果**：moved / renamed / skipped / failed 状态表。

**移动前可随时反悔**：进入预览阶段后仍可「返回批次调整」，重新挑选任何历史批次
的保留者（也可改回）；每次调整确认后系统**自动安排重赛**——重算落选者并按需
重跑锦标赛，配对按 url 集合命中裁决缓存，未受影响的配对不重复调用 LLM。重赛
完成后自动回到预览视图，移除清单已更新。

## 关键设计

- **手动裁决与 LLM 裁决同构**：人工选择通过 `Checkpoint.recordOverride` 写入与 CLI 共用的裁决缓存（按比较 url 集合为主键）。改选会覆盖同 key 的 LLM 裁决，保证后续运行（含 CLI `--resume`）读到人工结论。
- **移动前随时调整 + 自动重赛**：选择结果在移动开始前都不是最终结论。调整任一批次裁决后，服务端自动重算落选者并按需重跑锦标赛（`recomputeSelection`），受影响的配对才调用 LLM。
- **SSE 状态推送**：客户端通过 `GET /api/sessions/:id/events`（`hono/streaming`）订阅会话状态，连接即推全量、之后每次变更推送（15s 心跳保活，断线由浏览器 `EventSource` 自动重连）；REST 是唯一写路径。`run-remaining` 与后台重赛的进度因此实时可见，无轮询开销。
- **断点复用**：Web 会话与 CLI 共享 `~/.img-data/imgcleanup-checkpoint.json`，页面刷新自动恢复进行中的会话（含 SSE 重连），已裁决批次跨会话/跨工具复用。
- **图片服务安全**：`GET /api/image?u=…` 仅允许访问当前会话图片集合中的 file URL，防止任意文件读取；缩略图（sharp 转 webp）用于网格展示，`raw=1` 流式返回原图（Esc 或「关闭」退出全屏查看）。
- **系统对话框代开**：`POST /api/pick-folder` 由后端经 PowerShell 调出 Windows「选择文件夹」对话框（TopMost 隐藏窗体防遮挡，UTF-8 输出兼容中文路径），模态阻塞至选择/取消，同一时刻仅允许一个（409）。
- **配置表单记忆**：会话创建成功时表单（m/目标目录/批次大小/过滤/标准/dry-run/冲突策略）存入 localStorage；放弃会话或中断后回到配置页自动恢复上次输入。
- **单会话约束**：checkpoint 与 imgval.db 是全局资源，同一时刻只允许一个活跃会话（409 提示先完成或放弃）。

## 已知边界

- LLM 可用时锦标赛自动执行，暂不支持逐对改选（批次裁决可随时改，改后自动重赛）；手动加赛阶段不支持调整批次裁决（会改变落选者池，需放弃后重来）。
- standard 变更时的 CLI 交互确认在 Web 端按 `--force` 处理（强制复用，说明文字展示在前端）。
- 仅绑定 127.0.0.1，本地单用户工具。
