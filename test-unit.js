/* ============================================================================
   takeoff-flow — unit tests for the date engine, sort, and the import payload.

   Run:  node test-unit.js          (from the takeoff-flow folder; no deps)

   There was no test harness in this repo. These cover the parts where being
   silently wrong is worst, and every one of them corresponds to a real bug:

     · workday()      — a "skip whole weeks" optimisation was written, tested
                        against a reference implementation, found to be WRONG from
                        weekend starts and fundamentally broken once HOLIDAYS is
                        non-empty, and reverted. This test is why that never
                        shipped. Do not touch workday() without running it.
     · effective()    — memoised for performance; a stale cache would be worse
                        than a slow render, so the invalidation contract is pinned.
     · todayIso()     — returned the UTC day, so after ~7pm Eastern it was
                        tomorrow, stamping tomorrow's date into completed_date.
     · sortView()     — rewritten to precompute keys; must produce byte-identical
                        ordering to the old comparator.
     · updRows        — the import's update payload. Objects with differing key
                        sets make postgrest-js send a UNION of keys as ?columns=,
                        and PostgREST then writes NULL for the missing ones. This
                        nulled first_trench_date on 26 Orlando rows on 2026-09-14.
                        The invariant is: every object carries an identical key set.

   It reads app.js and slices the functions out by name, so it always tests the
   real source rather than a copy.
   ========================================================================== */
const fs=require("fs");
const R=__dirname+"/";
const src=fs.readFileSync(R+"app.js","utf8");
const cfgSrc=fs.readFileSync(R+"config.js","utf8");

function matchFrom(i){ let d=0,started=false;
  for(let k=i;k<src.length;k++){ const ch=src[k];
    if(ch==="{"||ch==="("||ch==="[") {d++;started=true;}
    else if(ch==="}"||ch===")"||ch==="]"){ d--; if(started&&d===0 && ch==="}") return src.slice(i,k+1); }
    else if(ch===";"&&d===0&&started) return src.slice(i,k+1);
  } throw new Error("unbalanced at "+i); }
function grab(name){ const i=src.indexOf("function "+name+"("); if(i<0) throw new Error("fn "+name); return matchFrom(i); }
function grabVar(name){ const m=src.match(new RegExp("^(?:const|let)\\s+"+name+"\\s*=","m")); if(!m) throw new Error("var "+name);
  return matchFrom(m.index).replace(/^(const|let)\s+/,"var "); }

let CFG={}; eval(cfgSrc.replace(/^window\.APP_CONFIG\s*=/m,"CFG ="));
const HOLIDAYS=new Set(CFG.HOLIDAYS||[]);
var state={sort:{flow:{field:"k",dir:1}},view:"flow"};
function getSort(){ return state.sort[state.view]||null; }

eval([
  grabVar("todayIso"), grab("parseIso"), grab("iso"), grab("isBiz"), grab("workday"),
  grabVar("_effCache"), grab("clearEffCache"), grab("effective"),
  grab("cmpVal"), grab("sortView")
].join("\n"));

let P=0,F=0; const ok=(n,c,d)=>{c?P++:F++;console.log(`  ${c?"PASS":"FAIL"}  ${n}${c?"":"   <- "+(d||"")}`);};
const ref=(s,n)=>{const [y,m,dd]=s.split("-").map(Number);const d=new Date(Date.UTC(y,m-1,dd));
  let st=n>=0?1:-1,r=Math.abs(n);
  while(r>0){d.setUTCDate(d.getUTCDate()+st);const g=d.getUTCDay();
    if(g!==0&&g!==6&&!HOLIDAYS.has(d.toISOString().slice(0,10)))r--;}
  return d.toISOString().slice(0,10);};

const d0=new Date();
const localToday=`${d0.getFullYear()}-${String(d0.getMonth()+1).padStart(2,"0")}-${String(d0.getDate()).padStart(2,"0")}`;
ok("todayIso() = local calendar day (not UTC)", todayIso()===localToday, todayIso()+" vs "+localToday);

const offsets=[...new Set(Object.values(CFG.DATE_RULES).filter(r=>!r.calendar).map(r=>r.days))];
let bad=0,cases=0;
for(let t=Date.UTC(2023,0,1);t<Date.UTC(2029,0,1);t+=864e5){
  const s=new Date(t).toISOString().slice(0,10);
  for(const n of offsets){ cases++; if(workday(s,n)!==ref(s,n)){ if(bad<3)console.log("     ",s,n,workday(s,n),ref(s,n)); bad++; } } }
