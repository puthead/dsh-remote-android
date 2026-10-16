# 手机端分页（对话/轨迹）真机取证结论

- 设备：emulator-5554（AVD `dshr_ui` / Android 14 / x86_64，1080x2340 @440dpi）
- APK：`android/app/build/outputs/apk/debug/app-debug.apk`
  **sha256 `3A287880FABC444876BB5C787ED98CEC28EDDB9B2931E56011749F90336E2685`**（versionCode 5 / versionName 2.3.0，= `deliverables/DSH-Remote-v2.3.0-debug.apk`）
  - Lead 在版本递增后复跑了同一脚本：**PASS=46 FAIL=0**，198 秒（本轮 `paging-check-report.txt` / `shots/` 即这一轮）。
  - 上一轮（同样 46/0，跑在 versionCode 4 / 2.2.0 的包上，sha256 `ADF9F7D9B1E5C7696E3931BE46BFCD35EC8C92EC1693C762A97CB1366DD49D92`）已归档到 `iter4-46pass/`。
  - 历史版本（都被本版取代）：`887C6909…`（修复前基线）、`B9AD500E…`（第一版 D1/D3/D5 修复）、`39BFA79F…`（第二版修复）。
- 夹具：`android/evidence/v4/mock-tunnel.mjs`，端口 **9545**，分页语义照抄 `tools/dsh-remote/lib/session-reader.mjs:745-751`（`limit` 上限 1000、`cursor` 是排他上界、`nextCursor = start > 0 ? String(start) : null`、`total/from/to`）
- 数据：会话 `session-22000000-aaaa-4bbb-8ccc-000000000220`，220 条消息、seq 稀疏（`+1` 或 `+7`），更早页注入 **1200ms** 时延（模拟真实网关）
- 脚本：`android/evidence/v4/run-paging-check.ps1 -Port 9545`（一轮 194~199 秒）
- 报告：`android/evidence/v4/paging-check-report.txt`（**PASS=46 FAIL=0**，最终轮）
  - 归档：`paging-check-report-iter1.txt`（修复前，PASS=31 FAIL=9）、`iter2/`（第一版修复，PASS=43 FAIL=3）、`iter3/`（第二轮修复 + 诊断日志，脚本自身崩在 step 10 的残轮）
- 截图：`android/evidence/v4/shots/`（10 张，见文末清单）

## 一句话结论

**修复前**：分页在手机上不工作 —— 用户连续上拉 6 次（T+74s…T+176s），界面计数与夹具请求两侧都零反应；
直到点了一下「轨迹」分段按钮（T+180.8s）客户端才在 12 秒内拉走 3 页历史并**重复请求最早一页 8 次**，「已到最早」的终止态始终没有出现。

**修复后（最终轮）**：**PASS=46 FAIL=0**。首屏只发 1 条 `limit=60` 请求（60/220），
第 1 次上拉新增 1 条 `cursor=160`（60→120），第 2 次上拉 `cursor=100`（120→220），第 3 次 `cursor=40`（0..40，40 条）后出现「已到最早，没有更早的消息了」；
切到轨迹视图**新增 0 条请求**、计数不变（220/220、轨迹 561 步）；点「回到最新」**新增 0 条请求**；
D6（在途刷新留下永久空洞）回归通过：在 1200ms 在途窗口内点「刷新」把窗口打回最新一页后，重新上拉仍能取满 **220/220**。

## 权威时间轴（两侧同一时基，T+ = 相对脚本启动秒数）

### 修复前（第一轮，缺陷复现）

| T+ | 事件 | 来源 |
| --- | --- | --- |
| 27.7s | `limit=60`（无 cursor，from=160 to=220）：首屏最新一页 | 夹具控制面 |
| 34s | UI 计数 = `已加载 60/220 条`（首次出现） | UI dump |
| 74s…176s | **6 次上拉到顶**：UI 计数始终 60/220；夹具请求数始终 **1** | UI dump + 夹具控制面 |
| 180.8s | 点击「轨迹」→ `cursor=160`（from=100 to=160） | 夹具控制面 |
| 182.1s | `cursor=100`（from=40 to=100） | 夹具控制面 |
| 183.5s | `cursor=40`（from=0 to=40，本页 40 条 = 最早一页） | 夹具控制面 |
| 184.9s…192.9s | **同一页 `cursor=40` 重复 8 次**，间隔 ≈1.3s（= 夹具注入的 1200ms） | 夹具控制面 |
| 186s | UI 计数 = `已加载 220/220 条`（唯一一次变化） | UI dump |

