/* ============================================================
   Lennar Takeoff Flow
   Static site (GitHub Pages) + Supabase (auth, roles, data).
   Roles: admin / editor / purchasing / viewer.
   Tabs:  Flow of Takeoffs · Pending Budgets · Takeoff Changes · To-Do List
   Leave SUPABASE_* placeholders in config.js to run in DEMO mode.
   ============================================================ */
const CFG  = window.APP_CONFIG;
const DEMO = !CFG.SUPABASE_URL || CFG.SUPABASE_URL.startsWith("YOUR_");
let sb = null;
if (!DEMO && window.supabase) sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
  auth: { persistSession:true, autoRefreshToken:true, detectSessionInUrl:true, storageKey:"lennar-vendor-portal-auth" }
});
const HOLIDAYS = new Set(CFG.HOLIDAYS || []);

const state = {
  email:null, role:"viewer", roleDivs:[], divKey:null, view:"flow", filter:"",
  flow:[], cols:[], checks:{}, status:{}, changes:[], users:[],
  sort:{}, colFilters:{}   // per-view column sort + per-column filter text
};

/* in-memory store for DEMO mode */
const MEM = { app_roles:[], flow_rows:[], pending_budget_cols:[], pending_budget_checks:[], pending_budget_status:[], takeoff_changes:[], change_log:[] };

/* ---------------- helpers ---------------- */
const $   = id => document.getElementById(id);
const esc = s => String(s==null?"":s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "id-"+Date.now()+"-"+Math.random().toString(16).slice(2));
const lc  = s => (s||"").toLowerCase().trim();
const todayIso = () => new Date().toISOString().slice(0,10);

function parseIso(s){ if(!s) return null; const [y,m,d]=s.split("-").map(Number); return new Date(Date.UTC(y,m-1,d)); }
function iso(d){ return d.toISOString().slice(0,10); }
function fmtDate(s){ const d=parseIso(s); if(!d) return ""; const mm=d.getUTCMonth()+1, dd=d.getUTCDate(), yy=String(d.getUTCFullYear()).slice(2); return `${mm}/${dd}/${yy}`; }
function isBiz(d){ const g=d.getUTCDay(); return g!==0 && g!==6 && !HOLIDAYS.has(iso(d)); }
function workday(startIso, n, calendar){
  const d = parseIso(startIso); if(!d) return null;
  if(calendar){ d.setUTCDate(d.getUTCDate()+n); return iso(d); }
  let step = n>=0?1:-1, remaining=Math.abs(n);
  while(remaining>0){ d.setUTCDate(d.getUTCDate()+step); if(isBiz(d)) remaining--; }
  return iso(d);
}
/* effective value of a flow field: manual override wins, else computed */
function effective(row, field){
  if(field==="first_trench_date" || field==="released") return row[field]||null;
  const rule = CFG.DATE_RULES[field];
  if(row[field]) return row[field];           // manual override stored on the row
  if(!rule) return row[field]||null;
  const base = effective(row, rule.from);
  return base ? workday(base, rule.days, rule.calendar) : null;
}
const isCalc      = f => !!CFG.DATE_RULES[f];
const isOverride  = (row,f) => isCalc(f) && !!row[f];
/* Plan name = manual override on the row, else looked up by division + plan number.
   The lookup is loaded from Supabase (tf_plan_names); demo mode falls back to any
   embedded window.TF_PLAN_NAMES. */
function planLookup(){ return state.planNames || (window.TF_PLAN_NAMES||{}); }
function planName(r){
  if(r.plan_name) return r.plan_name;
  const m=(planLookup()[r.division])||{};
  return m[String(r.plan==null?"":r.plan).trim().toUpperCase()] || "";
}
async function loadPlanNames(){
  if(DEMO){ state.planNames = window.TF_PLAN_NAMES || {}; return; }
  try{
    const { data } = await sb.from("tf_plan_names").select("division,plan_no,name");
    const m={}; (data||[]).forEach(r=>{ (m[r.division]=m[r.division]||{})[String(r.plan_no).trim().toUpperCase()]=r.name; });
    state.planNames=m;
  }catch(e){ console.warn("plan names load failed",e); state.planNames={}; }
}

/* ---------------- theme ---------------- */
(function(){ try{ const t=localStorage.getItem("tf_theme"); if(t) document.documentElement.setAttribute("data-theme",t);
  else if(window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches) document.documentElement.setAttribute("data-theme","dark"); }catch(e){} })();
function toggleTheme(){ const isDark=document.documentElement.getAttribute("data-theme")==="dark"; const next=isDark?"light":"dark";
  document.documentElement.setAttribute("data-theme",next); try{localStorage.setItem("tf_theme",next);}catch(e){}
  const b=$("themeBtn"); if(b) b.textContent=next==="dark"?"Light":"Dark"; }

/* ---------------- per-user UI memory (division, tab, sorts, column filters) ----------------
   Saved to localStorage, namespaced per email so a shared browser doesn't mix people up.
   colFilters hold Set objects, which aren't JSON-serializable, so they're stored as arrays. */
function prefsKey(){ return "tf_prefs:"+(state.email||"anon"); }
function loadPrefs(){ try{ return JSON.parse(localStorage.getItem(prefsKey())||"{}")||{}; }catch(e){ return {}; } }
function savePrefs(){
  if(!state.email) return;
  const cf={};
  for(const v in state.colFilters){ const m=state.colFilters[v]||{}, out={};
    for(const f in m){ if(m[f] instanceof Set) out[f]=[...m[f]]; }
    if(Object.keys(out).length) cf[v]=out;
  }
  try{ localStorage.setItem(prefsKey(), JSON.stringify({ divKey:state.divKey, view:state.view, sort:state.sort, colFilters:cf })); }catch(e){}
}
function applyPrefs(){
  const p=loadPrefs();
  if(p.divKey && CFG.DIVISIONS.some(d=>d.key===p.divKey)) state.divKey=p.divKey;
  if(["flow","budgets","changes","todo"].includes(p.view)) state.view=p.view;
  if(p.sort && typeof p.sort==="object") state.sort=p.sort;
  if(p.colFilters && typeof p.colFilters==="object"){
    const cf={};
    for(const v in p.colFilters){ const m=p.colFilters[v]||{}; cf[v]={};
      for(const f in m){ if(Array.isArray(m[f])) cf[v][f]=new Set(m[f]); } }
    state.colFilters=cf;
  }
}

/* ---------------- roles / permissions ---------------- */
function resolveRoleFromConfig(email){
  const r = CFG.ROLES[lc(email)];
  if(!r) return { role:CFG.DEFAULT_ROLE, divisions:[] };
  return { role:r.role||CFG.DEFAULT_ROLE, divisions:r.divisions||[] };
}
const isAdmin       = () => state.role==="admin";
const canEditDiv    = k => state.role==="admin" || (state.role==="editor" && state.roleDivs.includes(k));
const canManageCols = k => canEditDiv(k);
const canAddChange  = k => canEditDiv(k) || (state.role==="purchasing" && (state.roleDivs.length===0 || state.roleDivs.includes(k)));
function canToggleCheck(col){
  if(canEditDiv(state.divKey)) return true;
  return state.role==="purchasing" && lc(col.assigned_email)===lc(state.email);
}

/* ---------------- auth ---------------- */
function authMsg(t,k){ const m=$("authMsg"); m.className="msg "+(k||"info"); m.textContent=t; }
function clearAuth(){ const m=$("authMsg"); m.className="msg"; m.textContent=""; }
function prettyErr(e, fallback){
  console.error("Auth error:", e);
  let msg=(e && (e.message||e.error_description||e.msg))||"";
  if(!msg || msg==="{}" || msg==="[object Object]") return fallback+" (Check Supabase SMTP + email templates — see SETUP.md.)";
  if(/not authorized|sending|smtp|confirmation email/i.test(msg)) msg+=" (Check the SMTP settings + verified sender in Supabase.)";
  return msg;
}
if(DEMO){ $("demoPill").classList.remove("hidden"); }

$("sendBtn").addEventListener("click", sendCode);
$("email").addEventListener("keydown", e=>{ if(e.key==="Enter") sendCode(); });
$("verifyBtn").addEventListener("click", verifyCode);
$("code").addEventListener("keydown", e=>{ if(e.key==="Enter") verifyCode(); });
$("backBtn").addEventListener("click", ()=>{ $("stepCode").classList.add("hidden"); $("stepEmail").classList.remove("hidden"); clearAuth(); });

function otpHistory(){ try{ return JSON.parse(localStorage.getItem("tf_otp_sends")||"[]"); }catch(e){ return []; } }
function otpRecord(){ const h=otpHistory(); h.push(Date.now()); try{ localStorage.setItem("tf_otp_sends",JSON.stringify(h.slice(-50))); }catch(e){} }
function otpThrottle(){
  if(DEMO) return null;   // no cooldown in demo/test mode; limits still apply once Supabase is connected
  const L=CFG.OTP_LIMITS||{}, now=Date.now(), h=otpHistory();
  if(L.cooldownSec && h.length && now-h[h.length-1] < L.cooldownSec*1000) return `Please wait ${Math.ceil((L.cooldownSec*1000-(now-h[h.length-1]))/1000)}s before requesting another code.`;
  if(L.perHour && h.filter(t=>now-t<3600e3).length>=L.perHour) return "Too many code requests this hour. Try again later.";
  if(L.perDay  && h.filter(t=>now-t<864e5).length>=L.perDay)   return "Daily code-request limit reached.";
  return null;
}

async function sendCode(){
  const email = lc($("email").value);
  if(!email || !email.endsWith(CFG.ALLOWED_DOMAIN)) return authMsg("Use your "+CFG.ALLOWED_DOMAIN+" email address.","err");
  const t=otpThrottle(); if(t) return authMsg(t,"err");
  $("sendBtn").disabled=true;
  try{
    if(DEMO){ authMsg("DEMO mode — enter code "+CFG.DEMO_CODE+".","info"); }
    else{
      const { error } = await sb.auth.signInWithOtp({ email, options:{ shouldCreateUser:true } });
      if(error) throw error;
      authMsg("Code sent. Check your inbox.","ok");
    }
    otpRecord();
    state.email=email; $("sentTo").textContent=email;
    $("stepEmail").classList.add("hidden"); $("stepCode").classList.remove("hidden"); $("code").focus();
  }catch(e){ authMsg(prettyErr(e,"Couldn't send the code."),"err"); }
  finally{ $("sendBtn").disabled=false; }
}

async function verifyCode(){
  const code=$("code").value.trim();
  if(!code) return authMsg("Enter the code from your email.","err");
  $("verifyBtn").disabled=true;
  try{
    if(DEMO){
      if(code!==CFG.DEMO_CODE) throw new Error("Incorrect demo code.");
    }else{
      const { error } = await sb.auth.verifyOtp({ email:state.email, token:code, type:"email" });
      if(error) throw error;
    }
    await onSignedIn(state.email);
  }catch(e){ authMsg(prettyErr(e,"Couldn't verify the code."),"err"); }
  finally{ $("verifyBtn").disabled=false; }
}

async function onSignedIn(email){
  state.email=lc(email);
  // resolve role: Supabase tf_app_roles is authoritative; config is the fallback/seed
  let resolved=resolveRoleFromConfig(state.email);
  if(!DEMO){
    try{
      const { data } = await sb.from("tf_app_roles").select("role,divisions").eq("email",state.email).maybeSingle();
      if(data && data.role) resolved={ role:data.role, divisions:data.divisions||[] };
    }catch(e){ console.warn("role lookup failed, using config fallback",e); }
  }
  state.role=resolved.role; state.roleDivs=resolved.divisions||[];
  bootApp();
}

/* restore an existing Supabase session on reload */
async function tryRestore(){
  if(DEMO || !sb) return;
  try{ const { data } = await sb.auth.getSession(); if(data && data.session && data.session.user) await onSignedIn(data.session.user.email); }catch(e){}
}

/* --------------- data layer --------------- */
async function loadDivision(div){
  if(DEMO){
    await ensureSeed();
    state.flow    = MEM.flow_rows.filter(r=>r.division===div).sort(bySort);
    state.cols    = MEM.pending_budget_cols.filter(c=>c.division===div).sort(bySort);
    state.changes = MEM.takeoff_changes.filter(c=>c.division===div).sort((a,b)=>(b.req_date||"").localeCompare(a.req_date||""));
    state.checks  = keyChecks(MEM.pending_budget_checks);
    state.status  = keyStatus(MEM.pending_budget_status);
    return;
  }
  const [flow, cols, checks, status, changes] = await Promise.all([
    sbAll(()=>sb.from("flow_rows").select("*").eq("division",div)),
    sbAll(()=>sb.from("pending_budget_cols").select("*").eq("division",div)),
    sbAll(()=>sb.from("pending_budget_checks").select("*")),
    sbAll(()=>sb.from("pending_budget_status").select("*")),
    sbAll(()=>sb.from("takeoff_changes").select("*").eq("division",div))
  ]);
  state.flow    = flow.sort(bySort);
  state.cols    = cols.sort(bySort);
  state.changes = changes.sort((a,b)=>(b.req_date||"").localeCompare(a.req_date||""));
  const ids=new Set(state.flow.map(r=>r.id));
  state.checks  = keyChecks(checks.filter(c=>ids.has(c.flow_id)));
  state.status  = keyStatus(status.filter(s=>ids.has(s.flow_id)));
}
/* Supabase caps a single request at 1000 rows — page through with .range() to get all.
   Pass a factory so each page gets a fresh query builder. */
async function sbAll(makeQuery){
  const PAGE=1000; let from=0, out=[];
  for(;;){
    const { data, error } = await makeQuery().range(from, from+PAGE-1);
    if(error){ console.error("load error:", error); break; }
    out = out.concat(data||[]);
    if(!data || data.length<PAGE) break;
    from += PAGE;
  }
  return out;
}
const bySort = (a,b)=>(a.sort_order||0)-(b.sort_order||0) || String(a.community_name||a.name||"").localeCompare(String(b.community_name||b.name||""));
function keyChecks(rows){ const o={}; rows.forEach(r=>o[r.flow_id+"::"+r.col_id]=!!r.checked); return o; }
function keyStatus(rows){ const o={}; rows.forEach(r=>o[r.flow_id]={sim_reviewed:!!r.sim_reviewed, sent_to_loc:!!r.sent_to_loc}); return o; }

