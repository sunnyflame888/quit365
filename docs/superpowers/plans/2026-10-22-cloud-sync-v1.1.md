# QUIT / 365 V1.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在原静态PWA中增加经GitHub登录授权的可靠私有云同步，交付可审阅PR及真实部署验收清单，生产main保持V1.0.3。

**Architecture:** 前端先事务性保存到原IndexedDB，再由同步状态机协调Worker。Worker通过OAuth/PKCE和独立应用会话鉴权，用私有GitHub文件SHA做条件写入；一个SQLite-backed Durable Object只存认证和限流元数据。客户端三方比较处理非重叠编辑，同日与settings冲突由用户明确选择。

**Tech Stack:** 原生ES modules、IndexedDB、WebCrypto、Node test runner、Cloudflare Worker/Durable Object、GitHub OAuth/Contents API。前端无第三方运行依赖；测试/Worker打包工具仅为开发依赖。

**Spec:** `docs/superpowers/specs/2026-10-22-cloud-sync-v1.1-design.md`（用户已于2026-10-22明确批准，含暂不增加端到端加密口令的取舍）。

## Global Constraints

- 只在 `feature/cloud-sync-v1.1` 开发；提交PR，不合并、不覆盖生产main。
- 保留 `quit365-local-v1` / `kv` / `state`、`schemaVersion=1`；云端另有 `formatVersion=1`。
- 固定私有仓库 `sunnyflame888/quit365-data`、分支main、路径 `data/state.json`；不启用Pages。
- 只允许GitHub数字ID `289706800`；OAuth不申请repo权限；运行PAT只授权数据仓库Contents读写。
- OAuth授权请求10分钟；S256 PKCE；256位随机ticket/会话；sessionStorage会话最长12小时、空闲1小时；登录交换原子单次消费。
- 数据请求必须验证会话、ID、仓库private；上限1MiB；未知格式拒绝写入；API响应no-store。
- 保存后约1秒防抖；前台30秒检查；超时15秒；2/5/15/30/60秒带抖动重试，遵守Retry-After。
- 状态包含已同步、待同步、离线、同步失败及未登录/待迁移/冲突；不得以旧响应确认新编辑。
- IndexedDB失败保留本地降级、暂停同步；损坏读取不得自动写入空状态。
- 不改医学内容、剂量和统计口径；保留原JSON/CSV/加密备份与手机布局修复。
- 前端Secret、真实日志、备份、授权code和测试状态不得进入公开Git及Pages静态发布目录。
- V1.1云端不是端到端加密；不自动读取或上传用户现有真实日志用于测试。

## Review Focus

1. 上传成功响应丢失、此时本机又编辑：恢复后只确认已上传版本，保留新编辑（任务4）。
2. IndexedDB拒绝访问、配额不足或损坏原state：保留原始数据、暂停云同步、不显示保存成功（任务2、5）。
3. 同源其他Pages项目与iOS Safari/PWA分离：会话信任边界明确，缺原verifier时仅返回ticket供原应用完成交换（任务3、5、6）。
4. 导入备份或清空本机后在线：不得把本机清空悄悄传播为云端删除（任务4、5）。
5. 同一OAuth ticket并发兑换以及两台设备首次创建同一文件：最多一个成功，另一方获得可恢复失败/冲突（任务3、4、6）。

## File Map

- `src/sync-schema.js`：同步文档严格校验及字节上限；不承担医疗计算。
- `src/sync-merge.js`：三方合并、迁移预览、逐项冲突选择，纯函数。
- `src/store.js`：兼容旧state的事务、metadata、快照、跨标签revision保护。
- `src/sync-client.js`：登录ticket/session、API请求、同步队列/状态机。
- `src/sync-ui.js`：状态、登录、迁移、冲突及恢复控件，输出文本安全。
- `src/sync-config.js`：公开的HTTPS API配置，默认关闭。
- `worker/auth.js`、`worker/github.js`、`worker/api.js`、`worker/index.js`：认证状态机、私有数据适配、HTTP策略和平台入口。
- `worker/wrangler.jsonc`：非秘密绑定、SQLite迁移、兼容日期及Worker开发配置。
- `tests/fixtures.mjs`、`tests/sync-*.test.mjs`、`tests/worker-*.test.mjs`：全合成数据与自动化回归。
- `scripts/`（如需）、`.github/workflows/test.yml`：测试入口与PR检查，无真实凭据。
- `docs/cloud-sync-deploy.md`、`docs/cloud-sync-acceptance.md`：授权、部署、安全证据、真机待验收、迁移和回滚。