### 修复后（最终轮，全绿）

| T+ | 夹具收到的请求 | UI 计数 |
| --- | --- | --- |
| 27.1s | `limit=60`（无 cursor，from=160 to=220，60 条） | — |
| 33s | — | `60/220` |
| 72.6s | `cursor=160`（from=100 to=160）← 第 1 次上拉 | 77s → `120/220` |
| 79.7s | `cursor=100`（from=40 to=100）← 第 2 次上拉 | 88s → `220/220` |
| 83.4s | `cursor=40`（from=0 to=40，40 条，**只此一次**） | 「已到最早」出现 |
| 95–100s | 切轨迹视图：**新增 0 条** | `220/220`、轨迹 561 步 |
| 110.8s | `limit=60`（追新页，`turn.ended` 触发） | — |
| 117s | 8b 点「刷新」把窗口重置 | `60/220` |
| 155.6s | `cursor=160`（8b 上拉，进入在途） | — |
| 160.5s | `limit=60`（8b 在途窗口内立刻点「刷新」） | — |
| 170.6 / 174.3 / 181.0s | `cursor=160` / `cursor=100` / `cursor=40` | 179s → `180/220`；189s → `220/220`（**无空洞**） |
| 合计 | **10 条 transcript 请求，其中带游标 7 条** | — |

## 缺陷清单（按严重度）与最终状态

### D1（阻塞级，界面）：上拉到顶的自动加载被"一次性闩锁"永久吃掉 —— **已修**
- 位置（修复前）：`android/app/src/main/java/com/deepseek/dshremote/ui/screens/SessionDetailScreen.kt:144-154`（`fired` 在 :147 声明、:150 置位）
- 现象：`A18 上拉到顶会触发一次更早页请求 :: 新增 0 条`（夹具权威计数 1→1，6 次上拉无一例外）。
  界面上第 0 项入口确实出现了（`A2 PASS :: 到顶判据=entry`），所以"用户确实划到了顶"没有问题。
- 机制：`fired` 是**协程局部**的一次性闩锁，而 `LaunchedEffect(listState, ui.hasMoreOlder, ui.loadingOlder, ui.viewMode)`
  的这四个 key 在"用户上下滚动"时都不会变 ⇒ 闩锁一旦被用掉，这个 effect 实例就再也不会触发。
  **直接观测到的是"闩锁在用户上拉之前就已被消费"**：入口文案可见（下标 ≤1）却 6 次上拉零请求，
  而首屏到达那一刻（`hasMoreOlder` false→true 触发 effect 重启、初值就是当前下标）是唯一的候选时刻；
  那次调用只可能被 `SessionDetailViewModel.kt:235` 的 `if (state.loadingOlder || state.loading) return` 静默吞掉
  —— 两个分支里 `state.loading` 有来源（`refresh()` 在 `SessionDetailViewModel.kt:198-216` 期间 `loading=true`），
  `state.loadingOlder` 没有来源。**"被 loading 吞掉"这一句是推断，不是直接观测**；被观测的是闩锁已失效这个事实。
- 为什么 A19（打开会话只发 1 条请求）反而 PASS：正因为那次自动触发被 `loading` 挡住了 —— 闩锁的代价正好抵消了竞态。
- **判据实测（第二轮修复前的探针轮）**：6 次到顶每次都实测 `入口可见=True firstVisibleItemIndex≈0 距末尾=60 项`，
  而夹具累计请求恒 1 条 ⇒ **判据（下标 ≤1）从未失效，错的是开火时机**；Lead 提的两条修法里选的是"上升沿/离开顶部区才重新武装"这一支，
  **没有**改成 `!listState.canScrollBackward`。
- **最终修法（两版）**：
  1. 抽出**共享判定** `LoadOlderOnReachTop(listState, enabled, onLoadOlder)`（`TrajectoryList.kt`，D1/D3 共用，避免两份逻辑漂移），
     对话流 `SessionDetailScreen.kt` 直接调用它；
  2. 第一版把开火条件绑到 `listState.isScrollInProgress` —— **复跑证明不够**：程序自己的滚动动画（`animateScrollToItem`）也会置 true，
     实测 T+181.0s 点「回到最新」时视口仍在顶部，于是**白拉走一页更早页**（这正是 A11 FAIL 的直接原因）；
  3. 第二版改为认**真实触摸手势**：`listState.interactionSource.interactions` 收到 `DragInteraction.Start` 才置 `userDragged/userScrolled`，
     开火体 `if (index > TopZoneLastIndex) requested = false else if (scrolling && !requested && userDragged) { requested = true; userDragged = false; onLoadOlder() }`。
