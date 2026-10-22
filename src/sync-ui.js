const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const show=value=>value===undefined?'（已删除）':JSON.stringify(value,null,2);
function conflicts(items=[]){return items.map((c,i)=>`<fieldset class="sync-conflict"><legend>${esc(c.path)}</legend><div><strong>本机</strong><pre>${esc(show(c.local))}</pre></div><div><strong>云端</strong><pre>${esc(show(c.remote))}</pre></div><label for="sync-choice-${i}">保留哪个版本？</label><select id="sync-choice-${i}" data-conflict-path="${esc(c.path)}"><option value="">请明确选择</option><option value="local">保留本机版本</option><option value="remote">保留云端版本</option></select></fieldset>`).join('')}
export function mountSyncUI({client,getState,exportState,onRecovery,repository,notify=()=>{}}){
  let signature='',callbackTicket='';
  function render(){
    const s=client.getStatus();let badge=document.querySelector('#sync-status');
    if(!badge){badge=document.createElement('button');badge.id='sync-status';badge.type='button';badge.className='sync-status';badge.dataset.view='settings';badge.setAttribute('aria-live','polite');document.querySelector('.topbar>div')?.append(badge)}
    badge.textContent=s.message;badge.dataset.kind=s.kind;
    if(!document.querySelector('#start-date'))return;
    let panel=document.querySelector('#sync-panel');if(!panel){panel=document.createElement('section');panel.id='sync-panel';panel.className='card sync-panel';document.querySelector('main>.stack')?.prepend(panel);signature=''}
    const next=JSON.stringify(s)+callbackTicket;if(signature===next)return;if(panel.contains(document.activeElement)&&document.activeElement.matches('input,select,textarea'))return;signature=next;
    panel.innerHTML=`<h2>跨设备同步</h2><p role="status">${esc(s.message)}${s.detail?' · '+esc(s.detail):''}</p><p>${s.kind==='disabled'?'云同步尚未启用，记录继续保存在本机。':'开启后，记录经安全接口同步至你的私有GitHub数据仓库。云端不是端到端加密；建议定期保留加密备份。'}</p>${s.kind==='disabled'?'':`<div class="button-row"><button type="button" class="btn" data-sync-action="login">使用 GitHub 登录</button><button type="button" class="btn" data-sync-action="sync">立即同步</button><button type="button" class="btn" data-sync-action="preview">预览首次同步</button><button type="button" class="btn" data-sync-action="logout">退出登录</button><button type="button" class="btn" data-sync-action="disconnect">停止自动同步</button></div><div class="field form-section"><label for="sync-ticket">从另一浏览器返回的一次性授权码</label><input id="sync-ticket" autocomplete="off" spellcheck="false" maxlength="43" value="${esc(callbackTicket)}"/><span class="field-hint">仅当主屏幕应用的授权回到了Safari时使用。复制授权码，回到发起登录的应用粘贴并完成登录。不要分享授权码。</span><button type="button" class="btn" data-sync-action="finish-login">完成登录</button></div>`}${callbackTicket?'<p>此授权码不含健康记录，且必须配合原应用的验证信息使用，十分钟后失效。</p>':''}${s.migration?`<div class="form-section"><h3>首次同步预览</h3><p>本机 ${Number(s.localCount)||0} 天记录；云端 ${Number(s.remoteCount)||0} 天记录。原始本机记录会额外保留为迁移快照。</p>${conflicts(s.migration.conflicts)}<label class="tickbox"><input id="sync-backup-confirm" type="checkbox"/>我已导出并保存当前设备的备份</label><button type="button" class="btn primary" data-sync-action="migrate">合并并开启同步</button></div>`:''}${s.conflicts?.length?`<div class="form-section"><h3>需要处理多设备冲突</h3>${conflicts(s.conflicts)}<button type="button" class="btn primary" data-sync-action="resolve">按选择解决冲突并同步</button></div>`:''}<div class="button-row form-section"><button type="button" class="btn" data-sync-action="export-local">导出本机JSON备份</button><button type="button" class="btn" data-sync-action="export-remote">导出云端版本备份</button><button type="button" class="btn" data-sync-action="snapshots">查看本机恢复快照</button>${onRecovery()?'<button type="button" class="btn danger" data-sync-action="export-raw">导出原始待恢复数据</button>':''}</div><div id="sync-snapshots"></div>`;
  }
  function choices(){return Object.fromEntries([...document.querySelectorAll('#sync-panel [data-conflict-path]')].map(el=>[el.dataset.conflictPath,el.value]))}
  document.addEventListener('click',async event=>{
    const button=event.target.closest('[data-sync-action]');if(!button)return;
    const action=button.dataset.syncAction;let popup;
    if(action==='login'){popup=window.open('about:blank','_blank');if(popup)popup.opener=null}
    button.disabled=true;
    try{
      if(action==='login'){const {authorizeUrl}=await client.beginLogin();if(popup)popup.location=authorizeUrl;else location.assign(authorizeUrl)}
      if(action==='finish-login'){await client.finishLogin(document.querySelector('#sync-ticket').value.trim());callbackTicket='';notify('登录完成，请核对同步状态')}
      if(action==='sync')await client.syncNow();if(action==='preview')await client.previewMigration();
      if(action==='logout')await client.logout();if(action==='disconnect')await client.disconnect();
      if(action==='migrate'){if(!document.querySelector('#sync-backup-confirm')?.checked)throw Error('请先导出备份并勾选已保存');await client.confirmMigration(choices())}
      if(action==='resolve')await client.resolveConflicts(choices());
      if(action==='export-local')exportState('local',getState());
      if(action==='export-remote'){const versions=await client.exportVersions();if(!versions.remote)throw Error('尚无已读取的云端版本');exportState('cloud',versions.remote)}
      if(action==='export-raw'){exportState('recovery-raw',onRecovery().raw)}
      if(action==='snapshots'){const target=document.querySelector('#sync-snapshots');target.replaceChildren();for(const s of await repository.listSnapshots()){const b=document.createElement('button');b.className='btn small';b.textContent=`导出 ${s.label} · ${s.at}`;b.onclick=async()=>{try{exportState('snapshot',(await repository.readSnapshot(s.key)).state)}catch(e){notify(e.message)}};target.append(b)}if(!target.childElementCount)target.textContent='暂无恢复快照'}
    }catch(e){if(popup)popup.close();notify(e.message)}finally{button.disabled=false;render()}
  });
  const unsubscribe=client.subscribe(render);
  async function handleCallback(ticket){callbackTicket=ticket;try{await client.finishLogin(ticket);callbackTicket=''}catch(e){notify(e.message)}signature='';render();if(callbackTicket){document.querySelector('#sync-status')?.click();render()}}
  return {render,handleCallback,stop:unsubscribe};
}
