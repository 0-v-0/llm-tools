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

两种方式共享连播播放器、顺序约束重排、快照恢复与事件契约；`rank-change` 的
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
  `raw`（原始文件，卡片播放器与查看层使用）、
  `name`（该项当前的**显示名**，见下）。
- **事件**（均冒泡）：
  - `rank-decide` — 单对裁决，`detail: { pairIndex, keptId, eliminatedId }`；
  - `rank-change` — 每对裁决后与收束时发出，`detail: { mode, round, target,
    extractedCount, candidatesLeft, pendingCount, completed, estimateTotal,
    snapshot }`，`snapshot` 为完整状态快照（`kind` 为 `'precise'` 或 `'topK'`，
    供中断恢复）；
  - `rank-complete` — 收束，`detail: { result }`，`result.ranking` 为完整排名
    （长度恒等于候选数：topK 模式前 k 名经认证、其后为提取顺序的延拓），
    另含 `survivors` 与逐轮 `rounds`。
  - `rank-rename` — 曲目信息被改写，`detail: { id, previousId, name, meta,
    discardedVerdicts }`。`previousId` 与 `id` 不同即换了标识；`discardedVerdicts`
    为真表示因此丢弃了相关裁决（见「编辑与裁决回退」）。

### 交互

**布局按媒体类型分流**：音频一次只能听一个，待裁决对与最终排名以**播放列表
行**呈现（单列连续、序号 + 内嵌播放器）；图片/视频可同屏并排，保持**两列卡片**
对比布局。布局由待裁决首项的 `kind` 推导（`audioLayout`），暂不考虑同一对待
裁决项混合多种类型。点击「✓ 更好」即裁决并自动进入下一对；「详情」打开全屏
查看层（Esc 关闭）；图片项支持悬停 150ms 大图预览。

**未裁决项可改名**（`renameItem` / `renameMeta`）：待裁决对里的歌名与元数据是
内联输入框，回车或失焦提交。未裁决项尚未产生裁决记录，改名不会与引擎状态或快照
脱节。改名**不改 id**，但直链可以跟随：取链时组件把当前显示名作为 `params.name`
一并交给 `MediaSource`，按 id 解析直链的源（对象存储、代理端点）不受影响，按名字
解析的源（playlist-rank-web 的 URL 模板）则立即跟着变。id 要重新开始排名才会变。
已裁决项走下文的编辑面板。

### 编辑与裁决回退

已裁决的曲目同样可以编辑，入口在**已看得见的已裁决行**上：结果列表 / 校验模式的
逆序列表，以及对局中作为「上一首」承接的那一行。「编辑」按钮打开面板，可改
**标识（id）**、**名称**、**元数据**三项。

三类改动的后果完全不同：

- **只改名称 / 元数据** — 纯展示信息，裁决全部保留。可主动勾选「丢弃原裁决」
  来重来（面板默认对已裁决项勾选）。
- **改标识（id）** — 意味着换了另一首（`MediaSource` 按 id 取直链，新标识对应
  另一份媒体）。旧标识在裁决记录里已不成立，故**改 id 一律丢弃裁决并回退重做**，
  不受勾选影响。
- **重复标识** — 拒绝提交并提示，裁决不受影响。id 是重放的唯一键，重复会让
  「裁决与比较不符」且无法区分两条记录。

回退只能**整段截断**、无法就地删除：三个引擎的 `answers` 都是**位置日志**——第 i
条记录回答第 i 次比较，重放时逐位置喂回生成器。抽掉中间几条会让后续记录与比较
错位，因此截断点是该曲目的**首次出场下标**，其后的比较全部重做（不是最后一次
出场：后续每一步都建立在先前裁决之上，只回退到最后一次会留下依赖未回退中间态的
比较）。

按模式的差异：

| 模式 | 比较序列 | 改 id 后的回退 |
| --- | --- | --- |
| `precise` | 按位置配对 + 递归 | 回退到该曲目首次出场之前，其余裁决保留 |
| `verify` | 固定相邻对 `items[i]` vs `items[i+1]` | 回退到其相邻对之前（该对须重新裁决） |
| `topK` | **由 id 派生种子洗牌**的淘汰赛签表 | 签表随 id 重排，**全部裁决失效，从零开始** |

`topK` 的整表作废不是保守取舍而是结构约束：签表由候选 id 派生（`seededShuffle`），
任一 id 变化都会重排整张表，先前裁决不再对应任何一次比较。面板在该模式下会显式
提示这一点。三个引擎均提供 `comparisonsUpTo(n)` 与 `discardVerdictsOf(id)` 供宿主
定位与回退。

音频排名完成后列表变为**可连续播放的播放列表**：「▶ 从头连续播放」按排名序
逐首播放（`ended` 自动接续），点任意一首可从该首开始。该播放器（`playlistPlayer`，
结果视图专用的静态播放器）与对局连播（待裁决行的行内播放器）相互独立，任一
开始播放会暂停对方。

**顺序校验（只播重听）**：`start(items, source, target, true)` 改为**校验**
给定顺序是否正确——只比较**相邻**两项、共 n−1 次，判定为「后一首更好」处即
顺序错误（结果视图会标出），**不改变**原顺序。适合导入的已有歌单本身带顺序、
先听一遍确认对不对的场景。校验与排序不可比（排序是求最优序 ≈ n·log₂n；校验
是验证 = n−1），但远快于排序。

**自动连播**：音频对局自动播放——直接顺序播放待裁决两行**各自的行内播放器**
（A 播完经 `ended` 接续 B），播放状态由行内原生控件呈现；
一次点击即完成裁决并接续下一对。用户手动暂停行播放器时不强行恢复（任一
时刻全局只播一个）。纯图片对局无媒体可播、含视频的对局跳过自动连播
（行内播放器手动播放）；浏览器自动播放策略拒绝时静默降级为手动播放。

**播放衔接（播放共享）**：新对局若包含上一轮已展示过的歌曲，该曲固定渲染在
**首行**并标「上一首」，**不重播**；另一首从第二行渲染并单独播放——上一轮的
比较得以沿用。判定与引擎无关，只看新对局的两首是否与上一轮展示行重叠
（`carryPair`）：重叠则取其一置首行（两首都重叠时取上一轮的最后一行），
无重叠则原样渲染两行。这正是 FJ 插入链与 topK 胜者树中「败者锚点只在首次比较
时完整播放」的听感机制，播放次数因此维持在 ≈ 比较次数 + 候选数，而非每次
比较都重播两首。行序与引擎的比较序解耦，裁决按 id 判定不受影响。

## 开发

```sh
pnpm dev    # demo 页（运行时合成示例图片/音频/视频，无二进制资产）
pnpm test   # 状态机单测（淘汰赛 / FJ 精确排序 / 前 k 名提取 / 顺序校验 / 顺序约束）
pnpm typecheck && pnpm lint
```

设计决策见 [adr/decisions/media-rank.md](adr/decisions/media-rank.md)。