- **验证**：`A18` 新增 1 条（60→120）、`A3` PASS、`A5` 120→220、`A22` 点「回到最新」新增 **0** 条请求。

### D2（阻塞级，数据层）：到最早之后游标不回 null，`hasMoreOlder` 永真 —— **已修（Lead）**
- 位置：`android/app/src/main/java/com/deepseek/dshremote/data/api/TranscriptPager.kt:149-161`
  `private fun pickNextCursor(offered: String?, policy: CursorPolicy): String?` 第一行
  `if (offered.isNullOrEmpty()) return current`
- 现象：最早一页（`from=0`）的响应里 `nextCursor` 是 `null`，但客户端保留了旧游标 `40`
  ⇒ `TranscriptSync.hasMoreOlder = !nextCursor.isNullOrEmpty()`（`ModelsV2.kt:188`）恒为 true
  ⇒ `A7 入口文案变成「已到最早」` FAIL、`A8b 轨迹侧同款文案` FAIL，且每次触发都重复拉同一页（**8 次重复**）。
- 影响：`loadOlder()` 永远有下一页可拉 ⇒ 任何"上拉一次取一页"的界面都会被拖成无限空转（D3 就是它的放大器）。
- **最终修法**：`TranscriptPage` 增加 `cursorProvided`（`JsonV2.kt` 用 `obj.has("nextCursor")` 区分"字段缺失"与"字段为 null"）；
  `ADVANCE`（load-older）语义下服务端**明确**回 null ⇒ 关掉上拉入口；仅"字段缺失"时保留旧游标（老网关向后兼容）。
- **验证**：`A21` 干净序列里更早页恰好 3 条（游标 160、100、40），**无重复游标**（修复前 9 次重复）；
  `A7`/`A8b`「已到最早」文案出现；`A6` 220/220。

### D3（严重，界面）：切换到轨迹视图会把历史一次性拉下来 —— **已修**
- 位置（修复前）：`android/app/src/main/java/com/deepseek/dshremote/ui/components/TrajectoryList.kt:75-84`（与 D1 同一套闩锁模式：`fired` 在 :77 声明、:80 置位）
- 现象：`A17 切换视图本身不触发额外 transcript 请求 :: 新增 3 条`（T+180.8/182.1/183.5），
  `A9 切换视图没有重新拉取 :: 60 → 220`（本该不变）。
- 机制：轨迹列表首次组合时首可见下标就是 0，effect 的 `snapshotFlow` 立即发初值 ⇒ 开火；
  每次加载完成 `loadingOlder` true→false 会让 effect 重启、闩锁归零 ⇒ **自我维持的连续拉页**（12 秒 11 条请求）。
  空转在第 8 次重复后自己停下：轨迹行带 `key = row.rowKey`，更早的行插在视口上方时 LazyColumn 会锚住原可见项，
  首可见下标随之涨过 1（这一步是推断，观测到的是重复正好停在 8 次、T+192.9s）。
- **重新表述（与 D1 同根因，不是两个缺陷）**：A17/A9 观测到的 3 条请求是**上拉期间积压的加载在切视图那一刻被放行**，
  所以 `A17`/`A9` 是 D1 的观测面，不另立缺陷。
- **最终修法**：与 D1 同一个 `LoadOlderOnReachTop`（首次组合无手势 ⇒ 不开火）。
- **验证**：`A17` 切视图新增 **0** 条、`A9` 220 → 220、`A8` 轨迹 561 步 vs 220 条消息。

### D4（中，显示口径）：计数在只拿到 120 条时就说"已加载 220/220" —— **已修（Lead）**
- 位置：`TranscriptPager.merge` 的 `loadedTo = maxOf(state.loadedTo, page.to, serverCount())` /
  `loadedFrom = maxOf(0, loadedTo - serverCount())`，显示在 `SessionDetailScreen.kt:184-188`
