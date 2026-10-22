import {ApiError,requireValue} from './errors.js';
import {validateDocument} from '../src/sync-schema.js';
function encode(text){const bytes=new TextEncoder().encode(text);let s='';for(const byte of bytes)s+=String.fromCharCode(byte);return btoa(s)}
function decode(text){return new TextDecoder().decode(Uint8Array.from(atob(text.replace(/\s/g,'')),c=>c.charCodeAt(0)))}
export class GithubData {
  constructor(env,{fetch:upstreamFetch=globalThis.fetch}={}){this.env=env;this.fetch=upstreamFetch}
  async call(path,init={}){
    const e=this.env;requireValue(e.DATA_OWNER==='sunnyflame888'&&e.DATA_REPO==='quit365-data'&&e.DATA_BRANCH==='main'&&e.GITHUB_DATA_TOKEN,503,'CONFIGURATION_REQUIRED');
    return this.fetch('https://api.github.com/repos/'+e.DATA_OWNER+'/'+e.DATA_REPO+path,{...init,redirect:'error',headers:{Authorization:'Bearer '+e.GITHUB_DATA_TOKEN,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10','User-Agent':'QUIT365-Sync','Content-Type':'application/json'}});
  }
  async checkPrivate(){const r=await this.call('');if(!r.ok)throw new ApiError(503,'DATA_REPOSITORY_UNAVAILABLE');requireValue((await r.json()).private===true,503,'PRIVATE_REPOSITORY_REQUIRED')}
  async read(){
    await this.checkPrivate();const r=await this.call('/contents/data/state.json?ref=main');
    if(r.status===404){const branch=await this.call('/branches/main');if(!branch.ok)throw new ApiError(503,'DATA_BRANCH_UNAVAILABLE');return {revision:null,document:null}}
    if(!r.ok)throw new ApiError(r.status===429||r.status===403?429:503,'GITHUB_UNAVAILABLE',Number(r.headers.get('Retry-After'))||60);
    const body=await r.json();requireValue(body.type==='file'&&typeof body.sha==='string'&&body.size<=1048576,503,'INVALID_CLOUD_DATA');
    let document;try{document=validateDocument(JSON.parse(decode(body.content)))}catch{throw new ApiError(503,'INVALID_CLOUD_DATA')}return {revision:body.sha,document};
  }
  async write(document,revision){
    try{validateDocument(document)}catch{throw new ApiError(400,'INVALID_DOCUMENT')}
    requireValue(revision===null||/^[a-f0-9]{40,64}$/.test(revision),400,'INVALID_REVISION');await this.checkPrivate();
    const body={message:'Update private journal',branch:'main',content:encode(JSON.stringify(document)),...(revision===null?{}:{sha:revision})};
    const r=await this.call('/contents/data/state.json',{method:'PUT',body:JSON.stringify(body)});
    if(r.status===409||r.status===422)throw new ApiError(409,'CONFLICT');if(!r.ok)throw new ApiError(r.status===403||r.status===429?429:503,'GITHUB_UNAVAILABLE',Number(r.headers.get('Retry-After'))||60);
    const result=await r.json();requireValue(typeof result.content?.sha==='string',503,'INVALID_GITHUB_RESPONSE');return {revision:result.content.sha};
  }
}