## Task 1: 严格同步格式与三方合并

**Files:** Create `src/sync-schema.js`, `src/sync-merge.js`, `tests/fixtures.mjs`, `tests/sync-schema.test.mjs`, `tests/sync-merge.test.mjs`.

**Interfaces:**
- Consumes: `initialState`, `defaultLog`, `isDate` from existing logic; existing medical functions unchanged.
- Produces: `validateSyncState(state): State`, `validateDocument(doc): {formatVersion:1,appState:State}`, `documentBytes(doc): number`, `MAX_DOCUMENT_BYTES=1048576`.
- Produces: `mergeStates(base|null, local, remote): {state, conflicts:[{path,base,local,remote}], changed:boolean}`; `resolveMerge(result, choices): State` where every conflicting path must explicitly choose `local` or `remote`; never overwrite input objects.
- Logs keyed by date; settings one conflict unit; urges keyed by stable id or legacy timestamp/type/date with occurrence index; missing log distinct from confirmed zero. During migration base=null, differing settings or same-date logs require choices.

- [x] **Step 1: Write failing tests.** Include these assertions and malicious/unknown schema inputs:
  ```js
  assert.throws(()=>validateDocument({formatVersion:2,appState:initialState()}));
  assert.equal(mergeStates(base,changeDay(base,'2026-10-22'),changeDay(base,'2026-10-23')).conflicts.length,0);
  assert.equal(mergeStates(base,changeNote(base,'A'),changeNote(base,'B')).conflicts[0].path,'logs.2026-10-22');
  assert.throws(()=>resolveMerge(conflicted,{}));
  ```
  Fixtures define `changeDay(state,date)` as a copied completed log insertion; `changeNote(state,text)` changes the same dated log. Test settings conflicts, deletion-vs-edit, repeated urge import, future format, oversized UTF-8 input, prototype keys, HTML-like time strings, numeric strings/NaN, missing completion, and nonmutation.
- [x] **Step 2:** Run `node --test tests/sync-schema.test.mjs tests/sync-merge.test.mjs`; confirm missing modules fail.
- [x] **Step 3:** Implement interfaces, preserve only validated schema-compatible data without coercing missing days to zero; reject unsafe input while leaving original available to recovery.
- [x] **Step 4:** Run same command and `npm test`; require all new and original7 pass.
- [x] **Step 5:** Commit `feat: define versioned sync documents and conflict-safe merge`.

## Task 2: 事务性本地存储与恢复

**Files:** Modify `src/store.js`; create `tests/sync-store.test.mjs`; add only test dependency `fake-indexeddb` and ignore runtime/secret artifacts.

**Interfaces:**
- Preserve `load(): Promise<State|undefined>`, `save(state,{intent='edit'}={}): Promise<void>`, `storageMode()` used by V1.0.
- Add `readSync(): Promise<{state,meta}>`; meta contains `localRevision`, `generation`, `ackedGeneration`, `baseRevision`, `baseState`, `enabled`, `migration`, `conflict`.
- Add `updateSync(expectedLocalRevision, {state?,meta?,snapshot?}): Promise<{state,meta}>` in one readwrite transaction; return a typed `LocalConflictError` for stale revisions and retain its candidate as a separate local draft.
- Add `listSnapshots()` / `readSnapshot(key)` for migration/recovery exports; preserve originalstate on parse/validation failures. Cloud operations refuse fallback mode.

- [x] **Step 1:** Write tests opening an actual fake IndexedDB with V1.0 state, then assert exact original load, initialize-vs-edit generation, atomic state+meta commit, transaction failure preservation, stale-tab draft retention, metadata excluded from normal state export, raw corrupt-state recovery, IndexedDB refusal and localStorage fallback.
  ```js
  assert.deepEqual(await load(),legacyState);
  await assert.rejects(updateSync(oldRevision,{state:otherEdit}),LocalConflictError);
  assert.deepEqual((await readSync()).state,latestCommittedState);
  ```
