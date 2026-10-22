import {isDate,TRIGGERS,COPINGS} from './logic.js';
export const MAX_DOCUMENT_BYTES=1048576;
export const documentBytes=value=>new TextEncoder().encode(JSON.stringify(value)).length;
const fail=()=>{throw new Error('同步数据格式无效或版本不受支持，请保留备份')};
function object(v){if(!v||Array.isArray(v)||typeof v!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(v)))fail();return v}
function keys(o,allowed){object(o);if(Object.keys(o).some(k=>!allowed.includes(k)))fail()}
function str(v,n){if(typeof v!=='string'||v.length>n)fail()}
function bool(v){if(typeof v!=='boolean')fail()}
function num(v,max){if(typeof v!=='number'||!Number.isFinite(v)||v<0||v>max||!Number.isInteger(v))fail()}
function date(v){if(!isDate(v))fail()}
function time(v){if(typeof v!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(v))fail()}
function array(v,max){if(!Array.isArray(v)||v.length>max)fail()}
function timestamp(v){str(v,40);if(v&&!Number.isFinite(Date.parse(v)))fail()}
export function validateSyncState(s){
  keys(s,['schemaVersion','createdAt','settings','logs','urges']);if(s.schemaVersion!==1)fail();timestamp(s.createdAt);
  const x=s.settings;keys(x,['startDate','quitDate','doseVerified','amTime','pmTime','overrides','revisions','onboardingDismissed']);date(x.startDate);date(x.quitDate);if(x.quitDate<x.startDate)fail();bool(x.doseVerified);time(x.amTime);time(x.pmTime);if(x.onboardingDismissed!==undefined)bool(x.onboardingDismissed);
  array(x.overrides,1000);for(const o of x.overrides){keys(o,['effectiveDate','am','pm','reason','createdAt']);date(o.effectiveDate);if(![0,.5,1].includes(o.am)||![0,.5,1].includes(o.pm))fail();str(o.reason,200);if(o.createdAt!==undefined)timestamp(o.createdAt)}
  array(x.revisions,5000);for(const r of x.revisions){keys(r,['at','text']);timestamp(r.at);str(r.text,1000)}
  object(s.logs);if(Object.keys(s.logs).length>5000)fail();for(const [k,l] of Object.entries(s.logs)){
    date(k);keys(l,['date','iqos','cigarettes','otherTobacco','nrtGum','craving','episodes','trigger','sleep','nausea','mood','medAm','medPm','coping','notes','complete','updatedAt']);if(l.date!==k)fail();
    for(const f of ['iqos','cigarettes','otherTobacco','nrtGum','episodes'])num(l[f],10000);num(l.craving,10);
    for(const f of ['complete','medAm','medPm'])bool(l[f]);if(!Object.hasOwn(TRIGGERS,l.trigger))fail();
    for(const f of ['sleep','mood'])if(!['','1','2','3','4','5',1,2,3,4,5].includes(l[f]))fail();if(!['','0','1','2','3',0,1,2,3].includes(l.nausea))fail();
    array(l.coping,6);if(l.coping.some(c=>!Object.hasOwn(COPINGS,c)))fail();str(l.notes,3000);timestamp(l.updatedAt);
  }
  array(s.urges,20000);for(const u of s.urges){keys(u,['date','at','type','id']);date(u.date);timestamp(u.at);if(u.type!=='coping-session')fail();if(u.id!==undefined){str(u.id,128);if(!/^[\w:-]+$/.test(u.id))fail()}}
  return s;
}
export function validateDocument(d){keys(d,['formatVersion','appState']);if(d.formatVersion!==1)fail();validateSyncState(d.appState);if(documentBytes(d)>MAX_DOCUMENT_BYTES)throw Error('云端文档超过1MiB，已保留本机数据；请导出备份后调整云端容量');return d}
