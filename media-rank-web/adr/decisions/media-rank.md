# media-rank-web：通用媒体锦标赛排名组件

## 背景

img-cleanup-web 的手动加赛（LLM 未配置时的锦标赛）实现了一套「逐轮配对、
每对保留 1 张、轮空自动保留、候选 ≤ 目标收束」的交互，但与图片清理业务
（服务端会话状态机、`/api/image` 图片专用端点、URL 白名单）深度耦合。图片
之外的工具（音频选优、视频选优）需要同样的比较交互，因此抽离一个媒体无关
的公共组件。

## 核心决策

### 1. 独立 workspace 包，纯前端

`media-rank-web` 只含前端组件与状态机，无服务端。与 img-cleanup-web 同构的
栈：Cydon + UnoCSS/daisyUI 5 + Vite 8 (Rolldown) + TypeScript ESM + Vitest +
oxlint。`exports["."]` 直接指向 TS 源码而非 dist：消费方均为 Vite 应用
（组件模板经 Vite 的 `?raw` 导入，tsc 构建产物无法承载），避免为纯浏览器包
维护构建线。

### 2. 媒体源抽象：id/url → 直链接口

组件不加载媒体，只调用注入的 `MediaSource.getUrl(id, params)` 获取直链，
`params` 已知 `zoom`（缩略尺寸 px）与 `raw`（原始文件流），其余透传。这与
img-cleanup-web 的 `GET /api/image?u=…&w=…|raw=1` 端点同构（`w` → `zoom`、
`raw=1` → `raw`），迁移一个现有后端只需实现该接口。返回值直接用作
`img/audio/video` 的 `src`，代理端点、对象存储、data/blob URL 均可。媒体
类型由 `MediaItem.kind` 声明（缺省 image），决定渲染 `<img>`/`<audio>`/
`<video>`；`raw` 直链用于播放器与全屏查看层，`zoom` 用于卡片缩略图与悬停
预览（img-cleanup 的 `w=512`/`w=800` 语义）。

### 3. 锦标赛状态机客户端化，淘汰序即排名

img-cleanup 的加赛状态机在服务端（裁决要写 checkpoint 缓存），公共组件把
同构逻辑收敛为客户端同步纯类（配对/轮空/逐对裁决/收束），无 IO、可单测。
与 img-cleanup 的差异：收束后不只要保留集，还按淘汰轮次导出**完整排名**
（存活者最前、越晚淘汰名次越高）——比较过程的信息不丢弃。持久化不在组件
职责内：宿主监听 `rank-decide`/`rank-change` 事件自行记录（将来 img-cleanup
回接时可把裁决映射回 checkpoint 协议）。

**中断恢复（2026-09-30）**：配对经洗牌非确定，回放裁决记录无法重建同样的
对局，因此恢复以**完整状态快照**为契约——`rank-change` 事件携带
`toJSON()` 快照，`restore(snapshot, source)` 原样恢复（候选序/待裁决对/
轮空/轮次日志），宿主（如 playlist-rank-web）落 localStorage 即得刷新级
断点续排。快照与 img-cleanup 的 checkpoint 不同构：后者按 url 集合跨会话
复用裁决，前者只服务同一页面会话的中断续排。

### 3b. 淘汰赛升级为前 k 名提取（2026-10-01）

最初只有「淘汰赛」：逐轮配对、每对保留 1 张、轮空保留，收束时按淘汰轮次导出
分层排名。它的优点是裁决数最少（≈ n − target），但**名次只在轮次粒度上成立**
——同轮被淘汰者之间从未比较，相对顺序由裁决记录序填充。playlist-rank-web 的
真实诉求是「找出最好听的 5 首」，不是「给 40 首歌划出 5 个名次段」，分层名次
对导出播放列表毫无意义；而精确全排序（Ford-Johnson，≈ n·log₂n − 1.44n 次）
对 n=40 要比 ~100 次，代价又太大。

于是把 `target` 的语义从「目标保留数」改为**「找出前 k 名」**，并按 k 与候选数
n 的关系自动选算法（`mode` 成为派生状态，宿主不再手动切模式）：

- **k ≥ n（缺省）→ Ford-Johnson 精确全排序**：现有引擎原样保留。
- **k < n → 前 k 名提取**（`top-k.ts`）：先用**种子洗牌**（FNV-1a 哈希 id 播种
  xorshift）打乱候选做单败淘汰定出冠军（n − 1 次），再沿冠军的败者链用
  **胜者树**逐个提取次优（每次约 log₂n 次），直到凑满 k 名。总计
  ≈ (n − 1) + (k − 1)·log₂n，只保证前 k 名经比较链认证，k 名之后是提取过程的
  延拓（明写为「不承诺」）。

