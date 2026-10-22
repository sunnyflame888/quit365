import test from 'node:test';import assert from 'node:assert/strict';import {AuthStore,sha} from '../worker/auth.js';import {createHandler} from '../worker/api.js';import {ApiError} from '../worker/errors.js';
class Storage {data=new Map();queue=Promise.resolve();async get(k){return structuredClone(this.data.get(k))}async put(k,v){this.data.set(k,structuredClone(v))}async delete(k){this.data.delete(k)}async list({prefix=''}={}){return new Map([...this.data].filter(([k])=>k.startsWith(prefix)))}transaction(fn){const p=this.queue.then(()=>fn(this));this.queue=p.catch(()=>{});return p}}
function setup({user=289706800,scope=''}={}) {
  const auth=new AuthStore(new Storage()),calls=[];
  const stub={fetch:async(url,init)=>{
    try{return Response.json(await auth[new URL(url).pathname.slice(1)](JSON.parse(init.body)))}
    catch(e){return Response.json({error:e.code||'FAILED',retryAfter:e.retryAfter},{status:e.status||503})}
  }};
  const env={
    APP_ORIGIN:'https://sunnyflame888.github.io',APP_URL:'https://sunnyflame888.github.io/quit365/',WORKER_URL:'https://worker.example',
    GITHUB_CLIENT_ID:'synthetic',GITHUB_CLIENT_SECRET:'synthetic-secret',GITHUB_DATA_TOKEN:'synthetic-data-token',
    ALLOWED_USER_ID:'289706800',DATA_OWNER:'sunnyflame888',DATA_REPO:'quit365-data',DATA_BRANCH:'main',
    AUTH:{idFromName:()=>1,get:()=>stub}
  };
  const handler=createHandler({fetch:async(url,init)=>{
    calls.push({url,init});
    if(url==='https://github.com/login/oauth/access_token')return Response.json({access_token:'temporary-provider-token',token_type:'bearer',scope});
    if(url==='https://api.github.com/user')return Response.json({id:user,login:'synthetic-user'});
    if(init.method==='DELETE')return new Response(null,{status:204});
    throw Error('Unexpected GitHub request');
  }});
  return {env,calls,request:(path,method='GET',data,token)=>handler(new Request('https://worker.example'+path,{
    method,headers:{Origin:env.APP_ORIGIN,...(data?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{})},
    body:data?JSON.stringify(data):undefined
  }),env)};
}
async function attempt(s){const verifier='v'.repeat(64),state='s'.repeat(64);const start=await s.request('/auth/start','POST',{state,challenge:await sha(verifier)});assert.equal(start.status,200);const u=new URL((await start.json()).authorizeUrl);assert.equal(u.searchParams.get('code_challenge_method'),'S256');assert.equal(u.searchParams.get('scope'),'');const cb=await s.request('/auth/callback?state='+state+'&code=synthetic');assert.equal(cb.status,303);const location=new URL(cb.headers.get('Location'));assert.equal(location.origin,s.env.APP_ORIGIN);const ticket=new URLSearchParams(location.hash.slice(1)).get('oauth');return {ticket,verifier}}
test('full OAuth exchange issues independent session, revokes provider token and logout denies reuse',async()=>{const s=setup(),a=await attempt(s),r=await s.request('/auth/exchange','POST',a);assert.equal(r.status,200);const b=await r.json();assert.notEqual(b.token,'temporary-provider-token');assert.equal(b.token.length,43);assert.equal((await s.request('/v1/session','GET',null,b.token)).status,200);assert.equal((await s.request('/auth/exchange','POST',a)).status,401);assert.ok(s.calls.some(c=>c.init.method==='DELETE'));await s.request('/v1/logout','POST',null,b.token);assert.equal((await s.request('/v1/session','GET',null,b.token)).status,401)});
test('wrong GitHub identity never receives application session',async()=>{const s=setup({user:999}),a=await attempt(s),r=await s.request('/auth/exchange','POST',a);assert.equal(r.status,403);assert.equal((await r.json()).token,undefined);assert.ok(s.calls.some(c=>c.init.method==='DELETE'))});
test('unexpected repo scope is rejected and revoked instead of accepted',async()=>{const s=setup({scope:'repo'}),a=await attempt(s);assert.equal((await s.request('/auth/exchange','POST',a)).status,403)});
