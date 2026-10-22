const NAME='quit365-local-v1';
const KEY='state';
let mode='indexeddb';

export function storageMode(){return mode;}
function openDb(){return new Promise((resolve,reject)=>{
  const request=indexedDB.open(NAME,1);
  request.onupgradeneeded=()=>{request.result.createObjectStore('kv');};
  request.onsuccess=()=>resolve(request.result);
  request.onerror=()=>reject(request.error);
});}
async function idbGet(){const db=await openDb();return new Promise((res,rej)=>{const tx=db.transaction('kv','readonly'),req=tx.objectStore('kv').get(KEY);req.onsuccess=()=>{db.close();res(req.result)};req.onerror=()=>{db.close();rej(req.error)};});}
async function idbPut(obj){const db=await openDb();return new Promise((res,rej)=>{const tx=db.transaction('kv','readwrite');tx.objectStore('kv').put(obj,KEY);tx.oncomplete=()=>{db.close();res()};tx.onerror=()=>{db.close();rej(tx.error)};});}
export async function load(){
  try {mode='indexeddb';return await idbGet();}
  catch(e){console.warn('IndexedDB not available, using localStorage fallback',e);mode='localstorage';try{return JSON.parse(localStorage.getItem(NAME) || 'null')}catch{return null}}
}
export async function save(obj){
  if(mode==='indexeddb'){
    try {return await idbPut(obj)}catch(e){mode='localstorage';console.warn('IndexedDB save failed, fallback',e)}
  }
  try{localStorage.setItem(NAME,JSON.stringify(obj));}
  catch(e){mode='unavailable';throw new Error('设备无法保存数据。请检查浏览器存储权限并立即导出备份。');}
}
