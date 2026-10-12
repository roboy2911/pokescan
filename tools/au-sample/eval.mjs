import { readFileSync } from 'node:fs';
// Checks the AU sold filter against real sales (raw.json, fetched 12 Oct for list.json's cards):
// how many answers land more than 2x from TCGplayer. Compare a version of the filter with
// OLD=<path to another au-sold-filter.mjs>. Run: node tools/au-sample/eval.mjs [low|high|ok]
const here = (f) => new URL(f, import.meta.url);
const N = await import('../au-sold-filter.mjs');
const O = process.env.OLD ? await import(process.env.OLD) : N;
const { targets } = await import('../au-sold-keys.mjs');
const D = new URL('../../data/', import.meta.url).pathname;
const cm=JSON.parse(readFileSync(D+'cards.json'));const pr=JSON.parse(readFileSync(D+'prices.json')).cards;
const byId=new Map();for(const t of targets(cm,pr,1.52,0)){(byId.get(t.id)??byId.set(t.id,[]).get(t.id)).push(t);}
const list=JSON.parse(readFileSync(here('list.json')));
const raw=JSON.parse(readFileSync(here('raw.json')));
const agg={};const show=process.argv[2];
for(const t of list){const items=(raw[t.key]||[]).map(([title,p,c,d])=>({title,soldPrice:p,soldCurrency:'AUD',condition:c,endedAt:d}));
 const o=O.summarise(items,t.n,O.OTHER_LANG.test(t.q),t.q,t.t,{set:t.set});
 // new targets for this card that share the same eBay keyword
 const kw=O.ebayKeyword(t.q,t.t);
 const nts=(byId.get(t.id)||[]).filter(x=>N.ebayKeyword(x.q,x.t)===kw);
 const a=agg[t.grp]??={n:0,old:0,oldBad:0,neu:0,neuBad:0,lo:[],ln:[]};
 a.n++; if(o.ok){a.old++;const r=o.aud/t.tcgAud;a.lo.push(Math.abs(Math.log(r)));if(r<0.5||r>2)a.oldBad++;}
 for(const x of nts){const nw=N.summarise(items,x.n,N.OTHER_LANG.test(x.q),x.q,x.t,{set:x.set});
  if(nw.ok){a.neu++;const r=nw.aud/x.aud;a.ln.push(Math.abs(Math.log(r)));if(r<0.5||r>2)a.neuBad++;}
  if(show&&t.grp===show)console.log(x.q.padEnd(42),'tcg',x.aud.toFixed(0),'old',o.ok?o.aud:'-','new',nw.ok?nw.aud:'-',nw.ok&&(nw.aud/x.aud<0.5||nw.aud/x.aud>2)?'  <<':'');}
}
const med=(x)=>{const s=[...x].sort((a,b)=>a-b);return s.length?Math.exp(s[s.length>>1]).toFixed(2):'-'};
for(const [g,a] of Object.entries(agg))console.log(g,'cards',a.n,'| old priced',a.old,'>2x off',a.oldBad,'median factor',med(a.lo),'| new priced',a.neu,'>2x off',a.neuBad,'median factor',med(a.ln));
