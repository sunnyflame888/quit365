# QUIT / 365 — V1.1 增量交接

分支：feature/cloud-sync-v1.1；[Draft PR #1](https://github.com/sunnyflame888/quit365/pull/1)。生产main保持V1.0.3。代码与自动化验收完成度见[验收报告](docs/cloud-sync-acceptance.md)，账户授权与发布步骤见[部署文档](docs/cloud-sync-deploy.md)。Worker、OAuth App及两项加密Secrets已配置；真实桌面Chrome完整登录、私有数据读写、合并及冲突选择通过。物理iPhone和生产切换尚待完成，不得报告生产站已开启云同步。

当前Worker固定回跳HTTPS预览quit365-preview.pages.dev，ALLOW_LOCAL_DEV=false；源码Wrangler默认APP仍为正式Pages，普通deploy会覆盖预览值。本人已完成Pages预览上传，14个静态资源均200且与准备包逐字节一致；正式SYNC_API_URL仍空。PAT在2026-11-21到期，轮换时仍仅数据仓库Contents读写。

真实GitHub授权页仅公开身份数据。最初交换503的根因是workerd不支持redirect:error，以及成员方式调用原生fetch的Illegal invocation；修复manual且拒绝非2xx、无接收者调用fetch，新增实际运行时完整OAuth/私有读写/拒绝上游跳转回归先失败再通过。编辑器原有两项诊断也消除：显式序列化URLSearchParams，requireValue正确传递Retry-After（补失败回归）。npm test为60/60，控制台零诊断后已部署Worker版本10d5299b。

本人批准仅account:read/workers_scripts:write重新授权后，编辑器恢复。CLI授权尚未完成即取消，没有授予Wrangler附带的offline_access或新增CLI凭据；使用原有Dashboard会话部署。首次部署曾因编辑器诊断被自动审查拦截，清零并重跑测试后才成功，未绕过拦截。

真实预览合成验收：首次登录仅显示1天本机/0天云端，确认前不上传；JSON实际下载至本机并验证schema1/合成备注/无会话字段；显式迁移后已同步。受控GitHub CLI第二写入者用当前SHA新增另一天，Worker下载后可见；退出期间本机和远端同日分歧，重新登录触发冲突，选择前远端SHA不变，选择本机后已同步且保留远端新增日期。云端现有2天明确标记SYNTHETIC的记录，不是真实健康数据。此受控第二写入者不是物理第二台设备。已请求本人用iPhone Safari验证并追加IPHONE TEST，尚待结果。390px真实HTTPS页面日期边界/进展图文检查通过；不是iPhone真机。

新增模块：sync-schema（安全格式）、sync-merge（三方冲突）、store（原数据库事务/快照）、sync-client（认证/同步状态机）、sync-ui（状态/迁移/冲突）、worker/（OAuth、短期会话、限流、私有GitHub SHA写入）。src/logic.js除VERSION外保留医疗计算；每次变更继续跑原7项及新增回归。

数据兼容：数据库quit365-local-v1、kv/state与schemaVersion=1不变；sync-meta及snapshot键仅在本机。不要将sync-meta混入JSON备份（其中可能有短期PKCE verifier）。云端formatVersion=1与医疗数据版本分开；未来版本拒绝写回。新烟瘾应对记录增加可选稳定id，V1.0可忽略；旧记录以稳定旧字段及出现序号比较。

保护约束：先本机落盘再上传；generation避免旧ACK确认新编辑；inFlight识别上传成功回包丢失；syncEpoch防止清空/断开后旧请求重启同步；同日/settings冲突不按时间戳猜优先级。本机失败、缺state但有metadata、损坏状态均须保留恢复路径，不能初始化空库并上传。

仅本地模式保留localStorage备用；此时不具备IndexedDB事务保证，云同步暂停。导入/清空先留本机快照并停止同步。读取远端不得直接覆盖正在输入的内存草稿；app接收回包时仍作三方比较。

Worker所有读写须认证；固定数字ID289706800、private数据仓库与路径；fine-grained PAT只选数据仓库，放Cloudflare Secrets。Pages静态发布根目录中的文件均视为公开，即使文件夹名叫worker也不能放Secrets。CF观测日志关闭，不打印健康payload、OAuth code或token。

以下保留原交接规则与数据格式；V1.1能力以本节及新增文档为准。

# QUIT / 365 — V1.0 项目交接与验收

## 产品决策

- 目标：个人戒烟执行系统，而非通用健康App。
- 公开版本已移除原交接中的个人健康背景。应用内日期为可修改的初始设置；实际治疗与用药方案须由用户和医生或药师核对。
- 应用只能提供处方**参考**与跟踪，不能自动确定个人安全剂量；必须标记需医生/药师核对。
- 第一版不包含账号、云同步、推送服务、AI医嘱、后台服务器。

## 数据格式

保存对象存于 IndexedDB 数据库 `quit365-local-v1` → `kv` 对象仓库 → 键 `state`：

```json
{
  "schemaVersion": 1,
  "createdAt": "2026-10-22T...Z",
  "settings": {
    "startDate": "2026-10-22",
    "quitDate": "2026-10-29",
    "doseVerified": false,
    "amTime": "08:00",
    "pmTime": "19:00",
    "overrides": [],
    "revisions": []
  },
  "logs": {
    "2026-10-29": {
      "date": "2026-10-29",
      "iqos": 0, "cigarettes": 0,
      "otherTobacco": 0, "nrtGum": 0,
      "craving": 0, "episodes": 0,
      "trigger": "none", "sleep": "",
      "nausea": "", "mood": "",
      "medAm": false, "medPm": false,
      "coping": [], "notes": "",
      "complete": false,
      "updatedAt": ""
    }
  },
  "urges": []
}
```

- `complete=true` 才代表用户已**确认当日记录**；`iqos=0` 的空白日志不能直接算无烟。
- 严格无烟日：日期不早于正式戒烟日，且完成记录，且 IQOS + 卷烟 + 其他烟草均为0。
- 药用尼古丁口香糖被单独记录，不应误计为烟草复吸。
- `prescribedDose()` 以治疗启动日而非戒烟日起算；医生确认的 `settings.overrides` 仅从第8天起生效。
- 要增加第二疗程必须创建新的受控逻辑与核对流程，不能自动顺延第8至84天的剂量。

## 核心验收清单

- [x] 2026-10-22 第1天早0.5 mg、晚0 mg；2026-10-25 第4天早晚0.5 mg；2026-10-29 第8天早晚1 mg（仅标准参考）。
- [x] 2027-01-13 为第84天，之后显示首疗程结束/复诊，不默认发放剂量。
- [x] 未填日志与已确认0支严格区分。
- [x] 一次复吸保留历史累计无烟天数，但连续天数依真实记录重新统计。
- [x] 14天趋势区分缺失值与0。
- [x] 导出JSON/CSV；导入需校验、确认覆盖；支持AES-GCM加密备份。
- [x] 手机/桌面界面可渲染，导航、记录表单和烟瘾急救模态框的基本交互已做隔离浏览器检查。
- [x] 逻辑单元测试 7/7 通过。
- [ ] 真实 HTTPS 静态托管环境中完整回归测试：Service Worker安装、离线、IndexedDB长期持久化、Safari iOS下载与加密备份。
- [ ] 真实 iPhone 添加至主屏幕后的实际连续7天使用反馈。

## 下一版本优先级（非V1承诺）

1. iPhone Safari/主屏幕离线和导入导出实测后修复兼容性。
2. 复盘报告（周/月）和更可靠的服药提醒导出（ICS）。
3. 诊疗处方更改的只读锁定和审计版本。
4. 可选加密多设备同步（需要新增账号、安全与维护成本）。

## 重要安全提示

- 本产品是自我管理记录工具，**不构成医疗决策系统**。
- 体征与健康风险参考WHO成人烟草戒断指南、DailyMed伐尼克兰药品说明以及CDC戒烟建议。
- 不应通过 Craving 分数自动推荐尼古丁口香糖、加药、停药或延长处方。
- 如出现严重药物不良反应、精神行为异常或紧急危险症状，应按当地医疗流程处理。

## 开发规则

- 只增加有用功能，不堆叠社交/奖励机制。
- 所有记录保持本地优先与可导出，改Schema必须具备迁移方案。
- 改逻辑写单元测试；改界面在手机尺寸验证。
- 每次变更静态文件，应同时更新 `sw.js` CACHE key 和 `package.json`/界面版本号。