async function saveRow(table, row){
  row.updated_at=new Date().toISOString(); row.updated_by=state.email;
  if(DEMO){ const arr=MEM[table]; const i=arr.findIndex(x=>x.id===row.id); if(i>=0) arr[i]=row; else arr.push(row); return; }
  const { error } = await sb.from(table).upsert(row); if(error){ console.error(error); toast("Save failed: "+error.message,"err"); }
}
/* ---- field-level saves (conflict protection) ----
   The app has no live sync, so a full-row upsert would silently overwrite any column
   another person changed since we loaded. saveField writes ONE column and guards it
   with a compare-and-set on that column's prior value: it never clobbers a different
   field, and it detects (rather than overwrites) a change to the SAME cell — returning
   the current value so the UI can show the latest instead of losing someone's edit.
   savePatch writes a few columns at once (no guard, low-stakes toggles) but still
   leaves every other column untouched. */
function sameVal(a,b){ return a===b || (a==null&&b==null) || String(a??"")===String(b??""); }
async function saveField(table, id, field, newVal, oldVal){
  const meta={ updated_at:new Date().toISOString(), updated_by:state.email };
  if(DEMO){ const row=(MEM[table]||[]).find(x=>x.id===id); if(row) Object.assign(row,{[field]:newVal},meta); return {ok:true}; }
  let q=sb.from(table).update({[field]:newVal, ...meta}).eq("id",id);
  q = (oldVal==null) ? q.is(field,null) : q.eq(field,oldVal);
  const { data, error } = await q.select();
  if(error){
    // guard filter can choke on unusual text values — fall back to a plain field-level
    // write so the save still succeeds (and still won't clobber other columns).
    const { error:e2 } = await sb.from(table).update({[field]:newVal, ...meta}).eq("id",id);
    if(e2){ console.error(e2); toast("Save failed: "+e2.message,"err"); return {ok:false, current:oldVal}; }
    return {ok:true};
  }
  if(data && data.length===1) return {ok:true};
  // 0 rows changed → the cell moved under us, or it already holds the value we wanted
  const { data:fresh } = await sb.from(table).select(field+",updated_by").eq("id",id).maybeSingle();
  const current = fresh ? fresh[field] : oldVal;
  if(sameVal(current,newVal)) return {ok:true};
  const who = (fresh&&fresh.updated_by) ? " by "+String(fresh.updated_by).split("@")[0] : "";
  toast("Not saved — this cell was just changed"+who+". Showing the latest value; re-enter your change to keep it.","err");
  return {ok:false, current};
}
async function savePatch(table, id, patch){
  const body={ ...patch, updated_at:new Date().toISOString(), updated_by:state.email };
  if(DEMO){ const row=(MEM[table]||[]).find(x=>x.id===id); if(row) Object.assign(row,body); return; }
  const { error } = await sb.from(table).update(body).eq("id",id); if(error){ console.error(error); toast("Save failed: "+error.message,"err"); }
}
async function deleteRow(table, id){
  if(DEMO){ MEM[table]=MEM[table].filter(x=>x.id!==id); return; }
  const { error } = await sb.from(table).delete().eq("id",id); if(error){ console.error(error); toast("Delete failed: "+error.message,"err"); }
}
async function saveCheck(flow_id, col_id, checked){
  const row={ flow_id, col_id, checked, updated_by:state.email, updated_at:new Date().toISOString() };
  if(DEMO){ const a=MEM.pending_budget_checks; const i=a.findIndex(x=>x.flow_id===flow_id&&x.col_id===col_id); if(i>=0)a[i]=row; else a.push(row); return; }
  const { error } = await sb.from("pending_budget_checks").upsert(row,{ onConflict:"flow_id,col_id" }); if(error) toast("Save failed: "+error.message,"err");
}
async function saveStatus(flow_id, patch){
  const cur=state.status[flow_id]||{sim_reviewed:false,sent_to_loc:false};
  const row={ flow_id, sim_reviewed:cur.sim_reviewed, sent_to_loc:cur.sent_to_loc, ...patch, updated_by:state.email, updated_at:new Date().toISOString() };
  state.status[flow_id]={sim_reviewed:row.sim_reviewed, sent_to_loc:row.sent_to_loc};
  if(DEMO){ const a=MEM.pending_budget_status; const i=a.findIndex(x=>x.flow_id===flow_id); if(i>=0)a[i]=row; else a.push(row); return; }
  const { error } = await sb.from("pending_budget_status").upsert(row,{ onConflict:"flow_id" }); if(error) toast("Save failed: "+error.message,"err");
}

function toast(msg,kind){ const b=$("banner"); if(!b) return; b.innerHTML=`<b>${esc(msg)}</b>`; b.style.color=kind==="err"?"var(--bad)":""; setTimeout(()=>{ setBanner(); },4000); }

/* ---------------- app boot ---------------- */
function bootApp(){
  $("auth").classList.add("hidden"); $("app").classList.remove("hidden");
  if(DEMO) $("appDemoPill").classList.remove("hidden");
  $("userChip").innerHTML=esc(state.email)+`<span class="role-tag">${esc(state.role)}</span>`;
  $("themeBtn").textContent=document.documentElement.getAttribute("data-theme")==="dark"?"Light":"Dark";
  if(canEditDiv("__any__")||isAdmin()||state.role==="editor") $("adminLink").classList.remove("hidden");
  // division dropdown
  const sel=$("divisionSel"); sel.innerHTML="";
  CFG.DIVISIONS.forEach(d=>{ const o=document.createElement("option"); o.value=d.key; o.textContent=d.label; sel.appendChild(o); });
  state.divKey = DEMO ? "orlando" : CFG.DIVISIONS[0].key;
  applyPrefs();                    // restore last division, tab, sorts, and column filters
  sel.value=state.divKey;
  document.querySelectorAll(".tab").forEach(t=>t.classList.toggle("active", t.dataset.view===state.view));
  sel.onchange=async()=>{ state.divKey=sel.value; await loadDivision(state.divKey); render(); };
  // tabs
  document.querySelectorAll(".tab").forEach(t=>t.onclick=()=>{ document.querySelectorAll(".tab").forEach(x=>x.classList.remove("active")); t.classList.add("active"); state.view=t.dataset.view; state.filter=""; $("globalSearch").value=""; render(); });
  // topbar buttons
  $("homeLogo").onclick=()=>showDash();
  $("dashLink").onclick=()=>showDash();
  $("adminLink").onclick=()=>showAdmin();
  $("themeBtn").onclick=toggleTheme;
  $("whatsNewBtn").onclick=openWhatsNew;
  $("logoutBtn").onclick=async()=>{ if(!DEMO&&sb) await sb.auth.signOut(); location.reload(); };
  $("globalSearch").oninput=e=>{ state.filter=lc(e.target.value); render(); };
  loadPlanNames().then(()=>loadDivision(state.divKey)).then(()=>{ render(); refreshWhatsNewBadge(); startRealtime(); });
}
function showDash(){ $("admin").classList.add("hidden"); $("dashboard").classList.remove("hidden"); $("dashLink").classList.add("hidden"); if($("adminLink").classList.contains("hidden")===false){} render(); }
function setBanner(){
  const b=$("banner"); if(!b) return;
  const div=(CFG.DIVISIONS.find(d=>d.key===state.divKey)||{}).label||state.divKey;
  b.style.color="";
  const pend=state.changes.filter(c=>!c.complete).length;
  const outstanding=todoOutstanding().length;
  const notSentLoc=state.flow.filter(r=>!((state.status[r.id]||{}).sent_to_loc)).length;
  b.innerHTML=`<b>${esc(div)}</b> · ${state.flow.length} flow row(s) · ${pend} pending change request(s) · ${outstanding} outstanding on to-do · ${notSentLoc} not sent to LOC`;
}

/* ---------------- render router ---------------- */
function render(){
  setBanner();
  const tb=$("viewToolbar"), area=$("viewArea");
  const sc=[...area.querySelectorAll(".grid-wrap")].map(el=>[el.scrollLeft,el.scrollTop]);  // preserve scroll across re-render
  if(state.view==="flow")         renderFlow(tb,area);
  else if(state.view==="budgets") renderBudgets(tb,area);
  else if(state.view==="changes") renderChanges(tb,area);
  else if(state.view==="todo")    renderTodo(tb,area);
  area.querySelectorAll(".grid-wrap").forEach((el,i)=>{ if(sc[i]){ el.scrollLeft=sc[i][0]; el.scrollTop=sc[i][1]; } });
  tb.querySelectorAll("[data-export]").forEach(b=>b.onclick=exportCSV);
  savePrefs();   // remember division, tab, sorts, and column filters for next visit
}
function matchFilter(str){ return !state.filter || lc(str).includes(state.filter); }

/* ===================================================================
   TAB 1 · FLOW OF TAKEOFFS  (editable grid + WORKDAY date engine)
   =================================================================== */
const FLOW_COLS = [
  {f:"community_name", h:"Community Name", type:"text"},
  {f:"community_num",  h:"Community #",    type:"text"},
  {f:"plan",           h:"Plan",           type:"text"},
  {f:"plan_name",      h:"Plan Name",      type:"text", get:planName},
  {f:"elevation",      h:"Elevation",      type:"text"},
  {f:"cis_due",        h:"CIS Due",        type:"date", calc:true},
  {f:"master_tp_due",  h:"Master TP List Due", type:"date", calc:true},
  {f:"estimate_eta",   h:"Estimate Done ETA",  type:"date", calc:true},
  {f:"released",       h:"Released",       type:"date"},
  {f:"pricing_stage",  h:"Pricing Stage",  type:"date", calc:true},
  {f:"loc_upload",     h:"LOC Upload",     type:"date", calc:true},
  {f:"tasks_start",    h:"Tasks Start",    type:"date", calc:true},
  {f:"first_trench_date", h:"First Trench Date", type:"date"},
  {f:"notes",          h:"Notes",          type:"text", long:true}
];
function flowRows(){
  return state.flow.filter(r=>matchFilter([r.community_name,r.community_num,r.plan,r.elevation,r.notes,r.mike_notes,r.marlo_notes].join(" ")));
}
function renderFlow(tb,area){
  const canEd=canEditDiv(state.divKey);
  const cols=descFromCols(FLOW_COLS);
  const rows=sortView(passFilters(flowRows(),cols),cols);
  tb.innerHTML=`<span class="count">${rows.length} row(s)</span>`
    + (canEd?`<button class="btn mini" id="addFlow">+ Add row</button>
       <button class="btn mini ghost" id="importBtn">Import Start Schedule…</button>`:"")
    + `<button class="btn mini ghost" data-export>&#8681; Export CSV</button>`
    + `<span class="grow"></span>`
    + `<span class="section-note" style="margin:0">Works like Excel: click to select, drag or Shift-click for a range; double-click, Enter, or just type to edit; Ctrl+D fill down, Ctrl+R fill right, Ctrl+C/Ctrl+V copy/paste, Delete to clear, or drag the corner handle. Blue columns auto-calculate.</span>`;
  let h=`<div class="grid-wrap"><table class="grid"><thead>${theadHTML(cols,canEd)}</thead><tbody>`;
  if(!rows.length) h+=`<tr><td colspan="${FLOW_COLS.length+(canEd?1:0)}"><div class="empty">No rows yet. ${canEd?"Add a row or import the Start Schedule.":""}</div></td></tr>`;
  rows.forEach(r=>{
    h+=`<tr>`;
    if(canEd) h+=`<td class="rowhandle"><button class="delrow" data-del="${r.id}" title="Delete row">×</button></td>`;
    FLOW_COLS.forEach(c=>{
      if(c.calc){
        const ov=isOverride(r,c.f), val=effective(r,c.f);
        const tt=ov?' title="Manual override — click and clear to reset to auto"':'';
        h+=`<td class="calc ${ov?'overridden':''}"${tt}><span class="cell ${canEd?'editable':''} ${val?'':'empty'}" data-id="${r.id}" data-field="${c.f}" data-type="date"><span class="val">${esc(fmtDate(val))}</span></span></td>`;
      }else if(c.get){
        const disp=c.get(r)||"";
        h+=cellHTML(r.id,c,disp,disp,canEd);   // editable; saving stores an override in r[c.f]
      }else{
        const raw=r[c.f], disp=c.type==="date"?fmtDate(raw):(raw==null?"":String(raw));
        h+=cellHTML(r.id,c,disp,raw,canEd);
      }
    });
    h+=`</tr>`;
  });
  h+=`</tbody></table></div>`;
  area.innerHTML=h;
  bindGrid(area, saveFlowCell);
  bindHeader(area, cols, flowRows());
  if(canEd){
    $("addFlow").onclick=async()=>{ const r={ id:uid(), division:state.divKey, sort_order:(state.flow.at(-1)?.sort_order||0)+1 }; state.flow.push(r); await saveRow("flow_rows",r); render(); };
    $("importBtn").onclick=showAdmin;
    area.querySelectorAll("[data-del]").forEach(b=>b.onclick=async()=>{ if(!confirm("Delete this row?"))return; const id=b.dataset.del; await deleteRow("flow_rows",id); state.flow=state.flow.filter(x=>x.id!==id); render(); });
  }
}
async function saveFlowCell(id, field, type, value){
  const r=state.flow.find(x=>x.id===id); if(!r) return;
  if(field==="plan_name"){ await setPlanName(r, value); return; }   // maps to tf_plan_names, not a per-row value
  const oldVal = r[field]===undefined?null:r[field];
  const newVal = value===""?null:value;
  r[field]=newVal;
  const res = await saveField("flow_rows", id, field, newVal, oldVal);
  if(res && res.ok===false && "current" in res) r[field]=res.current; // show the latest on conflict
  render(); // recompute dependent calc columns
}
/* Set/rename a plan's name. Updates the tf_plan_names lookup (so every row in that
   division with the plan number reflects it), and keeps same-named plans in OTHER
   divisions in sync when renaming. Clearing the name removes the mapping. */