- [x] **Step 2:** Run `node --test tests/sync-store.test.mjs`; confirm absent interface fails.
- [x] **Step 3:** Implement transactional persistence on originalkv; no new databaseversion/objectstore required. Add ignored `.wrangler/`, `.dev.vars*`, secret/QA directories. Pin devdependency via lockfile without introducing front-end dependency.
- [x] **Step 4:** Repeat tests and original7; assert stored rejection snapshot can be exported even when normal parsing fails.
- [x] **Step 5:** Commit `feat: preserve local sync revisions and recovery snapshots`.

## Task 3: Worker认证、会话与GitHub条件写API

**Files:** Create `worker/auth.js`, `worker/github.js`, `worker/api.js`, `worker/index.js`, `worker/wrangler.jsonc`, `tests/worker-auth.test.mjs`, `tests/worker-api.test.mjs`; add locked Worker development tooling.

**Interfaces:**
- `createHandler({fetch:upstreamFetch,now,random}={}): (Request, env)=>Promise<Response>` in `worker/api.js`.
- `AuthStore(storage,{now,random})` pure runtime-compatible logic backed by DOtransaction storage; methods `start`, `callback`, `exchangeClaim`, `exchangeFinish`, `session`, `logout`, `limit`; platform `AuthState.fetch` exposes only internal service binding routes.
- `GithubData(env,{fetch}): {read():Promise<{revision,document|null}>,write(document,revision):Promise<{revision}>}`; enforce private repo and fixedmain/path before read/write. Upstream conflict becomes `ApiError(409,'CONFLICT')`; nofile distinctly `revision:null`.
- HTTP endpoints exactly as approvedspec. `/auth/start` body `{state,challenge}` returns authorizeURL; callback returns fixed Pages fragment `{ticket}`; exchange body `{ticket,verifier}` returns `{token,expiresAt,user:{id,login}}`. State endpoint envelope `{revision,document}`. CORS adds Authorization/Content-Type only for exact origin; no credentialed cookies.
- Env public values: `APP_ORIGIN`, `APP_URL`, `WORKER_URL`, `GITHUB_CLIENT_ID`, `ALLOWED_USER_ID`, `DATA_OWNER`, `DATA_REPO`, `DATA_BRANCH`; secrets: `GITHUB_CLIENT_SECRET`, `GITHUB_DATA_TOKEN`; binding `AUTH`.

- [x] **Step 1:** Write tests with deterministic clock and mocked GitHub HTTP/transactional storage. Assert unauthenticated and expired requests401; wrongID403; forgedOrigin/missingOrigin cannot bypass bearer; PKCE/state mismatch/replay rejection; concurrent exchange only oneGitHub redemption; deniedOAuth and lostexchange recover by restartinglogin; immediate logout; emptyrepo vs missingpermission; private=false rejects; staleSHA409; invalidschema400/413; upstream401/429/5xx do not leak payload/secrets; all sensitive responsesno-store; redirects never receive authorization; all rate/expiry limits matchglobalconstraints.
- [x] **Step 2:** Run `node --test tests/worker-*.test.mjs`; confirm failure before implementation.
- [x] **Step 3:** Implement module boundaries; token hashes/indexes, atomic pending→exchanging→consumed; SHA-based GitHubPUT and exact allowlist. Configure SQLiteDOmigration and disable application request-body/token logging. Any test account/secret is synthetic only.
- [x] **Step 4:** Run unit suite and `npx wrangler deploy --dry-run --config worker/wrangler.jsonc --outdir /private/tmp/quit365-worker-build`; require validbundle with no publicsecrets. Exercise DOservicebinding under local workerd as integration rather than claim mocks equal production.
- [x] **Step 5:** Commit `feat: secure worker OAuth sessions and private GitHub storage`.

## Task 4: 前端同步状态机与认证客户端

**Files:** Create `src/sync-client.js`, `src/sync-config.js`, `tests/sync-client.test.mjs`.

