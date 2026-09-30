# media-rank-web

`<media-rank>`：为图片、音频和视频做**锦标赛排名**的可复用 Web 组件。候选
媒体两两配对，人工逐对保留更好的一项（奇数轮空自动保留），直到找出前 k 名，
导出排名结果。媒体文件源抽象为「根据 id/url 获取直链」的接口，组件不关心
媒体存放位置与类型细节。

排名方式由 k 与候选数共同决定：`target` ≥ 候选数（或留空）走 **Ford-Johnson
精确全排序**，产出经认证的严格全序；`target` < 候选数走 **前 k 名提取**
（knockout 定冠军 + 胜者树提取），比较次数从 n² 量级降到 ≈ n + k·log₂n。

从 [img-cleanup-web](../img-cleanup-web/) 的手动加赛交互抽离而来，技术栈一致
（Cydon + UnoCSS/daisyUI + Vite）。

## 使用

```ts
import 'media-rank-web' // 注册 <media-rank>
import type { MediaItem, MediaSource, RankResult } from 'media-rank-web'

const items: MediaItem[] = [
	{ id: 'img-1', kind: 'image', name: 'a.jpg', meta: '1920×1080' },
	{ id: 'audio-1', kind: 'audio', name: 'b.flac', meta: '03:21' },
	{ id: 'video-1', kind: 'video', name: 'c.mp4', meta: '00:15' },
]

const source: MediaSource = {
	// id → 直链；zoom 为缩略尺寸请求（px），raw 为原始文件流
	getUrl(id, params) {
		return params?.raw ? `/api/media/${id}?raw=1` : `/api/media/${id}?w=${params?.zoom ?? 512}`
	},
}

const el = document.createElement('media-rank')
el.start(items, source, 2) // 候选、媒体源、要找的名次 k（缺省 = 候选数 = 精确全排序）
el.addEventListener('rank-complete', (e) => {
	const { ranking, survivors, rounds } = (e as CustomEvent<{ result: RankResult }>).detail.result
})
container.append(el)
```

也可在元素连接前设置 `items` / `source` / `target` 属性，连接后自动开赛；
`restart()` 用当前候选重新洗牌开赛；`restore(snapshot, source)` 从快照恢复
中断的锦标赛进度。

### 排名方式（k 值语义）

`el.target` / `start(items, source, k)` 的 k 与候选数 n 共同决定算法，无需手动
切换模式（`el.mode` 为派生状态）：

- **k ≥ n（或不填，默认）→ precise：Ford-Johnson 合并插入精确全排序**。
  产出经认证的严格全序（每个相邻位次都有比较链支撑），代价 ≈ n·log₂n − 1.44n
  次比较。奇数候选的尾项整链二分，n=5/9 最坏比经典 FJ 多 1 次比较（见测试
  容差说明）。
- **k < n → topK：前 k 名提取**。先用种子洗牌（确定性，可重放）打乱候选做
  单败淘汰定出冠军，再沿冠军的败者链用胜者树逐个提取次优，直到凑满 k 名。
  比较次数 ≈ (n − 1) + (k − 1)·log₂n，远低于全排序；代价是只保证前 k 名顺序
  正确（经认证），k 名之后无承诺。

两种方式共享对局连播、顺序约束重排、快照恢复与事件契约；`rank-change` 的
`detail.mode`、`detail.round`（两种方式均为已比较次数）、`detail.target`、
`detail.extractedCount` 随方式变化。两种方式都是单击一次即裁决并自动进入下一对。

### 顺序约束（可选）

设置 `el.constraints = [{ before: 'a', after: 'b' }, …]`（按 id 匹配）后，
收束时的排名会对锦标赛结果做**稳定拓扑重排**：保持每条约束的先后关系
（如有序歌单内部的相对顺序），且在可行选择中优先保留锦标赛序——约束未被
违反时结果与锦标赛排名一致，仅在被违反处局部调整。约束成环（互相冲突）
时无法满足，宿主应在开赛前用 `applyOrderConstraints(ranking, constraints)`
自行校验（返回值 `cycle` 非空即为冲突，`cycle` 为参与循环的条目）。

### 中断恢复

配对经洗牌非确定，恢复必须携带**完整状态快照**（仅回放裁决记录无法重建同
样的对局）。每次 `rank-change` 事件的 `detail.snapshot` 即当前快照，宿主
持久化后可随时用 `restore(snapshot, source)` 恢复（进行中或已完成的快照均
可，恢复后照常发出 `rank-change`/`rank-complete`）。

### 契约

- **MediaItem**：`id`（传给 MediaSource 的标识）、`kind`（`'image' | 'audio' | 'video'`，
  缺省 image）、`name`（缺省取 id 的 basename）、`meta`（可选徽标元数据）。
- **MediaSource.getUrl(id, params?)**：返回可直接用作 `img/audio/video src`
  的 URL（同源代理端点、对象存储或 data/blob URL 均可）。已知参数：
  `zoom`（缩略/预览尺寸 px，卡片 512、悬停预览 800、结果行 128）、
  `raw`（原始文件，卡片播放器与查看层使用）。
- **事件**（均冒泡）：
  - `rank-decide` — 单对裁决，`detail: { pairIndex, keptId, eliminatedId }`；
  - `rank-change` — 每对裁决后与收束时发出，`detail: { mode, round, target,
    extractedCount, candidatesLeft, pendingCount, completed, estimateTotal,
    snapshot }`，`snapshot` 为完整状态快照（`kind` 为 `'precise'` 或 `'topK'`，
    供中断恢复）；
  - `rank-complete` — 收束，`detail: { result }`，`result.ranking` 为完整排名
    （长度恒等于候选数：topK 模式前 k 名经认证、其后为提取顺序的延拓），
    另含 `survivors` 与逐轮 `rounds`。

### 交互

点击卡片选中，再次点击同一卡片确认；「原始文件」按钮打开全屏查看层
（Esc 关闭）。图片卡片支持悬停 150ms 大图预览；音频/视频卡片内嵌原生播放器。

**自动连播**：音频对局自动播放——直接顺序播放两张卡**各自的行内播放器**
（A 播完经 `ended` 接续 B），播放状态由行内原生控件呈现；一次点击即完成裁决
并接续下一对。用户手动暂停卡片播放器时不强行恢复（任一时刻全局只播一个）。
纯图片对局无媒体可播、含视频的对局跳过自动连播（卡片内嵌播放器手动播放）；
浏览器自动播放策略拒绝时静默降级为手动播放。

**播放共享（精确模式）**：同一败者的连续二分比较不重播败者——败者只在
首次比较时完整播放，后续比较仅播新的链元素，播放次数从 2×比较次数
降至 ≈ 比较次数 + 候选数（即"当前歌曲 vs 上一首"的听感流）。

## 开发

```sh
pnpm dev    # demo 页（运行时合成示例图片/音频/视频，无二进制资产）
pnpm test   # 状态机单测（淘汰赛 / FJ 精确排序 / 前 k 名提取 / 顺序约束）
pnpm typecheck && pnpm lint
```

设计决策见 [adr/decisions/media-rank.md](adr/decisions/media-rank.md)。
