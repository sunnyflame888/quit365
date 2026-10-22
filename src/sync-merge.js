// Pure three-way merge. A log date and the entire treatment settings are atomic.
export function canonical(value){if(value===undefined)return 'undefined';if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}'}
const equal=(a,b)=>canonical(a)===canonical(b);
function urgeMap(rows=[]){const result={},counts={};for(const row of rows){const stem=row.id||`${row.date}:${row.at}:${row.type}`;const n=counts[stem]||0;counts[stem]=n+1;result[`${stem}#${n}`]=row}return result}
export function mergeStates(base,local,remote){
  const state=structuredClone(local),conflicts=[];
  function pick(path,b,l,r,target,key){let value;if(equal(l,r))value=l;else if(base&&equal(l,b))value=r;else if(base&&equal(r,b))value=l;else if(!base&&l===undefined)value=r;else if(!base&&r===undefined)value=l;else{conflicts.push({path,base:structuredClone(b),local:structuredClone(l),remote:structuredClone(r),section:target,key});value=l}return structuredClone(value)}
  state.settings=pick('settings',base?.settings,local.settings,remote.settings,'settings');
  state.createdAt=[local.createdAt,remote.createdAt,base?.createdAt].filter(Boolean).sort()[0];state.logs={};
  for(const key of new Set([...Object.keys(base?.logs||{}),...Object.keys(local.logs),...Object.keys(remote.logs)])){const v=pick('logs.'+key,base?.logs[key],local.logs[key],remote.logs[key],'logs',key);if(v!==undefined)state.logs[key]=v}
  const b=urgeMap(base?.urges),l=urgeMap(local.urges),r=urgeMap(remote.urges),urges={};
  for(const key of new Set([...Object.keys(b),...Object.keys(l),...Object.keys(r)])){const v=pick('urges.'+key,b[key],l[key],r[key],'urges',key);if(v!==undefined)urges[key]=v}
  state.urges=Object.values(urges).sort((a,b)=>a.at.localeCompare(b.at));
  return {state,conflicts,changed:!equal(local,state),urgeEntries:urges};
}
export function resolveMerge(result,choices){const state=structuredClone(result.state),urges=structuredClone(result.urgeEntries);for(const c of result.conflicts){if(!['local','remote'].includes(choices[c.path]))throw Error('请明确选择每一项冲突');const v=structuredClone(c[choices[c.path]]);if(c.section==='settings')state.settings=v;else{const target=c.section==='logs'?state.logs:urges;if(v===undefined)delete target[c.key];else target[c.key]=v}}state.urges=Object.values(urges).sort((a,b)=>a.at.localeCompare(b.at));return state}
