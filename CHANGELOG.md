# Changelog

本项目遵循语义化版本；日期用 `YYYY-MM-DD`。

## 0.2.4 — 2026-11-21

### 修复

- **思考里引了一句 `<diary></diary>`，真正写好的日记被整篇丢掉**：模型这次把草稿过程放进了 `reasoning` 块，里面有一句「Only `<diary></diary>` content.」，而取正文时把 reasoning 的 text 也算进去了；`cleanText` 的正则先匹配到那对**空标签**，于是正文变成 0 个中文字，判成「正文不合格（中文太少（0 字））」，实际会话里那篇 185 字的日记是合格的。两处一起改：取消息正文时只认 `type: "text"` 的块（不再收 reasoning/thinking 里的 text）；`cleanText` 改为在所有 `<diary>…</diary>` 段里取**最长的一段**，空标签对和零碎片段抢不走正文。
- 新增两个用例（前面引过空标签、多段取最长）覆盖这个场景，测试 22/22。

## 0.2.3 — 2026-11-21

### 修复

- **客户端模块 id 与包名不一致，设置里「日记」整页消失**：改名后 `client.js` 注册的 id 仍是 `dsh-diary`，而 DSH 按插件名 `dsh-easy-diary` 查找已注册的 factory，找不到就再执行一遍 bundle，于是报 `client-modules: duplicate factory registration for "dsh-diary"` 并让整个客户端半边加载失败。现在 id 与 `package.json` 的 `name` 一致。
- `test/client.test.js` 的自注册用例改为断言「id 等于 `package.json` 的 `name`」，以后改名再踩同一个坑会直接测试失败。
- **新增/重新启用会话不再立刻写日记**：原先 `POST /config` 在这两种情况下会马上 `runDue()`，于是在设置页点「加入」的瞬间，插件就往那个会话里丢一条写日记任务（实测在 QQ 群会话里注入 3 条消息、对话被打断，日记还因正文不合格失败重试）。现在任何配置改动都只重排定时器，从下一次 `at` 开始写；要补今天用卡片上的「现在写今天」，加入后设置页也会提示这一点。
- **「新对话注入 N 天」如实改成「N 篇」**：`recapText` 一直是取最后 N 段日记，中间断写时覆盖的不止 N 天。界面、README、日志、注入正文里的措辞统一成「篇」，`recapDays` 字段名保持不变（兼容旧配置）。
- **拿不到 `agent.inject` 时不再静默降级**：`seedRecap` 现在返回 `injected / skipped / empty / failed`，跳过时日志写明「这本新会话不会带旧日记」，并把探测结果放进 `/diary-api/state` 的 `recapOk`；设置页在该项旁边显示一行提示。代码注释里原来写着「没有 inject 就退 followup」，实际从未实现——也不打算实现，那会让模型真的回一句（群里可见）。
- **定时器回调补上 `catch`**：`scheduleNext` 里的 `runDue` 原来没有接住 rejection，定时一抛就是未处理拒绝（Node 24 默认当异常，能把宿主带走）。
- **`/write` 的日期要真存在**：`body.date` 现在过 `validDay`，`2026-02-31` 这类会被 `Date` 悄悄算成 3 月 3 日的假日期直接 400，不再写成「## 2026-02-31 日记」永久留在文件里。
- **手改过的日记文件不再粘标题**：写之前若文件末尾没有换行，先补一个，避免 `…上一段## 2026-11-21 日记` 连成一行。
- **按天清上下文后不再留孤儿 `resetDue`**：换到新 id 时删掉旧 id 的到期日。
- **`POST /config` 不再接受 `s.newId` 直接改会话 id**：那是不归档、不搬桥映射、不动 state 的静默接管口，换会话只走 `/reset`。
- `/write` 撞上「正在写另一本」时给出明确原因，不再是上一次失败留下的旧错误。
- 只读接口的响应加 `cache-control: no-store`（日记刚写完不该被浏览器缓存拿旧的）。
- **崩溃留下的「半截回合」不再把日记永久卡死**：宿主在回合中途被杀时，日志里只有 `turn/start` 没有 `turn/end`，`turnState` 会一直认为她在聊，于是每晚都先取消、等 20 秒、判失败。现在超过两小时没有新事件就按残骸处理（按已结束），并写日志说明。
- **整篇写成繁体时重写一遍简体**：2026-11-21 群那篇日记整段是繁体（简体正文里绝不会出现这么多繁体字），原因是提示词只写了「中文散文」没限定简繁。现在提示词明确「只用简体中文」，质量闸门另外统计繁体字，`>=5` 时就地要她用简体重写一遍；重写拿不到合格正文也照收原文（繁体总比缺一天好），并写日志。
- **回合结束后多等几秒再取正文**：`turn/end` 有时候比助手消息进 store 早几毫秒，原来会立刻拿到空文本判失败；现在最多再等 6 秒。

### 加固

- **请求体设上限 256 KB**，超了回 413；JSON 解析失败回 400。原来所有写接口都是无上限地 `for await` 拼字符串，本机任意进程发个大包就能把宿主内存吃干。
- 顶部注释里「owner-only」的过时说法删掉（资源路由根本拿不到 Peer，只有回环这一道边界）。

