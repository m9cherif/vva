import { api, extractJson } from './api.js';
const MAX_SEARCHES=3,MAX_ROUNDS=9,IMAGES_PER_TURN=8;
const SYSTEM=`You are the research agent inside an automated viral-clip studio.
Your job: find the BEST source videos to mine for viral clips in a given category.
Each turn you receive the state and candidate videos (title, channel, duration, views). Covers are attached in the SAME ORDER as the list.
Reply with EXACTLY one JSON object: {"reason":"...","keep":[ids],"drop":[ids],"search":"new query or null","done":false}
Rules: keep only shown ids. Prefer duration >= MIN_DURATION and prefer CONTINUITY (one continuous subject) — but both are PREFERENCES, never hard filters: when nothing better is available, KEEP the best candidate you have. Completions/compilations are acceptable as a fallback once single-subject options are gone. Prefer strong covers/views; vary every query. NEVER end with keep=[] while candidates are on screen — pick the best of what exists. done:true only when enough are kept or the search budget is gone.`;
export async function researchSources({category,need,minDuration,spare=0,log=()=>{}}){
  const target=need+spare;
  const seen=new Map(),kept=[],dropped=new Set(),history=[];let pool=[],searches=0,round=0,lastQuery=null,malformed=0,stopped='';
  const note=t=>log(t);
  note(`🤖 Agent researching "${category}" — needs ${need} videos (≥${minDuration}s)${spare?` (+${spare} spare)`:''}`);
  while(round<MAX_ROUNDS){
    round++;
    const cands=pool.filter(v=>!dropped.has(v.id)&&!kept.some(k=>k.id===v.id)).slice(0,IMAGES_PER_TURN);
    const images=(await Promise.all(cands.map(async v=>{try{const r=await fetch(api.thumb(v.id));if(!r.ok)return null;const b=await r.blob();if(b.size<500||b.size>3e6)return null;return await new Promise(res=>{const fr=new FileReader();fr.onload=()=>res(fr.result.split(',')[1]);fr.readAsDataURL(b);});}catch{return null;}}))).filter(Boolean);
    const shown=images.length?cands.slice(0,images.length):cands;
    const user=`CATEGORY: ${category}\nNEED: ${need} | KEPT: ${kept.length} | MIN_DURATION: ${minDuration}s\nSEARCHES: ${searches}/${MAX_SEARCHES} | TURN: ${round}/${MAX_ROUNDS}\n${lastQuery?`LAST QUERY: "${lastQuery}"`:'NO SEARCH YET — start with a query.'}\n\nKEPT SO FAR:\n${kept.map((v,i)=>`  ${i+1}. id=${v.id} "${v.title}" | ${v.duration}s | ${v.views} views`).join('\n')||'  (none)'}\nDROPPED: ${[...dropped].slice(-10).join(', ')||'(none)'}\n\nCANDIDATES${images.length?` — ${images.length} covers attached, in this exact order`:''}:\n${shown.map((v,i)=>`  ${i+1}. id=${v.id} | "${v.title}" | ${v.duration}s | ${v.views} views | ${v.channel}`).join('\n')||'  (none — you must search)'}\n\nReply with ONLY the JSON object.`;
    let text;
    try{({text}=await api.ai({system:SYSTEM,user,images,history,maxTokens:2500,temperature:0.3,attempts:2}));}
    catch(e){note(`⚠ agent call failed: ${String(e.message||e).slice(0,140)}`);break;}
    history.push({role:'assistant',content:text});history.push({role:'user',content:user});
    while(history.length>12)history.shift();
    const d=extractJson(text);
    if(!d||typeof d!=='object'||Array.isArray(d)){malformed++;if(malformed>=3){note('⚠ agent stopped: unusable decisions');break;}history.push({role:'user',content:'Reply with ONLY the JSON object specified.'});continue;}
    malformed=0;
    const reason=String(d.reason||'').trim().slice(0,220);
    for(const id of Array.isArray(d.keep)?d.keep:[]){const c=seen.get(String(id));if(c&&!dropped.has(c.id)&&!kept.some(k=>k.id===c.id)){kept.push(c);note(`✅ kept "${c.title}" — ${c.duration}s · ${c.views} views`);}}
    for(const id of Array.isArray(d.drop)?d.drop:[]){const c=seen.get(String(id));if(c&&!kept.some(k=>k.id===c.id)&&!dropped.has(c.id)){dropped.add(c.id);note(`❌ dropped "${c.title}"${reason?` — ${reason}`:''}`);}}
    if(d.done&&reason)note(`🧠 ${reason}`);
    if(kept.length>=target){stopped=`found ${kept.length}/${need} videos`;break;}
    if(d.done){stopped=reason||'agent satisfied';break;}
    const q=typeof d.search==='string'?d.search.trim().slice(0,120):'';
    if(q&&searches<MAX_SEARCHES){
      searches++;lastQuery=q;note(`🔎 search ${searches}/${MAX_SEARCHES}: "${q}"`);
      try{const rows=(await api.search(q)).videos||[];rows.forEach(r=>seen.set(r.id,r));pool=rows;note(`   → ${rows.length} candidates`);if(!rows.length)history.push({role:'user',content:'That query returned zero results. Try a different one.'});}
      catch(e){note(`   ⚠ ${String(e.message||e).slice(0,160)}`);pool=[];history.push({role:'user',content:`Search failed: ${String(e.message||e).slice(0,200)}`});}
      continue;
    }
    history.push({role:'user',content:searches>=MAX_SEARCHES?'Search budget exhausted — decide with what is on screen.':'Give a decision: keep, drop, search or done.'});
  }
  if(!stopped)stopped=`round limit (${MAX_ROUNDS}) reached`;
  // Fill up from everything we ever saw — including videos the agent dropped —
  // rather than failing the whole job over a strict judgment call.
  if(kept.length<target){[...seen.values()].filter(v=>!kept.some(k=>k.id===v.id)).sort((a,b)=>b.views-a.views).forEach(v=>{if(kept.length<target){kept.push(v);note(`➕ topped up with "${v.title}" (${v.views} views)`);}});}
  if(!kept.length)throw new Error(`The AI research agent found no videos at all for "${category}". Try another category.`);
  note(`🎯 agent finished: ${kept.length} video${kept.length===1?'':'s'} selected (${stopped})`);
  return {videos:kept.slice(0,target)};
}
