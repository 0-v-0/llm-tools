# img-cleanup-web：Web UI 技术栈与交互设计

## 背景

img-cleanup 是纯 CLI：参数一次性传入后全自动跑完，用户只能事后看结果。批次
比较（LLM 从 n 张中选 1 张保留）是整个流程中最需要人工监督的环节——LLM 可能
选错，且 CLI 没有介入点。因此需要一个 Web UI：跑完整清理流程的同时，允许用户
逐批查看比较过程，并手动改选保留者。

## 核心决策

### 1. 技术栈：与 mirror-boost 一致的前端栈 + 新增本地 Hono 后端

前端沿用 mirror-boost 的选型：**Cydon + @cydon/ui**（本地 link 依赖）、
**UnoCSS + daisyUI 5**（`unocss-preset-daisyui-next`）、**Vite 8 (Rolldown)**、
TypeScript ESM、Vitest、oxlint。

mirror-boost 是浏览器扩展、没有后端；img-cleanup 需要访问本地 sqlite、读取/
移动文件、代理 LLM 调用，因此新增一个 **Hono**（`@hono/node-server`）本地 API
服务。选 Hono 而非 Express/Fastify：轻量、ESM 原生、TypeScript 优先，与本仓库
「极少框架依赖」的风格一致。服务仅绑定 127.0.0.1（本地单用户工具）。

### 2. 复用而非重写：img-cleanup 暴露 `./api` 库入口

img-cleanup 的核心函数（分组、切批、`selectFromBatch`、`runTournament`、
`moveImages`、`Checkpoint`）本就与 CLI 解耦。新增 `src/api.ts` barrel +
`exports["./api"]`，Web 端不复制任何业务逻辑；CLI 行为零变化。
配套改动（均为增量）：

- `selectFromBatch` 增加可选 `opts.record`：Web 手动挑选的「LLM 建议」场景
  需要只出建议不落缓存，避免未被采纳的建议污染裁决缓存。
- `Checkpoint.recordOverride`：人工改选需覆盖同 key 的 LLM 裁决，否则缓存里
  留着被否决的结论，后续 CLI `--resume` 会读到错误结果。
- 构建开启 `declaration: true`（供 Web 端类型检查）。

### 3. 手动裁决与 LLM 裁决同构入缓存

人工选择通过 `recordOverride` 写入与 CLI 共用的 checkpoint 裁决缓存（主键为
比较 url 集合）。收益：Web 里的手动/自动结论对 CLI 完全可见，跨会话、跨工具
复用；m/targetDir/batchSize 变化不影响复用语义（沿用既有设计）。

### 4. 交互：逐批切换 + LLM 建议；移动前随时调整 + 自动重赛（用户选定）

- 会话式状态机：POST /api/sessions 创建（分组、切批、恢复缓存裁决）→ 逐批
  auto/manual → finalize（锦标赛自动）→ move。
- 每批两种方式：「自动选择（LLM）」（缓存命中直接返回）与「手动挑选」——
  手动态先展示 LLM 建议（`record: false`，不落缓存）及理由，点击图片采纳或
  改选；确认后以 `recordOverride` 落缓存。
- **选择结果在移动开始前都不是最终结论**：进入预览阶段（finalized）后仍可
  返回调整任何历史批次裁决。每次调整确认后服务端自动「重赛」
  （`recomputeSelection`，幂等）：重算落选者并按需重跑锦标赛——锦标赛配对
  按 url 集合缓存，未受影响的配对不重复调用 LLM。finalize 同样幂等，可重复
  触发；重赛在后台执行（running 标志 + 前端轮询），失败信息随 DTO 返回展示。
- 单张批次自动保留；「自动完成剩余批次」后台顺序执行，前端轮询进度。
- 锦标赛配对本身暂不支持手动改选（批次裁决可改 + 自动重赛已覆盖主要诉求，
  接口按阶段拆分可扩展）。
- **写路径并发免疫**（2026-09-29）：`move()` 执行期间置 `moving` 互斥标志并随
  DTO 推送，期间的人工裁决/重赛/再次移动一律 409——多标签页（或任意并发
  写入）不会在移动进行中改变移除清单与 checkpoint。

### 5. Web 端 checkpoint 确认策略

CLI 在 standard 变更时交互确认是否复用裁决。Web 无交互终端，按 `--force`
处理（强制复用），`resolveCheckpoint` 的 notes 返回给前端展示。

### 6. 状态更新通道：SSE 推送而非轮询/WebSocket（2026-09-29）

后台任务（run-remaining、自动重赛）的状态更新最初由客户端每 1.2s 轮询
`GET /api/sessions/:id`。问题：全量 SessionDTO（含所有批次图片元数据）在
大会话下随每次轮询重复序列化/传输。改为 **SSE**：

- `CleanupSession.onUpdate(cb)` 在各变更点（批次裁决、running 翻转、错误、
  移动完成）触发；`GET /api/sessions/:id/events`（`hono/streaming` 的
  `streamSSE`）连接即推全量、之后每次变更推送；15s 心跳防代理超时。
- 客户端 `EventSource` 替代轮询：浏览器原生自动重连，重连后服务端先推全量
  状态、天然恢复；连接生命周期跟随会话状态（moved/无会话时断开）。
- **REST 是唯一写路径**，SSE 只做单向状态通知——因此不需要 WebSocket 的
  双向能力、连接握手与 ws 代理配置，也无需新增依赖。