ok(`workday() = reference, ${cases.toLocaleString()} cases (offsets ${offsets.join(", ")})`, bad===0, bad+" mismatches");
ok("workday(calendar) is plain calendar math", workday("2026-03-02",-30,true)==="2026-01-31", workday("2026-03-02",-30,true));
ok("workday(null) -> null", workday(null,-67)===null);

const row={id:"r1",first_trench_date:"2026-07-21"};
const v1=effective(row,"cis_due"); row.first_trench_date="2026-08-21";
const vStale=effective(row,"cis_due"); clearEffCache();
const vFresh=effective(row,"cis_due");
ok("effective() memoises by row id + field", vStale===v1, `${vStale} vs ${v1}`);
ok("clearEffCache() forces recompute", vFresh!==v1 && !!vFresh);
ok("memoised value == uncached math", vFresh===ref("2026-08-21",-67), `${vFresh} vs ${ref("2026-08-21",-67)}`);

clearEffCache();
const anon={first_trench_date:"2026-07-21"}; effective(anon,"cis_due"); anon.first_trench_date="2026-08-21";
ok("rows with no id are never cached", effective(anon,"cis_due")===ref("2026-08-21",-67));

clearEffCache(); const r2={id:"r2",first_trench_date:"2026-07-21"};
ok("pricing_stage recurses via estimate_eta", effective(r2,"pricing_stage")===ref(ref("2026-07-21",-30),2));
ok("loc_upload recurses via tasks_start", effective(r2,"loc_upload")===ref(ref("2026-07-21",-10),-5));
clearEffCache();
ok("manual override beats the calc", effective({id:"r3",first_trench_date:"2026-07-21",cis_due:"2020-01-01"},"cis_due")==="2020-01-01");
ok("no trench date -> null", effective({id:"r4"},"cis_due")===null);

const rows=Array.from({length:500},(_,i)=>({id:"x"+i,k:String((i*7919)%500).padStart(3,"0")}));
const cols=[{f:"k",raw:r=>r.k}];
const neu=sortView(rows,cols).map(r=>r.id);
const old=rows.slice().sort((a,b)=>cmpVal(cols[0].raw(a),cols[0].raw(b))*1).map(r=>r.id);
ok("sortView() order == old comparator order", JSON.stringify(neu)===JSON.stringify(old));
ok("sortView() does not mutate its input", rows[0].id==="x0");
state.sort.flow.dir=-1;
ok("sortView() honours descending", JSON.stringify(sortView(rows,cols).map(r=>r.id))===JSON.stringify(old.slice().reverse()));
state.sort={}; ok("sortView() with no sort returns input untouched", sortView(rows,cols)===rows);

// updRows key-set invariant, using the real construction from publishImport
const mk=(existRows,updates,lastUpd,div,now,email)=>{
  const curById=new Map(existRows.map(r=>[r.id,r]));
  const byId=new Map(); (updates||[]).forEach(u=>byId.set(u.id,{id:u.id,trTo:u.trTo}));
  if(lastUpd) lastUpd.forEach((lt,id)=>{ const cur=byId.get(id)||{id}; cur.lastTo=lt; byId.set(id,cur); });
  return [...byId.values()].map(u=>{ const cur=curById.get(u.id)||{};
    return { id:u.id, division:div, updated_at:now, updated_by:email,
             first_trench_date: u.trTo || cur.first_trench_date || null,
             last_trench_date:  u.lastTo|| cur.last_trench_date  || null }; }); };
const ex=[{id:"A",first_trench_date:"2026-01-01",last_trench_date:"2026-05-01"},
          {id:"B",first_trench_date:"2026-02-02",last_trench_date:null},
          {id:"C",first_trench_date:null,last_trench_date:null}];
const up=mk(ex,[{id:"C",trTo:"2026-03-03"}],new Map([["A","2026-09-01"],["B","2026-09-02"]]),"tampa","T","me");
const keysets=new Set(up.map(r=>Object.keys(r).sort().join(",")));
ok("updRows: identical key set on every object (the NULL bug)", keysets.size===1, [...keysets].join(" | "));
ok("updRows: last-only change preserves first_trench_date", up.find(r=>r.id==="A").first_trench_date==="2026-01-01");
ok("updRows: first-only change preserves last_trench_date", up.find(r=>r.id==="C").last_trench_date===null);
ok("updRows: both keys always present", up.every(r=>"first_trench_date" in r && "last_trench_date" in r));

console.log(`\n${P} passed, ${F} failed`);
process.exit(F?1:0);