async function setPlanName(row, rawName){
  const div=row.division, planNo=String(row.plan==null?"":row.plan).trim().toUpperCase();
  if(!planNo){ render(); return; }
  const name=(rawName==null?"":String(rawName)).trim();
  state.planNames=state.planNames||{};
  const map=state.planNames[div]=state.planNames[div]||{};
  const oldName=map[planNo]||"";
  if(!name){                                   // clear mapping for this division + plan
    delete map[planNo];
    if(!DEMO){ try{ await sb.from("tf_plan_names").delete().eq("division",div).eq("plan_no",planNo); }catch(e){ console.warn(e); } }
    render(); return;
  }
  map[planNo]=name;
  const upserts=[{division:div, plan_no:planNo, name}];
  if(oldName && lc(oldName)!==lc(name)){       // rename → keep same-named plans in other divisions in sync
    for(const d in state.planNames){ if(d===div) continue;
      const m=state.planNames[d];
      for(const pn in m){ if(lc(m[pn])===lc(oldName)){ m[pn]=name; upserts.push({division:d, plan_no:pn, name}); } }
    }
  }
  if(!DEMO){ try{ await sb.from("tf_plan_names").upsert(upserts,{onConflict:"division,plan_no"}); }catch(e){ console.warn("plan name save failed",e); } }
  render();
}

/* ===================================================================
   TAB 2 · PENDING BUDGETS  (auto-mirror flow rows + per-email checkbox cols)
   =================================================================== */
function renderBudgets(tb,area){
  const canMng=canManageCols(state.divKey), canEd=canEditDiv(state.divKey);
  tb.innerHTML=`<span class="count">${flowRows().length} row(s) · ${state.cols.length} cost managers(s)</span>`
    + (canMng?`<button class="btn mini" id="addCol">+Cost Manager</button>`:"")
    + `<button class="btn mini ghost" data-export>&#8681; Export CSV</button>`
    + `<span class="grow"></span>`
    + `<span class="section-note" style="margin:0">Rows mirror Flow of Takeoffs. ${state.role==="purchasing"?"You can tick the column(s) assigned to you.":""}</span>`;
  if(canMng && !state.cols.length){
    tb.innerHTML+=`<button class="btn mini ghost" id="seedCols">Add standard cost manager</button>`;
  }
  const cols=budgetCols();
  const rows=sortView(passFilters(flowRows(),cols),cols);
  const s=getSort(), cf=colFilterMap();
  let h=`<div class="grid-wrap"><table class="grid"><thead><tr>`;
  cols.forEach(col=>{
    const on=s&&s.field===col.f, ind=on?(s.dir===1?"▲":"▼"):"";
    let extra="", title="";
    if(col.person){ const c=col.person;
      title=c.assigned_email?` title="Assigned to ${esc(c.assigned_email)}"`:` title="Unassigned — no one can tick this column yet"`;
      extra=canMng?`<span class="colhead-tools"><button data-editcol="${c.id}" title="Edit column">&#9998;</button><button data-delcol="${c.id}" title="Remove column">&times;</button></span>`
                  :(c.assigned_email?"":`<span class="colhead-flag">unassigned</span>`); }
    h+=`<th${title} class="${col.cls||""} sorth" data-sort="${col.f}">${esc(col.h)}${col.calc?'<span class="calc-badge">auto</span>':""}<span class="sort-ind">${ind}</span>${extra}</th>`;
  });
  h+=`</tr><tr class="filterrow">`;
  cols.forEach(col=>h+=filterCellHTML(col));
  h+=`</tr></thead><tbody>`;
  const spanN=4+state.cols.length+6;
  if(!rows.length) h+=`<tr><td colspan="${spanN}"><div class="empty">No rows. Add rows on the Flow of Takeoffs tab.</div></td></tr>`;
  rows.forEach(r=>{
    const st=state.status[r.id]||{sim_reviewed:false,sent_to_loc:false};
    h+=`<tr><td><span class="cell"><span class="val">${esc(r.community_name||'')}</span></span></td>`
      + `<td><span class="cell"><span class="val">${esc(r.plan||'')}</span></span></td>`
      + `<td><span class="cell"><span class="val">${esc(planName(r))}</span></span></td>`
      + `<td><span class="cell"><span class="val">${esc(r.elevation||'')}</span></span></td>`
      + `<td class="calc"><span class="cell"><span class="val">${esc(fmtDate(effective(r,"released")))}</span></span></td>`;
    state.cols.forEach(c=>{
      const on=!!state.checks[r.id+"::"+c.id], allow=canToggleCheck(c);
      h+=`<td class="chkcell"><input type="checkbox" class="chk" data-chk="${r.id}" data-col="${c.id}" ${on?"checked":""} ${allow?"":"disabled"}></td>`;
    });
    h+=`<td class="chkcell"><input type="checkbox" class="chk" data-st="${r.id}" data-k="sim_reviewed" ${st.sim_reviewed?"checked":""} ${canEd?"":"disabled"}></td>`
      + `<td class="chkcell"><input type="checkbox" class="chk" data-st="${r.id}" data-k="sent_to_loc" ${st.sent_to_loc?"checked":""} ${canEd?"":"disabled"}></td>`
      + `<td class="calc"><span class="cell"><span class="val">${esc(fmtDate(workday(r.first_trench_date,-30,true)))}</span></span></td>`
      + `<td class="calc"><span class="cell"><span class="val">${esc(fmtDate(effective(r,"loc_upload")))}</span></span></td>`
      + `<td class="calc"><span class="cell"><span class="val">${esc(fmtDate(effective(r,"tasks_start")))}</span></span></td>`
      + `<td class="calc"><span class="cell"><span class="val">${esc(fmtDate(r.first_trench_date))}</span></span></td></tr>`;
  });
  h+=`</tbody></table></div>`;
  area.innerHTML=h;
  bindHeader(area, cols, flowRows());
  area.querySelectorAll("[data-chk]").forEach(cb=>cb.onchange=async()=>{ const fid=cb.dataset.chk, cid=cb.dataset.col; state.checks[fid+"::"+cid]=cb.checked; await saveCheck(fid,cid,cb.checked); });
  area.querySelectorAll("[data-st]").forEach(cb=>cb.onchange=async()=>{ await saveStatus(cb.dataset.st,{[cb.dataset.k]:cb.checked}); });
  if(canMng){
    const add=$("addCol"); if(add) add.onclick=()=>openColModal(null);
    const seed=$("seedCols"); if(seed) seed.onclick=seedDefaultCols;
    area.querySelectorAll("[data-editcol]").forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); openColModal(state.cols.find(c=>c.id===b.dataset.editcol)); });
    area.querySelectorAll("[data-delcol]").forEach(b=>b.onclick=async(e)=>{ e.stopPropagation(); const c=state.cols.find(x=>x.id===b.dataset.delcol); if(c&&confirm(`Remove column "${c.name}"?`)){ await deleteRow("pending_budget_cols",c.id); state.cols=state.cols.filter(x=>x.id!==c.id); render(); } });
  }
}
function budgetCols(){
  const list=[
    {f:"community_name",h:"Community",disp:r=>r.community_name||"",raw:r=>r.community_name||""},
    {f:"plan",h:"Plan",disp:r=>r.plan||"",raw:r=>r.plan||""},
    {f:"plan_name",h:"Plan Name",disp:r=>planName(r),raw:r=>planName(r)},
    {f:"elevation",h:"Elev",disp:r=>r.elevation||"",raw:r=>r.elevation||""},
    {f:"released",h:"Estimating Release",cls:"calc",calc:true,disp:r=>fmtDate(effective(r,"released")),raw:r=>effective(r,"released")||""}
  ];
  state.cols.forEach(c=>list.push({f:"c_"+c.id,h:c.name,person:c,disp:r=>state.checks[r.id+"::"+c.id]?"Yes":"No",raw:r=>state.checks[r.id+"::"+c.id]?1:0}));
  list.push(
    {f:"sim",h:"SIM Reviewed",disp:r=>(state.status[r.id]||{}).sim_reviewed?"Yes":"No",raw:r=>(state.status[r.id]||{}).sim_reviewed?1:0},
    {f:"sent",h:"Sent to LOC",disp:r=>(state.status[r.id]||{}).sent_to_loc?"Yes":"No",raw:r=>(state.status[r.id]||{}).sent_to_loc?1:0},
    {f:"pricing_due",h:"Pricing Due",cls:"calc",calc:true,disp:r=>fmtDate(workday(r.first_trench_date,-30,true)),raw:r=>workday(r.first_trench_date,-30,true)||""},
    {f:"loc_upload",h:"LOC Upload",cls:"calc",calc:true,disp:r=>fmtDate(effective(r,"loc_upload")),raw:r=>effective(r,"loc_upload")||""},
    {f:"tasks_start",h:"Tasks Start",cls:"calc",calc:true,disp:r=>fmtDate(effective(r,"tasks_start")),raw:r=>effective(r,"tasks_start")||""},
    {f:"trench",h:"Trench Date",cls:"calc",calc:true,disp:r=>fmtDate(r.first_trench_date),raw:r=>r.first_trench_date||""}
  );
  return list;
}
/* modal editor for a Pending-Budgets person column (no browser prompts) */
function openColModal(col){
  const isNew=!col;
  document.querySelectorAll(".modal-ov").forEach(m=>m.remove());
  const ov=document.createElement("div"); ov.className="modal-ov";
  ov.innerHTML=`<div class="modal-card" style="max-width:440px">
    <div class="modal-h">${isNew?"Add Cost Manager":"Edit column"}<button class="linkbtn" data-x aria-label="Close">&times;</button></div>
    <div class="modal-body">
      <label class="fld" for="mcName">Display name</label>
      <input type="text" id="mcName" value="${esc(col?col.name:"")}" placeholder="e.g. Jennifer">
      <label class="fld" for="mcEmail" style="margin-top:14px">Assigned user
        <span style="font-weight:400;color:var(--muted)">— only this purchasing user can tick this column (leave blank for editors only)</span></label>
      <input type="email" id="mcEmail" value="${esc(col&&col.assigned_email?col.assigned_email:"")}" placeholder="name@lennar.com">
      ${state.users&&state.users.length?`<datalist id="mcUsers">${state.users.map(u=>`<option value="${esc(u.email)}">`).join("")}</datalist>`:""}
      <div id="mcMsg" class="msg"></div>
      <div class="modal-actions">
        <button class="btn" id="mcSave">${isNew?"Add column":"Save changes"}</button>
        <button class="btn ghost" id="mcCancel">Cancel</button>
        ${isNew?"":`<button class="btn danger" id="mcDel">Delete column</button>`}
      </div>
    </div></div>`;
  document.body.appendChild(ov);
  const emailInp=ov.querySelector("#mcEmail"); if(state.users&&state.users.length) emailInp.setAttribute("list","mcUsers");
  const close=()=>ov.remove();
  const mcmsg=t=>{ const m=ov.querySelector("#mcMsg"); m.className="msg err"; m.textContent=t; };
  ov.addEventListener("click",e=>{ if(e.target===ov) close(); });
  document.addEventListener("keydown",function esc2(e){ if(e.key==="Escape"){ close(); document.removeEventListener("keydown",esc2);} });
  ov.querySelector("[data-x]").onclick=close;
  ov.querySelector("#mcCancel").onclick=close;
  ov.querySelector("#mcName").focus();
  ov.querySelector("#mcSave").onclick=async()=>{
    const name=ov.querySelector("#mcName").value.trim();
    const email=lc(emailInp.value);
    if(!name) return mcmsg("Enter a display name.");
    if(email && !email.endsWith(CFG.ALLOWED_DOMAIN)) return mcmsg("Email must be a "+CFG.ALLOWED_DOMAIN+" address.");
    const row = col || { id:uid(), division:state.divKey, sort_order:(state.cols.at(-1)?.sort_order||0)+1 };
    row.name=name; row.assigned_email=email||null;
    if(isNew) state.cols.push(row);
    await saveRow("pending_budget_cols", row); close(); render();
  };
  if(!isNew) ov.querySelector("#mcDel").onclick=async()=>{
    if(!confirm(`Remove column "${col.name}"? Existing ticks in this column are cleared.`)) return;
    await deleteRow("pending_budget_cols", col.id); state.cols=state.cols.filter(x=>x.id!==col.id); close(); render();
  };
}
async function seedDefaultCols(){
  let n=(state.cols.at(-1)?.sort_order||0);
  for(const nm of (CFG.DEFAULT_BUDGET_COLUMNS||[])){ const row={ id:uid(), division:state.divKey, name:nm, assigned_email:null, sort_order:++n }; state.cols.push(row); await saveRow("pending_budget_cols",row); }
  render();
}

/* ===================================================================
   TAB 3 · TAKEOFF CHANGES  (log; Purchasing can add rows)
   =================================================================== */
