# V1.1 部署与账户授权

2026-10-22。前端仍为GitHub Pages静态PWA；Worker是额外的鉴权/读写接口，不替换前端托管。源码分支 `feature/cloud-sync-v1.1`，合并和生产切换须由用户决定。

## 当前外部状态

- 源码仓库：[quit365](https://github.com/sunnyflame888/quit365)，公开。
- 数据仓库：[quit365-data](https://github.com/sunnyflame888/quit365-data)，**Private**；main含README与`data/state.json`的2天合成验收记录（SYNTHETIC/设备测试标记）；Pages未启用。没有上传原生产站健康日志。
- Cloudflare登录已验证，Worker已部署为 [quit365-sync.quit-365.workers.dev](https://quit365-sync.quit-365.workers.dev)。GitHub OAuth App已创建，两项秘密均以Secret类型保存；公开Client ID已配置。真实未登录GET/PUT返回401，伪造会话401，非允许来源403；OAuth入口、完整正确账户交换及桌面合成数据同步通过。固定callback、S256和空scope已核对。
- 独立预览[quit365-preview](https://quit365-preview.pages.dev/)首页及14个资源均200并核对内容；Worker修复已部署为10d5299b，60项测试通过。真实登录/私有读写/合并/冲突选择及iPhone→电脑标记同步通过。主屏幕与真机离线验证按用户要求跳过。Worker固定回跳预览、关闭localhost例外；源码Wrangler保留正式Pages默认值。前端 `src/sync-config.js` 的URL仍为空，生产main未改变。
- 本文命令中的Secrets均通过交互提示输入，不把值写进命令、聊天、源码或终端历史。不要用当前gh CLI的广权限token作为Worker凭据。

## 1. 本机验证

在本项目目录，使用Node 22或以上（CI使用Node24）：

```bash
npm ci --ignore-scripts
npm test
npm run worker:check
npm run check:public
npx playwright install chromium webkit
npm run test:browser
QUIT365_BROWSER=webkit npm run test:browser
```

前端运行时没有第三方依赖；npm依赖仅用于开发、Worker打包和测试。浏览器测试自建临时静态服务，用两个隔离上下文及合成日志，不访问真实OAuth或健康数据。截图写入操作系统临时目录。

## 2. 私有数据仓库核对

GitHub打开quit365-data → Settings → General → Danger Zone确认Private，勿改为Public。Settings → Pages不启用。main必须已有README提交；空仓库没有main时，Worker拒绝把无法确认的404当作空数据。

Worker只允许 `sunnyflame888/quit365-data` 的main分支 `data/state.json`；不接受客户端传入其他仓库/路径。文件首次同步时创建，不需手工粘贴真实日志。

## 3. Cloudflare登录与初始Worker

由账户本人在终端运行并完成浏览器授权：

```bash
npx wrangler login
npx wrangler whoami
```

登录完成后，检查 `worker/wrangler.jsonc`：name为quit365-sync，AUTH绑定AuthState，v1迁移使用SQLite。使用账户支持的Workers/Durable Objects额度；不自动购买套餐。

初次部署可先保留空OAuth Client ID及未配置Secrets，服务会拒绝数据请求：

```bash
WRANGLER_SEND_METRICS=false npx wrangler deploy --config worker/wrangler.jsonc
```

记下返回的HTTPS Worker地址，例如 `https://quit365-sync.<你的子域>.workers.dev`。在配置中设置 `WORKER_URL` 为该origin，**不带末尾斜杠**。这只是公开接口地址，不是秘密。默认APP_ORIGIN/APP_URL指向现有生产Pages，客户端不能指定回跳地址。

## 4. GitHub OAuth App（仅登录身份）

GitHub → 头像 → Settings → Developer settings → OAuth Apps → New OAuth App：

- Application name：QUIT / 365 Sync。
- Homepage URL：`https://sunnyflame888.github.io/quit365/`。
- Authorization callback URL：`https://quit365-sync.quit-365.workers.dev/auth/callback`，必须与WORKER_URL一致；不启用通配符。
- 不需要开启Device Flow。

创建后，Client ID填写到Wrangler vars的GITHUB_CLIENT_ID；Generate a new client secret产生的值只交互写入Cloudflare：

```bash
npx wrangler secret put GITHUB_CLIENT_SECRET --config worker/wrangler.jsonc
```

应用请求空scope，通过/user核对GitHub数字ID289706800；如果历史授权意外带repo等超出身份用途的scope，会拒绝并撤销临时令牌。临时GitHub用户token不送入浏览器，也不用来访问数据仓库。

## 5. 最小权限数据凭据

GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token：

- Resource owner：sunnyflame888。
- Expiration：设置较短有效期，记录轮换日期。
- Repository access：Only select repositories → 仅quit365-data。
- Repository permissions：Contents → Read and write；Metadata为自动附带Read。
- 不授予Actions/Workflows、公开源码仓库或其他仓库权限。

仅交互存入Cloudflare：

```bash
npx wrangler secret put GITHUB_DATA_TOKEN --config worker/wrangler.jsonc
```

随后使用下一节的非生产预览部署命令，避免普通deploy将临时回跳切回正式Pages。当前PAT已生成，只选quit365-data，Contents读写、Metadata只读，30天有效（2026-11-21到期）。GitHub最终确认界面核对为1个仓库/2项权限；Cloudflare两项均显示“加密值”。值只在浏览器配置期间短暂保留内存，保存后清除；没有写入聊天、源码或临时凭据文件。

也可在Cloudflare Dashboard → Workers & Pages → quit365-sync → Settings → Variables and Secrets，将上述两项设为Secret。不要截图、粘贴或导出它们到公开文件。不要把实际值放在项目根目录或worker/的.env、.dev.vars，即使已被gitignore忽略。

## 6. 不修改生产main的真实OAuth预验收

本机可以先预览 feature 分支。运行 `npm run dev`，使用 `http://localhost:4173/`；localhost属于安全上下文，可使用IndexedDB/WebCrypto。

在尚未接入生产站的Worker上，用命令覆盖公开vars；不必把localhost提交为正式默认值：

```bash
npx wrangler deploy --config worker/wrangler.jsonc \
  --var APP_ORIGIN:http://localhost:4173 \
  --var APP_URL:http://localhost:4173/ \
  --var ALLOW_LOCAL_DEV:true
```

再次部署Worker；将本分支 `src/sync-config.js` 的公开SYNC_API_URL设为实际Worker origin。GitHub OAuth App的回调仍为Worker HTTPS地址，无需改成localhost。在独立浏览器配置/空本地数据库中只录入合成数据，测试登录、拒绝错误账号、退出、显式迁移及两个浏览器并发编辑。仓库已有真实数据时，不执行自动化修改或清空；先私密备份，再由本人选择手动验收方式。

本机预览不会发布main。预验收后在线退出登录，把APP_ORIGIN/APP_URL恢复到正式Pages HTTPS地址，移除ALLOW_LOCAL_DEV或设false，再部署。当前实现也允许管理员声明一个固定的HTTPS预览前端地址；不能由请求参数覆盖它。

iPhone真机预生产验收需要可访问的HTTPS预览前端；localhost预览仅针对运行服务的电脑。若没有单独HTTPS预览，真机验收留在用户明确批准生产切换之后，不能把WebKit自动化写成iPhone真机通过。

当前独立HTTPS预览采用Cloudflare Pages直接上传，仅作为非生产验收，不替换GitHub Pages。上传包为 `/private/tmp/quit365-v11-https-preview.zip`：index.html在根，只有styles.css、manifest、sw.js、src的8个模块及2个图标，共14文件；没有Git、文档、测试、Worker代码或Secret。副本中API指向上述Worker，缓存版本为preview1，正式源码API仍关闭。通过控制台上传并部署后，必须先验证首页200、无追踪脚本、静态离线和OAuth，再给iPhone录入合成数据验收。

此前CLI默认广权限重新授权被自动审批拒绝，没有绕过。本人随后明确批准仅account:read和workers_scripts:write；启动登录后发现Wrangler自动附带offline_access，未授予该范围。控制台编辑器此时恢复，CLI待授权进程已取消，最终通过原有Dashboard会话部署，无新增CLI凭据。浏览器扩展未扩大file URL访问权限，公开ZIP由本人手动上传。控制台首次部署因原有诊断被自动审查拦截，消除诊断并通过60项测试后再部署成功。

## 7. 前端启用与生产切换

确认Worker已配置、private检查和OAuth预验收通过后，在feature分支设置公开API URL。若使用workers.dev以外的自定义域，还需将该精确HTTPS origin加入index.html的connect-src；当前策略只允许self及workers.dev。不要用任意HTTPS通配策略。

变更API配置等静态资源时同步提升sw.js缓存版本。PR审查和CI通过后，再由用户批准合并。Pages仍使用main / root，.nojekyll保留。首次刷新可能先显示旧版本，等待新Worker静态缓存安装后再刷新；切勿清除网站数据来更新版本。

## 8. 日常维护与紧急处理

- PAT到期前生成同样最小权限的新PAT → 覆盖Cloudflare Secret → 部署验证 → 撤销旧PAT。Worker无法访问仓库时停止安全读写，本机仍可记录/备份。
- OAuth Client Secret轮换后覆盖对应Secret并部署；旧授权请求可能失败，重新登录即可，不改本机数据。
- 退出登录在线时即时撤销对应应用会话。离线退出只能清除本机会话，服务端旧会话最迟按空闲1小时/绝对12小时过期；界面会说明。
- 应急撤销数据PAT或停用Worker可立即切断云端读写；不要删除本机数据库。若需撤销全部会话，可部署新的AUTH命名空间绑定，旧会话将全部失效；不触碰数据仓库。
- 云端文件和Git历史均是明文健康数据，不是端到端加密。删除当前文件不清除历史。GitHub、Cloudflare管理员及有权限的仓库访问者可读取内容。
- 同一sunnyflame888.github.io域的其他Pages项目处在同源信任边界；不要部署不可信脚本。迁往专用域名会改变本地存储，须先备份迁移。
- 不承诺PWA关闭后后台上传；前台每30秒检查，保存后约1秒排队，网络恢复或回前台重试。

官方参考：[GitHub OAuth/PKCE](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)、[GitHub Contents与最小权限](https://docs.github.com/en/rest/repos/contents)、[Cloudflare Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)、[Durable Objects存储](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)。
