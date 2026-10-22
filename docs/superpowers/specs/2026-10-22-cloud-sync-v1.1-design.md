# QUIT / 365 V1.1 云同步安全设计（待审阅）

日期：2026-10-22。基线：生产 V1.0.3 / `dd17430`。本设计尚待用户确认；本分支当前不改变应用行为。

## 目标与边界

保留原生 HTML/CSS/JavaScript、GitHub Pages、PWA、IndexedDB 和全部医学与统计规则。新增可选择开启的单用户云同步，服务 iPhone Safari/主屏幕 PWA、Mac、PC。公开源码仓库 `sunnyflame888/quit365` 不含个人数据；新增私有 `sunnyflame888/quit365-data` 不启用 Pages。所有实现只进 `feature/cloud-sync-v1.1`，测试通过后提交 PR；不得合并或覆盖生产 main。

现有检查：7/7 逻辑测试通过；`src/app.js` 集中处理 UI、记录和备份，`src/store.js` 使用 `quit365-local-v1` / `kv` / `state`，无网络接口。当前 CLI 所见尚无 `quit365-data` 仓库。保留现有数据库名称、state 键和 schemaVersion=1，不删除原记录。

## 方案选择

1. **推荐：Worker + 一个 SQLite-backed Durable Object（仅认证状态/限流）+ GitHub 私有文件版本。** Durable Object 用于需要原子消费的 OAuth 请求、短期会话与限流；不保存日志。健康记录保存在私有 GitHub 的单一 JSON 文档，使用文件 SHA 比较后写入。无需独立服务器或业务数据库。
2. Worker + Workers KV：部署组件相近，但 KV 的最终一致性不适合一次性 OAuth 凭证消费和即时会话撤销；不选。
3. Worker + D1：能实现事务，但需维护额外 SQL 表及查询流程；对本项目的认证元数据没有明显优势，不选。

Durable Object 仍是云端状态存储，存在用量与服务配额；不能声称 Worker 完全无状态或零成本。部署前检查账户支持情况，不自动购买套餐。

## 信任边界与凭据

- 只允许 GitHub 数字用户 ID `289706800`（当前 sunnyflame888）建立个人会话；不以可改名的 login 单独授权。
- 登录使用 GitHub OAuth Authorization Code + S256 PKCE + 随机 state，不申请 repo 权限。OAuth 用户令牌只在 Worker 内用于获取 /user 身份，不发给前端、不用它写数据仓库；身份核验后撤销该临时令牌。
- 另一个 fine-grained PAT 仅选择 `quit365-data`，授予 Contents: Read and write 及 GitHub 自动附带的 Metadata: Read。不授予公开源码、Actions、其他仓库或组织权限。设置到期日；保存在 Cloudflare Secret 中，不使用当前 gh CLI 的广权限令牌作为运行凭据。
- OAuth Client Secret、数据仓库 PAT 仅存在 Cloudflare Secrets。公开配置只有 API 地址、GitHub OAuth Client ID（如需要）、允许的前端地址等非秘密信息。
- Worker 数据请求除校验会话与用户 ID 外，再检查数据仓库确实 private；权限或私密性检查失败则拒绝读写。缺失配置时 fail closed，不退回匿名访问或其他仓库。
- 私有 GitHub 及其 Git 历史仍含健康信息；GitHub、Cloudflare 和被授权的账户管理员可接触明文。删除当前文件不会清除历史提交。

## 登录与 iPhone/PWA

避免依赖跨站 Cookie。Pages 和 workers.dev 是不同站点，不能假设 Safari 会接受第三方会话 Cookie。