const CHG_COLS=[
  {f:"req_date",h:"Date",type:"date",noedit:true,cellClass:"tc-center"},
  {f:"requestor",h:"Requestor",type:"text"},
  {f:"community",h:"Community",type:"text"},
  {f:"plan",h:"Plan",type:"text"},
  {f:"elev",h:"Elev",type:"text"},
  {f:"urgent",h:"Urgent",type:"check"},
  {f:"request",h:"Request",type:"text",long:true},
  {f:"estimator",h:"Estimator",type:"text",placeholder:"[Unassigned]"},
  {f:"complete",h:"Complete",type:"check"},
  {f:"completed_date",h:"Completed",type:"date",noedit:true,cellClass:"tc-center tc-narrow"},
  {f:"estimator_notes",h:"Estimator Notes",type:"text",long:true}
];
function chgRows(){ return state.changes.filter(c=>matchFilter([c.requestor,c.community,c.plan,c.request,c.estimator,c.estimator_notes].join(" "))); }
function canEditChange(c){
  if(canEditDiv(state.divKey)) return true;
  return state.role==="purchasing" && lc(c.created_by)===lc(state.email) && !c.complete;
}
function renderChanges(tb,area){
  const canAdd=canAddChange(state.divKey);
  const cols=descFromCols(CHG_COLS);
  const rows=sortView(passFilters(chgRows(),cols),cols);
  const pending=rows.filter(r=>!r.complete).length;
  tb.innerHTML=`<span class="count">${pending} pending change requests</span>`
    + (canAdd?`<button class="btn mini" id="addChg">+ Add change request</button>`:"")
    + `<button class="btn mini ghost" data-export>&#8681; Export CSV</button>`
    + `<span class="grow"></span>`;
  let h=`<div class="grid-wrap"><table class="grid"><thead>${theadHTML(cols,true)}</thead><tbody>`;
  if(!rows.length) h+=`<tr><td colspan="${CHG_COLS.length+1}"><div class="empty">No change requests yet.</div></td></tr>`;
  rows.forEach(r=>{
    const canEd=canEditChange(r);
    h+=`<tr class="${r.urgent?'urgent-row':''}"><td class="rowhandle">${canEd?`<button class="delrow" data-delchg="${r.id}" title="Delete">×</button>`:""}</td>`;
    CHG_COLS.forEach(c=>{
      if(c.type==="check"){
        const on=!!r[c.f]; const cls=c.f==="urgent"?"urgent":"done";
        // urgent editable by requestor/editor; complete only by editor
        const allow = c.f==="complete" ? canEditDiv(state.divKey) : canEd;
        h+=`<td class="chkcell"><input type="checkbox" class="chk" data-chgchk="${r.id}" data-f="${c.f}" ${on?"checked":""} ${allow?"":"disabled"}></td>`;
      }else{
        const rawv=r[c.f];
        const disp=c.type==="date"?fmtDate(rawv):(rawv==null?"":String(rawv));
        // estimator + estimator_notes are editor-only fields
        const editorOnly=["estimator","estimator_notes"].includes(c.f);
        const allow = c.noedit ? false : (editorOnly ? canEditDiv(state.divKey) : canEd);
        h+=cellHTML(r.id,c,disp,rawv,allow);
      }
    });
    h+=`</tr>`;
  });
  h+=`</tbody></table></div>`;
  area.innerHTML=h;
  bindGrid(area, saveChgCell);
  bindHeader(area, cols, chgRows());
  area.querySelectorAll("[data-chgchk]").forEach(cb=>cb.onchange=async()=>{ const r=state.changes.find(x=>x.id===cb.dataset.chgchk); if(!r)return; const f=cb.dataset.f; r[f]=cb.checked; const patch={[f]:cb.checked}; if(f==="complete"){ r.completed_date = cb.checked ? (r.completed_date||todayIso()) : null; patch.completed_date=r.completed_date; } await savePatch("takeoff_changes",r.id,patch); render(); });
  area.querySelectorAll("[data-delchg]").forEach(b=>b.onclick=async()=>{ if(!confirm("Delete this request?"))return; const id=b.dataset.delchg; await deleteRow("takeoff_changes",id); state.changes=state.changes.filter(x=>x.id!==id); render(); });
  const add=$("addChg"); if(add) add.onclick=async()=>{ const r={ id:uid(), division:state.divKey, req_date:todayIso(), requestor:state.email.split("@")[0], urgent:false, complete:false, created_by:state.email }; state.changes.unshift(r); await saveRow("takeoff_changes",r); render(); };
}
async function saveChgCell(id,field,type,value){
  const r=state.changes.find(x=>x.id===id); if(!r)return;
  const oldVal = r[field]===undefined?null:r[field];
  const newVal = value===""?null:value;
  r[field]=newVal;
  const res = await saveField("takeoff_changes", id, field, newVal, oldVal);
  if(res && res.ok===false && "current" in res) r[field]=res.current;
  render();
}

/* ===================================================================
   TAB 4 · TO-DO LIST  (auto-derived: upcoming trench dates)
   =================================================================== */
/* Mirrors the workbook's TO-DO LET formula: list every plan/elevation that is NOT
   yet completed on Flow of Takeoffs. "Completed" = a Flow row with a RELEASED date.
   So a row drops off automatically once its Released date is filled in. */
function todoOutstanding(){
  // community#|plan|elevation keys that ARE completed (have a Released date)
  const done=new Set();
  state.flow.forEach(r=>{ if(effective(r,"released")) done.add([lc(r.community_num),lc(r.plan),lc(r.elevation)].join("|")); });
  const seen=new Set(), out=[];
  state.flow.forEach(r=>{
    const key=[lc(r.community_num),lc(r.plan),lc(r.elevation)].join("|");
    if(done.has(key)) return;        // completed elsewhere → not outstanding
    if(seen.has(key)) return;        // unique, first occurrence only
    seen.add(key); out.push(r);
  });
  return out;
}
function renderTodo(tb,area){
  const cols=[
    {f:"community_name",h:"Community",disp:r=>r.community_name||"",raw:r=>r.community_name||""},
    {f:"community_num", h:"Comm #",   disp:r=>r.community_num||"", raw:r=>r.community_num||""},
    {f:"plan",          h:"Plan",     disp:r=>r.plan||"",          raw:r=>r.plan||""},
    {f:"elevation",     h:"Ele",      disp:r=>r.elevation||"",     raw:r=>r.elevation||""},
    {f:"first_trench_date",h:"Trench",disp:r=>fmtDate(r.first_trench_date),raw:r=>r.first_trench_date||""}
  ];
  const base=todoOutstanding().filter(r=>matchFilter([r.community_name,r.community_num,r.plan,r.elevation].join(" ")));
  const rows=sortView(passFilters(base,cols),cols);
  tb.innerHTML=`<span class="count">${rows.length} outstanding</span>`
    + `<button class="btn mini ghost" data-export>&#8681; Export CSV</button>`
    + `<span class="grow"></span>`
    + `<span class="section-note" style="margin:0">Plan/elevations from Flow of Takeoffs that are <b>not yet completed</b> (no Released date). Fill in Released on the Flow tab and the item clears itself.</span>`;
  let h=`<div class="grid-wrap"><table class="grid"><thead>${theadHTML(cols,false)}</thead><tbody>`;
  if(!rows.length) h+=`<tr><td colspan="5"><div class="empty">Nothing outstanding — every plan/elevation has a Released date.</div></td></tr>`;
  rows.forEach(r=>{ h+=`<tr>`+cols.map(c=>`<td><span class="cell"><span class="val">${esc(c.disp(r))}</span></span></td>`).join("")+`</tr>`; });
  h+=`</tbody></table></div>`;
  area.innerHTML=h;
  bindHeader(area, cols, base);
}

/* ---------------- sortable + filterable headers ---------------- */
/* Each grid passes a `cols` array of {f, h, cls, calc, sortable?, filterable?, raw(row), disp(row)}.
   raw() drives sorting (comparable value); disp() drives per-column text filtering. */
function colFilterMap(){ return state.colFilters[state.view] || (state.colFilters[state.view]={}); }
function getSort(){ return state.sort[state.view]||null; }
function toggleSort(f){ const s=getSort(); if(!s||s.field!==f) state.sort[state.view]={field:f,dir:1}; else if(s.dir===1) s.dir=-1; else delete state.sort[state.view]; render(); }
function cmpVal(a,b){
  a=a==null?"":a; b=b==null?"":b;
  if(a===""&&b==="")return 0; if(a==="")return 1; if(b==="")return -1;
  const nre=/^-?\d+(\.\d+)?$/;
  if(nre.test(String(a))&&nre.test(String(b))) return Number(a)-Number(b);
  return String(a).localeCompare(String(b));
}
/* colFilters[view][field] = Set of selected display values. Absent/empty Set = no filter (all). */
function passFilters(rows, cols){
  const cf=colFilterMap();
  const active=cols.filter(c=>c.filterable!==false && cf[c.f] instanceof Set && cf[c.f].size);
  if(!active.length) return rows;
  return rows.filter(r=>active.every(c=>{ let v=c.disp?c.disp(r):r[c.f]; v=(v==null||v==="")?"":String(v); return cf[c.f].has(v); }));
}
function sortView(rows, cols){
  const s=getSort(); if(!s) return rows; const c=cols.find(x=>x.f===s.field); if(!c) return rows;
  const val=c.raw||c.disp||(r=>r[c.f]);
  return rows.slice().sort((a,b)=>cmpVal(val(a),val(b))*s.dir);
}
function distinctVals(rows, col){
  const set=new Set();
  rows.forEach(r=>{ let v=col.disp?col.disp(r):r[col.f]; set.add((v==null||v==="")?"":String(v)); });
  return [...set].sort(cmpVal);
}
function mselLabel(col){
  const sel=colFilterMap()[col.f];
  if(!(sel instanceof Set) || !sel.size) return "All";
  if(sel.size===1){ const v=[...sel][0]; return v===""?"(blank)":v; }
  return sel.size+" selected";
}
function filterCellHTML(col){
  if(col.filterable===false) return "<th></th>";
  const active = colFilterMap()[col.f] instanceof Set;
  return `<th><div class="msel colmsel${active?" active":""}" data-col="${col.f}"><button type="button" class="msel-btn" data-mbtn>${esc(mselLabel(col))}</button><div class="msel-panel hidden" data-mpanel></div></div></th>`;
}
function theadHTML(cols, hasHandle){
  const s=getSort();
  let h="<tr>"; if(hasHandle) h+="<th></th>";
  cols.forEach(c=>{
    const on=s&&s.field===c.f, ind=on?(s.dir===1?"▲":"▼"):"";
    const sortable=c.sortable!==false;
    h+=`<th class="${c.cls||""} ${c.cellClass||""} ${sortable?"sorth":""}" ${sortable?`data-sort="${c.f}"`:""}>${esc(c.h)}${c.calc?'<span class="calc-badge">auto</span>':""}<span class="sort-ind">${ind}</span></th>`;
  });
  h+="</tr><tr class=\"filterrow\">"; if(hasHandle) h+="<th></th>";
  cols.forEach(c=>h+=filterCellHTML(c));
  return h+"</tr>";
}
/* ---- multi-select filter dropdown (msel), lazily built on open ---- */
let _openMsel=null, _openMselSearch="";
function visBoxes(w){ return [...w.querySelectorAll(".msel-opt")].filter(o=>o.style.display!=="none").map(o=>o.querySelector("input")); }
function applyMselSearch(w){ const q=(w.querySelector(".msel-search").value||"").trim().toLowerCase();
  w.querySelectorAll(".msel-opt").forEach(o=>{ o.style.display=(!q||o.textContent.toLowerCase().includes(q))?"":"none"; }); }
function buildMselPanel(w, col, baseRows){
  const panel=w.querySelector("[data-mpanel]");
  const sel=colFilterMap()[col.f];
  let opts=distinctVals(baseRows, col);
  if(opts.includes("")){ opts=opts.filter(v=>v!==""); opts.unshift(""); }   // blanks first for easy access
  const optHTML=opts.map(v=>{ const on=(!(sel instanceof Set)||sel.has(v))?"checked":""; const lbl=v===""?'<i class="msel-blank">(Blanks)</i>':esc(v);
    return `<label class="msel-opt${v===""?" msel-opt-blank":""}"><input type="checkbox" value="${esc(v)}" ${on}>${lbl}</label>`; }).join("");
  panel.innerHTML=`<input type="text" class="msel-search" placeholder="Search…">
    <div class="msel-actions"><button type="button" class="linkbtn" data-mall>Select all</button><button type="button" class="linkbtn" data-mnone>Unselect all</button></div>
    <div class="msel-list">${optHTML}</div>`;
}
function wireMselPanel(w, col){
  const panel=w.querySelector("[data-mpanel]");
  panel.addEventListener("click",e=>e.stopPropagation());
  const search=panel.querySelector(".msel-search");
  search.addEventListener("input",()=>{ _openMselSearch=search.value; applyMselSearch(w); });
  panel.querySelector("[data-mall]").addEventListener("click",()=>{ visBoxes(w).forEach(b=>b.checked=true); commitMsel(w,col); });
  panel.querySelector("[data-mnone]").addEventListener("click",()=>{ visBoxes(w).forEach(b=>b.checked=false); commitMsel(w,col); });
  panel.querySelectorAll(".msel-list input[type=checkbox]").forEach(b=>b.addEventListener("change",()=>commitMsel(w,col)));
}
let _mselDirty=false;
function applyMselIfDirty(){ if(_mselDirty){ _mselDirty=false; render(); } }
function commitMsel(w, col){
  // update the filter state live, but DON'T re-render yet — keep the dropdown open
  // so multiple boxes can be ticked. Filtering is applied when the panel closes.
  const boxes=[...w.querySelectorAll(".msel-list input[type=checkbox]")];
  const checked=boxes.filter(b=>b.checked).map(b=>b.value);
  if(checked.length===boxes.length) delete colFilterMap()[col.f];
  else colFilterMap()[col.f]=new Set(checked);
  const btn=w.querySelector("[data-mbtn]"); if(btn) btn.textContent=mselLabel(col);
  w.classList.toggle("active", colFilterMap()[col.f] instanceof Set);
  _mselDirty=true;
}
function positionMsel(w){
  const panel=w.querySelector("[data-mpanel]"), r=w.querySelector("[data-mbtn]").getBoundingClientRect();
  panel.style.position="fixed"; panel.style.top=(r.bottom+2)+"px";
  panel.style.left=Math.max(6, Math.min(r.left, window.innerWidth-346))+"px";
}
function bindHeader(container, cols, baseRows){
  const byField={}; (cols||[]).forEach(c=>byField[c.f]=c);
  container.querySelectorAll("th[data-sort]").forEach(th=>th.addEventListener("click",e=>{ if(e.target.closest(".colmsel")) return; toggleSort(th.dataset.sort); }));
  container.querySelectorAll(".colmsel").forEach(w=>{
    const col=byField[w.dataset.col]; if(!col) return;
    w.querySelector("[data-mbtn]").addEventListener("click",e=>{ e.stopPropagation();
      const panel=w.querySelector("[data-mpanel]"), wasHidden=panel.classList.contains("hidden");
      document.querySelectorAll(".colmsel [data-mpanel]").forEach(p=>{ if(p!==panel) p.classList.add("hidden"); });
      if(wasHidden){ buildMselPanel(w,col,baseRows); wireMselPanel(w,col); panel.classList.remove("hidden"); positionMsel(w); _openMsel=col.f; const s=panel.querySelector(".msel-search"); if(s) s.focus(); }
      else { panel.classList.add("hidden"); _openMsel=null; applyMselIfDirty(); }
    });
  });
  // close open filter panels when the grid is scrolled (panel is fixed-positioned)
  container.querySelectorAll(".grid-wrap").forEach(g=>g.addEventListener("scroll",()=>{ if(_openMsel){ document.querySelectorAll(".colmsel [data-mpanel]:not(.hidden)").forEach(p=>p.classList.add("hidden")); _openMsel=null; applyMselIfDirty(); } }));
}
if(!window._mselDocBound){ window._mselDocBound=true;
  document.addEventListener("click",()=>{ let any=false; document.querySelectorAll(".colmsel [data-mpanel]:not(.hidden)").forEach(p=>{ p.classList.add("hidden"); any=true; }); if(any){ _openMsel=null; applyMselIfDirty(); } });
}
/* build a cols descriptor from a simple {f,h,type,calc} list (Flow / Changes) */
function descFromCols(list){
  return list.map(c=>({
    f:c.f, h:c.h, cls:c.calc?"calc":"", calc:c.calc,
    raw:r=>{ if(c.get) return c.get(r)||""; if(c.type==="check") return r[c.f]?1:0; const v=c.calc?effective(r,c.f):r[c.f]; return v==null?"":v; },
    disp:r=>{ if(c.get) return c.get(r)||""; if(c.type==="check") return r[c.f]?"Yes":"No"; const v=c.calc?effective(r,c.f):r[c.f]; return c.type==="date"?fmtDate(v):(v==null?"":v); }
  }));
}

