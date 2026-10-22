import {initialState} from './logic.js';
import {validateDocument,validateSyncState} from './sync-schema.js';
import {canonical,mergeStates,resolveMerge} from './sync-merge.js';
const equal=(a,b)=>canonical(a)===canonical(b);
const SESSION='quit365-session-v1';
const labels={disabled:'仅本机保存',login:'请登录以同步',migration:'首次同步待确认',synced:'已同步',pending:'待同步',offline:'离线',failed:'同步失败',conflict:'存在同步冲突'};
function sessionStore(){try{return globalThis.window?.sessionStorage}catch{return undefined}}
function nonce(){return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','')}
async function challenge(v){return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v))))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','')}
export function createTransport(baseURL,{fetch:fetcher=globalThis.fetch}={}){
  const url=new URL(baseURL);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw Error('同步API必须是经过确认的HTTPS Worker地址');
  return async(path,{method='GET',body,token}={})=>{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
    try{const r=await fetcher(url.origin+path,{method,cache:'no-store',credentials:'omit',redirect:'error',signal:controller.signal,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body)});
      let data;try{data=await r.json()}catch{throw Object.assign(Error('服务返回了无法读取的数据'),{status:r.status||503})}
      if(!r.ok){const retry=r.headers.get('Retry-After');throw Object.assign(Error(data.error||'SYNC_REQUEST_FAILED'),{status:r.status,retryAfter:retry?(/^[0-9]+$/.test(retry)?Number(retry)*1000:Math.max(0,Date.parse(retry)-Date.now())):undefined})}return data;
    }finally{clearTimeout(timer)}
  };
}
export function createSyncClient({repository,transport,onState=()=>{},onStatus=()=>{},clock={now:Date.now,setTimeout:globalThis.setTimeout.bind(globalThis),clearTimeout:globalThis.clearTimeout.bind(globalThis)},online=()=>globalThis.navigator?.onLine!==false,sessionStorage=sessionStore()}={}){
  let token=null,status={kind:transport?'login':'disabled',message:transport?labels.login:labels.disabled},preview=null,retry=0,saveTimer,pollTimer,retryTimer,started=false,stopped=false,chain=Promise.resolve();
  const subscribers=new Set();try{token=JSON.parse(sessionStorage?.getItem(SESSION)||'null')?.token||null}catch{}
  const emit=(kind,detail={})=>{status={kind,message:labels[kind],...detail};onStatus(status);for(const listener of subscribers)listener(status);return status};
  const serial=fn=>{const work=chain.then(fn);chain=work.catch(()=>{});return work};
  const request=(path,opts={})=>transport(path,{...opts,token:opts.auth===false?undefined:token});
  function scheduleRetry(error){clock.clearTimeout(retryTimer);if(error.retryable===false||repository.storageMode?.()!=='indexeddb')return;if(error.status&&![409,429].includes(error.status)&&error.status<500)return;const delay=error.retryAfter??[2000,5000,15000,30000,60000][Math.min(retry++,4)]*(.8+Math.random()*.4);retryTimer=clock.setTimeout(()=>syncNow(),Math.max(1000,delay))}
  function failure(error){
    if(error.status===401||error.status===403){token=null;sessionStorage?.removeItem(SESSION);return emit('login',{detail:'会话已失效或当前账户无权限；本机待同步记录保留'})}
    const offline=!online();emit(offline?'offline':error.status===409?'conflict':'failed',{detail:error.message});if(!offline)scheduleRetry(error);return status;
  }
  async function authenticated(){if(!transport){emit('disabled');return false}if(!online()){emit('offline');return false}if(!token){emit('login');return false}const s=await request('/v1/session');if(s.user?.id!==289706800)throw Object.assign(Error('USER_NOT_ALLOWED'),{status:403});return true}
  async function cloud(){const value=await request('/v1/state');if(value.document!==null){try{validateDocument(value.document)}catch{throw Object.assign(Error('云端格式不受支持，已停止同步并保留本机数据'),{retryable:false})}}if(value.revision!==null&&!/^[a-f0-9]{40,64}$/.test(value.revision))throw Error('云端版本标识无效');if((value.document===null)!==(value.revision===null))throw Error('云端版本与数据不一致');return value}
  async function makePreview(){
    if(!await authenticated())return null;const remote=await cloud(),local=await repository.readSync();if(!local.state)throw Error('本机尚未初始化，不能迁移');
    const empty=local.meta.generation===0&&Object.keys(local.state.logs).length===0&&local.state.urges.length===0&&equal(local.state.settings,initialState().settings);
    const merge=!remote.document?mergeStates(local.state,local.state,local.state):empty?mergeStates(remote.document.appState,remote.document.appState,remote.document.appState):mergeStates(null,local.state,remote.document.appState);
    preview={remote,local,merge};emit('migration',{migration:merge,localCount:Object.keys(local.state.logs).length,remoteCount:Object.keys(remote.document?.appState.logs||{}).length});return preview;
  }
  async function acknowledge(candidate,revision,generation,{migration=false,epoch}={}){
    const current=await repository.readSync(),unchanged=current.meta.generation===generation;
    if(epoch!==undefined&&(current.meta.syncEpoch||0)!==epoch){emit('migration',{detail:'自动同步已关闭；已发送的旧请求不会重新开启同步'});return}
    const result=await repository.updateSync(current.meta.localRevision,{...(unchanged?{state:candidate}:{}),meta:{baseState:structuredClone(candidate),baseRevision:revision,ackedGeneration:generation,inFlight:null,conflict:null,...(migration?{enabled:true,migration:true}:{})}});
    if(unchanged)await onState(candidate,current.state);
    retry=0;clock.clearTimeout(retryTimer);emit(result.meta.generation>result.meta.ackedGeneration?'pending':'synced',{at:clock.now()});
  }
  async function upload(candidate,remote,generation,{migration=false}={}){
    try{validateSyncState(candidate)}catch(e){e.retryable=false;throw e}const current=await repository.readSync();const epoch=current.meta.syncEpoch||0;
    if(!migration&&!current.meta.enabled){emit('migration');return}
    if(current.meta.generation!==generation)throw Object.assign(Error('本机记录已变化，请重新同步'),{status:409});
    await repository.updateSync(current.meta.localRevision,{meta:{inFlight:{state:candidate,generation}},...(migration&&!current.meta.migrationSnapshot?{snapshot:{label:'before-cloud-migration',state:current.state},meta:{...current.meta,inFlight:{state:candidate,generation},migrationSnapshot:true}}:{})});
    const result=await request('/v1/state',{method:'PUT',body:{document:{formatVersion:1,appState:candidate},revision:remote.revision}});
    if(!/^[a-f0-9]{40,64}$/.test(result.revision))throw Error('云端确认版本无效');await acknowledge(candidate,result.revision,generation,{migration,epoch});
  }
  async function syncOnce(){
    if(!await authenticated())return;
    let local=await repository.readSync();if(!local.meta.enabled){await makePreview();return}
    const remote=await cloud();local=await repository.readSync();if(!local.meta.enabled){emit('migration');return}
    if(!remote.document&&local.meta.baseRevision!==null)throw Error('云端数据文件消失；自动同步已停止，请核对私有仓库');
    const base=local.meta.inFlight&&remote.document&&equal(local.meta.inFlight.state,remote.document.appState)?local.meta.inFlight.state:local.meta.baseState;
    const merged=remote.document?mergeStates(base,local.state,remote.document.appState):mergeStates(local.state,local.state,local.state);
    if(merged.conflicts.length){
      const conflict={merge:merged,revision:remote.revision,generation:local.meta.generation};await repository.updateSync(local.meta.localRevision,{meta:{conflict}});emit('conflict',{conflicts:merged.conflicts});return;
    }
    if(remote.document&&equal(merged.state,remote.document.appState))await acknowledge(merged.state,remote.revision,local.meta.generation);
    else await upload(merged.state,remote,local.meta.generation);
  }
  function syncNow(){return serial(async()=>{if(stopped)return status;clock.clearTimeout(saveTimer);try{await syncOnce()}catch(e){failure(e)}return status})}
  function notifySaved(){if(!transport)return emit('disabled');emit(online()?'pending':'offline');clock.clearTimeout(saveTimer);if(online())saveTimer=clock.setTimeout(()=>syncNow(),1000)}
  async function confirmMigration(choices={}){return serial(async()=>{
    try{if(!preview)await makePreview();if(!preview)return;const current=await repository.readSync(),remote=await cloud();if(current.meta.generation!==preview.local.meta.generation||(current.meta.syncEpoch||0)!==(preview.local.meta.syncEpoch||0)||remote.revision!==preview.remote.revision){await makePreview();throw Error('迁移预览已变化，请重新核对并确认')}
      const candidate=resolveMerge(preview.merge,choices);
      if(remote.document&&equal(candidate,remote.document.appState)){
        await repository.updateSync(current.meta.localRevision,{snapshot:{label:'before-cloud-migration',state:current.state}});await acknowledge(candidate,remote.revision,current.meta.generation,{migration:true,epoch:current.meta.syncEpoch||0});
      }else await upload(candidate,remote,current.meta.generation,{migration:true});preview=null;
    }catch(e){failure(e);throw e}
  })}
  async function resolveConflicts(choices){return serial(async()=>{
    const local=await repository.readSync(),conflict=local.meta.conflict;if(!conflict)throw Error('当前没有待处理冲突');const remote=await cloud();if(remote.revision!==conflict.revision||local.meta.generation!==conflict.generation){await syncOnce();throw Error('冲突记录已变化，请重新选择')}
    try{await upload(resolveMerge(conflict.merge,choices),remote,local.meta.generation)}catch(e){failure(e);throw e}
  })}
  async function beginLogin(){
    if(!transport)throw Error('尚未配置Worker');if(!online())throw Error('请联网后登录');const verifier=nonce(),state=nonce(),local=await repository.readSync();
    await repository.updateSync(local.meta.localRevision,{meta:{pendingLogin:{verifier,state,createdAt:clock.now()}}});return request('/auth/start',{method:'POST',auth:false,body:{state,challenge:await challenge(verifier)}});
  }
  async function finishLogin(ticket){
    if(!/^[A-Za-z0-9_-]{43}$/.test(ticket))throw Error('授权码格式无效');const local=await repository.readSync(),pending=local.meta.pendingLogin;
    if(!pending||pending.createdAt+600000<=clock.now())throw Object.assign(Error('请将一次性授权码复制到最初发起登录的Safari或主屏幕应用；如已过期请重新登录'),{code:'MISSING_VERIFIER',ticket});
    const result=await request('/auth/exchange',{method:'POST',auth:false,body:{ticket,verifier:pending.verifier}});
    if(result.user?.id!==289706800||!/^[A-Za-z0-9_-]{43}$/.test(result.token))throw Error('登录身份或会话无效');token=result.token;sessionStorage?.setItem(SESSION,JSON.stringify({token,expiresAt:result.expiresAt}));
    const latest=await repository.readSync();await repository.updateSync(latest.meta.localRevision,{meta:{pendingLogin:null}});await syncNow();return result;
  }
  async function logout(){let revoked=false;try{if(token&&online()){await request('/v1/logout',{method:'POST'});revoked=true}}finally{token=null;sessionStorage?.removeItem(SESSION);emit('login',{detail:revoked?'已退出云同步登录':'已清除本机会话；离线时服务端会话将在到期后失效'})}return revoked}
  async function disconnect(){const local=await repository.readSync();await repository.updateSync(local.meta.localRevision,{meta:{enabled:false,conflict:null,syncEpoch:(local.meta.syncEpoch||0)+1}});clock.clearTimeout(saveTimer);clock.clearTimeout(retryTimer);emit('migration',{detail:'已停止自动同步；本机与云端数据均保留'})}
  function poll(){if(stopped)return;if(!globalThis.document||document.visibilityState==='visible')syncNow();pollTimer=clock.setTimeout(poll,30000)}
  const resumed=()=>{if(!globalThis.document||document.visibilityState==='visible')syncNow()};
  function start(){if(started)return;started=true;stopped=false;globalThis.window?.addEventListener('online',resumed);globalThis.document?.addEventListener('visibilitychange',resumed);pollTimer=clock.setTimeout(poll,30000);return syncNow()}
  function stop(){stopped=true;clock.clearTimeout(saveTimer);clock.clearTimeout(pollTimer);clock.clearTimeout(retryTimer);globalThis.window?.removeEventListener('online',resumed);globalThis.document?.removeEventListener('visibilitychange',resumed)}
  return {start,stop,notifySaved,syncNow,beginLogin,finishLogin,logout,disconnect,confirmMigration,resolveConflicts,previewMigration:()=>serial(makePreview),getStatus:()=>status,subscribe:fn=>{subscribers.add(fn);fn(status);return()=>subscribers.delete(fn)}};
}