- WebSocket 路线（`@hono/node-ws` + `ws`）仅在出现双向高频需求时再考虑。

### 7. 原图查看：同源 raw 端点，而非 file:// URL（2026-09-27）

手动挑选需要核实画质，512px 缩略图不够。曾考虑「file:// 打开页面 + 原图
file URL 直显 + ws 连后端」方案，否决：服务器因业务逻辑（sqlite/LLM/移动
文件）反正必须运行，file:// 省不掉它反而引入跨域（再靠 ws 绕）、破坏 Vite
dev（HMR）与生产双模式一致性；且原图直载会让多图网格的解码内存与滚动性能
倒退。实现：`GET /api/image?u=…&raw=1` 同源流式返回原图（按扩展名给
content-type），沿用会话白名单；前端全局弹层查看（非手动态点图 / 待移除
清单点图 / 卡片「原图」按钮均可打开，Esc 关闭），缩略图仍是网格默认。

### 8. LLM 不可用时回退手动模式（2026-09-27）

resolveProviderConfig 无密钥时抛 ConfigError，曾导致服务启动即崩——但批次
比较本就支持纯手动挑选，LLM 不是启动的必要条件。改为启动时捕获：provider
置 null 并告警，服务照常监听。

- **不可用面收窄到真正依赖 LLM 的操作**：auto / suggest / run-remaining /
  锦标赛淘汰（finalize 时落选者 > m）返回 409；`run-remaining` 路由需在
  fire-and-forget 之外显式守卫（服务端 catch 会吞掉异步 409）。
- **前端按 `ConfigDTO.llmAvailable` 降级**：隐藏「自动选择」「自动完成剩余」
  入口，review 视图显示提示条；手动挑选界面的 LLM 建议请求仅在可用时发起。
- **裁决缓存以 manual 身份记录**：缓存键含 judge（provider/model），无 LLM
  时以 `manual/manual` 记录——手动模式的裁决在手动模式会话间复用，但与真实
  provider 的缓存互不复用（CLI 用真实密钥恢复时视为裁判变更，属可接受取舍：
  不回退则根本无法启动）。
- 落选者 ≤ m 的 finalize 不需要 LLM，手动模式可完整走到移动/dry-run。

## 踩坑记录（Cydon 模板约束）

- `c-if` 在绑定期间会把节点从 DOM 摘除并替换为注释锚点，子节点绑定仍在挂载
  时求值；`c-for` 模板移除 + `c-if` 摘除叠加会破坏 compile/bind 的索引同步，
  多模板场景下遍历错位（表现为 `el.content` undefined 等诡异错误）。
  **结论：视图切换与条件显示统一用 `c-show`（仅切 display），不用 `c-if`；
  所有跨状态引用的表达式必须空值安全。**
- 属性绑定走 `setAttribute`，布尔属性（disabled/checked）不可绑定，禁用态用
  `:class="btn-disabled: …"` + 方法内守卫。
- 文本插值 `$var` 只支持 `[\\w.]*` 标识符；带参数的方法调用必须写 `${expr}`。
- `c-for` 的列表必须是元素顶层属性，模板内嵌套列表需在状态层拍平。
- `<select>` 内嵌 `c-for` 模板会触发 `for_` 对父节点 `textContent` 的破坏性
  清空，选项列表用按钮组替代。
  **（已修复并在 cydon a17d76f / 0c7f573 落地，2026-09-27 复核源码与测试：
  `for_` 以私有 Symbol 标记自己渲染的节点，只删自有节点——父节点全部自有
  时才走 `textContent` 快速路径且跳过空白文本节点；模板移除延迟到 bind 结束
  （queueMicrotask）；bind 遍历本身对遍历中 DOM 变更恢复弹性。12 项测试覆盖
  多模板共存、静态兄弟保留、false c-if 后兄弟照常绑定且响应式恢复等场景，
  全部通过；本包 link 的 dist 产物已含修复。**结论：`c-if` 与多 `c-for` 的
  正确性限制已解除**——但 `c-if` false 时节点仍真实摘除（mount/unmount），
  跨状态 DOM 引用与空值安全要求不变；当前模板继续沿用 `c-show` 约定，属
  渲染成本与语义选择，无迁移必要。）**
- **c-for 克隆节点的事件处理器以循环上下文为 `this`**：在处理器里通过
  `this.xxx` 读写组件状态会落到 ctx 层而非元素（属性赋值脱离响应式代理，
  甚至污染 ctx）。非循环区域的元素走直接 addEventListener，`this` 是元素的
  data 代理，无此问题。**结论：所有组件方法一律通过模块级单例实例访问状态，
  不依赖事件处理器的 `this`；内联赋值（`@click="x = y"`）同样会污染 ctx，
  一律改为方法调用。**
- ~~布尔属性（disabled/checked）不可绑定~~ **更正**：`.*prop`（DOM property
  绑定）一直可用，`.disabled="busy"` 是受支持的写法；此前误读源码。
  禁用态按钮推荐 `.disabled` + `:class="btn-disabled: …"` 组合。

## 后果

- 新增 workspace 成员 `img-cleanup-web`；`img-cleanup` 构建 4 个新产物文件
  （api.js/api.d.ts + 声明），CLI 无行为变化。
- Web 与 CLI 共享裁决缓存文件，两者不可同时对同一 checkpoint 并发写
  （单会话约束 + 本地单用户可接受）。