/* ---------------- cell HTML builder (text/date, long, placeholder) ---------------- */
function cellHTML(id, c, disp, rawv, allow){
  const tdc=c.cellClass?` class="${c.cellClass}"`:"";
  if(c.type==="text" && c.long){   // long text → view/edit modal on click
    return `<td${tdc}><span class="cell longcell ${allow?'editallowed':''} ${disp?'':'empty'}" data-id="${id}" data-field="${c.f}" data-type="text" data-label="${esc(c.h)}"><span class="val">${esc(disp)}</span></span></td>`;
  }
  if(c.type==="text" && c.placeholder && (disp===""||disp==="0")){   // e.g. Estimator "[Unassigned]"
    return `<td${tdc}><span class="cell ${allow?'editable':''}" data-id="${id}" data-field="${c.f}" data-type="text" data-raw=""><span class="val muted">${esc(c.placeholder)}</span></span></td>`;
  }
  const tt=(c.type==="text"&&disp)?` title="${esc(disp)}"`:"";
  const rawAttr=(c.type!=="date")?` data-raw="${esc(rawv==null?"":String(rawv))}"`:"";
  return `<td${tdc}><span class="cell ${allow?'editable':''} ${disp?'':'empty'}"${tt}${rawAttr} data-id="${id}" data-field="${c.f}" data-type="${c.type}"><span class="val">${esc(disp)}</span></span></td>`;
}

/* ---------------- editable-cell engine (delegated) ---------------- */
function bindGrid(container, commit){
  // Budgets / To-Do keep the simple click-to-edit behavior.
  if(state.view!=="flow" && state.view!=="changes"){
    container.addEventListener("click", e=>{
      const lc=e.target.closest(".cell.longcell"); if(lc){ openTextModal(lc, commit); return; }
      const span=e.target.closest(".cell.editable"); if(span && !span._editing) startEdit(span, commit);
    });
    return;
  }
  // Flow / Changes use the Excel-style sheet model. Selection persists across renders.
  const viewChanged = sheet.view!==state.view;
  sheet.view=state.view; sheet.container=container; sheet.commit=commit; sheet.drag=false; sheet.fill=false; sheet.fillTo=null;
  if(viewChanged){ sheet.anchor=null; sheet.focus=null; }
  attachSheetMouse(container);
  clampSel(); paintSelection();
}
/* full-text viewer / editor for long cells */
function openTextModal(cell, commit){
  const id=cell.dataset.id, field=cell.dataset.field, label=cell.dataset.label||"Details";
  const editable=cell.classList.contains("editallowed");
  const text=(cell.querySelector(".val")?.textContent)||"";
  document.querySelectorAll(".modal-ov").forEach(m=>m.remove());
  const ov=document.createElement("div"); ov.className="modal-ov";
  ov.innerHTML=`<div class="modal-card" style="max-width:640px">
    <div class="modal-h">${esc(label)}<button class="linkbtn" data-x aria-label="Close">&times;</button></div>
    <div class="modal-body">
      ${editable
        ? `<textarea id="txtArea" class="txtbox" rows="10">${esc(text)}</textarea>
           <div class="modal-actions"><button class="btn" id="txtSave">Save</button><button class="btn ghost" id="txtCancel">Cancel</button></div>`
        : `<div class="txtview">${text?esc(text):'<span class="muted">(blank)</span>'}</div>
           <div class="modal-actions"><button class="btn ghost" id="txtCancel">Close</button></div>`}
    </div></div>`;
  document.body.appendChild(ov);
  const close=()=>ov.remove();
  ov.addEventListener("click",e=>{ if(e.target===ov) close(); });
  ov.querySelector("[data-x]").onclick=close;
  ov.querySelector("#txtCancel").onclick=close;
  if(editable){ const ta=ov.querySelector("#txtArea"); ta.focus();
    ov.querySelector("#txtSave").onclick=async()=>{ await commit(id, field, "text", ta.value); close(); }; }
}
function startEdit(span, commit, after, prefill){
  const type=span.dataset.type, id=span.dataset.id, field=span.dataset.field;
  const cur = type==="date" ? invFmt(span.querySelector(".val").textContent)
            : (span.dataset.raw!==undefined ? span.dataset.raw : span.querySelector(".val").textContent);
  span._editing=true;
  const cellW=Math.round(span.getBoundingClientRect().width);   // lock editor to current cell width (no column expansion)
  const inp=document.createElement("input");
  inp.className="cellinput"; inp.type = type==="date"?"date":(type==="num"?"number":"text");
  inp.value = (prefill!=null && type!=="date") ? String(prefill) : (cur||"");
  if(cellW>0) inp.style.width=cellW+"px";
  span.innerHTML=""; span.appendChild(inp); inp.focus();
  if(prefill==null){ if(inp.select) try{inp.select();}catch(e){} } else { try{ inp.setSelectionRange(inp.value.length,inp.value.length); }catch(e){} }
  let done=false, dir=null;
  const finish=async(save)=>{
    if(done) return; done=true;
    const val=inp.value;
    if(save){ await commit(id, field, type, val); if(after) after(dir); }
    else { render(); if(after) after(null); }
  };
  inp.addEventListener("blur", ()=>finish(true));
  inp.addEventListener("keydown", ev=>{
    if(ev.key==="Enter"){ ev.preventDefault(); dir=ev.shiftKey?"up":"down"; finish(true); }
    else if(ev.key==="Tab"){ ev.preventDefault(); dir=ev.shiftKey?"left":"right"; finish(true); }
    else if(ev.key==="Escape"){ dir=null; finish(false); }
  });
}

/* ================= Excel-style sheet (Flow / Changes) =================
   Single click selects a cell; click-drag or Shift-click selects a rectangle. Double
   click, Enter, F2, or just typing edits the active cell (Enter/Tab commit and move).
   Arrow keys move (Shift+arrow extends). Ctrl+C copies, Ctrl+V pastes a block, Ctrl+D
   fills down, Ctrl+R fills right, Delete clears. Drag the corner handle to fill down/up.
   Every write goes through the field-level save, so conflict protection + RLS apply. */
let sheet={ view:null, container:null, commit:null, anchor:null, focus:null, drag:false, fill:false, fillTo:null };
function shRows(c){ return [...c.querySelectorAll("table.grid tbody tr")].filter(tr=>tr.querySelector(".cell")); }
function shDims(c){ const rows=shRows(c); return { R:rows.length, C:rows[0]?rows[0].querySelectorAll(".cell").length:0 }; }
function shCell(c,r,cc){ const tr=shRows(c)[r]; return tr?(tr.querySelectorAll(".cell")[cc]||null):null; }
function shCoord(cell){ const tr=cell.closest("tr"); const r=shRows(sheet.container).indexOf(tr); const c=[...tr.querySelectorAll(".cell")].indexOf(cell); return (r<0||c<0)?null:{r,c}; }
function selRect(){ const a=sheet.anchor, f=sheet.focus||sheet.anchor; return { r1:Math.min(a.r,f.r), c1:Math.min(a.c,f.c), r2:Math.max(a.r,f.r), c2:Math.max(a.c,f.c) }; }
function clampSel(){ const {R,C}=shDims(sheet.container); if(!sheet.anchor) return; if(R===0||C===0){ sheet.anchor=sheet.focus=null; return; }
  const cl=p=>{ p.r=Math.max(0,Math.min(p.r,R-1)); p.c=Math.max(0,Math.min(p.c,C-1)); }; cl(sheet.anchor); if(sheet.focus) cl(sheet.focus); }