**Interfaces:**
- `createSyncClient({repository,transport,onState,onStatus,clock,online,sessionStorage}): SyncClient`; repository uses task2 snapshot/transaction interfaces; transport wraps WorkerAPI with cache:no-store, credentials:omit, timeout15s and validatedHTTPS baseURL.
- Methods `start()`, `notifySaved()`, `syncNow()`, `beginLogin()`, `finishLogin(ticket)`, `logout()`, `previewMigration()`, `confirmMigration(choices, reviewedVersion)`, `resolveConflicts(choices, reviewedVersion)`, `disconnect()`, `stop()`.
- `onStatus({kind,message,conflicts?,migration?,user?})`; `onState(state)` only after accepted localtransaction, never raw unvalidatedremote. `beginLogin` retains verifier/state outside exportedhealthstate; `finishLogin` requires localverifier and ticket, removes transientvalues on completion/expiry. Session onlysessionStorage.
- Disabled APIconfig yields localonly status and no network; sessionexpired preserves queue; disconnect stops uploads and keeps data. Firstmigration explicit, with snapshot before apply; cloudclear is never automatic consequence of localclear/import.

- [x] **Step 1:** Write two-client tests sharing mock CASserver but separate persistent repositories; assert automatic save/upload/read; differentdays merge; sameday/settings conflicts stopwrite; offline→restart→online drains durablepending; ACKlost+subsequentedit not falselyacknowledged; slowGET cannot overwrite newedit; repeatedmigration/idempotency; onlyfetchonapprovedmigration; clear-local/disconnect neverdeletecloud; retrybackoff/Retry-After; 401requireslogin; formatinvalid retainsdraft.
  ```js
  assert.equal(status.kind,'conflict');
  assert.equal(server.writeCount,beforeConflictWrites);
  assert.equal((await repo.readSync()).meta.ackedGeneration,uploadedGeneration);
  assert.ok((await repo.readSync()).meta.generation>uploadedGeneration);
  ```
- [x] **Step 2:** Run `node --test tests/sync-client.test.mjs`; require missingclient failure.
- [x] **Step 3:** Implement serializedstate machine with generationchecks and threewaymerge. Runtime lifecycle sync on online/visibilitychange plus foreground30spoll, with timer cleanup; no backgroundsync promise. Avoid unbounded retry or snapshot accumulation.
- [x] **Step 4:** Run deterministic client tests plus all prior tests; check exact state transitions and atomic acknowledgements.
- [x] **Step 5:** Commit `feat: synchronize durable local edits with conflict-safe retries`.

## Task 5: 既有UI、迁移与备份的增量接入

**Files:** Create `src/sync-ui.js`; modify `src/app.js`, `index.html`, `styles.css`, `sw.js`, `src/logic.js` VERSION only, `package.json` version/scripts; create `tests/sync-ui.test.mjs` if needed for purepresentation logic.

**Interfaces:**
- `mountSyncUI({client,getState,exportState,onLocalReset,onImport,onRecovery})` attaches small status badge/settings card and delegatedevents; uses textContent/escapedattributes; existing appnavigation unaltered.
- Apppersist returns explicit result; only after localsuccess calls notifySaved. Bootstrap initialization distinct from useredit; remote onState rerenders safely without losing unsavedform state. pagehide uses same localtransaction path.
- Loginbutton opens blanktab synchronously then navigates once authorizeURL ready; callbackfragment removed before normalrender. Missingverifier shows ticketcopy/paste fallback, no token exposure.
- Migrationcheckbox confirmsbackup; preview conflicts use explicit choices, no defaultdestructive selection. Exports can select retained recovery snapshots; encryptedbackup stays AES-GCM. Localdelete disconnects sync before writing emptylocalstate; import pauses upload until preview/confirmation.
- Version1.1.0; cachedassets include all newfrontendmodules; API/sessions nevercached; CSP permits onlyself scripts and configuredHTTPSWorker, preserves relativepaths.