- 现象：T+186s 计数直接 60 → **220/220**，而当时窗口里只有 120 条消息（服务端 total 被当成"已加载数"的基数）。
- 影响：用户与自动化都会被误导；本轮 A9 的"X 不变"断言也因此被带偏。
- **最终修法**：`loadedCount` 用窗口内实际服务端消息条数（`TranscriptSync.loaded`）。
- **验证**：`A20` 界面「已加载 X」= 220 ≤ 夹具累计服务的 220 条（4 页），两侧口径一致；
  最终轮 UI 计数逐个台阶 60 → 120 → 220，最后一步不再是"一步跳到 total"。

### D5（中，可见缺陷）：视口就贴在最新一条，「回到最新」按钮却已经出现 —— **已修（真缺陷 + 两个脚本假失败）**
- 修复前现象：`A1c` FAIL，截图 `01-first-page.png` 与 `01b-first-page-fab.png` **同字节**（307289），肉眼可见右下角蓝色下箭头按钮。
- 位置（修复前）：`SessionDetailScreen.kt:495` 私有扩展 `LazyListState.isNearBottom()`（`lastIndex - firstVisibleIndex <= 2`）
  与 `atBottom` 的重算时机（只在滚动停止时重算；首屏贴底动画期间发出的中间帧把 `atBottom` 算成 false，之后没有任何事件再纠正它）。
- **真因（用 DEBUG 日志实测，不是推断）**：首屏那条 `observe` 序列显示 `total` 从 0 涨到 61 的过程中，
  `isNearBottom()` 一度为 false（`lastIdx=4 total=61 nearBottom=false`），紧跟着的一次 `scrolling=false` 就把 `atBottom` 写成 false；
  而**程序自己的**贴底动画（`animateScrollToItem`）同样会置 `isScrollInProgress` ⇒ 不能拿它当"用户操作"的信号。
- **最终修法（三处）**：①判据换成"最后一项可见"`info.visibleItemsInfo.lastOrNull()?.index == info.totalItemsCount - 1`，且 `totalItemsCount == 0` 时返回 true（首屏加载中不闪 FAB）；
  ②`atBottom` 的重算加闸：只有用户**亲手拖过**列表（`DragInteraction.Start`）之后才重算；
  ③观测信号跟着判据换成"末可见项下标"。
- **验证**：`A1c` 首屏 FAB=False、`A1d` FAB 出现与几何判定一致；01 与 01b 仍同字节（最终轮 304929 字节）—— 这次的含义是**按钮确实没画**（肉眼复核无按钮、DshPaging 日志全程 `atBottom=true`）。
- **必须区分的历史**：`A1c`/`A1d` 在修复后的两轮里继续 FAIL，是**脚本假失败** —— 脚本用文本子串找「回到最新」，
  而夹具第 220 条消息正文写着「最新消息 #220：分页窗口的末尾 —— 点「回到最新」后必须看到这一条。」；
  改成按 `contentDescription` 精确匹配（`Test-FabVisible`）后即 PASS。**这不是产品缺陷，而"修复前那张截图里按钮真的画出来了"才是真缺陷。**

### D6（严重，数据层）：在途"更早页"落到被重置的窗口 ⇒ 永久空洞 —— **已修（Lead）+ 已回归**
- 时序：窗口 offsets 100..160（游标 "100"）→ 上拉触发 `loadOlder`（在途取 40..100）→ 用户刷新 ⇒ 窗口只剩 161..220（游标 "160"）
  → 在途回包落地且游标判据 40<160 成立 ⇒ 窗口 = `seq 41..100 ∪ 161..220`，**101..160 这 60 条永久丢失**，而标题栏仍谎报「已加载 120/220 条」。
- **最终修法**：`ConsoleRepository` 加 per-session **窗口世代号** `windowEpochs`（`resetWindow` 自增、`loadOlder` 抓游标时一并抓 epoch、
  `mergeOlderPage` 发现 epoch 变了整页丢弃），另加 `normalizeOffsets` 保证 `to - from == messages.length`。
- **已知代价（有意取舍，不当 bug 报）**：`turn.ended` 的追新页也会作废在途的更早页 —— 那一次上拉会白做、需再拉一次。
- **验证（A23，脚本 step 8b）**：T+155.6s 上拉进入在途 → T+160.5s（1200ms 窗口内）点「刷新」→ 恢复上拉 →
  T+170.6/174.3/181.0s 取到 180/220 → 220/220，**窗口条数 == total，无空洞**；期间 logcat 无异常（A12–A14）。