function normVal(type, v){ v=(v==null?"":String(v)).trim();
  if(type!=="date") return v;
  if(/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const inv=invFmt(v); if(inv) return inv;
  const d=new Date(v); return isNaN(d.getTime())?"":d.toISOString().slice(0,10);
}
function cellSaveVal(cell){ const arr=sheet.view==="flow"?state.flow:state.changes; const r=arr.find(x=>x.id===cell.dataset.id); const v=r?r[cell.dataset.field]:null; return v==null?"":v; }
function paintSelection(){
  const c=sheet.container; if(!c) return;
  c.querySelectorAll(".cell.cell-active,.cell.cell-selected,.cell.fill-preview").forEach(x=>x.classList.remove("cell-active","cell-selected","fill-preview"));
  c.querySelectorAll("td.handle-td").forEach(td=>td.classList.remove("handle-td"));
  c.querySelectorAll(".fill-handle").forEach(x=>x.remove());
  if(!sheet.anchor) return;
  const s=selRect();
  for(let r=s.r1;r<=s.r2;r++) for(let cc=s.c1;cc<=s.c2;cc++){ const el=shCell(c,r,cc); if(el) el.classList.add("cell-selected"); }
  const act=shCell(c,sheet.anchor.r,sheet.anchor.c); if(act) act.classList.add("cell-active");
  if(sheet.fill && sheet.fillTo!=null){
    const a=Math.min(sheet.fillTo,s.r1), b=Math.max(sheet.fillTo,s.r2);
    for(let r=a;r<=b;r++){ if(r>=s.r1 && r<=s.r2) continue; for(let cc=s.c1;cc<=s.c2;cc++){ const el=shCell(c,r,cc); if(el) el.classList.add("fill-preview"); } }
  }
  const br=shCell(c,s.r2,s.c2); if(br){ const td=br.parentElement; td.classList.add("handle-td"); const h=document.createElement("div"); h.className="fill-handle"; td.appendChild(h); }
}
function moveActive(dir, extend){
  const {R,C}=shDims(sheet.container); if(R===0||C===0) return;
  if(!sheet.anchor){ sheet.anchor={r:0,c:0}; sheet.focus={r:0,c:0}; paintSelection(); return; }
  const base=extend?(sheet.focus||{r:sheet.anchor.r,c:sheet.anchor.c}):sheet.anchor;
  let r=base.r, c=base.c;
  if(dir==="down") r++; else if(dir==="up") r--; else if(dir==="right") c++; else if(dir==="left") c--;
  r=Math.max(0,Math.min(r,R-1)); c=Math.max(0,Math.min(c,C-1));
  if(extend){ sheet.focus={r,c}; } else { sheet.anchor={r,c}; sheet.focus={r,c}; }
  paintSelection();
  const el=shCell(sheet.container,r,c); if(el) el.scrollIntoView({block:"nearest",inline:"nearest"});
}
function editActive(prefill){
  const cell=sheet.anchor?shCell(sheet.container,sheet.anchor.r,sheet.anchor.c):null; if(!cell) return;
  if(cell.matches(".longcell")){ if(cell.matches(".editallowed")) openTextModal(cell, sheet.commit); return; }
  if(!cell.matches(".editable")) return;
  startEdit(cell, sheet.commit, dir=>{ if(dir) moveActive(dir,false); else paintSelection(); }, prefill);
}
async function applyBulk(view, field, type, edits){
  if(!edits.length) return;
  if(edits.length>500){ toast("That's over 500 cells — please work in a smaller range.","err"); return; }
  const table=view==="flow"?"flow_rows":"takeoff_changes";
  const arr=view==="flow"?state.flow:state.changes;
  let conflicts=0;
  for(const {id,value} of edits){
    const r=arr.find(x=>x.id===id); if(!r) continue;
    if(view==="flow" && field==="plan_name"){ await setPlanName(r, value); continue; }
    const oldVal=r[field]===undefined?null:r[field];
    const newVal=(value===""||value==null)?null:value;
    if(sameVal(oldVal,newVal)) continue;
    r[field]=newVal;
    const res=await saveField(table,id,field,newVal,oldVal);
    if(res && res.ok===false && "current" in res){ r[field]=res.current; conflicts++; }
  }
  render();
  if(conflicts) toast(conflicts+" cell(s) weren't saved — changed by someone else. Latest values shown.","err");
}
function collectEdits(cells){ const byField={};
  cells.forEach(({el,value})=>{ if(!el||!el.matches(".editable,.editallowed")) return; const field=el.dataset.field,type=el.dataset.type||"text";
    (byField[field]=byField[field]||{type,list:[]}).list.push({id:el.dataset.id, value:normVal(type,value)}); });
  return byField;
}
async function runEdits(byField){ for(const f in byField) await applyBulk(sheet.view,f,byField[f].type,byField[f].list); }
async function clearSelection(){ const s=selRect(), cells=[];
  for(let r=s.r1;r<=s.r2;r++) for(let cc=s.c1;cc<=s.c2;cc++){ const el=shCell(sheet.container,r,cc); if(el) cells.push({el,value:""}); }
  await runEdits(collectEdits(cells)); }
async function fillDir(dir){ const s=selRect(), cells=[];
  if(dir==="down"){ if(s.r2<=s.r1) return; for(let cc=s.c1;cc<=s.c2;cc++){ const src=shCell(sheet.container,s.r1,cc); if(!src) continue; const v=cellSaveVal(src);
      for(let r=s.r1+1;r<=s.r2;r++) cells.push({el:shCell(sheet.container,r,cc),value:v}); } }
  else { if(s.c2<=s.c1) return; for(let r=s.r1;r<=s.r2;r++){ const src=shCell(sheet.container,r,s.c1); if(!src) continue; const v=cellSaveVal(src);
      for(let cc=s.c1+1;cc<=s.c2;cc++) cells.push({el:shCell(sheet.container,r,cc),value:v}); } }
  await runEdits(collectEdits(cells)); }
async function doHandleFill(toRow){ if(toRow==null||!sheet.anchor) return; const s=selRect(), h=s.r2-s.r1+1, cells=[];
  if(toRow>s.r2){ for(let cc=s.c1;cc<=s.c2;cc++) for(let r=s.r2+1;r<=toRow;r++){ const src=shCell(sheet.container,s.r1+((r-s.r1)%h),cc); cells.push({el:shCell(sheet.container,r,cc),value:cellSaveVal(src)}); } sheet.anchor={r:s.r1,c:s.c1}; sheet.focus={r:toRow,c:s.c2}; }
  else if(toRow<s.r1){ for(let cc=s.c1;cc<=s.c2;cc++) for(let r=toRow;r<s.r1;r++){ const src=shCell(sheet.container,s.r1+(((r-toRow)%h)),cc); cells.push({el:shCell(sheet.container,r,cc),value:cellSaveVal(src)}); } sheet.anchor={r:toRow,c:s.c1}; sheet.focus={r:s.r2,c:s.c2}; }
  await runEdits(collectEdits(cells)); }
function selTSV(){ const s=selRect(), lines=[];
  for(let r=s.r1;r<=s.r2;r++){ const parts=[]; for(let cc=s.c1;cc<=s.c2;cc++){ const el=shCell(sheet.container,r,cc); parts.push(el?(el.querySelector(".val")?.textContent||""):""); } lines.push(parts.join("\t")); }
  return lines.join("\n"); }
async function doPaste(txt){ const c=sheet.container; if(!sheet.anchor) return;
  const matrix=txt.replace(/\r\n?/g,"\n").split("\n"); if(matrix.length && matrix[matrix.length-1]==="") matrix.pop();
  const {R,C}=shDims(c), sr=sheet.anchor.r, sc=sheet.anchor.c, cells=[];
  matrix.forEach((line,ri)=>line.split("\t").forEach((val,ci)=>{ const r=sr+ri, cc=sc+ci; if(r>=R||cc>=C) return; cells.push({el:shCell(c,r,cc),value:val}); }));
  const pr=matrix.length-1, pc=Math.max(...matrix.map(l=>l.split("\t").length))-1;
  sheet.anchor={r:sr,c:sc}; sheet.focus={r:Math.min(R-1,sr+pr),c:Math.min(C-1,sc+pc)};
  await runEdits(collectEdits(cells)); }
function attachSheetMouse(c){
  c.addEventListener("mousedown", e=>{
    if(e.target.closest(".fill-handle")){ e.preventDefault(); sheet.fill=true; sheet.fillTo=selRect().r2; return; }
    const cell=e.target.closest(".cell"); if(!cell) return; const co=shCoord(cell); if(!co) return;
    e.preventDefault();
    if(e.shiftKey && sheet.anchor){ sheet.focus=co; } else { sheet.anchor=co; sheet.focus=co; sheet.drag=true; }
    paintSelection();
  });
  c.addEventListener("mouseover", e=>{
    if(!sheet.drag && !sheet.fill) return;
    const cell=e.target.closest(".cell"); if(!cell) return; const co=shCoord(cell); if(!co) return;
    if(sheet.fill){ sheet.fillTo=co.r; } else { sheet.focus=co; }
    paintSelection();
  });
  c.addEventListener("dblclick", e=>{ const cell=e.target.closest(".cell"); if(!cell) return; const co=shCoord(cell); if(co){ sheet.anchor=co; sheet.focus=co; } editActive(); });
}
function sheetActive(){ return sheet.container && (state.view==="flow"||state.view==="changes") && !isEditingOpen(); }
function onSheetKey(e){
  if(!sheetActive()) return;
  const ae=document.activeElement; if(ae && (ae.tagName==="INPUT"||ae.tagName==="TEXTAREA"||ae.tagName==="SELECT")) return;
  const k=e.key, ctrl=e.ctrlKey||e.metaKey;
  if(!sheet.anchor && !k.startsWith("Arrow")) return;
  if(k==="ArrowUp"){ e.preventDefault(); moveActive("up",e.shiftKey); }
  else if(k==="ArrowDown"){ e.preventDefault(); moveActive("down",e.shiftKey); }
  else if(k==="ArrowLeft"){ e.preventDefault(); moveActive("left",e.shiftKey); }
  else if(k==="ArrowRight"){ e.preventDefault(); moveActive("right",e.shiftKey); }
  else if(k==="Tab"){ e.preventDefault(); moveActive(e.shiftKey?"left":"right",false); }
  else if(k==="Enter"||k==="F2"){ e.preventDefault(); editActive(); }
  else if(k==="Escape"){ sheet.focus={r:sheet.anchor.r,c:sheet.anchor.c}; paintSelection(); }
  else if(k==="Delete"||k==="Backspace"){ e.preventDefault(); clearSelection(); }
  else if(ctrl && (k==="d"||k==="D")){ e.preventDefault(); fillDir("down"); }
  else if(ctrl && (k==="r"||k==="R")){ e.preventDefault(); fillDir("right"); }
  else if(ctrl){ /* let native copy/paste/select-all pass through */ }
  else if(k.length===1 && !e.altKey){ e.preventDefault(); editActive(k); }
}
if(!window._sheetDocBound){ window._sheetDocBound=true;
  document.addEventListener("mouseup", ()=>{ if(sheet.fill){ sheet.fill=false; const to=sheet.fillTo; sheet.fillTo=null; doHandleFill(to); } sheet.drag=false; });
  document.addEventListener("keydown", onSheetKey);
  document.addEventListener("copy", e=>{ if(!sheetActive()||!sheet.anchor) return; const ae=document.activeElement; if(ae && (ae.tagName==="INPUT"||ae.tagName==="TEXTAREA")) return;
    const tsv=selTSV(); if(tsv==null) return; e.preventDefault(); (e.clipboardData||window.clipboardData).setData("text/plain",tsv); });
  document.addEventListener("paste", e=>{ if(!sheetActive()||!sheet.anchor) return; const ae=document.activeElement; if(ae && (ae.tagName==="INPUT"||ae.tagName==="TEXTAREA")) return;
    const cd=e.clipboardData||window.clipboardData, txt=cd&&cd.getData("text"); if(!txt) return; e.preventDefault(); doPaste(txt); });
}

/* ================= live updates (Supabase Realtime) =================
   Subscribes to row changes on every data table and merges them into local state,
   so edits by other people appear without a reload. Re-render is debounced and
   deferred while this user has a cell editor or modal open (so it never yanks their
   input away). Realtime honors RLS, so users only receive rows they may read. */
let _rt=null, _rtTimer=null;
function isEditingOpen(){ return !!(document.querySelector(".cellinput") || document.querySelector(".modal-ov")); }
function rtRender(){ clearTimeout(_rtTimer); _rtTimer=setTimeout(function tick(){ if(isEditingOpen()){ _rtTimer=setTimeout(tick,400); return; } render(); }, 150); }
function setLive(status){
  const el=$("liveDot"); if(!el) return;
  if(DEMO){ el.classList.add("hidden"); return; }
  const ok=status==="SUBSCRIBED";
  el.classList.toggle("on",ok); el.classList.toggle("off",!ok);
  el.textContent = ok ? "Live" : (status==="CLOSED" ? "Offline" : "Reconnecting…");
  el.title = ok ? "Live updates connected — changes appear automatically" : "Reconnecting to live updates";
}
async function startRealtime(){
  if(DEMO){ setLive(); return; }
  if(!sb || _rt) return;
  try{ const { data } = await sb.auth.getSession(); const tok=data&&data.session&&data.session.access_token;
    if(tok && sb.realtime && sb.realtime.setAuth) sb.realtime.setAuth(tok); }catch(e){}
  const tables=["flow_rows","pending_budget_cols","pending_budget_checks","pending_budget_status","takeoff_changes","tf_plan_names","tf_change_log"];
  let ch=sb.channel("tf-live");
  tables.forEach(t=>{ ch=ch.on("postgres_changes",{event:"*",schema:"public",table:t},p=>onRemote(t,p)); });
  ch.subscribe(status=>setLive(status)); _rt=ch;
}
function onRemote(table, p){
  const ev=p.eventType||p.event, row=(p.new && Object.keys(p.new).length)?p.new:null, old=p.old||{};
  if(table==="flow_rows"){
    if(ev==="DELETE") state.flow=state.flow.filter(x=>x.id!==old.id);
    else if(row){ if(row.division!==state.divKey) state.flow=state.flow.filter(x=>x.id!==row.id);
      else { const i=state.flow.findIndex(x=>x.id===row.id); if(i>=0) state.flow[i]=row; else { state.flow.push(row); state.flow.sort(bySort); } } }
  } else if(table==="pending_budget_cols"){
    if(ev==="DELETE") state.cols=state.cols.filter(x=>x.id!==old.id);
    else if(row){ if(row.division!==state.divKey) state.cols=state.cols.filter(x=>x.id!==row.id);
      else { const i=state.cols.findIndex(x=>x.id===row.id); if(i>=0) state.cols[i]=row; else { state.cols.push(row); state.cols.sort(bySort); } } }
  } else if(table==="pending_budget_checks"){
    if(ev==="DELETE") delete state.checks[old.flow_id+"::"+old.col_id];
    else if(row) state.checks[row.flow_id+"::"+row.col_id]=!!row.checked;
  } else if(table==="pending_budget_status"){
    if(ev==="DELETE") delete state.status[old.flow_id];
    else if(row) state.status[row.flow_id]={sim_reviewed:!!row.sim_reviewed, sent_to_loc:!!row.sent_to_loc};
  } else if(table==="takeoff_changes"){
    if(ev==="DELETE") state.changes=state.changes.filter(x=>x.id!==old.id);
    else if(row){ if(row.division!==state.divKey) state.changes=state.changes.filter(x=>x.id!==row.id);
      else { const i=state.changes.findIndex(x=>x.id===row.id); if(i>=0) state.changes[i]=row; else { state.changes.unshift(row); state.changes.sort((a,b)=>(b.req_date||"").localeCompare(a.req_date||"")); } } }
  } else if(table==="tf_plan_names"){ loadPlanNames().then(rtRender); return; }
  else if(table==="tf_change_log"){ refreshWhatsNewBadge(); return; }
  rtRender();
}
/* convert displayed M/D/YY back to ISO for the date input */
function invFmt(disp){ if(!disp||disp==="—") return ""; const p=disp.split("/"); if(p.length!==3) return ""; let[m,d,y]=p.map(Number); y=y<100?2000+y:y; return `${y}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}`; }

/* ---------------- CSV export ---------------- */
function exportCSV(){
  let cols,rows,name;
  if(state.view==="flow"){ cols=FLOW_COLS.map(c=>c.h); name="flow_of_takeoffs";
    rows=flowRows().map(r=>FLOW_COLS.map(c=>c.get?c.get(r):(c.calc?fmtDate(effective(r,c.f)):(c.type==="date"?fmtDate(r[c.f]):r[c.f])))); }
  else if(state.view==="budgets"){ cols=["Community","Plan","Plan Name","Elev","Estimating Release",...state.cols.map(c=>c.name),"SIM Reviewed","Sent to LOC","Pricing Due","LOC Upload","Tasks Start","Trench Date"]; name="pending_budgets";
    rows=flowRows().map(r=>{ const st=state.status[r.id]||{}; return [r.community_name,r.plan,planName(r),r.elevation,fmtDate(effective(r,"released")),
      ...state.cols.map(c=>state.checks[r.id+"::"+c.id]?"Y":""), st.sim_reviewed?"Y":"", st.sent_to_loc?"Y":"", fmtDate(workday(r.first_trench_date,-30,true)), fmtDate(effective(r,"loc_upload")), fmtDate(effective(r,"tasks_start")), fmtDate(r.first_trench_date)]; }); }
  else if(state.view==="changes"){ cols=CHG_COLS.map(c=>c.h); name="takeoff_changes";
    rows=chgRows().map(r=>CHG_COLS.map(c=>c.type==="check"?(r[c.f]?"Y":""):(c.type==="date"?fmtDate(r[c.f]):r[c.f]))); }
  else { cols=["Community","Comm #","Plan","Ele","Trench"]; name="todo_outstanding";
    rows=todoOutstanding().map(r=>[r.community_name,r.community_num,r.plan,r.elevation,fmtDate(r.first_trench_date)]); }
  const csv=[cols,...rows].map(r=>r.map(v=>{ v=v==null?"":String(v);
    if(/^[=+\-@\t\r]/.test(v)) v="'"+v;                              // neutralize spreadsheet formula injection
    return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v; }).join(",")).join("\n");
  const a=document.createElement("a"); a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));
  a.download=`${name}_${state.divKey}_${todayIso()}.csv`; a.click(); URL.revokeObjectURL(a.href);
}