1. 用户在设置中点“使用 GitHub 登录”；前端生成高熵 PKCE verifier 和 state，将短期待登录信息存于本设备，调用 Worker 创建十分钟有效的授权请求。
2. Worker 固定 GitHub 授权地址、回调地址和前端返回地址，保存 challenge/state 的绑定；禁止任意 return URL。前端通过用户点击打开授权页，避免异步弹窗被拦截。
3. GitHub 回调只交给 Worker。Worker校验 state、过期和单次使用状态，暂存授权 code，生成 256 位随机一次性 ticket，以 fragment 返回固定 Pages 地址；URL 中没有应用会话、PAT 或健康数据。Pages 立即清除 fragment，禁止把 ticket 交给第三方资源。
4. 同一浏览器可用原 verifier + ticket 向 Worker 完成交换。Worker携带 client secret 和 verifier 兑换 GitHub code，获取 /user 并核对数字 ID，通过后原子消费 ticket，再签发独立的随机应用会话。
5. 若 iOS 主屏幕 PWA 的授权回到 Safari，Safari 中没有原 verifier，不能自行登录：显示“复制一次性授权码并返回发起登录的应用”，在原 PWA 中粘贴 ticket 后完成交换。ticket 单独不能取得会话；原 verifier 单独也不能取得会话。授权码过期可安全重新登录，不改本地日志。此为浏览器隔离时的明确兼容回退，不假设 Safari/PWA 共享存储。
6. 会话 bearer 仅放 sessionStorage，不放 URL、GitHub 或持久日志。关闭会话/会话失效须重登，不影响离线记录。会话最长 12 小时，空闲 1 小时过期；Worker每次请求检查到期与撤销，退出登录立即撤销。前端登录中断、拒绝授权、错误账户和到期均有可恢复提示。
7. OAuth ticket、state 和会话令牌仅存哈希索引；短期必要 OAuth code 在 Durable Object 内到期删除。禁止输出令牌、code、请求体、日志至应用日志。清理过期记录，限制单个来源未完成请求数量。

身份核验前不读取或上传任何健康记录。身份核验通过也不代表用户已同意首次上传：仍需下面的迁移确认。

## 云端文档与版本并发

- 固定路径 `data/state.json`，固定数据仓库和分支；客户端不能指定 repo、路径或用户 ID。
- 文档为 `{formatVersion:1, appState:<现有 schemaVersion=1 的状态>}`；GitHub 内容 SHA 是不透明 revision。`formatVersion` 与医疗数据 schemaVersion 分离；未知未来版本拒绝写入，保留本地数据并提示升级。
- GET /v1/state 返回文档与 revision；无文件时返回明确的空云端状态，不把其他 404/权限错误当成空数据。
- PUT /v1/state 必须带先前 revision（首次创建明确为 null），以该 SHA 调用 GitHub Contents API；GitHub并发冲突映射为 HTTP 409。禁止无条件重试“用最新 SHA 覆盖”。所有数据严格校验大小、日期、布尔值、数值范围、字符串和数组类型，防止把异常数据注入现有模板。
- 单次上传最大 1 MiB；过大不上传且提示导出备份。后续扩容须升级设计，不能偷偷截断日志。
- 全部数据响应 Cache-Control: no-store；前端 API fetch 不使用浏览器缓存；Service Worker 仅缓存本站静态资源，绝不缓存 Worker 身份或健康 API。

## 同步协调与离线

- 先写本地事务，再排队同步。IndexedDB 的同一 kv 对象仓库增加 sync metadata 与迁移快照键，不重命名或删除旧 state。
- metadata 包含云端基础版本、基础快照、dirty generation、已确认上传 generation 和待解决冲突；不把会话或 PAT混入可导出的健康状态。只合并最新待上传快照，不无限累积每次按键的完整健康副本。
- 启动/返回前台/恢复联网时验证会话并拉取；前台每 30 秒检查远端变化以更新其他设备的修改，不承诺 iOS 后台实时运行。保存后先防抖约 1 秒，所有请求串行；请求超时 15 秒。
- 成功响应只能确认该次上传的 generation；上传过程中发生的新编辑仍为待同步，不能被较早的回包标记成已同步。
- 同步回包应用前再次比较本地 generation，避免慢 GET 覆盖刚录入的日志。多标签页以 IndexedDB 事务检查本地 revision；遇到过期写入保存独立草稿并提示，不静默覆盖另一个标签的本地编辑。
- 临时网络/5xx/429 按 2、5、15、30、60 秒上限并带随机抖动重试；遵守 Retry-After；离线停止请求。401/403要求重新登录或修复权限；409进入冲突流程；校验错误不得无限重试。
- 顶部轻量状态：已同步、待同步、离线、同步失败；另明确未登录/未启用、首次迁移待确认与存在冲突。所有页面沿用原导航与视觉，不重新设计 UI。
- PWA关闭时不承诺上传成功或持续轮询；下次打开自动读取本地待同步队列并继续。