## 0.2.2 — 2026-11-20

### 变更

- **发布名改为 `dsh-easy-diary`**：原本想用的 `dsh-diary` 在 npm 上已被别人占用（`hypermoss11` 的 0.1.1）。只改了 `package.json` 的 `name` 和 `cordis.patch.yml` 里的 `name`；行 id、`dsh-diary.log`、`/diary-api` 路由都没动。
- 仓库更名为 **dsh-easy-diary**，README 的安装段改成以 npm 为主：DSH 的「插件 → 添加插件」里填 `dsh-easy-diary` 即可，另附本地目录 / Release tarball 两种备选；删掉「把 `plugins/dsh-diary/` 整个目录放进插件搜索路径」——那是插件还寄居在别的仓库里时的旧路径，独立仓库的根目录就是插件本体。
- 补充「npm 安装升级会替换整个包目录、`config.json` 会丢」的提醒。
- `package.json` 的 `repository` / `homepage` / `bugs` 从 `dsh-diary` 改成 `dsh-easy-diary`（旧地址只是 301 重定向）。

无功能代码改动。

## 0.2.1 — 2026-11-20

### 移除

- **旧的 HTML 控制页 `/diary-api/ui` 整页删除**（含后端 `renderUi`、`legacyUrl` 字段、前端「旧版控制页」链接）。该页挂在宿主的只读资源路由下，表单提交全是 POST，必然 405；「看日记」还用了根绝对路径 `/read`（404）。留着只会让人以为它还能用。管理界面只剩 **设置 → 日记**。

### 修复

- **`/reset` 改成先建新会话、成功后才归档旧会话**。原来先归档再建，建失败时配置仍指向已归档会话，这本日记从此写不出来。接口现在如实返回 `{ ok, oldId, newId, archivedOk, error }`。
- **`config.json` / `state.json` 改原子写**（临时文件 + `fsync` + `rename`）。原来进程被杀在写一半，下次启动读到空配置 → 会话全丢、token 重新生成。
- **`token` 首次生成即落盘**，不再每次重启换一个。
- **等待回合改为以 `turn/end` 为准**：超时后如果回合还没结束，发 `cancel` 停掉并记日志，不再「有正文等 30 秒就收」，避免把半篇日记收下。
- **`followup` 全部 `await`**：原来未处理的 rejection 能带崩宿主进程。
- **热重载不再整数组替换 `sessions`**：按 id 就地合并，正在进行的写入不会把旧 id 写回配置；`dispose` 里补了 `fs.unwatchFile`，禁用再启用不叠 watcher。
- **时间校验统一**：`normalizeAt` 一处实现，`atToday` / `pastTodayAt` / `POST /config` 共用；`25:00` 这类直接拒，`7:05` 规范成 `07:05`。原来 `pastTodayAt` 用原始时分，填 `25:00` 会导致「永远认为没到点」，天天写前一天。
- **`/toggle` 从 GET 改成 POST**（带副作用的 GET 会被预取/爬虫触发）。
- **桥映射精确改写**：只改 `sessions` 里已知字段（`sessionId` / `session_id` / `id`）和扁平值，不再递归替换整棵树里所有等于旧 id 的字符串；写文件走原子写；改完立即失效 30 秒缓存。
- **`state.json` 孤儿键剪枝**：换会话/移除会话后，`lastWrite` / `ruleSent` / `attempts` 等不再无限堆积旧 id。
- **日志路径随 `diaryDir`** 现算，热改目录后日志跟着走。
- 删死代码 `scanSessionDirs`（含一个会破坏 Windows 路径的正则）。

### 变更

- **改配置不再顺手写一篇日记**：`POST /config` 保存后只重排定时器，只有「新增会话」和「从关到开」才立刻补跑一轮（否则 23 点后新加的书会等到明天、漏掉当天），其余改动等下一次 `at` / 重启 / 重试 / 手动按钮。
- **写接口只接受本机来源**：`/diary-api-write/*` 在 `x-diary-write: 1` + 同源 `Origin` 之外，还校验 `req.socket.remoteAddress`，非回环一律 403 `local only`（并记日志）。
- **绑非回环地址时告警**：挂路由时读 `webServer.host`，不是 `127.0.0.1` / `::1` 就写警告日志；`/diary-api/state` 新增 `bindHost` 与 `nonLoopback` 字段。
- **会话事件按 `(size, mtime)` 缓存**，轮询不再每 2 秒整份解压 zstd。
- 测试从 14 个增加到 16 个（新增 `normalizeAt` 用例）。

### 未改（已知，记录在案）

- 只读接口 `/diary-api/*` 仍不校验身份：DSH 的 `WebResource` 只传 `Fetch Request`（源码注释：*without a Peer*），插件拿不到 socket 或 principal，只能靠「绑定地址是回环」这一层。
- 本机任意进程仍可读 `state` / `read` 并伪造写请求（属于信任边界以内）。

## 0.2.0 — 2026-11-20

- 首个快照：每晚定时按会话写日记、补写、看日记、提示词可编辑、归档注入、桥映射跟随、DSH 设置页。
- `92dbc3e` 把 `client.js` 补进 tarball。