/* ===================================================================
   ADMIN · import + user management
   =================================================================== */
let importState={ file:null, wb:null };
function showAdmin(){
  if(!(isAdmin()||state.role==="editor")) return;
  $("dashboard").classList.add("hidden"); $("admin").classList.remove("hidden"); $("dashLink").classList.remove("hidden");
  const sel=$("adminDiv"); sel.innerHTML="";
  CFG.DIVISIONS.filter(d=>canEditDiv(d.key)).forEach(d=>{ const o=document.createElement("option"); o.value=d.key; o.textContent=d.label; sel.appendChild(o); });
  if(!sel.value && sel.options.length) sel.value=sel.options[0].value;
  bindImport();
  renderPerms();
}
function bindImport(){
  const tile=$("tileStarts"), input=$("startsInput");
  tile.onclick=()=>input.click();
  tile.onkeydown=e=>{ if(e.key==="Enter"||e.key===" ") input.click(); };
  input.onchange=e=>{ if(e.target.files[0]) loadStartsFile(e.target.files[0]); e.target.value=""; };
  ["dragover","dragenter"].forEach(ev=>tile.addEventListener(ev,e=>{e.preventDefault();tile.classList.add("drag");}));
  ["dragleave","drop"].forEach(ev=>tile.addEventListener(ev,e=>{e.preventDefault();tile.classList.remove("drag");}));
  tile.addEventListener("drop",e=>{ const f=e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files[0]; if(f) loadStartsFile(f); });
}
function adminMsg(t,k){ const m=$("adminMsg"); m.className="msg "+(k||"info"); m.textContent=t; }
async function loadStartsFile(file){
  try{
    $("startsName").textContent=file.name; $("tileStarts").classList.add("filled");
    const buf=await file.arrayBuffer(); const wb=XLSX.read(buf,{type:"array",cellDates:true});
    const kind = wb.SheetNames.includes("FLOW OF TAKEOFFS") ? "flow" : "starts";
    importState={ file:file.name, wb, kind };
    await buildImportPreview();
  }catch(e){ console.error(e); adminMsg("Couldn't read the file: "+e.message,"err"); }
}
/* parse the FLOW OF TAKEOFFS workbook sheet directly → full flow rows.
   Calc dates that differ from the WORKDAY result are kept as manual overrides. */
