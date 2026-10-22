import {createHandler} from './api.js';
import {AuthStore} from './auth.js';
import {ApiError} from './errors.js';
export default {fetch:createHandler()};
export class AuthState {
  constructor(ctx){this.ctx=ctx;this.auth=new AuthStore(ctx.storage)}
  async fetch(request){
    try{const op=new URL(request.url).pathname.slice(1);if(!['start','callback','exchangeClaim','exchangeFinish','cancel','session','logout','limit'].includes(op))return Response.json({error:'NOT_FOUND'},{status:404});const result=await this.auth[op](await request.json());if(await this.ctx.storage.getAlarm()===null)await this.ctx.storage.setAlarm(Date.now()+600000);return Response.json(result)}
    catch(e){return Response.json({error:e instanceof ApiError?e.code:'AUTH_UNAVAILABLE',retryAfter:e.retryAfter},{status:e instanceof ApiError?e.status:503})}
  }
  async alarm(){const entries=await this.ctx.storage.list();const now=Date.now();for(const [key,value] of entries)if(value.expiresAt<=now||key.startsWith('session:')&&value.lastSeen+3600000<=now)await this.ctx.storage.delete(key);if((await this.ctx.storage.list({limit:1})).size)await this.ctx.storage.setAlarm(now+600000)}
}