- [x] **Step 1:** Write browser acceptance assertions before wiring: disabledconfig noAPIcalls; logediting persists; localfailures nofalse success; full login→migration→syncstatus; missingverifier callback displays copyfallback; maliciousnotes renderastext; import/clear explicitly preservecloud; conflictchoicesrequired; originalexports stillwork.
- [x] **Step 2:** Run with injectable localmockWorker on nonproductionURL; capture failures from unimplementedcontrols.
- [x] **Step 3:** Integrate client/UI without refactoring medicalviews; only privacycopy reflects cloudopt-in. Add V1.1asset/cacheversion; ensure no secrets in config or HTML.
- [x] **Step 4:** Run `npm test` and browser flows at 320/375/390/420/430/768/1440px, including datecontrolbounds and chartcaptiongaps. Verify offlineassets, unchangedmedicaloutputs, savedlogs/medchecks and JSON/CSV/encryptedroundtrip; screenshots outsidegit.
- [x] **Step 5:** Commit `feat: expose opt-in cloud sync and safe migration in existing PWA`.

## Task 6: 非生产联调、安全审查与部署文档

**Files:** Create `docs/cloud-sync-deploy.md`, `docs/cloud-sync-acceptance.md`, `.github/workflows/test.yml`; update `README.md`, `HANDOFF.md`.

- [x] **Step 1:** Create/check private `quit365-data` through authenticatedgh, verifyvisibility and Pagesdisabled; seed only documentation or synthetictestdata, never existinguserdata. Do not use broad CLI token as Workersecret.
- [x] **Step 2:** Run complete node/Worker/runtime/browser suite. Conduct independent review against approvedspec and ReviewFocus; fix findings with failingregressiontests. Record actualchecks and remaininglimits, including same-originPages trust and Gitplaintext history.
- [x] **Step 3:** Write exactmanual GitHubOAuthApp, minimumPAT, Cloudflarebinding/Secret and nonproductionWorker configsteps; distinguishpublicconfig fromSecrets; rotation/emergencyrevoke, storagecost/quotas, backupbeforemigration, restore/rollback and no-Pagesdatarepo instructions. Never askuser topasteSecrets intochat.
- [ ] **Step 4:** With user-provided accountauthorization, test actualOAuth/Worker/privateGit CAS in nonproduction, then physicaliPhoneSafari/PWA and desktopcrossdevice. If unavailable, record explicit pendingcells; keepoverallgoal unachieved rather than invent results.
- [x] **Step 5:** Verify no productionchanges and no personaldata/secrets in git/workerdartifacts; commit docs/CI and onlytestedfixes.

## Task 7: PR与逐项交付审计

- [x] **Step 1:** `npm test`, Workerbundle/runtimechecks, browserregressions, `git diff --check`, secret/filelistreview, then inspectfinaldiff against everyrow in spec evidenceledger.
- [ ] **Step 2:** Push only `feature/cloud-sync-v1.1`, createPR to main with problem/behavior/securitychoices/testevidence and explicit pending realaccount/truedevicechecks. Do not merge. AttachPR tothischat with `attach_artifact`.
- [ ] **Step 3:** Give userPR/source links, Worker/datarepo instructions, crossdevicetestresults, migration/rollback and securityreport. If manualcloud authorization/physicaltest stillpending, reportexactnextactions and keepgoalopen; do not claim livecloudsync exists.

## Self-review

所有spec条款映射：schema/version/conflicts→1；oldstate/localfallback/snapshots/tabrevision→2；OAuth/allowlist/repoPAT/private/CAS/ratelimit→3；save/retry/concurrentedits/migration→4；UI/backups/PWA/medicalinvariants→5；actualcloud/truedevice/docs/security→6；PR/no-production/completionaudit→7。ReviewFocus五项各有对应失败测试；代码接口名与调用方向一致。未知真实Cloudflare账号、OAuthClientID和PAT不作为可猜占位secret，留部署授权阶段由用户完成。

## Execution handoff

推荐Native：本人在当前会话逐项实现并测试，完成后再独立审查整分支。同步、认证和存储接口耦合紧密，逐项保持一致更便于核验；不自动开启并行子代理。若用户选择Subagent-driven，则按相应技能另行调度。须先由用户确认本计划及执行方式。
