import test from 'node:test';import assert from 'node:assert/strict';import {Miniflare,convertV4MiniflareOptions} from 'miniflare';import {sha} from '../worker/auth.js';import {build} from 'esbuild';
test('real workerd SQLite Durable Object atomically rejects concurrent OAuth callbacks',async()=>{
  const compiled=await build({entryPoints:['worker/index.js'],bundle:true,write:false,format:'esm',platform:'browser'});
  const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'quit365-test',modules:true,script:compiled.outputFiles[0].text,compatibilityDate:'2026-10-22',durableObjects:{AUTH:{className:'AuthState',useSQLite:true}},bindings:{APP_ORIGIN:'https://sunnyflame888.github.io',APP_URL:'https://sunnyflame888.github.io/quit365/',WORKER_URL:'https://worker.example',GITHUB_CLIENT_ID:'synthetic',GITHUB_CLIENT_SECRET:'synthetic-only',GITHUB_DATA_TOKEN:'synthetic-only',ALLOWED_USER_ID:'289706800',DATA_OWNER:'sunnyflame888',DATA_REPO:'quit365-data',DATA_BRANCH:'main'}}]}));
  try{
    const state='s'.repeat(64),r=await mf.dispatchFetch('https://worker.example/auth/start',{method:'POST',headers:{Origin:'https://sunnyflame888.github.io','Content-Type':'application/json'},body:JSON.stringify({state,challenge:await sha('v'.repeat(64))})});assert.equal(r.status,200);
    const replies=await Promise.all([mf.dispatchFetch('https://worker.example/auth/callback?state='+state+'&code=synthetic',{redirect:'manual'}),mf.dispatchFetch('https://worker.example/auth/callback?state='+state+'&code=synthetic',{redirect:'manual'})]);assert.deepEqual(replies.map(r=>r.status).sort(),[303,401]);
    const denied=await mf.dispatchFetch('https://worker.example/v1/state');assert.equal(denied.status,401);
  }finally{await mf.dispose()}
});
