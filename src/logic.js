export const VERSION = '1.0.0';
export const DEFAULT_START = '2026-10-22';
export const DEFAULT_QUIT = '2026-10-29';
export const WEEKS = 12;
export const LAST_DAY = 84;
export const PREP_TARGETS = [10, 9, 8, 6, 5, 3, 2]; // optional behavioral ceilings only

export const SOURCES = [
  {label:'DailyMed · 伐尼克兰官方处方说明', url:'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=f0ff4f27-5185-4881-a749-c6b7a0ca5696'},
  {label:'WHO · 成人烟草戒断临床指南（2024）', url:'https://www.who.int/publications/i/item/9789240096431'},
  {label:'CDC · 戒烟支持与戒断症状', url:'https://www.cdc.gov/tobacco/campaign/tips/quit-smoking/index.html'}
];

export const TRIGGERS = {
  morning:'晨起', meal:'饭后', work:'工作压力', driving:'开车/等待', social:'聚会/饮酒', exercise:'运动后', evening:'睡前', idle:'无聊/习惯', unknown:'不确定', none:'无明显烟瘾'
};
export const COPINGS = {walk:'散步', water:'喝水', breath:'呼吸', gum:'普通口香糖', contact:'寻求支持', other:'其他'};

export function initialState() {
  return {
    schemaVersion:1,
    createdAt:new Date().toISOString(),
    settings:{
      startDate:DEFAULT_START,
      quitDate:DEFAULT_QUIT,
      doseVerified:false,
      amTime:'08:00', pmTime:'19:00',
      overrides:[],
      revisions:[],
      onboardingDismissed:false
    },
    logs:{},
    urges:[]
  };
}
export function pad(n){ return String(n).padStart(2,'0'); }
export function localToday(now = new Date()) {return `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;}
export function utcDate(iso){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(iso||'')) return NaN;
  const [y,m,d]=iso.split('-').map(Number);
  const ms = Date.UTC(y,m-1,d);
  const dt=new Date(ms);
  return dt.getUTCFullYear()===y && dt.getUTCMonth()===m-1 && dt.getUTCDate()===d ? ms : NaN;
}
export function isDate(iso){return Number.isFinite(utcDate(iso));}
export function addDays(iso, days){return new Date(utcDate(iso)+days*86400000).toISOString().slice(0,10);}
export function daysBetween(a,b){return Math.round((utcDate(b)-utcDate(a))/86400000);}
export function protocolDay(date,settings){return daysBetween(settings.startDate,date)+1;}
export function quitDayNumber(date,settings){return daysBetween(settings.quitDate,date)+1;}
export function isTobaccoFree(log) {return Boolean(log?.complete && (Number(log.iqos)||0)===0 && (Number(log.cigarettes)||0)===0 && (Number(log.otherTobacco)||0)===0);}
export function tobaccoTotal(log){return (Number(log?.iqos)||0)+(Number(log?.cigarettes)||0)+(Number(log?.otherTobacco)||0);}
export function prescribedDose(date, settings){
  const d=protocolDay(date,settings);
  if(d<1) return {am:0, pm:0, stage:'not-started', day:d};
  if(d<=3) return {am:0.5, pm:0, stage:'starting', day:d};
  if(d<=7) return {am:0.5, pm:0.5, stage:'titration', day:d};
  if(d<=LAST_DAY) {
    let am=1,pm=1,stage='maintenance';
    const applicable=[...(settings.overrides||[])].filter(o=>o.effectiveDate<=date && o.effectiveDate>=settings.startDate).sort((a,b)=>a.effectiveDate.localeCompare(b.effectiveDate));
    if(applicable.length){ const o=applicable.at(-1); am=o.am;pm=o.pm;stage='adjusted'; }
    return {am,pm,stage,day:d};
  }
  return {am:0,pm:0,stage:'finished',day:d};
}
export function defaultLog(date){return {date,iqos:0,cigarettes:0,otherTobacco:0,nrtGum:0,craving:0,episodes:0,trigger:'none',sleep:'',nausea:'',mood:'',medAm:false,medPm:false,coping:[],notes:'',complete:false,updatedAt:''};}
export function timelineStage(date,settings){
  const d=protocolDay(date,settings), q=quitDayNumber(date,settings);
  if(d<1) return '待开始';
  if(d<=7 && q<=0) return '药物准备期';
  if(q>=1 && q<=14) return '急性戒断与习惯建立';
  if(d<=84) return '长期巩固期';
  if(d>84) return '首疗程后随访';
  return '戒烟准备与过渡';
}
export function streak(logs, settings, asOf){
  if(daysBetween(settings.quitDate,asOf)<0)return 0;
  let cursor=asOf, count=0;
  // no completed entry for today? start from yesterday; never count assumed zeros
  if(!logs[cursor]?.complete) cursor=addDays(cursor,-1);
  while(cursor>=settings.quitDate && isTobaccoFree(logs[cursor])){
    count++;cursor=addDays(cursor,-1);
  }
  return count;
}
export function summaryStats(logs,settings, asOf){
  const rows=Object.values(logs).filter(x=>x.date<=asOf && x.date>=settings.startDate && x.complete).sort((a,b)=>a.date.localeCompare(b.date));
  const after=rows.filter(x=>x.date>=settings.quitDate);
  const zeroDays=after.filter(isTobaccoFree).length;
  const lapseDays=after.filter(x=>tobaccoTotal(x)>0).length;
  const medDoses=rows.reduce((acc,l)=>{const expected=prescribedDose(l.date,settings);if(expected.am>0){acc.total++; if(l.medAm)acc.done++;}if(expected.pm>0){acc.total++;if(l.medPm)acc.done++;}return acc;},{total:0,done:0});
  const avgCraving=after.length?after.reduce((a,b)=>a+(Number(b.craving)||0),0)/after.length:null;
  return {rows,after,zeroDays,lapseDays,streak:streak(logs,settings,asOf),medDoses,avgCraving};
}
export function validateState(s){
  if(!s || s.schemaVersion!==1 || !s.settings || typeof s.logs!=='object' || !Array.isArray(s.urges)) throw new Error('备份格式或版本不受支持');
  if(!isDate(s.settings.startDate)||!isDate(s.settings.quitDate)) throw new Error('备份日期无效');
  if(Object.keys(s.logs).length>5000 || s.urges.length>20000) throw new Error('备份包含异常大量记录');
  for(const [key,log] of Object.entries(s.logs)){
    if(!isDate(key) || !log || log.date!==key)throw new Error('备份日志的日期无效');
    for(const k of ['iqos','cigarettes','otherTobacco','nrtGum','craving','episodes']){
      const v=Number(log[k]||0);
      if(!Number.isFinite(v)||v<0||v>10000)throw new Error('备份包含无效记录');
    }
  }
  for(const o of s.settings.overrides||[]){if(!isDate(o.effectiveDate)||![o.am,o.pm].every(v=>Number.isFinite(v)&&v>=0&&v<=1))throw new Error('备份剂量调整数据无效');}
  return s;
}
export function doseText(mg){return `${mg} mg`;} 
export function weekName(d){if(d<=0)return '启动前';if(d>84)return '12周已完成';return `第 ${Math.ceil(d/7)} / 12 周`;}
export function exportCsv(logs){
  const columns=['date','complete','iqos','cigarettes','otherTobacco','nrtGum','craving','episodes','trigger','sleep','nausea','mood','medAm','medPm','coping','notes'];
  const csvSafe=v=>{let s=String(v??'');if(/^[\s]*[=+\-@\t\r]/.test(s))s="'"+s;return `"${s.replaceAll('"','""')}"`;};
  return [columns.join(','),...Object.values(logs).sort((a,b)=>a.date.localeCompare(b.date)).map(log=>columns.map(c=>csvSafe(c==='coping'?(log[c]||[]).join('|'):log[c])).join(','))].join('\r\n');
}