两个取舍值得记下：

1. **为什么洗牌**：确定性种子保证同一候选集总能洗出同一配对，快照只需存
   `{items, target, answers}` 三元组即可重放——与精确模式同构。若用随机源，
   恢复必须序列化配对状态机，快照体积和耦合都会上升。
2. **淘汰赛状态机（`tournament.ts`）保留**：它是 topK 冠军阶段的算法基础，
   也有 11 个单测覆盖轮空/逐轮推进/分层名次导出；只是不再由 element 直接驱动。

比较序列全部用 generator 表达（`MergeInsertionRunner`/`TopKRunner` 都是
`replay()` 重建），快照 = 候选集 + 目标 + 已完成裁决 id 序列。

**顺序约束（2026-09-30）**：playlist-rank-web 的多歌单场景要求「有序歌单
内部的相对顺序在最终排名中保持」。约束作为组件的可选入参
（`constraints`），收束时对锦标赛排名做**稳定拓扑重排**（每步取锦标赛序
最靠前的可行项）——约束未违反时与锦标赛排名一致，仅在被违反处局部调整，
锦标赛的人工裁决语义不被静默放大；约束成环时无解，宿主在开赛前用同一
纯函数（`applyOrderConstraints`）校验并提示检查输入。约束不进入配对
过程（受约束的对局仍会比较，人工裁决与歌单顺序相左时提醒但以约束为准），
避免为豁免配对引入配对算术的复杂度。

### 4. Cydon 组件自带模板与依赖追踪边界

可复用组件不能依赖宿主页面提供模板（img-cleanup-web 的模板写在 index.html）。
组件在构造器中以 `?raw` 导入的模板字符串注入自身子节点，随后 Cydon 的
`connectedCallback → mount` 正常编译——Cydon 无 ShadowDOM 要求，light DOM
注入即可。

沿用 img-cleanup-web ADR 的全部踩坑结论（`c-show` 切换显示、`c-for` 列表
拍平、布尔属性用 `.prop` 绑定），并新增三条边界：

- **预绑定方法**：事件表达式与 `c-for` 克隆节点内的方法调用拿到的 `this`
  不可依赖（循环上下文/globalThis/代理），组件在 `connectedCallback` 把模板
  引用的方法 `bind` 到元素自身；绑定到 data 代理不可行——DOM 方法
  （`dispatchEvent` 等）经代理调用会 Illegal invocation。绑定后方法内状态
  写入必须经 `this.data`（响应式代理），直接在 `this` 上赋值不触发更新。
- **依赖追踪只认表达式直读**：绑定方法的内部读取不经过追踪代理。模板表达式
  引用的方法只能依赖**入参**（如同 img-cleanup 的 `rawUrl(url)`），组件状态
  （如当前查看的 `viewerId`）必须在模板表达式里直接读取，否则视图不更新。
- **点击即选、再点即确认**：音频/视频卡片内嵌原生播放器，原生控件吞掉点击
  与双击，img-cleanup 的「点击选中 + 双击确认」不通用；改为统一的
  「点击选中，再次点击同一卡片确认」，卡片底部按钮提供同一路径。

### 5. demo 页运行时合成媒体

demo 需要真实的图片/音频/视频验证三类渲染。仓库不提交二进制示例：图片用
canvas 合成（`zoom` 参数映射生成尺寸）、音频用 JS 合成 WAV（blob URL）、
视频用 canvas 动画 + `captureStream` + `MediaRecorder` 录制 WebM（初始化时
异步预生成，`getUrl` 保持同步；浏览器不支持时降级提示）。这也示范了
MediaSource 的 data/blob URL 形态。

## 后果

- 新增 workspace 成员 `media-rank-web`；img-cleanup-web 零改动。
- 组件为客户端状态机，img-cleanup-web 的加赛视图（服务端驱动）暂未回接；
  回接需组件支持受控模式（外部推进轮次），按需扩展。
- 排名算法有两档：k ≥ 候选数时付出 n·log₂n 换取严格全序；k < 候选数时只
  认证前 k 名，k 名之后无承诺。宿主若需要完整分层名次（如 img-cleanup 的
  「淘汰轮次 = 名次段」语义），k 应取 1 或用分层导出自行组装。
