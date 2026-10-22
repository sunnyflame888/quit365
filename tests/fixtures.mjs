import {initialState,defaultLog} from '../src/logic.js';
export function fixture(){const s=initialState();s.createdAt='2026-10-22T00:00:00.000Z';return s}
export function withDay(s,date='2026-10-22',notes='test'){const x=structuredClone(s);x.logs[date]={...defaultLog(date),complete:true,notes,updatedAt:'2026-10-22T01:00:00.000Z'};return x}