## 复跑实测（同一脚本、同一夹具、四个迭代）

| 迭代 | APK sha256（前 8 位） | 结果 | 说明 |
| --- | --- | --- | --- |
| 修复前基线 | `887C6909` | PASS=31 FAIL=9 | 归档 `paging-check-report-iter1.txt` |
| 第一版 D1/D3/D5 修复 | `B9AD500E` | PASS=36 FAIL=7 | `A18`/`A3`/`A17`/`A21` 转 PASS；`A1c/A1d/A5/A6/A7/A11` 仍 FAIL |
| 第二版修复（`DragInteraction` 闸） | `39BFA79F` | PASS=43 FAIL=3 | 只剩 `A1c`/`A1d`（脚本假失败）与 `A21`（D6 阶段重复取页，属正确行为） |
| 第二轮修复 + 诊断日志（残轮） | `ADF9F7D9` | PASS=40 FAIL=2 | 脚本自身崩在 step 10（`raw\raw\logcat-dshpaging.txt` 路径 bug），步 10 的断言缺失 ⇒ 归档 `iter3/` |
| **最终轮（versionCode 4 / 2.2.0）** | `ADF9F7D9` | **PASS=46 FAIL=0** | 归档 `iter4-46pass/` |
| **v2.3.0 复跑（Lead，versionCode 5 / 2.3.0）** | `3A287880` | **PASS=46 FAIL=0** | 本目录 `paging-check-report.txt` / `shots/` |

**关键读数对照（D1/A1c）**：

| 读数 | 修复前 | 最终轮 |
| --- | --- | --- |
| 首屏「回到最新」出现 | True（真缺陷） | **False** |
| 上拉到顶后新增请求 | 0 条 | **1 条** |
| 上拉 3 次后的计数 | 60/220（不动） | **220/220**（60→120→220） |
| 切视图新增请求 | 3 条 | **0 条** |
| 点「回到最新」新增请求 | 1 条（程序动画误开火） | **0 条**（A22） |
| `cursor=40` 重复次数 | 9 次 | **0 次**（A21） |
| 在途刷新后能否取满 | 未测 | **220/220，无空洞**（A23） |

## 本轮已经取得的正向证据（最终轮 46 条全绿，按断言编号）

- 数据层：`A19` 打开会话只 1 条请求；`A15/A16` 夹具共 10 条 transcript 请求（7 条带游标）；`A21` 干净序列无重复游标；
  `A20` 界面计数 ≤ 夹具实际服务条数（220 = 220，4 页）。
- 首屏：`A1/A1b` `60/220`、恰好一页（`PAGE_SIZE=60`，`ConsoleRepository.kt:956`）；`A1c/A1d` 贴底时 FAB 不出现。
- 上拉：`A2` 能划到第 0 项入口；`A18` 新增 1 条；`A3` 60→120；`A3b` 一次上拉不拉完剩余历史；
  `A4` 加载更早后视口没被拽回底部（可见最小 #101，FAB 出现=True —— **这是预期行为**）；`A5` 120→220；`A6` 220/220；
  `A7`「已到最早，没有更早的消息了」。
- 轨迹视图：`A8` 561 步 ≥ 220 条消息（工具调用/结果摊平成多行）；`A8b` 轨迹侧同款「已到最早」文案；
  `A17` 切视图新增 0 条请求；`A9` 计数不变。
- 回到最新：`A10` FAB 可见；`A11` 点一次即看到末尾「最新消息 #220」；`A22` 该操作产生 0 条请求。
- 稳定性：`A12/A13/A14` logcat 本包 FATAL EXCEPTION 0 条、`Key was already used` 0 条、本包 IllegalArgumentException 0 条；
  `A23` D6 在途刷新无空洞。

## 未取证 / 明确不做声明的部分