## 冲突解决

- 使用基础快照、本机最新状态、云端最新状态三方比较。只有可证明双方互不重叠的修改才自动合并，并显示其他设备已合并的提示。
- 日志以日期为最小冲突单元：两个设备都更改同一天日志，即使一个修改服药、另一个修改备注，也必须明确处理，避免按时间戳猜测优先级。相同结果不算冲突。
- 治疗 settings 整块作为一个单元，不自动拼接两份医嘱/日期设置。urges 按稳定记录身份合并；旧格式使用内容确定的身份，不把导入的同一记录重复计数；删除和新增/修改冲突必须显式提示。
- 冲突 UI 在设置显示本机与云端差异、各日期与设置的选择，以及保留/导出双方备份的入口；不提供默认静默“最后写入者获胜”。选择后仍以最新 revision 条件写入，再次冲突则重新展示。
- 自动拉取不允许覆盖未同步修改。解决前保留本机、云端和基础快照；网络失败不清除冲突或草稿。

## V1.0首次迁移与回滚

1. 升级打开仍先读原 `quit365-local-v1` / `kv` / `state`，默认仅本地使用；配置后可登录。登录前绝不自动上传。
2. 登录后先拉云端，展示本机/云端日志数量及是否有日期/设置冲突，提供原有加密/JSON导出。原始本地状态还须在 IndexedDB 中保留专用迁移快照。
3. 用户确认已保存备份并选择“合并并开启同步”后才执行首次条件写入。云端为空时上传本机；云端有数据时预览合并；任何同日/设置冲突必须选择，不用空白新设备默认设置覆盖云端计划。
4. 云端写入成功后再标记迁移完成；中断、离线、重复点击或响应丢失均可安全重试，不能出现双份日志或假成功。
5. 新设备本地确为空且无实际编辑时，可在授权确认后下载云端。两设备都有日志则不能假设任一边是主副本。
6. V1.0 回滚：先导出最新完整状态，关闭同步；保留 schemaVersion=1 的 state。只回滚前端版本即可继续读取本地日志；生产 main 在 PR 期间不变。云端 SHA/Git历史用于有授权的人工恢复，不能自动用旧提交覆盖现有数据。PAT失效/Worker停服不影响本地读写。
7. 原有清空/导入操作必须改成同步可识别的显式本机或云端操作：清空本机不应默默删除云端；恢复备份不应无条件覆盖云端。确认对话框说明范围，操作前保存可导出快照。

## 客户端端到端加密评估

可用 WebCrypto 从独立同步口令派生密钥，再以 AES-GCM加密整份文档；Worker只存密文和版本。GitHub登录不能恢复密钥，所有设备首次使用还要输入同一口令；遗失口令无密码重置可救回数据。冲突需要客户端解密双方，换口令涉及全量重加密与 Git 历史中的旧密文。

本设计建议 V1.1 先实现经过认证的私有云同步，明确**不是端到端加密**；保留现有加密备份。客户端加密不以虚假的“private=加密”替代，也不静默新增口令；若用户要求云端也必须无法读取内容，则需先把客户端加密纳入 V1.1 验收再实施。

## Worker API 与安全控制