function parseFlowWorkbook(wb){
  const rows=XLSX.utils.sheet_to_json(wb.Sheets["FLOW OF TAKEOFFS"],{defval:null});
  const norm=k=>String(k).trim().replace(/\s+/g," ").toUpperCase();
  const H={ "COMMUNITY NAME":"community_name","COMMUNITY #":"community_num","PLAN":"plan","ELEVATION":"elevation",
    "CIS DUE":"cis_due","MASTER TP LIST DUE":"master_tp_due","ESTIMATE DONE *ETA*":"estimate_eta","RELEASED":"released",
    "PRICING STAGE":"pricing_stage","LOC UPLOAD":"loc_upload","TASKS START":"tasks_start","FIRST TRENCH DATE":"first_trench_date",
    "MIKE NOTES":"mike_notes","MARLO NOTES":"marlo_notes","CABS":"cabs","FLOORING":"flooring","MISSING PLANS?":"missing_plans","NOTES":"notes" };
  const dateFields=new Set(["cis_due","master_tp_due","estimate_eta","released","pricing_stage","loc_upload","tasks_start","first_trench_date"]);
  const calcFields=["cis_due","master_tp_due","estimate_eta","pricing_stage","loc_upload","tasks_start"];
  const S=v=>v==null?null:(String(v).trim().replace(/^'+/,"")||null);
  const isoCell=v=>{ if(v==null||v==="")return null; if(v instanceof Date) return new Date(Date.UTC(v.getFullYear(),v.getMonth(),v.getDate())).toISOString().slice(0,10);
    if(typeof v==="number"){ const d=(XLSX.SSF&&XLSX.SSF.parse_date_code)?XLSX.SSF.parse_date_code(v):null; if(d) return `${d.y}-${String(d.m).padStart(2,"0")}-${String(d.d).padStart(2,"0")}`; }
    const d=new Date(v); return isNaN(d)?null:d.toISOString().slice(0,10); };
  const out=[];
  for(const r of rows){
    const rec={};
    for(const k in r){ const f=H[norm(k)]; if(!f) continue; rec[f]= dateFields.has(f)?isoCell(r[k]):S(r[k]); }
    if(!rec.community_name && !rec.plan) continue;
    const row={ community_name:rec.community_name, community_num:rec.community_num, plan:rec.plan, elevation:rec.elevation,
      released:rec.released||null, first_trench_date:rec.first_trench_date||null,
      mike_notes:rec.mike_notes, marlo_notes:rec.marlo_notes, cabs:rec.cabs, flooring:rec.flooring, missing_plans:rec.missing_plans, notes:rec.notes };
    const base={first_trench_date:row.first_trench_date};
    calcFields.forEach(f=>{ const v=rec[f]; if(!v) return; if(v!==effective(base,f)) row[f]=v; }); // store only genuine overrides
    out.push(row);
  }
  return out;
}
/* parse a division's Starts Log → proposed flow rows grouped by community+plan+elevation.
   Orlando (OLH) uses the "Permit Log" tab (Comm/Job/Plan/EV/Start columns);
   Tampa   (TPU) uses the "Start Log"  tab (Project/Job/Plan/EV/ActStart columns). */
function parseStartSchedule(wb, div){
  const digits=x=>String(x==null?"":x).replace(/\D/g,"");
  const S=s=>(s==null?null:String(s).trim()||null);
  const xlDate=v=>{ if(v==null||v==="")return null; if(typeof v==="number"){ const d=XLSX.SSF?XLSX.SSF.parse_date_code(v):null; if(d) return `${d.y}-${String(d.m).padStart(2,"0")}-${String(d.d).padStart(2,"0")}`; }
    const d=new Date(v); return isNaN(d)?null:d.toISOString().slice(0,10); };
  const find=n=>wb.SheetNames.find(s=>lc(s)===lc(n));
  const want = div==="orlando" ? "Permit Log" : div==="tampa" ? "Start Log" : null;
  const sheet = (want && find(want)) || find("Permit Log") || find("Start Log") || find("START SCHEDULE") || wb.SheetNames[0];
  const rows=XLSX.utils.sheet_to_json(wb.Sheets[sheet],{defval:null});
  const commNum=r=>{ const job=digits(r["Job"]); return job.length>=7 ? job.slice(0,7)+"0000" : (S(r["Comm"])||""); };  // first 7 digits = community (handles model/spec jobs like 1116272S111)
  // Pre-count building sizes so plex lots become "{N}-PLEX" like the workbook does.
  // Count units per building INSTANCE = community + building + projected-start (matches the
  // workbook's COUNTIFS(Start, Bldg)); avoids over-counting a reused building id across phases.
  const startKey=r=>String(r["Start (Prj)"]??r["PrjStart"]??r["Start (Act)"]??r["ActStart"]??"");
  const bldgCount={};
  for(const r of rows){ const b=S(r["Bldg"]); if(b){ const k=commNum(r)+"|"+b+"|"+startKey(r); bldgCount[k]=(bldgCount[k]||0)+1; } }
  const idName={}; const groups=new Map();
  for(const r of rows){
    let comm=null, num="", plan=null, ev=null, trench=null; const bldg=S(r["Bldg"]);
    if(r["Comm"]!=null || (r["Job"]!=null && r["Project"]==null)){       // OLH "Permit Log" format
      comm=S(r["Comm"]); num=commNum(r);
      plan = S(r["Plan"]); ev = S(r["EV"])||S(r["Elevation"]);
      trench = xlDate(r["TrenchKey"])||xlDate(r["Start (Prj)"])||xlDate(r["Start (Act)"]);
      if(num && comm) idName[num]=comm;
    } else if(r["Project"]!=null){                                       // TPU "Start Log" format
      const proj=S(r["Project"])||""; comm = proj.includes(" - ") ? proj.split(" - ").slice(1).join(" - ").trim() : proj;
      num = commNum(r); plan = S(r["Plan"]); ev = S(r["EV"])||S(r["Elevation"]);
      trench = xlDate(r["ActStart"])||xlDate(r["PrjStart"]);
    } else continue;
    // plex transform: buildings → "{units}-PLEX", elevation → first letter (matches the Flow grid)
    if(bldg){ const cnt=bldgCount[num+"|"+bldg+"|"+startKey(r)]; if(cnt) plan=cnt+"-PLEX"; if(ev) ev=ev.charAt(0); }
    const name = comm || idName[num] || num;
    if(!num || !plan) continue;
    const key=[num,lc(plan),lc(ev||"")].join("|");   // dedup by community NUMBER (names differ between systems)
    if(!groups.has(key)) groups.set(key,{ community_name:name, community_num:num, plan, elevation:ev, first_trench_date:trench });
    else{ const g=groups.get(key); if(trench && (!g.first_trench_date || trench<g.first_trench_date)) g.first_trench_date=trench; }
  }
  return [...groups.values()];
}
async function buildImportPreview(){
  const div=$("adminDiv").value;
  const isFlow=importState.kind==="flow";
  const proposed=isFlow?parseFlowWorkbook(importState.wb):parseStartSchedule(importState.wb, div);
  const existRows=await existingFlow(div);   // always compare against the TARGET division's rows in the DB
  // A combination = community NUMBER + plan + elevation. Only genuinely new combinations are added.
  // Plex plans are normalized (the "{N}-PLEX" unit count is unreliable between the log and the grid),
  // so a plex is matched by community + "PLEX" + elevation.
  const normPlan=p=>{ const s=lc(p); return /^\d+\s*-?\s*plex$/.test(s) ? "plex" : s; };
  const combo=(num,plan,ev)=>[String(num||"").trim(),normPlan(plan),lc(ev||"")].join("|");
  const existing=new Set(existRows.map(r=>combo(r.community_num,r.plan,r.elevation)));
  const existingNumPlan=new Set(existRows.map(r=>String(r.community_num||"").trim()+"|"+normPlan(r.plan)));  // for elevation-less plex
  const existingNums=new Set(existRows.map(r=>String(r.community_num||"").trim()));
  const numName={}; existRows.forEach(r=>{ const n=String(r.community_num||"").trim(); if(n && !(n in numName)) numName[n]=r.community_name; });
  const fresh=proposed.filter(p=>{
    const num=String(p.community_num||"").trim();
    if(existing.has(combo(num,p.plan,p.elevation))) return false;                                        // community + plan + elevation exists
    if(!String(p.elevation||"").trim() && existingNumPlan.has(num+"|"+normPlan(p.plan))) return false;   // no elevation in source → skip if community+plan already present
    return true;
  });
  // for communities already in the grid, keep the grid's canonical name (log names differ)
  fresh.forEach(p=>{ const n=String(p.community_num||"").trim(); if(numName[n]) p.community_name=numName[n]; });
  const panel=$("previewPanel"), body=$("previewBody");
  panel.classList.remove("hidden");
  const src=isFlow?"FLOW OF TAKEOFFS workbook":"Starts Log";
  if(!fresh.length){ body.innerHTML=`<p class="tiny" style="text-align:left">Parsed ${proposed.length} combination(s) from the ${src} — all already exist in ${esc(div)}. Nothing new to import.</p>`; return; }
  // ---- change summary ----
  const byComm=new Map();
  fresh.forEach(r=>byComm.set(r.community_name,(byComm.get(r.community_name)||0)+1));
  const newComms=[...new Set(fresh.filter(p=>!existingNums.has(String(p.community_num||"").trim())).map(p=>p.community_name))];
  importState.summary=`Imported ${fresh.length} new row(s) from ${src} → ${div} · ${byComm.size} communities${newComms.length?`, ${newComms.length} new`:""}`;
  importState.detail={ source:src, division:div, communities:byComm.size, newCommunities:newComms,
    added:fresh.map(r=>({community:r.community_name, plan:r.plan, elevation:r.elevation||"", trench:r.first_trench_date||""})) };
  let h=`<div class="import-summary">
    <div class="is-row"><span class="is-n">${fresh.length}</span> new row(s) to add to <b>${esc(div)}</b></div>
    <div class="tiny" style="text-align:left;margin:2px 0 0">${proposed.length} parsed · ${proposed.length-fresh.length} already exist · ${byComm.size} communities affected${newComms.length?` · <b>${newComms.length} new communities</b>`:""}</div>
    ${newComms.length?`<div class="tiny" style="text-align:left;margin:6px 0 0">New communities: ${newComms.slice(0,12).map(esc).join(", ")}${newComms.length>12?` +${newComms.length-12} more`:""}</div>`:""}
    <div class="tiny" style="text-align:left;margin:6px 0 0">${isFlow?"All columns and dates come in as-is; calculated dates stay auto unless overridden.":"Trench dates are suggestions — refine them in the grid after publishing."} Existing rows are never overwritten.</div>
  </div>`;
  const pnMap=(state.planNames&&state.planNames[div])||{};
  const pnOf=r=>pnMap[String(r.plan==null?"":r.plan).trim().toUpperCase()]||"";
  h+=`<div class="prev-scroll"><table class="prev-table"><thead><tr><th>Community</th><th>Comm #</th><th>Plan</th><th>Plan Name</th><th>Elevation</th><th>Suggested Trench</th></tr></thead><tbody>`;
  fresh.slice(0,200).forEach(r=>h+=`<tr><td>${esc(r.community_name)}${newComms.includes(r.community_name)?' <span class="badge" style="background:var(--good)">new</span>':""}</td><td>${esc(r.community_num||"")}</td><td>${esc(r.plan)}</td><td>${esc(pnOf(r))}</td><td>${esc(r.elevation||"")}</td><td>${esc(fmtDate(r.first_trench_date))}</td></tr>`);
  h+=`</tbody></table></div>`;
  if(fresh.length>200) h+=`<p class="tiny" style="text-align:left">…and ${fresh.length-200} more.</p>`;
  h+=`<button class="btn" id="publishImport">Publish ${fresh.length} row(s) to ${esc(div)}</button>`;
  body.innerHTML=h;
  $("publishImport").onclick=async()=>{ await publishImport(div, fresh, importState.summary, importState.detail); };
}
async function existingFlow(div){
  if(DEMO) return MEM.flow_rows.filter(r=>r.division===div);
  return await sbAll(()=>sb.from("flow_rows").select("id,community_name,community_num,plan,elevation,sort_order").eq("division",div));
}
async function publishImport(div, fresh, summary, detail){
  $("publishImport").disabled=true;
  const existRows=await existingFlow(div);
  let n=existRows.reduce((m,r)=>Math.max(m, r.sort_order||0), 0);
  for(const p of fresh){ const row={ id:uid(), division:div, sort_order:++n };
    for(const k in p){ if(k!=="id"&&k!=="division"&&k!=="sort_order") row[k]=p[k]; }
    await saveRow("flow_rows",row); if(div===state.divKey) state.flow.push(row); }
  await logChange(div, summary||`Imported ${fresh.length} row(s) into ${div}`, detail);
  adminMsg(`Published ${fresh.length} row(s) to ${div}.`,"ok");
  $("previewPanel").classList.add("hidden"); $("tileStarts").classList.remove("filled"); $("startsName").textContent="Drop the Starts Log .xlsx here or click to browse";
  if(div===state.divKey) { /* refresh underlying data */ await loadDivision(div); render(); }
}
/* ---- change history ("What's New") ---- */
async function logChange(division, summary, detail){
  const row={ id:uid(), division, at:new Date().toISOString(), by:state.email, summary, detail:detail||null };
  if(DEMO){ MEM.change_log.unshift(row); }
  else { try{ await sb.from("tf_change_log").insert(row); }catch(e){ console.warn("change_log insert failed",e); } }
  refreshWhatsNewBadge();
}
async function latestChange(){
  if(DEMO) return MEM.change_log[0]||null;
  try{ const { data }=await sb.from("tf_change_log").select("at,by,summary").order("at",{ascending:false}).limit(1); return data&&data[0]?data[0]:null; }catch(e){ return null; }
}
async function refreshWhatsNewBadge(){
  const btn=$("whatsNewBtn"); if(!btn) return;
  const latest=await latestChange();
  let seen=null; try{ seen=localStorage.getItem("tf_wn_seen"); }catch(e){}
  const unseen = latest && latest.at && (!seen || latest.at>seen);
  btn.classList.toggle("has-updates", !!unseen);
  btn.innerHTML = "What's New" + (unseen?'<span class="notif-dot"></span>':"");
  const note=$("lastUpdateNote");
  if(note){
    if(latest && latest.at){
      const when=new Date(latest.at).toLocaleString([], {month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});
      note.textContent=`Last update ${when} · ${latest.by||"—"}`;
      note.title=latest.summary||"";
    } else { note.textContent="No updates logged yet"; note.title=""; }
  }
}
async function openWhatsNew(){
  let rows;
  if(DEMO){ rows=MEM.change_log.slice(0,20); }
  else { try{ const { data }=await sb.from("tf_change_log").select("*").order("at",{ascending:false}).limit(20); rows=data||[]; }catch(e){ rows=[]; } }
  document.querySelectorAll(".modal-ov").forEach(m=>m.remove());
  const ov=document.createElement("div"); ov.className="modal-ov";
  const items = rows.length ? rows.map((r,i)=>{
    const when=r.at?new Date(r.at).toLocaleString([], {month:"short",day:"numeric",year:"numeric",hour:"numeric",minute:"2-digit"}):"";
    const d=r.detail && (typeof r.detail==="string"?safeJSON(r.detail):r.detail);
    let detailHTML="";
    if(d){
      if(d.newCommunities&&d.newCommunities.length) detailHTML+=`<div class="chg-sec"><div class="chg-sec-h">New communities (${d.newCommunities.length})</div><ul class="chg-list">${d.newCommunities.map(c=>`<li class="add-v">${esc(c)}</li>`).join("")}</ul></div>`;
      if(d.added&&d.added.length) detailHTML+=`<div class="chg-sec"><div class="chg-sec-h">Rows added (${d.added.length})</div><ul class="chg-list">${d.added.slice(0,300).map(a=>`<li>${esc(a.community)} — ${esc(a.plan)} ${esc(a.elevation||"")} ${a.trench?`<span class="chg-arrow">trench ${esc(fmtDate(a.trench))}</span>`:""}</li>`).join("")}${d.added.length>300?`<li class="tiny">…and ${d.added.length-300} more</li>`:""}</ul></div>`;
      if(d.source) detailHTML+=`<div class="chg-meta">Source: ${esc(d.source)}</div>`;
    }
    const hasDetail=!!detailHTML;
    return `<div class="wn-item">
      <button class="wn-toggle${hasDetail?"":" nodetail"}" data-i="${i}">
        <span class="wn-when">${esc(when)}</span>${r.division?`<span class="wn-div">${esc(r.division)}</span>`:""}
        <span class="wn-sum">${esc(r.summary||"")}</span>
        ${hasDetail?'<span class="chg-chev">▸</span>':""}
      </button>
      ${hasDetail?`<div class="chg-detail hidden" data-d="${i}">${detailHTML}</div>`:""}
      <div class="wn-by">${esc(r.by||"")}</div>
    </div>`;
  }).join("") : `<div class="empty">No updates recorded yet. Publishing a Start Schedule or workbook import will show up here.</div>`;
  ov.innerHTML=`<div class="modal-card" style="max-width:600px">
    <div class="modal-h">What's New — recent updates<button class="linkbtn" data-x aria-label="Close">&times;</button></div>
    <div class="modal-body"><div class="wn-list">${items}</div></div></div>`;
  document.body.appendChild(ov);
  const close=()=>ov.remove();
  ov.addEventListener("click",e=>{ if(e.target===ov) close(); });
  ov.querySelector("[data-x]").onclick=close;
  ov.querySelectorAll(".wn-toggle:not(.nodetail)").forEach(b=>b.onclick=()=>{ const d=ov.querySelector(`[data-d="${b.dataset.i}"]`); if(d){ d.classList.toggle("hidden"); b.classList.toggle("open"); } });
  // mark all as seen
  const latest=rows[0]?.at; if(latest){ try{ localStorage.setItem("tf_wn_seen",latest); }catch(e){} }
  refreshWhatsNewBadge();
}
function safeJSON(s){ try{ return JSON.parse(s); }catch(e){ return null; } }

/* ---- user / role management (admin only) ---- */
async function renderPerms(){
  const p=$("permsPanel");
  if(!isAdmin()){ p.innerHTML=`<div class="panel"><div class="panel-h">Access</div><div style="padding:16px"><p class="tiny" style="text-align:left;margin:0">You can import and edit data for your division(s). Only an admin can change user roles.</p></div></div>`; return; }
  // load users
  if(DEMO){ state.users=MEM.app_roles.slice(); }
  else{ try{ const { data }=await sb.from("tf_app_roles").select("*").order("email"); state.users=data||[]; }catch(e){ state.users=[]; } }
  const divOpts=CFG.DIVISIONS.map(d=>`<label class="permchk"><input type="checkbox" class="pdiv" value="${d.key}"> ${esc(d.label)}</label>`).join("");
  let h=`<div class="panel"><div class="panel-h">Users &amp; roles</div><div style="padding:16px">
    <div class="permform">
      <input type="email" id="pEmail" placeholder="name@lennar.com">
      <select id="pRole"><option value="viewer">viewer</option><option value="editor">editor</option><option value="purchasing">purchasing</option><option value="admin">admin</option></select>
      <span class="permdivs" id="pDivs">${divOpts}</span>
      <button class="btn mini" id="pAdd">Save user</button>
    </div>
    <p class="tiny" style="text-align:left;margin:0 0 12px">Divisions apply to <b>editor</b> and <b>purchasing</b> roles. Everyone at ${esc(CFG.ALLOWED_DOMAIN)} is a viewer by default.</p>
    <div id="userList"></div>
  </div></div>`;
  p.innerHTML=h;
  $("pAdd").onclick=addUser;
  drawUsers();
}
function drawUsers(){
  const list=$("userList"); if(!list) return;
  if(!state.users.length){ list.innerHTML=`<p class="tiny" style="text-align:left;margin:0">No custom roles yet.</p>`; return; }
  list.innerHTML=state.users.map(u=>`<div class="userrow"><span class="em">${esc(u.email)}</span><span class="role-tag">${esc(u.role)}</span>${(u.divisions||[]).map(d=>`<span class="badge" style="background:var(--navy)">${esc(d)}</span>`).join(" ")}<button class="btn mini danger" data-deluser="${esc(u.email)}">Remove</button></div>`).join("");
  list.querySelectorAll("[data-deluser]").forEach(b=>b.onclick=async()=>{ const em=b.dataset.deluser; if(!confirm("Remove role for "+em+"?"))return;
    if(DEMO){ MEM.app_roles=MEM.app_roles.filter(u=>u.email!==em); } else { await sb.from("tf_app_roles").delete().eq("email",em); }
    state.users=state.users.filter(u=>u.email!==em); drawUsers(); });
}
async function addUser(){
  const email=lc($("pEmail").value), role=$("pRole").value;
  if(!email.endsWith(CFG.ALLOWED_DOMAIN)) return adminMsg("Email must be "+CFG.ALLOWED_DOMAIN,"err");
  const divisions=[...document.querySelectorAll(".pdiv:checked")].map(c=>c.value);
  const row={ email, role, divisions };
  if(DEMO){ const i=MEM.app_roles.findIndex(u=>u.email===email); if(i>=0)MEM.app_roles[i]=row; else MEM.app_roles.push(row); }
  else{ const { error }=await sb.from("tf_app_roles").upsert(row); if(error) return adminMsg("Save failed: "+error.message,"err"); }
  const i=state.users.findIndex(u=>u.email===email); if(i>=0)state.users[i]=row; else state.users.push(row);
  $("pEmail").value=""; document.querySelectorAll(".pdiv:checked").forEach(c=>c.checked=false);
  adminMsg("Saved "+email+" as "+role+".","ok"); drawUsers();
}

/* ---------------- DEMO seed ----------------
   In demo mode we load the real Orlando FLOW OF TAKEOFFS export (data/flow_orlando.json,
   898 rows) so the site shows actual data without a backend. Falls back to a tiny
   sample if the file can't be fetched (e.g. opened directly from disk via file://). */
function ingestSeed(suf){
  const flows=window["TF_SEED_"+suf]; if(!Array.isArray(flows)) return false;
  MEM.flow_rows.push(...flows.map(r=>({...r})));
  const cols=window["TF_SEED_"+suf+"_COLS"]; if(Array.isArray(cols)) MEM.pending_budget_cols.push(...cols.map(c=>({...c})));
  const chk=window["TF_SEED_"+suf+"_CHECKS"]; if(Array.isArray(chk)) chk.forEach(c=>MEM.pending_budget_checks.push({flow_id:c.flow_id,col_id:c.col_id,checked:true}));
  const st=window["TF_SEED_"+suf+"_STATUS"]; if(Array.isArray(st)) st.forEach(s=>MEM.pending_budget_status.push({flow_id:s.flow_id,sim_reviewed:!!s.sim_reviewed,sent_to_loc:!!s.sent_to_loc}));
  const ch=window["TF_SEED_"+suf+"_CHANGES"]; if(Array.isArray(ch)) ch.forEach(c=>MEM.takeoff_changes.push({...c}));
  return true;
}
async function ensureSeed(){
  if(MEM._seeded) return; MEM._seeded=true;
  // embedded seeds (data/flow_orlando.js, data/flow_tampa.js) — work even under file://
  ingestSeed("ORLANDO"); ingestSeed("TAMPA");
  if(!MEM.flow_rows.length){   // fallback tiny sample if no embedded data
    const mk=(name,num,plan,ev,trench,extra)=>Object.assign({id:uid(),division:"orlando",community_name:name,community_num:num,plan,elevation:ev,first_trench_date:trench,sort_order:MEM.flow_rows.length+1},extra||{});
    MEM.flow_rows.push(mk("BronsonRidge 60","11149720000","3216","J","2026-08-25",{released:"2024-07-12",mike_notes:"MIKE DONE"}));
    (CFG.DEFAULT_BUDGET_COLUMNS||[]).forEach((nm,i)=>MEM.pending_budget_cols.push({id:uid(),division:"orlando",name:nm,assigned_email:null,sort_order:i+1}));
  }
  // sample history so "What's New" isn't empty in demo
  MEM.change_log.push(
    {id:uid(),division:"orlando",at:new Date(Date.now()-6*36e5).toISOString(),by:"stephen.svedman@lennar.com",summary:"Imported 12 new row(s) from Start Schedule → orlando · 3 communities, 1 new",
     detail:{source:"Start Schedule",newCommunities:["Silverleaf 40"],added:[{community:"Silverleaf 40",plan:"N120",elevation:"A",trench:"2026-11-10"},{community:"Silverleaf 40",plan:"N122",elevation:"B",trench:"2026-11-18"},{community:"RANCHES 60GC",plan:"L100",elevation:"C",trench:"2026-10-02"}]}},
    {id:uid(),division:"orlando",at:new Date(Date.now()-2*864e5).toISOString(),by:"stephen.svedman@lennar.com",summary:"Imported 636 rows from FLOW OF TAKEOFFS workbook → orlando · 108 communities",
     detail:{source:"FLOW OF TAKEOFFS workbook",newCommunities:[],added:[]}}
  );
}

/* ---------------- start ---------------- */
tryRestore();