1. **真实网关没跑**：`session-reader.mjs` 的分页实现只是被照抄成夹具，Tunnel → 网关 → session-reader 全链路未验证。
2. **窗口上限（600 条）与裁剪路径未触发**：四轮都是 220 条 < 上限，`trimOldest/trimNewer`、`enforcedCapacity` 的实际行为没有证据。
3. **只有模拟器**，没有实体手机（USB/网络抖动、真实触摸惯性未覆盖）。
4. **版本号已递增，但两轮证据对应不同构建**：本条原写「版本号未递增（versionCode 4 / versionName 2.2.0）」——现已由 Lead 递增为 `versionCode 5 / versionName 2.3.0` 并产出交付包；本目录留存的证据即跑在该构建上（`3A287880…`），上一轮同结论证据在 `iter4-46pass/`（`ADF9F7D9…`、versionCode 4），两者仅 `versionCode`/`versionName` 两字段之差。
5. **轨迹侧「已到最早」只在 220 条窗口下取证**（A8b PASS），未在"轨迹行数超过一屏很多"的极端下重复取页。
6. **D6/D7 的已知代价未单独取证**：窗口被重置或被追新页裁掉最旧一段时，在途的更早页会被整页作废（"那一次上拉白做"）——只验证了「无空洞」这一必要条件（A23 PASS），代价本身没有被单独构造与计数。两条并发缺陷的完整记录见 `docs/06-项目管理/变更记录.md` §11.2（D6）/§11.3（D7）。

## 脚本自身的两处假失败（诚实记账，已修）

1. **A5/A6/A7（第一版修复轮）**：`Invoke-PullToTop`（`run-paging-check.ps1:717`）在"入口已经可见"时**直接 return、一次都不滑**；
   取到一页后视口被锚在新载入页的顶部、入口本来就可见 ⇒ 第 2~6 次"上拉"根本没有手势（夹具累计请求恒 2 条）。
   修法：每次上拉前先朝更新方向 `Scroll-Up` 一段离开顶部区，保证产生真实手势。
2. **A1c/A1d（第二版修复轮）**：见 D5 条目 —— 文本子串匹配撞上夹具消息正文。修法：`Test-FabVisible` 按 `contentDescription` 精确匹配。

## 复现方式

```powershell
# 1) 启动夹具（分页会话 + 1200ms 更早页时延）
node android/evidence/v4/mock-tunnel.mjs --port 9545 --code 482913 --page-delay-ms 1200 --big-messages 220
# 2) 跑证据脚本（内部会自己起停夹具、装 APK、配对、跑断言、写报告）
& android/evidence/v4/run-paging-check.ps1 -Port 9545
```

## 截图清单（`android/evidence/v4/shots/`，最终轮）

| 文件（字节） | 内容 | 证明的断言 | 肉眼可判 |
| --- | --- | --- | --- |
| `00-sessions-list.png`（253831） | 配对后的会话列表，含「分页验证：220 条历史消息」 | 配对/列表 | 是 |
| `01-first-page.png`（304929） | 首屏：副标题 `已加载 60/220 条`、分段 `对话（60/220）` / `轨迹（153 步）`，视口停在 #218…#220，**右下角没有按钮** | A1/A1b/A1c/A1d | 是 |
| `01b-first-page-fab.png`（304929） | 与上一张**同字节**（按钮确实没画） | A1c | 是 |
| `03-after-pull-1.png`（287444） | 第 1 次上拉后：计数 `120/220`，视口在旧历史 #101…，右下角出现「回到最新」 | A3/A3b/A4/A18 | 是 |
| `05-after-pull-2.png`（300756） | 第 2 次上拉后：计数 `220/220` | A5 | 是 |
| `06-earliest.png`（300756） | 第 3 次（拉到最早）：入口文案「已到最早，没有更早的消息了」 | A6/A7 | 是 |
| `07-trajectory.png`（282707） | 轨迹视图：`220/220`、轨迹 561 步 | A8/A8b/A9/A17 | 是 |
| `08-fab-visible.png`（300756） | 上翻历史时右下角「回到最新」 | A10 | 是 |
| `09-after-fab.png`（304695） | 点「回到最新」后看到「最新消息 #220」 | A11/A22 | 是 |
| `10-d6-after-refresh.png`（300591） | D6 回归：在途刷新之后重新拉到最早，计数 `220/220` | A23 | 是 |

需要读夹具日志/控制面才能判的断言：A18、A17、A19、A15、A16、A21、A22、A23
（界面文案上看不出请求有没有发出去，这也是本轮加时间轴、`/__control/transcript-log` 与 DshPaging 诊断日志的原因：
诊断日志落在 `android/evidence/v4/raw/logcat-dshpaging.txt`，249 行，`if (BuildConfig.DEBUG)` 守卫，正式包不含）。