- `POST /auth/start`：仅创建短期 OAuth请求；无健康数据访问。
- `GET /auth/callback`：验证state后仅生成一次性ticket，固定跳转；不建立未授权的数据会话。
- `POST /auth/exchange`：ticket+verifier交换、PKCE、GitHub身份白名单、单次消费。
- `GET /v1/session`、`POST /v1/logout`：必须有效 bearer；退出即时撤销。
- `GET /v1/state`、`PUT /v1/state`：会话+ID+private检查+限流+严格schema+CAS。
- CORS只允许精确生产 origin；localhost仅显式开发配置。CORS不是鉴权；无 Origin/伪造 Origin 也无法绕过 bearer。OPTIONS不返回个人数据。
- OAuth创建每IP每10分钟10次，交换每请求至多5次失败；会话每分钟120请求，写入每分钟30次，超限429。来源IP仅用于短期哈希限流，不进Git数据。
- 固定GitHub API地址，不接受任意上游URL；禁止把Authorization转发到重定向域；统一错误文案不泄漏上游响应、仓库内容、token。
- 公开前端脚本无第三方依赖/追踪；CSP尽量限定script/connect来源，外链保留noopener。所有新展示字段按文本渲染。
- Secrets到期前轮换：新PAT最小权限验证后覆盖secret并部署，撤销旧PAT；OAuth secret轮换保留到期窗口；应急可撤销全部会话或停止Worker，不删除本机数据。

## 实现边界与文件职责

- `src/sync-schema.js`：云格式/安全校验，独立于医疗计算。
- `src/sync-merge.js`：纯三方比较与冲突结果。
- `src/sync-client.js`：认证与同步状态机、串行重试、生命周期。
- `src/sync-ui.js`：小范围登录/状态/迁移/冲突控件。
- `src/sync-config.js`：非秘密配置，未配置时关闭同步。
- `src/store.js`：增加metadata/快照与本地revision事务，兼容原数据。
- `src/app.js`：将现有persist与新协调器连接，安全应用远端结果，保留备份和医学内容。
- `worker/`：API路由、OAuth、会话/限流Durable Object、GitHub仓库适配器、Wrangler配置。前端不依赖Worker开发包。
- `tests/`：原7项测试不删；新增schema、merge、同步状态机、Worker鉴权/并发测试。
- `docs/`、README、HANDOFF：部署授权、测试证据、迁移/回滚、凭据轮换与限制。

## 验收证据与发布边界

必须先有可失败的自动化测试，再实现相应模块。覆盖未登录/错误用户/过期会话/CORS伪造/state重放/PKCE失败/ticket重复消费/错误repo权限/public仓库/远端格式异常；两设备不同日合并、同日冲突、settings冲突、删除冲突；上传途中再编辑、GET途中编辑、响应丢失后重试、离线重启、恢复联网、跨标签旧写入；空云端首次迁移、已有云端首次迁移、迁移中断、重复迁移、备份导入/退出登录/清空本机。

浏览器用两个隔离上下文模拟不同设备，验证状态、迁移、冲突、离线、刷新持久化；手机尺寸检查保留V1.0.3的日期和图表修复。真实iPhone Safari/PWA、GitHub OAuth与实际Cloudflare部署必须分别记录证据；模拟通过不能写成真机/真实云通过。

阶段交付顺序：书面设计审阅 → 实施计划审阅 → 模块实现与测试 → PR（不合并） → 用户完成OAuth App及Cloudflare授权/Secrets → 非生产真实云验收 → 用户决定何时合并上线。未获真实账户授权时交付完整可部署源码与清单，并明确待验收项；不得把尚未实际运行的跨设备云同步标记完成。

## 官方依据（2026-10-22查验）

- GitHub OAuth/PKCE：https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
- GitHub Contents API及SHA与最小权限：https://docs.github.com/en/rest/repos/contents
- Cloudflare事务性Durable Object存储：https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
