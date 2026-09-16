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
/* Sign out in one app signs out of all of them. All four sites share an origin and
   the storageKey above, so clearing the session raises a storage event in every
   other open tab. Without this an already-open tab keeps its in-memory session and
   its cached JWT stays valid until expiry — it would look signed in for up to an
   hour after you signed out elsewhere. */
if (!DEMO && window.supabase) {
  window.addEventListener("storage", function (e) {
    if (e.key === "lennar-vendor-portal-auth" && !e.newValue) location.reload();
  });
}
const HOLIDAYS = new Set(CFG.HOLIDAYS || []);

const state = {
  email:null, role:"viewer", roleDivs:[], divKey:null, view:"flow", filter:"",
  flow:[], cols:[], checks:{}, status:{}, changes:[], users:[], locLock:null,
  sort:{}, colFilters:{}   // per-view column sort + per-column filter text
};

/* in-memory store for DEMO mode */
const MEM = { app_roles:[], flow_rows:[], pending_budget_cols:[], pending_budget_checks:[], pending_budget_status:[], takeoff_changes:[], change_log:[], locLocks:{} };

/* ---------------- helpers ---------------- */
const $   = id => document.getElementById(id);
const esc = s => String(s==null?"":s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "id-"+Date.now()+"-"+Math.random().toString(16).slice(2));
const lc  = s => (s||"").toLowerCase().trim();
/* LOCAL calendar day, not the UTC one. toISOString() rolls over at 00:00 UTC, so
   for anyone east of it this returned TOMORROW after ~7-8pm Eastern: a plan whose
   latest start is today flipped to red on the Plans tab, every Frequency preset
   range shifted a day, and completed_date stamped tomorrow's date permanently onto
   whatever was ticked complete that evening. The rest of the date engine (parseIso,
   iso, fmtDate, isBiz) is deliberately UTC and internally consistent; only "what
   day is it for the person looking at the screen" is a local-time question. */
const todayIso = () => {
  const d=new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
};

function parseIso(s){ if(!s) return null; const [y,m,d]=s.split("-").map(Number); return new Date(Date.UTC(y,m-1,d)); }
function iso(d){ return d.toISOString().slice(0,10); }
function fmtDate(s){ const d=parseIso(s); if(!d) return ""; const mm=d.getUTCMonth()+1, dd=d.getUTCDate(), yy=String(d.getUTCFullYear()).slice(2); return `${mm}/${dd}/${yy}`; }
/* isBiz used to call iso(d) unconditionally — a toISOString() + slice, i.e. a string
   allocation, on EVERY iteration of the workday loop below. With CFG.HOLIDAYS empty
   (the current config) that string was built purely to test it against an empty Set.
   Skipping it when there are no holidays removes every allocation from the loop. */
function isBiz(d){
  const g=d.getUTCDay();
  if(g===0 || g===6) return false;
  return HOLIDAYS.size===0 || !HOLIDAYS.has(iso(d));
}
/* Business-day offset. Deliberately still a day-at-a-time loop.

   A "skip whole weeks" version of this was written and tested and is WRONG, twice
   over. (1) 5 business days is only 7 calendar days when you start on a business
   day — from a Saturday or Sunday start the jump lands a day early: from Sunday
   2023-01-01, WORKDAY(-60) is 2022-10-10, the week-skip gives 2022-10-07. (2) Once
   CFG.HOLIDAYS is non-empty the premise collapses entirely, because a week
   containing a holiday has four business days, not five — so the shortcut would
   appear correct today and start silently shifting every calculated date the day
   someone populates HOLIDAYS. An exhaustive diff over 205,130 (start, offset)
   pairs found mismatches in both cases.

   The loop is not the bottleneck anyway. isBiz no longer allocates, and effective()
   below memoises, so each cell is computed once per render instead of once per
   render *and* twice per sort comparison. Don't "optimise" this again without
   diffing it against every offset in CFG.DATE_RULES from a weekend start. */
function workday(startIso, n, calendar){
  const d = parseIso(startIso); if(!d) return null;
  if(calendar){ d.setUTCDate(d.getUTCDate()+n); return iso(d); }
  let step = n>=0?1:-1, remaining=Math.abs(n);
  while(remaining>0){ d.setUTCDate(d.getUTCDate()+step); if(isBiz(d)) remaining--; }
  return iso(d);
}
/* effective value of a flow field: manual override wins, else computed.

   MEMOISED, because it is called far more often than it looks. Every render walks
   every row × 6 calculated columns, the rules recurse (pricing_stage -> estimate_eta,
   loc_upload -> tasks_start), and sortView's comparator used to call it for both
   operands of every comparison. Measured on real data at live row counts: a sorted
   Tampa render spent 1,589 ms and made 1,071,962 toISOString() calls; Orlando 807 ms.
   With this memo plus the workday change above, 39 ms and 9,546 calls.

   The cache is keyed by row id + field and MUST be cleared whenever a row changes —
   clearEffCache() is called from loadDivision, saveFlowCell, applyBulk and onRemote.
   A row with no id (never persisted) is not cached. */
let _effCache=new Map();
function clearEffCache(){ _effCache.clear(); }
function effective(row, field){
  if(field==="first_trench_date" || field==="released") return row[field]||null;
  const rule = CFG.DATE_RULES[field];
  if(row[field]) return row[field];           // manual override stored on the row
  if(!rule) return row[field]||null;
  const key = row.id ? row.id+"|"+field : null;
  if(key){ const hit=_effCache.get(key); if(hit!==undefined) return hit; }
  const base = effective(row, rule.from);
  const val = base ? workday(base, rule.days, rule.calendar) : null;
  if(key) _effCache.set(key, val);
  return val;
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
/* Two bugs lived in four lines here. (1) No paging, so this silently capped at
   1000 rows across ALL divisions combined — plan 1001 onward simply had no name,
   indistinguishable from "not mapped yet", which invites an admin to re-add
   mappings that already exist. (2) supabase-js resolves with {data,error} rather
   than rejecting, so the catch was dead code: on failure `data` was null,
   state.planNames became {}, and not even the console.warn fired. */
async function loadPlanNames(){
  if(DEMO){ state.planNames = window.TF_PLAN_NAMES || {}; return; }
  try{
    const rows=await sbAll(()=>sb.from("tf_plan_names").select("division,plan_no,name"), ["division","plan_no"]);
    const m={}; rows.forEach(r=>{ (m[r.division]=m[r.division]||{})[String(r.plan_no).trim().toUpperCase()]=r.name; });
    state.planNames=m;
  }catch(e){
    console.error("plan names load failed",e);
    state.planNames={};
    toast("Couldn't load plan names — the Plan Name column will be blank. Reload to retry.","err");
  }
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
  // Frequency tab: remember the date basis and range, but NOT the community/plan
  // picks — those are a momentary drill-down and shouldn't silently narrow the
  // report the next time the tab is opened.
  const fq=state.freq ? { basis:state.freq.basis, from:state.freq.from, to:state.freq.to } : null;
  try{ localStorage.setItem(prefsKey(), JSON.stringify({ divKey:state.divKey, view:state.view, sort:state.sort, colFilters:cf, freq:fq })); }catch(e){}
}
function applyPrefs(){
  const p=loadPrefs();
  if(p.divKey && CFG.DIVISIONS.some(d=>d.key===p.divKey)) state.divKey=p.divKey;
  if(["flow","budgets","changes","todo","plans","freq"].includes(p.view)) state.view=p.view;
  if(p.freq && typeof p.freq==="object"){ state.freq=Object.assign(freqState(), p.freq); freqState(); }
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
/* Sent-to-LOC: editors/admins always; if the column is locked to a user, only that
   user; if unlocked, anyone except a viewer may check it. */
function canToggleSentToLoc(){
  if(canEditDiv(state.divKey)) return true;
  const a=state.locLock;
  if(a) return lc(a)===lc(state.email);  // locked → the assigned user only
  return state.role!=="viewer";          // unlocked → anyone but a viewer
}

/* ---------------- auth ---------------- */
function authMsg(t,k){ const m=$("authMsg"); m.className="msg "+(k||"info"); m.textContent=t; }
function clearAuth(){ const m=$("authMsg"); m.className="msg"; m.textContent=""; }
function prettyErr(e, fallback){
  console.error("Auth error:", e);
  // Takeoff Flow no longer sends any email — surface the real server/DB error instead of
  // the old OTP-era "check SMTP" boilerplate, which misreported non-email failures.
  const msg=(e && (e.message||e.error_description||e.msg||e.hint||e.details))||"";
  return (msg && msg!=="{}" && msg!=="[object Object]") ? msg : fallback;
}
if(DEMO){ $("demoPill").classList.remove("hidden"); }

$("signinBtn").addEventListener("click", signIn);
$("email").addEventListener("keydown", e=>{ if(e.key==="Enter") $("password").focus(); });
$("password").addEventListener("keydown", e=>{ if(e.key==="Enter") signIn(); });

async function signIn(){
  const email=lc($("email").value);
  const password=$("password").value;
  clearAuth();
  if(!email || !email.includes("@")) return authMsg("Please enter your email address.","err");
  if(!email.endsWith(CFG.ALLOWED_DOMAIN)) return authMsg("Access is limited to "+CFG.ALLOWED_DOMAIN+" email addresses.","err");
  if(!password) return authMsg("Please enter your password.","err");
  $("signinBtn").disabled=true; $("signinBtn").textContent="Signing in…";
  try{
    if(DEMO){ await new Promise(r=>setTimeout(r,300)); await onSignedIn(email); return; }
    const { error }=await sb.auth.signInWithPassword({ email, password }); if(error) throw error;
    await onSignedIn(email);
  }catch(e){ const m=(e&&e.message)||"";
    const friendly = /invalid login credentials/i.test(m) ? "Incorrect email or password."
      : /email not confirmed/i.test(m) ? "Your account isn't activated yet — contact the portal admin."
      : prettyErr(e,"Sign-in failed.");
    authMsg(friendly,"err");
  }finally{ $("signinBtn").disabled=false; $("signinBtn").textContent="Sign in"; }
}

/* ---- password reset / new-user (admin-generated one-time link) ---- */
function getRecoverToken(){ const m=(location.hash||"").match(/[#&]recover=([^&]+)/); return m?decodeURIComponent(m[1]):null; }
function initRecovery(){
  const tok=getRecoverToken(); if(!tok) return false;
  window._recovering=true;
  $("app").classList.add("hidden"); $("auth").classList.remove("hidden");
  const sub=document.querySelector(".auth-sub"); if(sub) sub.textContent="Set a new password for your account.";
  $("stepSignin").classList.add("hidden"); $("stepRecover").classList.remove("hidden");
  $("setPassBtn").addEventListener("click",()=>redeemReset(tok));
  $("newPass2").addEventListener("keydown",e=>{ if(e.key==="Enter") redeemReset(tok); });
  return true;
}
async function redeemReset(tok){
  const p1=$("newPass").value, p2=$("newPass2").value; clearAuth();
  if(!p1 || p1.length<8) return authMsg("Password must be at least 8 characters.","err");
  if(p1!==p2) return authMsg("Passwords don't match.","err");
  if(DEMO) return authMsg("Password reset is disabled in demo mode.","err");
  $("setPassBtn").disabled=true; $("setPassBtn").textContent="Saving…";
  try{
    const { data, error }=await sb.rpc("redeem_reset_token",{ p_token:tok, p_new_password:p1 });
    if(error) throw error;
    if(!data || !data.ok) throw new Error((data&&data.error)||"Could not set your password.");
    $("stepRecover").classList.add("hidden");
    const sub=document.querySelector(".auth-sub"); if(sub) sub.textContent="Your password has been set. You can now sign in.";
    authMsg("Password updated — taking you to sign in…","ok");
    setTimeout(()=>{ location.hash=""; location.reload(); },1600);
  }catch(e){ authMsg((e&&e.message)||"Could not set your password.","err"); }
  finally{ $("setPassBtn").disabled=false; $("setPassBtn").textContent="Set password"; }
}

let _entered=false;
async function onSignedIn(email){
  if(window._recovering) return;                       // don't boot the app while setting a new password
  if(_entered) return; _entered=true;                 // guard against double-boot (signIn + onAuthStateChange)
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
  try{ sb.auth.onAuthStateChange((_e, session)=>{ if(session && session.user) onSignedIn(session.user.email); }); }catch(e){}
}

/* --------------- data layer --------------- */

/* loadDivision now throws when a read fails (see sbAll). Everything that loads a
   division goes through here so the two consequences are handled in one place.

   1. A FAILED LOAD MUST NOT LOOK LIKE AN EMPTY DIVISION. Previously sbAll
      swallowed the error and returned [], so a load failure rendered the grid's
      "No rows yet. Add a row or import the Start Schedule." empty state — a
      failure presented as a healthy, empty division, with an invitation to import
      into it. state.loadError makes render() show a retry instead.

   2. THE DIVISION SWITCH WAS A RACE. `sel.onchange` awaited loadDivision with no
      sequencing, so switching Orlando -> Tampa -> Orlando quickly (or once on a
      slow link) let the slower load resolve last: state.divKey said one division
      while state.flow held the other's rows, the banner paired the wrong label
      with the wrong count, and canEditDiv(state.divKey) authorised edits against
      rows belonging to the other division — which for an admin succeed. A
      monotonic token discards any load that is no longer the current one.        */
let _loadSeq=0;
async function loadDivisionGuarded(div){
  const seq=++_loadSeq;
  state.loadError=null;
  try{
    await loadDivision(div);
    if(seq!==_loadSeq) return false;        // superseded by a newer switch — drop it
    return true;
  }catch(e){
    if(seq!==_loadSeq) return false;
    console.error("division load failed:", e);
    state.loadError=e.message||String(e);
    state.flow=[]; state.cols=[]; state.changes=[]; state.checks={}; state.status={};
    return false;
  }
}

async function loadDivision(div){
  clearUndo();       // undo history is scoped to the currently-loaded division
  clearEffCache();   // calculated dates are memoised per row id — see effective()
  if(DEMO){
    await ensureSeed();
    state.flow    = MEM.flow_rows.filter(r=>r.division===div).sort(bySort);
    state.cols    = MEM.pending_budget_cols.filter(c=>c.division===div).sort(bySort);
    state.changes = MEM.takeoff_changes.filter(c=>c.division===div).sort((a,b)=>(b.req_date||"").localeCompare(a.req_date||""));
    state.checks  = keyChecks(MEM.pending_budget_checks);
    state.status  = keyStatus(MEM.pending_budget_status);
    state.locLock = (MEM.locLocks||{})[div] || null;
    return;
  }
  /* Every sbAll gets a unique ORDER BY — see sbAll. pending_budget_checks is keyed
     (flow_id, col_id) and pending_budget_status by flow_id, so those are the unique
     sorts; the rest use id. If any page fails, sbAll throws and this rejects, which
     is deliberate: loadDivision's callers must not render an empty grid as if the
     division were genuinely empty. */
  const [flow, cols, checks, status, changes, lock] = await Promise.all([
    sbAll(()=>sb.from("flow_rows").select("*").eq("division",div), "id"),
    sbAll(()=>sb.from("pending_budget_cols").select("*").eq("division",div), "id"),
    sbAll(()=>sb.from("pending_budget_checks").select("*"), ["flow_id","col_id"]),
    sbAll(()=>sb.from("pending_budget_status").select("*"), "flow_id"),
    sbAll(()=>sb.from("takeoff_changes").select("*").eq("division",div), "id"),
    /* The lock read stays soft, but note WHICH way it fails. supabase-js resolves
       with {data,error} rather than rejecting, so the old catch here was dead code
       and a real error surfaced as data:null — i.e. "no lock", which makes
       canToggleSentToLoc() enable the checkbox for everyone and the RPC then
       refuse the write. Check error explicitly and treat an unreadable lock as
       LOCKED (the safe direction) rather than absent. */
    (async()=>{ const { data, error }=await sb.from("tf_loc_locks").select("assigned_email").eq("division",div).maybeSingle();
      if(error){ console.warn("loc lock read failed:", error); return { assigned_email:"__unreadable__" }; }
      return data; })()
  ]);
  state.locLock = (lock && lock.assigned_email && String(lock.assigned_email).trim()) || null;
  state.flow    = flow.sort(bySort);
  state.cols    = cols.sort(bySort);
  state.changes = changes.sort((a,b)=>(b.req_date||"").localeCompare(a.req_date||""));
  const ids=new Set(state.flow.map(r=>r.id));
  state.checks  = keyChecks(checks.filter(c=>ids.has(c.flow_id)));
  state.status  = keyStatus(status.filter(s=>ids.has(s.flow_id)));
}
/* Supabase caps a single request at 1000 rows — page through with .range() to get all.
   Pass a factory so each page gets a fresh query builder.

   TWO THINGS HERE ARE LOAD-BEARING.

   1. It THROWS on error. It used to `break` and return whatever it had, which made
      a failed page indistinguishable from the end of the table. existingFlow() is
      the only source of truth for the import diff, so one transient 502 or expired
      JWT during a preview silently truncated "what already exists", every missing
      row was classified as new, and the preview confidently offered to insert
      duplicates. That is the Blueprint import bug with an error instead of a row
      cap as the truncation mechanism. A partial read must be an error, never a
      short answer — callers decide what to do about it.

   2. `orderBy` is REQUIRED, and must be unique. Offset pagination without a
      deterministic sort is not a pager: Postgres guarantees no ordering, and every
      UPDATE writes a new tuple version (typically at the end of the heap), so rows
      move between requests. A row that relocates past the page boundary is
      silently skipped; one that relocates backward comes back twice. This is not
      theoretical — pending_budget_checks is multi-page and every tick is an
      upsert, i.e. exactly the operation that relocates tuples, so ticked boxes
      could load as unticked and self-heal on reload. */
async function sbAll(makeQuery, orderBy){
  if(!orderBy) throw new Error("sbAll: an orderBy column is required — unordered .range() paging silently skips rows");
  const PAGE=1000; let from=0, out=[];
  for(;;){
    let q=makeQuery();
    for(const col of [].concat(orderBy)) q=q.order(col,{ascending:true});
    const { data, error } = await q.range(from, from+PAGE-1);
    if(error){ console.error("load error:", error); throw new Error(error.message||String(error)); }
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
    /* NO FALLBACK. This used to retry as a plain unguarded update "so the save
       still succeeds", and return {ok:true}. That turned any error — a transient
       500, a pooler reset, a statement timeout, a cast failure on the filter value
       — into a last-write-wins overwrite that discarded whatever another user had
       just written to this exact cell, recorded an undo entry, and told the user
       nothing. It was a hole straight through the app's only concurrency control,
       presented in the comment as a safety net. Report and let the user retry. */
    console.error(error);
    toast("Save failed: "+error.message+" — your change was not saved. Try again.","err");
    return {ok:false, current:oldVal};
  }
  if(data && data.length===1) return {ok:true};
  // 0 rows changed → the cell moved under us, or it already holds the value we wanted
  /* Check the refetch's error rather than ignoring it. On a failed refetch this
     used to fall back to `current = oldVal`, which makes sameVal(current,newVal)
     false and produces the "this cell was just changed by someone else" toast when
     in fact nobody changed anything and the write was refused by RLS — sending the
     user to argue with a colleague about an edit that never happened. */
  const { data:fresh, error:eRefetch } = await sb.from(table).select(field+",updated_by").eq("id",id).maybeSingle();
  if(eRefetch){
    console.error(eRefetch);
    toast("Not saved, and couldn't re-read the cell: "+eRefetch.message,"err");
    return {ok:false, current:oldVal};
  }
  const current = fresh ? fresh[field] : oldVal;
  if(sameVal(current,newVal)) return {ok:true};
  const who = (fresh&&fresh.updated_by) ? " by "+String(fresh.updated_by).split("@")[0] : "";
  toast("Not saved — this cell was just changed"+who+". Showing the latest value; re-enter your change to keep it.","err");
  return {ok:false, current};
}
/* savePatch / saveCheck / saveStatus / saveSentToLoc return true on success, false when the
   write was refused (RLS, network) so an optimistic caller can put the UI back. */
async function savePatch(table, id, patch){
  const body={ ...patch, updated_at:new Date().toISOString(), updated_by:state.email };
  if(DEMO){ const row=(MEM[table]||[]).find(x=>x.id===id); if(row) Object.assign(row,body); return true; }
  const { error } = await sb.from(table).update(body).eq("id",id); if(error){ console.error(error); toast("Save failed: "+error.message,"err"); return false; }
  return true;
}

/* ---- Undo (Flow tab): reverses THIS browser's recent Flow edits, newest first.
   Each entry carries an async undo() that writes the prior value(s) back. Cleared on
   division change so it never reverts rows that aren't loaded. ---- */
const undoStack=[];
function pushUndo(entry){ undoStack.push(entry); if(undoStack.length>50) undoStack.shift(); updateUndoBtn(); }
function clearUndo(){ undoStack.length=0; updateUndoBtn(); }
function updateUndoBtn(){ const b=$("undoFlowBtn"); if(!b) return; b.disabled=!undoStack.length; b.title=undoStack.length?("Undo "+undoStack[undoStack.length-1].label):"Nothing to undo"; }
async function doUndo(){
  const e=undoStack.pop(); if(!e){ return; }
  try{ await e.undo(); toast("Undid "+e.label+".","ok"); }
  catch(err){ console.error(err); toast("Undo failed: "+((err&&err.message)||err),"err"); }
  updateUndoBtn(); render();
}
async function deleteRow(table, id){
  if(DEMO){ MEM[table]=MEM[table].filter(x=>x.id!==id); return; }
  const { error } = await sb.from(table).delete().eq("id",id); if(error){ console.error(error); toast("Delete failed: "+error.message,"err"); }
}
async function saveCheck(flow_id, col_id, checked){
  const row={ flow_id, col_id, checked, updated_by:state.email, updated_at:new Date().toISOString() };
  if(DEMO){ const a=MEM.pending_budget_checks; const i=a.findIndex(x=>x.flow_id===flow_id&&x.col_id===col_id); if(i>=0)a[i]=row; else a.push(row); return true; }
  const { error } = await sb.from("pending_budget_checks").upsert(row,{ onConflict:"flow_id,col_id" }); if(error){ toast("Save failed: "+error.message,"err"); return false; }
  return true;
}
/* Writes ONLY the toggled column. It used to send both sim_reviewed and
   sent_to_loc, sourced from this browser's cached state.status — so an editor
   ticking SIM Reviewed also wrote their possibly-stale copy of sent_to_loc. If a
   purchasing user had set Sent-to-LOC in the meantime and the realtime event
   hadn't landed (socket down, tab backgrounded, token expired), the editor's
   unrelated tick silently reverted it, and the purchasing user watched their own
   checkbox un-check itself. Exactly the failure the saveField comment above was
   written to prevent, one table over.

   The upsert still needs a full row when inserting, so the fallback columns are
   only used on a genuine INSERT — merge-duplicates then updates just `patch`'s
   keys. Note postgrest-js takes the union of keys across the array; this is a
   single object, so the key set is exactly what we send. */
async function saveStatus(flow_id, patch){
  const cur=state.status[flow_id]||{sim_reviewed:false,sent_to_loc:false};
  const next={sim_reviewed:cur.sim_reviewed, sent_to_loc:cur.sent_to_loc, ...patch};
  state.status[flow_id]=next;
  const meta={ updated_by:state.email, updated_at:new Date().toISOString() };
  if(DEMO){ const a=MEM.pending_budget_status; const i=a.findIndex(x=>x.flow_id===flow_id);
    const row={flow_id, ...next, ...meta}; if(i>=0)a[i]=row; else a.push(row); return true; }
  // update the one column first; only insert a row if none exists yet
  const { data, error } = await sb.from("pending_budget_status")
    .update({ ...patch, ...meta }).eq("flow_id",flow_id).select();
  if(error){ toast("Save failed: "+error.message,"err"); return false; }
  if(data && data.length) return true;
  const { error:eIns } = await sb.from("pending_budget_status")
    .insert({ flow_id, sim_reviewed:!!next.sim_reviewed, sent_to_loc:!!next.sent_to_loc, ...meta });
  if(eIns){ toast("Save failed: "+eIns.message,"err"); return false; }
  return true;
}
/* Sent-to-LOC toggles go through an RPC that enforces the per-division lock server-side
   (and only ever touches sent_to_loc, so sim_reviewed stays editor-only). */
async function saveSentToLoc(flow_id, val){
  if(DEMO){ const a=MEM.pending_budget_status; const i=a.findIndex(x=>x.flow_id===flow_id); if(i>=0)a[i].sent_to_loc=val; else a.push({flow_id,sim_reviewed:false,sent_to_loc:val}); return true; }
  const { error } = await sb.rpc("tf_set_sent_to_loc",{ p_flow_id:flow_id, p_value:val }); if(error){ toast("Save failed: "+error.message,"err"); return false; }
  return true;
}
/* Editor/admin sets or clears the user the Sent-to-LOC column is locked to (per division). */
function openLocLockModal(){
  const div=state.divKey, cur=state.locLock||"";
  document.querySelectorAll(".modal-ov").forEach(m=>m.remove());
  const ov=document.createElement("div"); ov.className="modal-ov";
  ov.innerHTML=`<div class="modal-card" style="max-width:460px">
    <div class="modal-h">Lock “Sent to LOC”<button class="linkbtn" data-x aria-label="Close">&times;</button></div>
    <div class="modal-body">
      <p class="tiny" style="text-align:left;margin:0 0 12px">Lock this column to one person so only they (plus editors and admins) can tick it. Leave it blank and <b>anyone</b> can check the boxes.</p>
      <label class="fld" for="llEmail">Locked to</label>
      <input type="email" id="llEmail" placeholder="name@lennar.com" value="${esc(cur)}"${state.users&&state.users.length?' list="llUsers"':''}>
      ${state.users&&state.users.length?`<datalist id="llUsers">${state.users.map(u=>`<option value="${esc(u.email)}">`).join("")}</datalist>`:""}
      <div id="llMsg" class="msg"></div>
      <div class="modal-actions" style="margin-top:14px"><button class="btn" id="llSave">Save</button>${cur?`<button class="btn ghost" id="llClear">Remove lock</button>`:""}<button class="btn ghost" id="llCancel">Cancel</button></div>
    </div></div>`;
  document.body.appendChild(ov);
  const close=()=>ov.remove();
  ov.addEventListener("click",e=>{ if(e.target===ov) close(); });
  ov.querySelector("[data-x]").onclick=close; ov.querySelector("#llCancel").onclick=close;
  const msg=(t,k)=>{ const m=ov.querySelector("#llMsg"); m.className="msg "+(k||"info"); m.textContent=t; };
  ov.querySelector("#llSave").onclick=async()=>{
    const email=lc(ov.querySelector("#llEmail").value);
    if(email && !email.endsWith(CFG.ALLOWED_DOMAIN)) return msg("Email must be "+CFG.ALLOWED_DOMAIN,"err");
    if(!email){ await clearLocLock(div); close(); return; }
    if(DEMO){ MEM.locLocks[div]=email; } else { const { error }=await sb.from("tf_loc_locks").upsert({division:div, assigned_email:email, updated_by:state.email, updated_at:new Date().toISOString()},{onConflict:"division"}); if(error) return msg("Save failed: "+error.message,"err"); }
    state.locLock=email; close(); render();
  };
  const clr=ov.querySelector("#llClear"); if(clr) clr.onclick=async()=>{ await clearLocLock(div); close(); };
}
async function clearLocLock(div){
  if(DEMO){ delete MEM.locLocks[div]; } else { try{ await sb.from("tf_loc_locks").delete().eq("division",div); }catch(e){ toast("Could not remove lock: "+(e.message||e),"err"); return; } }
  state.locLock=null; render();
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
  sel.onchange=async()=>{ state.divKey=sel.value; await loadDivisionGuarded(state.divKey); render(); renderPlanNames(); restartRealtime(); };
  // tabs
  document.querySelectorAll(".tab").forEach(t=>t.onclick=()=>{ document.querySelectorAll(".tab").forEach(x=>x.classList.remove("active")); t.classList.add("active"); state.view=t.dataset.view; state.filter=""; $("globalSearch").value=""; render(); });
  // topbar buttons
  $("homeLogo").onclick=()=>showDash();
  $("dashLink").onclick=()=>showDash();
  $("adminLink").onclick=()=>showAdmin();
  $("themeBtn").onclick=toggleTheme;
  $("whatsNewBtn").onclick=openWhatsNew;
  $("logoutBtn").onclick=async()=>{ if(!DEMO&&sb){ try{ await sb.auth.signOut({scope:"global"}); }catch(e){} try{ localStorage.removeItem("lennar-vendor-portal-auth"); }catch(e){} } location.reload(); };
  /* Debounced. This rendered the whole grid on every keystroke, and a sorted Tampa
     render measured 1,589 ms — so each character froze the tab and keystrokes
     queued behind it. The memo in effective() brings that to ~67 ms, which makes
     typing usable on its own, but the grid is still ~71,000 DOM nodes for Tampa so
     there is no reason to rebuild it mid-word. */
  let _searchT=null;
  $("globalSearch").oninput=e=>{
    const v=lc(e.target.value);
    clearTimeout(_searchT);
    _searchT=setTimeout(()=>{ if(state.filter!==v){ state.filter=v; render(); } }, 150);
  };
  loadPlanNames().then(()=>loadDivisionGuarded(state.divKey)).then(()=>{ render(); refreshWhatsNewBadge(); startRealtime(); });
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
  /* A failed load is not an empty division. Without this the grid's "No rows yet"
     empty state is shown for a load that errored, which reads as "this division is
     genuinely empty — import something", and an import against a truncated view of
     what exists is how duplicates get created. Fail loudly instead. */
  if(state.loadError){
    tb.innerHTML="";
    area.innerHTML=`<div class="empty"><b>Couldn't load ${esc((CFG.DIVISIONS.find(d=>d.key===state.divKey)||{}).label||state.divKey)}.</b>`
      + `<div class="tiny" style="margin:6px 0 10px">${esc(state.loadError)}</div>`
      + `<div class="tiny">Nothing is shown because the rows could not be read — this is <b>not</b> an empty division. `
      + `Don't import until it loads: an import compares against what it can read.</div>`
      + `<button class="btn" id="retryLoad" style="margin-top:10px">Retry</button></div>`;
    const rb=$("retryLoad");
    if(rb) rb.onclick=async()=>{ rb.disabled=true; rb.textContent="Loading…"; await loadDivisionGuarded(state.divKey); render(); };
    savePrefs();
    return;
  }
  const sc=[...area.querySelectorAll(".grid-wrap")].map(el=>[el.scrollLeft,el.scrollTop]);  // preserve scroll across re-render
  if(state.view==="flow")         renderFlow(tb,area);
  else if(state.view==="budgets") renderBudgets(tb,area);
  else if(state.view==="changes") renderChanges(tb,area);
  else if(state.view==="todo")    renderTodo(tb,area);
  else if(state.view==="plans")   renderPlans(tb,area);
  else if(state.view==="freq")    renderFreq(tb,area);
  area.querySelectorAll(".grid-wrap").forEach((el,i)=>{ if(sc[i]){ el.scrollLeft=sc[i][0]; el.scrollTop=sc[i][1]; } });
  tb.querySelectorAll("[data-export]").forEach(b=>b.onclick=exportCSV);
  tb.querySelectorAll("[data-clearfilters]").forEach(b=>{ b.onclick=clearViewFilters; b.disabled=!anyFilters(); });
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
  {f:"first_trench_date", h:"First Trench", type:"date", auto:true, readonly:true},
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
       <button class="btn mini ghost" id="undoFlowBtn" title="Nothing to undo">&#8630; Undo</button>
       <button class="btn mini ghost" id="importBtn">Import Start Schedule…</button>`:"")
    + `<button class="btn mini ghost" data-clearfilters>Clear filters</button>`
    + `<button class="btn mini ghost" data-export>&#8681; Export CSV</button>`
    + `<span class="grow"></span>`
    + `<span class="section-note" style="margin:0">Works like Excel: click to select, drag or Shift-click for a range; double-click, Enter, or just type to edit; Ctrl+D fill down, Ctrl+R fill right, Ctrl+C/Ctrl+V copy/paste, Delete to clear, or drag the corner handle. Blue columns auto-calculate.</span>`;
  let h=`<div class="grid-wrap"><table class="grid"><thead>${theadHTML(cols,canEd)}</thead><tbody>`;
  if(!rows.length) h+=`<tr><td colspan="${FLOW_COLS.length+(canEd?1:0)}"><div class="empty">No rows yet. ${canEd?"Add a row or import the Start Schedule.":""}</div></td></tr>`;
  rows.forEach(r=>{
    h+=`<tr>`;
    if(canEd) h+=`<td class="rowhandle"><button class="delrow" data-del="${r.id}" title="Delete row">×</button></td>`;
    FLOW_COLS.forEach(c=>{
      if(c.readonly){   // auto, system-maintained (e.g. First Trench = earliest from import); shown but not editable
        const val=r[c.f], disp=c.type==="date"?fmtDate(val):(val==null?"":String(val));
        h+=`<td class="calc"><span class="cell ${disp?'':'empty'}" data-id="${r.id}" data-field="${c.f}" data-type="${c.type}"><span class="val">${esc(disp)}</span></span></td>`;
      }else if(c.calc){
        const ov=isOverride(r,c.f), val=effective(r,c.f);
        const tt=ov?' title="Manual override — click and clear to reset to auto"':'';
        h+=`<td class="calc ${ov?'overridden':''}"${tt}><span class="cell ${canEd?'editable':''} ${val?'':'empty'}" data-id="${r.id}" data-field="${c.f}" data-type="date"><span class="val">${esc(fmtDate(val))}</span></span></td>`;
      }else if(c.get){
        const disp=c.get(r)||"";   // read-only (e.g. Plan Name) — managed in Admin › Plan names
        h+=`<td><span class="cell ${disp?'':'empty'}" data-id="${r.id}" data-field="${c.f}" data-type="text"><span class="val">${esc(disp)}</span></span></td>`;
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
    $("addFlow").onclick=async()=>{ const r={ id:uid(), division:state.divKey, sort_order:(state.flow.at(-1)?.sort_order||0)+1 }; state.flow.push(r); await saveRow("flow_rows",r);
      pushUndo({ label:"add row", undo:async()=>{ state.flow=state.flow.filter(x=>x.id!==r.id); await deleteRow("flow_rows",r.id); } }); render(); };
    $("importBtn").onclick=showAdmin;
    $("undoFlowBtn").onclick=doUndo; updateUndoBtn();
    /* pending_budget_checks and pending_budget_status reference flow_rows(id) ON
       DELETE CASCADE, so deleting a row also destroys every Pending Budgets tick on
       it plus its SIM Reviewed / Sent to LOC state. Undo restored only the flow row
       and then toasted "Undid delete row." — the row came back, so the ticks looked
       like they had too. Snapshot the children and restore them as well, and say so
       in the confirm. */
    area.querySelectorAll("[data-del]").forEach(b=>b.onclick=async()=>{
      const id=b.dataset.del;
      const kids=Object.keys(state.checks).filter(k=>k.startsWith(id+"::") && state.checks[k]).length;
      const st=state.status[id]||{};
      const extra=[kids?`${kids} budget tick(s)`:"", (st.sim_reviewed||st.sent_to_loc)?"its SIM Reviewed / Sent-to-LOC state":""].filter(Boolean).join(" and ");
      if(!confirm(`Delete this row?${extra?`\n\nThis also removes ${extra}. Undo restores all of it, but only in this browser session.`:""}`)) return;
      const snap={...state.flow.find(x=>x.id===id)};
      const chkSnap=Object.keys(state.checks).filter(k=>k.startsWith(id+"::"))
        .map(k=>({ flow_id:id, col_id:k.slice(id.length+2), checked:!!state.checks[k] }));
      const stSnap=state.status[id]?{...state.status[id]}:null;
      await deleteRow("flow_rows",id);
      state.flow=state.flow.filter(x=>x.id!==id);
      pushUndo({ label:"delete row", undo:async()=>{
        await saveRow("flow_rows",snap);
        if(!state.flow.some(x=>x.id===snap.id)){ state.flow.push(snap); state.flow.sort(bySort); }
        for(const c of chkSnap){ await saveCheck(c.flow_id, c.col_id, c.checked); }
        if(stSnap) await saveStatus(id, stSnap);
        clearEffCache();
      } });
      render(); });
  }
}
async function saveFlowCell(id, field, type, value){
  const r=state.flow.find(x=>x.id===id); if(!r) return;
  const oldVal = r[field]===undefined?null:r[field];
  const newVal = value===""?null:value;
  /* No-op commits used to call render(), so merely clicking into a cell and
     clicking away (startEdit commits on blur) rebuilt the entire grid — ~71,000
     DOM nodes for Tampa. Nothing changed, so there is nothing to re-render. */
  if(sameVal(oldVal,newVal)) return;
  r[field]=newVal;
  clearEffCache();                 // this row's calculated dates are now stale
  const res = await saveField("flow_rows", id, field, newVal, oldVal);
  if(res && res.ok===false && "current" in res) r[field]=res.current; // conflict: show latest, don't record undo
  /* Undo goes through saveField, not savePatch. savePatch is an unguarded write:
     undoing an edit that a colleague has since corrected would silently destroy
     their correction and report success. saveField's compare-and-set detects that
     the cell no longer holds what we wrote and refuses, and we say so. */
  else pushUndo({ label:`edit ${field.replace(/_/g," ")}`, undo:async()=>{
    const rr=state.flow.find(x=>x.id===id);
    const res2=await saveField("flow_rows",id,field,oldVal,newVal);
    if(res2 && res2.ok===false && "current" in res2){
      if(rr) rr[field]=res2.current;
      toast("Not undone — someone else changed that cell since. Showing their value.","err");
    } else if(rr) rr[field]=oldVal;
    clearEffCache();
  } });
  clearEffCache();
  render(); // recompute dependent calc columns
}

/* ===================================================================
   TAB 2 · PENDING BUDGETS  (auto-mirror flow rows + per-email checkbox cols)
   =================================================================== */
function renderBudgets(tb,area){
  const canMng=canManageCols(state.divKey), canEd=canEditDiv(state.divKey);
  tb.innerHTML=`<span class="count">${flowRows().length} row(s) · ${state.cols.length} cost managers(s)</span>`
    + (canMng?`<button class="btn mini" id="addCol">+Cost Manager</button>`:"")
    + `<button class="btn mini ghost" data-clearfilters>Clear filters</button>`
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
    if(col.f==="sent"){ const a=state.locLock;
      title=a?` title="Locked to ${esc(a)} — only they (and editors) can check it"`:` title="Unlocked — anyone except viewers can check it"`;
      extra=canMng?`<span class="colhead-tools"><button data-loclock title="${a?"Locked to "+esc(a)+" — click to change":"Lock to a user"}">${a?"&#128274;":"&#128275;"}</button></span>`
                  :(a?`<span class="colhead-flag">${esc(a.split("@")[0])}</span>`:""); }
    h+=`<th${title} class="${col.cls||""} sorth" data-sort="${col.f}">${esc(col.h)}${col.calc?'<span class="calc-badge">auto</span>':""}<span class="sort-ind">${ind}</span>${extra}</th>`;
  });
  h+=`</tr><tr class="filterrow">`;
  cols.forEach(col=>h+=filterCellHTML(col));
  h+=`</tr></thead><tbody>`;
  const spanN=5+state.cols.length+6;
  if(!rows.length) h+=`<tr><td colspan="${spanN}"><div class="empty">No rows. Add rows on the Flow of Takeoffs tab.</div></td></tr>`;
  rows.forEach(r=>{
    const st=state.status[r.id]||{sim_reviewed:false,sent_to_loc:false};
    h+=`<tr><td><span class="cell"><span class="val">${esc(r.community_name||'')}</span></span></td>`
      + `<td><span class="cell"><span class="val">${esc(r.community_num||'')}</span></span></td>`
      + `<td><span class="cell"><span class="val">${esc(r.plan||'')}</span></span></td>`
      + `<td><span class="cell"><span class="val">${esc(planName(r))}</span></span></td>`
      + `<td><span class="cell"><span class="val">${esc(r.elevation||'')}</span></span></td>`
      + `<td class="calc"><span class="cell"><span class="val">${esc(fmtDate(effective(r,"released")))}</span></span></td>`;
    state.cols.forEach(c=>{
      const on=!!state.checks[r.id+"::"+c.id], allow=canToggleCheck(c);
      h+=`<td class="chkcell"><input type="checkbox" class="chk" data-chk="${r.id}" data-col="${c.id}" ${on?"checked":""} ${allow?"":"disabled"}></td>`;
    });
    h+=`<td class="chkcell"><input type="checkbox" class="chk" data-st="${r.id}" data-k="sim_reviewed" ${st.sim_reviewed?"checked":""} ${canEd?"":"disabled"}></td>`
      + `<td class="chkcell"><input type="checkbox" class="chk" data-st="${r.id}" data-k="sent_to_loc" ${st.sent_to_loc?"checked":""} ${canToggleSentToLoc()?"":"disabled"}></td>`
      + `<td class="calc"><span class="cell"><span class="val">${esc(fmtDate(workday(r.first_trench_date,-30,true)))}</span></span></td>`
      + `<td class="calc"><span class="cell"><span class="val">${esc(fmtDate(effective(r,"loc_upload")))}</span></span></td>`
      + `<td class="calc"><span class="cell"><span class="val">${esc(fmtDate(effective(r,"tasks_start")))}</span></span></td>`
      + `<td class="calc"><span class="cell"><span class="val">${esc(fmtDate(r.first_trench_date))}</span></span></td></tr>`;
  });
  h+=`</tbody></table></div>`;
  area.innerHTML=h;
  bindHeader(area, cols, flowRows());
  // Ticks are optimistic; if the write is refused (RLS, offline) the prior value goes back
  // into state AND onto the box, so the grid never shows a check the database doesn't have.
  area.querySelectorAll("[data-chk]").forEach(cb=>cb.onchange=async()=>{ const fid=cb.dataset.chk, cid=cb.dataset.col, key=fid+"::"+cid, prev=!!state.checks[key];
    state.checks[key]=cb.checked;
    if(!await saveCheck(fid,cid,cb.checked)){ state.checks[key]=prev; cb.checked=prev; } });
  area.querySelectorAll("[data-st]").forEach(cb=>cb.onchange=async()=>{ const fid=cb.dataset.st, k=cb.dataset.k;
    const prev={...(state.status[fid]||{sim_reviewed:false,sent_to_loc:false})};
    if(k==="sent_to_loc"){ state.status[fid]={sim_reviewed:prev.sim_reviewed, sent_to_loc:cb.checked};
      if(!await saveSentToLoc(fid, cb.checked)){ state.status[fid]=prev; cb.checked=prev.sent_to_loc; } }
    else if(!await saveStatus(fid,{[k]:cb.checked})){ state.status[fid]=prev; cb.checked=prev[k]; } });
  const ll=area.querySelector("[data-loclock]"); if(ll) ll.onclick=(e)=>{ e.stopPropagation(); openLocLockModal(); };
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
    {f:"community_num",h:"Community #",disp:r=>r.community_num||"",raw:r=>r.community_num||""},
    {f:"plan",h:"Plan",disp:r=>r.plan||"",raw:r=>r.plan||""},
    {f:"plan_name",h:"Plan Name",disp:r=>planName(r),raw:r=>planName(r)},
    {f:"elevation",h:"Elev",disp:r=>r.elevation||"",raw:r=>r.elevation||""},
    {f:"released",h:"Estimating Release",cls:"calc",calc:true,fdate:true,disp:r=>fmtDate(effective(r,"released")),raw:r=>effective(r,"released")||""}
  ];
  state.cols.forEach(c=>list.push({f:"c_"+c.id,h:c.name,person:c,disp:r=>state.checks[r.id+"::"+c.id]?"Yes":"No",raw:r=>state.checks[r.id+"::"+c.id]?1:0}));
  list.push(
    {f:"sim",h:"SIM Reviewed",disp:r=>(state.status[r.id]||{}).sim_reviewed?"Yes":"No",raw:r=>(state.status[r.id]||{}).sim_reviewed?1:0},
    {f:"sent",h:"Sent to LOC",disp:r=>(state.status[r.id]||{}).sent_to_loc?"Yes":"No",raw:r=>(state.status[r.id]||{}).sent_to_loc?1:0},
    {f:"pricing_due",h:"Pricing Due",cls:"calc",calc:true,fdate:true,disp:r=>fmtDate(workday(r.first_trench_date,-30,true)),raw:r=>workday(r.first_trench_date,-30,true)||""},
    {f:"loc_upload",h:"LOC Upload",cls:"calc",calc:true,fdate:true,disp:r=>fmtDate(effective(r,"loc_upload")),raw:r=>effective(r,"loc_upload")||""},
    {f:"tasks_start",h:"Tasks Start",cls:"calc",calc:true,fdate:true,disp:r=>fmtDate(effective(r,"tasks_start")),raw:r=>effective(r,"tasks_start")||""},
    {f:"trench",h:"Trench Date",cls:"calc",calc:true,fdate:true,disp:r=>fmtDate(r.first_trench_date),raw:r=>r.first_trench_date||""}
  );
  return list;
}
/* modal editor for a Pending-Budgets person column (no browser prompts) */
/* Users who can be assigned a cost-manager column for a division: purchasing, editors,
   and admins that cover it. Uses an RPC because RLS otherwise hides other people's role
   rows from non-admins. Returns [{email, role}]. */
async function loadAssignableUsers(div){
  const match=u=> u.role==="admin" || (["editor","purchasing"].includes(u.role) && (!(u.divisions&&u.divisions.length)||u.divisions.includes(div)));
  if(DEMO){ return (MEM.app_roles||[]).filter(match).map(u=>({email:u.email, role:u.role})); }
  try{ const { data, error }=await sb.rpc("tf_assignable_users",{ p_division:div }); if(error) throw error; return (data||[]).map(u=>({email:u.email, role:u.role})); }
  catch(e){ console.warn("tf_assignable_users failed",e);
    return (state.users||[]).filter(match).map(u=>({email:u.email, role:u.role}));
  }
}
async function openColModal(col){
  const isNew=!col;
  document.querySelectorAll(".modal-ov").forEach(m=>m.remove());
  const curEmail=(col&&col.assigned_email)?lc(col.assigned_email):"";
  let people=[]; try{ people=await loadAssignableUsers(state.divKey); }catch(e){}
  const seen=new Set(), rows=[];
  people.forEach(p=>{ const e=lc(p.email); if(e && !seen.has(e)){ seen.add(e); rows.push({email:e, role:p.role}); } });
  if(curEmail && !seen.has(curEmail)) rows.unshift({email:curEmail, role:""});   // keep a current assignee even if their role changed
  const divLabel=(CFG.DIVISIONS.find(d=>d.key===state.divKey)||{}).label||state.divKey;
  const optionsHtml=`<option value="">— Unassigned (editors only) —</option>`+rows.map(r=>`<option value="${esc(r.email)}"${r.email===curEmail?" selected":""}>${esc(r.email)}${r.role?` (${esc(r.role)})`:""}</option>`).join("");
  const ov=document.createElement("div"); ov.className="modal-ov";
  ov.innerHTML=`<div class="modal-card" style="max-width:440px">
    <div class="modal-h">${isNew?"Add Cost Manager":"Edit column"}<button class="linkbtn" data-x aria-label="Close">&times;</button></div>
    <div class="modal-body">
      <label class="fld" for="mcName">Display name</label>
      <input type="text" id="mcName" value="${esc(col?col.name:"")}" placeholder="e.g. Jennifer">
      <label class="fld" for="mcEmail" style="margin-top:14px">Assigned user
        <span style="font-weight:400;color:var(--muted)">— only this purchasing user can tick this column (leave unassigned for editors only)</span></label>
      <select id="mcEmail">${optionsHtml}</select>
      ${rows.length?"":`<p class="tiny" style="text-align:left;margin:6px 0 0;color:var(--muted)">No purchasing, editor, or admin users cover ${esc(divLabel)} yet — add them in Admin &rsaquo; Access &amp; permissions.</p>`}
      <div id="mcMsg" class="msg"></div>
      <div class="modal-actions">
        <button class="btn" id="mcSave">${isNew?"Add column":"Save changes"}</button>
        <button class="btn ghost" id="mcCancel">Cancel</button>
        ${isNew?"":`<button class="btn danger" id="mcDel">Delete column</button>`}
      </div>
    </div></div>`;
  document.body.appendChild(ov);
  const emailInp=ov.querySelector("#mcEmail");
  const esc2=e=>{ if(e.key==="Escape") close(); };
  const close=()=>{ document.removeEventListener("keydown",esc2); ov.remove(); };   // every close path unhooks the key handler, not just Escape
  const mcmsg=t=>{ const m=ov.querySelector("#mcMsg"); m.className="msg err"; m.textContent=t; };
  ov.addEventListener("click",e=>{ if(e.target===ov) close(); });
  document.addEventListener("keydown",esc2);
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
  /* Undo button on this tab too. It has had the full Excel sheet model (Delete,
     Ctrl+D, Ctrl+R, fill handle, paste) as long as bindGrid has covered "changes",
     but undo was recorded only for the Flow view and this button was only rendered
     there — so bulk edits here were irreversible with nothing on screen to press.
     applyBulk records undo for both views now. */
  tb.innerHTML=`<span class="count">${pending} pending change requests</span>`
    + (canAdd?`<button class="btn mini" id="addChg">+ Add change request</button>`:"")
    + (canAdd?`<button class="btn mini ghost" id="undoFlowBtn" title="Nothing to undo">&#8630; Undo</button>`:"")
    + `<button class="btn mini ghost" data-clearfilters>Clear filters</button>`
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
  area.querySelectorAll("[data-chgchk]").forEach(cb=>cb.onchange=async()=>{ const r=state.changes.find(x=>x.id===cb.dataset.chgchk); if(!r)return; const f=cb.dataset.f;
    const prev=r[f], prevDate=r.completed_date;                     // optimistic: roll back if the write is refused
    r[f]=cb.checked; const patch={[f]:cb.checked}; if(f==="complete"){ r.completed_date = cb.checked ? (r.completed_date||todayIso()) : null; patch.completed_date=r.completed_date; }
    if(!await savePatch("takeoff_changes",r.id,patch)){ r[f]=prev; r.completed_date=prevDate; }
    render(); });
  { const ub=$("undoFlowBtn"); if(ub){ ub.onclick=doUndo; updateUndoBtn(); } }
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
    {f:"plan_name",     h:"Plan Name",disp:r=>planName(r),          raw:r=>planName(r)},
    {f:"elevation",     h:"Ele",      disp:r=>r.elevation||"",     raw:r=>r.elevation||""},
    {f:"first_trench_date",h:"Trench",fdate:true,disp:r=>fmtDate(r.first_trench_date),raw:r=>r.first_trench_date||""}
  ];
  const base=todoOutstanding().filter(r=>matchFilter([r.community_name,r.community_num,r.plan,r.elevation].join(" ")));
  const rows=sortView(passFilters(base,cols),cols);
  tb.innerHTML=`<span class="count">${rows.length} outstanding</span>`
    + `<button class="btn mini ghost" data-clearfilters>Clear filters</button>`
    + `<button class="btn mini ghost" data-export>&#8681; Export CSV</button>`
    + `<span class="grow"></span>`
    + `<span class="section-note" style="margin:0">Plan/elevations from Flow of Takeoffs that are <b>not yet completed</b> (no Released date). Fill in Released on the Flow tab and the item clears itself.</span>`;
  let h=`<div class="grid-wrap"><table class="grid"><thead>${theadHTML(cols,false)}</thead><tbody>`;
  if(!rows.length) h+=`<tr><td colspan="6"><div class="empty">Nothing outstanding — every plan/elevation has a Released date.</div></td></tr>`;
  rows.forEach(r=>{ h+=`<tr>`+cols.map(c=>`<td><span class="cell"><span class="val">${esc(c.disp(r))}</span></span></td>`).join("")+`</tr>`; });
  h+=`</tbody></table></div>`;
  area.innerHTML=h;
  bindHeader(area, cols, base);
}

/* ---------------- TAB 5 · PLANS (cross-reference: communities ↔ plans) ----------------
   Two modes group the results; a multi-select dropdown (same style as the column filters)
   picks the OTHER entity to search by:
     • By community → pick plans; communities that contain ALL picked plans are highlighted + first.
     • By plan      → pick communities; plans present in ALL picked communities are highlighted + first. */
/* ---- per-(community, plan) release status for the Plans-tab chips ----
   Aggregates Flow rows by community + plan:
     red   (off)  – the plan has no start on the start log from today forward
                    (e.g. removed from the community). Red is the most dominant
                    status: it wins even over fully released.
     green (done) – every elevation has a Released date
     yellow(part) – some elevations released
     blue  (none) – nothing released yet
   "On the start log going forward" comes from last_trench_date — the LATEST
   start seen for the combo in the most recent Starts Log import. (The row's
   first_trench_date is the EARLIEST-ever start, so it goes stale for any plan
   that began building months ago and must not drive red on its own.) Until a
   Starts Log import has stamped last_trench_date for the division, we can't
   tell who dropped off the log, so nothing is flagged red.               */
function planStatusIndex(){
  const idx=new Map(); const today=todayIso();
  state.flow.forEach(r=>{
    const ck=(r.community_num||r.community_name); if(!ck||!r.plan) return;
    const key=String(ck)+"|"+lc(String(r.plan));
    let e=idx.get(key); if(!e){ e={evs:new Map(), future:false, lastStart:null, anyLast:false}; idx.set(key,e); }
    const evKey=lc(r.elevation||"");
    let ev=e.evs.get(evKey); if(!ev){ ev={label:String(r.elevation||"").trim(), released:null, trench:null}; e.evs.set(evKey,ev); }
    const rel=effective(r,"released"); if(rel && (!ev.released || rel<ev.released)) ev.released=rel;
    const tr=r.first_trench_date||null; if(tr && (!ev.trench || tr<ev.trench)) ev.trench=tr;
    const last=r.last_trench_date||null;
    if(last){ e.anyLast=true; if(!e.lastStart || last>e.lastStart) e.lastStart=last; }
    if((tr && tr>=today) || (last && last>=today)) e.future=true;
  });
  idx.forEach(e=>{
    const evs=[...e.evs.values()].sort((a,b)=>a.label.localeCompare(b.label,undefined,{numeric:true}));
    e.list=evs; e.total=evs.length; e.done=evs.filter(v=>v.released).length;
    /* "Off the start log" requires evidence for THIS plan, not for the division.
       This used to test a single division-wide boolean (`state.flow.some(r =>
       r.last_trench_date)`), so the moment the first row in a division got a
       last_trench_date, every plan that had none was declared red with the
       tooltip asserting "Not on the start log from today forward" as fact — for
       hundreds of plans the import had simply never mentioned. Absence of data is
       not evidence of dropping off the log. No last_trench_date for this plan now
       means unknown, which falls through to the released-based statuses.        */
    const onLog = e.future || !e.anyLast;
    e.status = !onLog ? "off" : (e.total && e.done===e.total) ? "done" : e.done>0 ? "part" : "none";
  });
  return idx;
}
const PLAN_ST_LABEL={ done:"All elevations released", part:"Some elevations released",
  none:"Nothing released yet", off:"Not on the start log from today forward" };
function planTipHTML(entry, plan, planNm, commName){
  const head=`${esc(plan)}${planNm?` — ${esc(planNm)}`:""}`;
  const st=entry.status;
  const stLine=`${PLAN_ST_LABEL[st]}${entry.total?` · ${entry.done} of ${entry.total} released`:""}${st==="off"&&entry.lastStart?` · last start ${esc(fmtDate(entry.lastStart))}`:""}`;
  const rows=entry.list.map(ev=>{
    const right = ev.released ? `Released ${esc(fmtDate(ev.released))}`
      : `Pending${ev.trench?` · trench ${esc(fmtDate(ev.trench))}`:""}`;
    return `<div class="chip-tip-ev"><span class="chip-tip-evl">${esc(ev.label||"—")}</span><span class="chip-tip-evr ${ev.released?"ok":"pend"}">${right}</span></div>`;
  }).join("");
  return `<div class="chip-tip-h">${head}</div>`
    + (commName?`<div class="chip-tip-c">${esc(commName)}</div>`:"")
    + `<div class="chip-tip-st st-${st}">${stLine}</div>${rows}`;
}
/* The tooltip ELEMENT was guarded with if(!tip); the two listeners were not — and
   `container` is #viewArea, which survives every render (only its innerHTML is
   replaced). So every Plans render added another mouseover/mouseout pair, each
   closing over a stale index. After 20 renders, hovering one chip did 20 tooltip
   rebuilds and 60 forced layouts, and the stale closures pinned every previous
   index in memory. That is the "it gets slower the longer I leave it open"
   symptom. Wire once; keep the current index on the container so the single
   handler always reads fresh data. */
function attachChipTips(container, idx){
  container._psIdx = idx;
  let tip=$("chipTip");
  if(!tip){ tip=document.createElement("div"); tip.id="chipTip"; tip.className="chip-tip hidden"; document.body.appendChild(tip);
    window.addEventListener("scroll",()=>tip.classList.add("hidden"),{passive:true}); }
  if(container.dataset.chipTipsWired) return;
  container.dataset.chipTipsWired="1";
  const hide=()=>tip.classList.add("hidden");
  container.addEventListener("mouseover",e=>{
    const ch=e.target.closest(".chip[data-ttc]"); if(!ch) return;
    const idx=container._psIdx; if(!idx) return;
    const entry=idx.get(ch.dataset.ttc+"|"+lc(ch.dataset.ttp)); if(!entry) return;
    tip.innerHTML=planTipHTML(entry, ch.dataset.ttp, ch.dataset.ttn||"", ch.dataset.ttx||"");
    tip.classList.remove("hidden");
    const r=ch.getBoundingClientRect(), tw=tip.offsetWidth, th=tip.offsetHeight;
    let x=r.left+r.width/2-tw/2; x=Math.max(8,Math.min(x,window.innerWidth-tw-8));
    let y=r.top-th-8; if(y<8) y=r.bottom+8;
    tip.style.left=x+"px"; tip.style.top=y+"px";
  });
  container.addEventListener("mouseout",e=>{ if(e.target.closest(".chip[data-ttc]")) hide(); });
}
function renderPlans(tb,area){
  const mode = state.plansMode || "community";
  const pnm = (planLookup()[state.divKey])||{};
  const nameOf = pl => pnm[String(pl==null?"":pl).trim().toUpperCase()] || "";
  const mkBtn=(m,label)=>`<button class="btn mini ${mode===m?"":"ghost"}" data-pmode="${m}">${label}</button>`;
  if(!Array.isArray(state.plansSel)) state.plansSel=[];
  const psIdx=planStatusIndex();
  const stOf=(ck,p)=>{ const en=psIdx.get(String(ck)+"|"+lc(String(p))); return en?en.status:"none"; };

  // Aggregate. items = the cards; each carries a `set` of the OTHER entity it contains.
  // options = the pickable universe of that other entity.
  const items=[]; const optMap=new Map();   // value -> label
  if(mode==="community"){
    const byComm=new Map();
    state.flow.forEach(r=>{ const key=(r.community_num||r.community_name); if(!key||!r.plan) return;
      let e=byComm.get(key); if(!e){ e={ck:String(key), name:r.community_name||"", num:r.community_num||"", plans:new Set() }; byComm.set(key,e); } e.plans.add(String(r.plan)); });
    [...byComm.values()].sort((a,b)=>String(a.name).localeCompare(String(b.name))).forEach(e=>{
      const plans=[...e.plans].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
      plans.forEach(p=>{ if(!optMap.has(p)) optMap.set(p, nameOf(p)?`${p} — ${nameOf(p)}`:p); });
      items.push({ set:e.plans, name:e.name,
        card:(hi)=>`<div class="pl-card"><div class="pl-card-h">${esc(e.name)} <span class="pl-sub">${esc(e.num||"")} · ${plans.length} plan${plans.length===1?"":"s"}</span></div>
          <div class="pl-chips">${plans.map(p=>{ const nm=nameOf(p), on=hi&&hi.has(p); return `<span class="chip chip-st-${stOf(e.ck,p)}${on?" chip-hit":""}" data-ttc="${esc(e.ck)}" data-ttp="${esc(p)}" data-ttn="${esc(nm)}" data-ttx="${esc(e.name)}">${esc(p)}${nm?` <span class="pl-nm">${esc(nm)}</span>`:""}</span>`; }).join("")}</div></div>` });
    });
  } else {
    const byPlan=new Map();
    state.flow.forEach(r=>{ if(!r.plan) return; const p=String(r.plan); const ck=r.community_num||r.community_name; if(!ck) return;
      let e=byPlan.get(p); if(!e){ e={plan:p, comms:new Map() }; byPlan.set(p,e); } e.comms.set(ck, r.community_name||r.community_num||""); });
    [...byPlan.values()].sort((a,b)=>a.plan.localeCompare(b.plan,undefined,{numeric:true})).forEach(e=>{
      const keys=new Set(e.comms.keys());
      [...e.comms.entries()].forEach(([k,nm])=>{ if(!optMap.has(k)) optMap.set(k, nm||k); });
      const comms=[...e.comms.entries()].sort((a,b)=>String(a[1]).localeCompare(String(b[1]))); const nm=nameOf(e.plan);
      items.push({ set:keys, name:e.plan,
        card:(hi)=>`<div class="pl-card"><div class="pl-card-h">${esc(e.plan)}${nm?` <span class="pl-nm">${esc(nm)}</span>`:""} <span class="pl-sub">${comms.length} communit${comms.length===1?"y":"ies"}</span></div>
          <div class="pl-chips">${comms.map(([k,cn])=>{ const on=hi&&hi.has(k); return `<span class="chip chip-st-${stOf(k,e.plan)}${on?" chip-hit":""}" data-ttc="${esc(k)}" data-ttp="${esc(e.plan)}" data-ttn="${esc(nm)}" data-ttx="${esc(cn||k)}">${esc(cn||k)}</span>`; }).join("")}</div></div>` });
    });
  }
  const options=[...optMap.entries()].map(([value,label])=>({value,label,search:lc(value+" "+label)}))
    .sort((a,b)=>a.value.localeCompare(b.value,undefined,{numeric:true}));
  const noun=n=>mode==="community"?("communit"+(n===1?"y":"ies")):("plan"+(n===1?"":"s"));
  const pickNoun=mode==="community"?"plans":"communities";

  tb.innerHTML=`<span class="count" id="plansCount"></span>`
    + mkBtn("community","By community") + mkBtn("plan","By plan")
    + `<div class="pl-dd" id="plDd">
         <button type="button" class="btn mini ghost pl-dd-btn" id="plDdBtn"></button>
         <div class="pl-dd-panel hidden" id="plDdPanel">
           <input type="text" class="pl-dd-search" id="plDdSearch" placeholder="Search ${pickNoun}…">
           <button type="button" class="linkbtn pl-dd-master" id="plDdMaster">(Select all)</button>
           <div class="pl-dd-addrow hidden" id="plDdAddRow"><button type="button" class="linkbtn pl-dd-add" id="plDdAdd">&#10133; Add current results to filter</button><span class="pl-dd-note" id="plDdNote"></span></div>
           <div class="pl-dd-list" id="plDdList">${options.map(o=>`<label class="msel-opt pl-dd-opt"><input type="checkbox" value="${esc(o.value)}">${esc(o.label)}</label>`).join("")||`<div class="empty" style="padding:12px">None in this division.</div>`}</div>
         </div>
       </div>`
    + `<button class="btn mini ghost" data-export>&#8681; Export CSV</button>`
    + `<span class="grow"></span>`
    + `<span class="section-note" style="margin:0">Pick ${pickNoun} from the dropdown to filter. Choose 2+ and the ${noun(2)} containing <b>all</b> of them are highlighted and listed first. Current division only.</span>`;
  area.innerHTML=`<div class="pl-legend"><span class="pl-legend-t">Release status:</span>
      <span class="chip chip-st-none">Nothing released</span>
      <span class="chip chip-st-part">Some elevations released</span>
      <span class="chip chip-st-done">All elevations released</span>
      <span class="chip chip-st-off" title="Judged from the latest start date seen in the most recent Starts Log import">Not on start log (today &rarr;)</span>
      <span class="pl-legend-t" style="margin-left:6px">Hover a chip for elevation detail.</span></div>
    <div class="pl-list"></div>`;
  attachChipTips(area, psIdx);

  const panel=$("plDdPanel"), search=$("plDdSearch"), listEl=$("plDdList");
  const boxes=()=>[...listEl.querySelectorAll("input[type=checkbox]")];
  const visBoxes=()=>boxes().filter(b=>b.closest(".pl-dd-opt").style.display!=="none");
  if(!panel._lock) panel._lock=new Set();

  const paint=()=>{
    const sel=new Set(boxes().filter(b=>b.checked).map(b=>b.value));
    state.plansSel=[...sel];
    $("plDdBtn").innerHTML=(sel.size?`${sel.size} ${pickNoun} selected`:`Filter by ${pickNoun}…`)+" &#9662;";
    const multi=sel.size>=2;
    let shown;
    if(sel.size){
      shown=items.map(it=>{ let hits=0; it.set.forEach(v=>{ if(sel.has(v)) hits++; }); return {it,hits}; }).filter(o=>o.hits>0);
      if(multi) shown.sort((a,b)=>(b.hits===sel.size)-(a.hits===sel.size));
    } else shown=items.map(it=>({it,hits:0}));
    const allN=multi?shown.filter(o=>o.hits===sel.size).length:0;
    $("plansCount").textContent=`${shown.length} ${noun(shown.length)}`+(multi?` · ${allN} with all ${pickNoun}`:"");
    area.querySelector(".pl-list").innerHTML = shown.length
      ? shown.map(o=>{ const all=multi&&o.hits===sel.size; const html=o.it.card(sel.size?sel:null); return all?html.replace('class="pl-card"','class="pl-card pl-card-all"'):html; }).join("")
      : `<div class="empty">No ${noun(2)} match your selection.</div>`;
  };
  const syncMaster=()=>{ const q=search.value.trim(); const vis=visBoxes(), on=vis.filter(b=>b.checked).length;
    const box=on===0?"&#9744;":((vis.length&&on===vis.length)?"&#9745;":"&#9632;");
    $("plDdMaster").innerHTML=box+" "+(q?"Select all search results":"Select all");
    const n=panel._lock.size, note=$("plDdNote");
    $("plDdAddRow").classList.toggle("hidden", !(q||n));
    if(note) note.innerHTML=n?`${n} kept &middot; <a href="#" class="pl-dd-clear">clear</a>`:""; };

  // restore prior selection
  const prev=new Set(state.plansSel); boxes().forEach(b=>{ if(prev.has(b.value)) b.checked=true; });

  $("plDdBtn").addEventListener("click",e=>{ e.stopPropagation(); const hid=panel.classList.toggle("hidden"); if(!hid){ search.focus(); } });
  panel.addEventListener("click",e=>{ e.stopPropagation(); const c=e.target.closest(".pl-dd-clear"); if(c){ e.preventDefault(); panel._lock.clear(); const q=search.value.trim().toLowerCase(); boxes().forEach(b=>{ if(q) b.checked=b.closest(".pl-dd-opt").textContent.toLowerCase().includes(q); }); paint(); syncMaster(); } });
  if(window._plDdClose) document.removeEventListener("click",window._plDdClose);
  window._plDdClose=()=>{ const p=$("plDdPanel"); if(p&&!p.classList.contains("hidden")) p.classList.add("hidden"); };
  document.addEventListener("click",window._plDdClose);
  search.addEventListener("input",()=>{
    const q=search.value.trim().toLowerCase();
    boxes().forEach(b=>{ const o=b.closest(".pl-dd-opt"); const m=(!q||o.textContent.toLowerCase().includes(q)); o.style.display=m?"":"none";
      if(q) b.checked=m||panel._lock.has(b.value); });   // current matches become the selection; kept stay selected
    paint(); syncMaster();
  });
  search.addEventListener("keydown",e=>{ if(e.key==="Enter"){ e.preventDefault(); panel.classList.add("hidden"); } });
  $("plDdMaster").addEventListener("click",()=>{ const vis=visBoxes(); const allOn=vis.length&&vis.every(b=>b.checked); vis.forEach(b=>b.checked=!allOn); if(!allOn) panel._lock.clear(); paint(); syncMaster(); });
  $("plDdAdd").addEventListener("click",()=>{ visBoxes().forEach(b=>{ if(b.checked) panel._lock.add(b.value); }); search.value=""; boxes().forEach(b=>{ b.closest(".pl-dd-opt").style.display=""; b.checked=panel._lock.has(b.value); }); paint(); syncMaster(); search.focus(); });
  listEl.addEventListener("change",()=>{ paint(); syncMaster(); });

  tb.querySelectorAll("[data-pmode]").forEach(b=>b.onclick=()=>{ state.plansMode=b.dataset.pmode; state.plansSel=[]; if(panel)panel._lock=new Set(); render(); });
  paint(); syncMaster();
}

/* ===================================================================
   TAB 6 · FREQUENCY  (how often each plan comes up in a date range)
   ===================================================================
   IMPORTANT — what is being counted.
   flow_rows stores ONE row per community + plan + elevation combination,
   with the EARLIEST (first_trench_date) and LATEST (last_trench_date) start
   seen for that combination in the most recent Starts Log import. Individual
   lots/starts are collapsed away at import time and are NOT in the database.

   So "frequency" here = the number of community/elevation combinations a plan
   has whose date falls in the selected range — i.e. how often the plan comes
   up as work, NOT how many homes were started. If a true homes-started count
   is ever needed, the Starts Log import has to persist per-lot rows (a new
   tf_plan_starts table) and this tab can be repointed at it; the aggregation
   below is deliberately isolated in freqData() to make that a one-function
   change (Blueprint's import workflow would have to move in lockstep).      */

const FREQ_BASES = [
  { v:"trench",   label:"First trench (earliest start)" },
  { v:"last",     label:"Latest start" },
  { v:"activity", label:"Any start activity in range" },
  { v:"released", label:"Released date" }
];
const FREQ_BASIS_NOTE = {
  trench:  "Counts a plan/elevation once when its <b>earliest</b> start falls in the range — new work entering the pipeline.",
  last:    "Counts a plan/elevation once when its <b>latest</b> start falls in the range — where the plan is still starting today.",
  activity:"Counts a plan/elevation when its start window (earliest &rarr; latest) <b>overlaps</b> the range — anything active at any point in it.",
  released:"Counts a plan/elevation once when its <b>Released</b> date falls in the range — estimating throughput rather than build activity."
};
const FREQ_CHART_CAP = 25;   // bars drawn before the "show all" toggle

function freqShift(n){ const d=parseIso(todayIso()); d.setUTCDate(d.getUTCDate()+n); return iso(d); }
function freqPresets(){
  const y=new Date().getUTCFullYear();
  return [
    { v:"year", label:"This year",      from:`${y}-01-01`,  to:`${y}-12-31` },
    { v:"l12",  label:"Last 12 months", from:freqShift(-365), to:todayIso() },
    { v:"l90",  label:"Last 90 days",   from:freqShift(-90),  to:todayIso() },
    { v:"n180", label:"Next 6 months",  from:todayIso(),      to:freqShift(180) },
    { v:"all",  label:"All dates",      from:"",              to:"" }
  ];
}
function freqState(){
  if(!state.freq){ const y=new Date().getUTCFullYear();
    state.freq={ basis:"trench", from:`${y}-01-01`, to:`${y}-12-31`, comms:[], plans:[], showAll:false }; }
  const f=state.freq;
  if(!FREQ_BASES.some(b=>b.v===f.basis)) f.basis="trench";
  if(!Array.isArray(f.comms)) f.comms=[];
  if(!Array.isArray(f.plans)) f.plans=[];
  return f;
}
/* does this flow row fall inside [from,to] under the chosen date basis? */
function freqInRange(r, basis, from, to){
  const within = d => !!d && (!from || d>=from) && (!to || d<=to);
  if(basis==="released") return within(effective(r,"released"));
  if(basis==="last")     return within(r.last_trench_date);
  if(basis==="activity"){
    const lo=r.first_trench_date||r.last_trench_date, hi=r.last_trench_date||r.first_trench_date;
    if(!lo && !hi) return false;
    return (!to || lo<=to) && (!from || hi>=from);
  }
  return within(r.first_trench_date);
}
/* stable per-community colour so a community keeps its shade across renders */
function freqColor(key){
  let h=0; const s=String(key);
  for(let i=0;i<s.length;i++) h=(h*31+s.charCodeAt(i))>>>0;
  const dark=document.documentElement.getAttribute("data-theme")==="dark";
  return `hsl(${h%360} ${52+(h>>9)%20}% ${dark?58:44}%)`;
}
/* ---- aggregation: current division's flow rows → per-plan counts, split by community ----
   Option lists are built from the WHOLE division so the pickers never collapse as you filter. */
function freqData(){
  const f=freqState();
  const selC=new Set(f.comms), selP=new Set(f.plans);
  const pnm=(planLookup()[state.divKey])||{};
  const nameOf=pl=>pnm[String(pl==null?"":pl).trim().toUpperCase()]||"";
  const commOpts=new Map(), planOpts=new Map(), byPlan=new Map(), commTot=new Map();
  let matched=0;
  state.flow.forEach(r=>{
    if(!r.plan) return;
    const ck=String(r.community_num||r.community_name||"").trim(); if(!ck) return;
    const cname=r.community_name||r.community_num||ck;
    const p=String(r.plan), pn=nameOf(p);
    if(!commOpts.has(ck)) commOpts.set(ck,cname);
    if(!planOpts.has(p))  planOpts.set(p, pn?`${p} — ${pn}`:p);
    if(!freqInRange(r,f.basis,f.from,f.to)) return;
    if(selC.size && !selC.has(ck)) return;
    if(selP.size && !selP.has(p))  return;
    if(!matchFilter([cname,r.community_num,p,pn,r.elevation].join(" "))) return;
    matched++;
    let e=byPlan.get(p);
    if(!e){ e={ plan:p, name:pn, total:0, comms:new Map(), evs:new Set(), first:null, last:null, rel:0 }; byPlan.set(p,e); }
    e.total++;
    let c=e.comms.get(ck); if(!c){ c={ ck, name:cname, n:0 }; e.comms.set(ck,c); } c.n++;
    commTot.set(ck,(commTot.get(ck)||0)+1);
    if(String(r.elevation||"").trim()) e.evs.add(lc(r.elevation));
    if(effective(r,"released")) e.rel++;
    const lo=r.first_trench_date, hi=r.last_trench_date||r.first_trench_date;
    if(lo && (!e.first || lo<e.first)) e.first=lo;
    if(hi && (!e.last  || hi>e.last )) e.last =hi;
  });
  const plans=[...byPlan.values()].sort((a,b)=> b.total-a.total || a.plan.localeCompare(b.plan,undefined,{numeric:true}));
  plans.forEach(e=>{ e.commList=[...e.comms.values()].sort((x,y)=> y.n-x.n || String(x.name).localeCompare(String(y.name))); });
  const legend=[...commTot.entries()].sort((a,b)=>b[1]-a[1])
    .map(([ck,n])=>({ ck, name:commOpts.get(ck)||ck, n }));
  return { plans, matched, legend,
    commOpts:[...commOpts.entries()].map(([value,label])=>({value,label}))
      .sort((a,b)=>String(a.label).localeCompare(String(b.label))),
    planOpts:[...planOpts.entries()].map(([value,label])=>({value,label}))
      .sort((a,b)=>a.value.localeCompare(b.value,undefined,{numeric:true})) };
}

/* ---- generic multi-select dropdown (reuses the Plans-tab .pl-dd styling) ----
   `noun` is [singular, plural] so the button reads "1 community selected". */
function mselLabel(n, noun){ return n ? `${n} ${n===1?noun[0]:noun[1]} selected` : `All ${noun[1]}`; }
function mselHTML(id, noun, options, selected){
  const sel=new Set(selected||[]);
  return `<div class="pl-dd" id="${id}">
      <button type="button" class="btn mini ghost pl-dd-btn" data-msel-btn>${esc(mselLabel(sel.size,noun))} &#9662;</button>
      <div class="pl-dd-panel hidden">
        <input type="text" class="pl-dd-search" placeholder="Search ${esc(noun[1])}…">
        <button type="button" class="linkbtn pl-dd-master">Select all</button>
        <div class="pl-dd-list">${
          options.map(o=>`<label class="msel-opt pl-dd-opt"><input type="checkbox" value="${esc(o.value)}"${sel.has(o.value)?" checked":""}> ${esc(o.label)}</label>`).join("")
          || `<div class="empty" style="padding:12px">None in this division.</div>`}</div>
        <button type="button" class="linkbtn pl-dd-clearall">Clear selection</button>
      </div>
    </div>`;
}
function bindMsel(id, noun, onChange){
  const root=$(id); if(!root) return;
  const panel=root.querySelector(".pl-dd-panel"), btn=root.querySelector("[data-msel-btn]"),
        search=root.querySelector(".pl-dd-search"), list=root.querySelector(".pl-dd-list");
  const boxes=()=>[...list.querySelectorAll("input[type=checkbox]")];
  const vis=()=>boxes().filter(b=>b.closest(".pl-dd-opt").style.display!=="none");
  const emit=()=>{ const on=boxes().filter(b=>b.checked).map(b=>b.value);
    btn.innerHTML=esc(mselLabel(on.length,noun))+" &#9662;";
    onChange(on); };
  btn.onclick=e=>{ e.stopPropagation(); const hid=panel.classList.toggle("hidden"); if(!hid) search.focus(); };
  panel.onclick=e=>e.stopPropagation();
  search.oninput=()=>{ const q=lc(search.value);
    boxes().forEach(b=>{ const o=b.closest(".pl-dd-opt"); o.style.display=(!q||lc(o.textContent).includes(q))?"":"none"; }); };
  search.onkeydown=e=>{ if(e.key==="Enter"){ e.preventDefault(); panel.classList.add("hidden"); } };
  root.querySelector(".pl-dd-master").onclick=()=>{ const v=vis(); const allOn=v.length&&v.every(b=>b.checked); v.forEach(b=>b.checked=!allOn); emit(); };
  root.querySelector(".pl-dd-clearall").onclick=()=>{ boxes().forEach(b=>b.checked=false); search.value=""; boxes().forEach(b=>b.closest(".pl-dd-opt").style.display=""); emit(); };
  list.onchange=emit;
}

function renderFreq(tb,area){
  const f=freqState();
  const d0=freqData();                       // for the option universe (independent of filters)
  const presets=freqPresets();
  const curPreset=(presets.find(p=>p.from===f.from && p.to===f.to)||{}).v || "custom";

  tb.innerHTML=`<span class="count" id="fqCount"></span>`
    + `<select id="fqBasis" title="Which date the range filters on">${
        FREQ_BASES.map(b=>`<option value="${b.v}"${f.basis===b.v?" selected":""}>${esc(b.label)}</option>`).join("")}</select>`
    + `<select id="fqPreset" title="Quick date ranges">${
        presets.map(p=>`<option value="${p.v}"${curPreset===p.v?" selected":""}>${esc(p.label)}</option>`).join("")
      }<option value="custom"${curPreset==="custom"?" selected":""}>Custom…</option></select>`
    + `<span class="fq-range"><input type="date" class="fq-date" id="fqFrom" value="${esc(f.from)}" title="From (inclusive)">`
    + `<span class="fq-dash">&ndash;</span>`
    + `<input type="date" class="fq-date" id="fqTo" value="${esc(f.to)}" title="To (inclusive)"></span>`
    + mselHTML("fqCommDd",["community","communities"],d0.commOpts,f.comms)
    + mselHTML("fqPlanDd",["plan","plans"],d0.planOpts,f.plans)
    + `<button class="btn mini ghost" data-export>&#8681; Export CSV</button>`
    + `<span class="grow"></span>`
    + `<span class="section-note" style="margin:0" id="fqNote"></span>`;
  area.innerHTML=`<div id="fqBody"></div>`;

  const paint=()=>{
    const d=freqData();
    const body=$("fqBody"); if(!body) return;
    $("fqNote").innerHTML=FREQ_BASIS_NOTE[f.basis]+" Current division only.";
    const plans=d.plans, maxN=plans.length?plans[0].total:0;
    const comms=new Set(); plans.forEach(e=>e.comms.forEach((_,k)=>comms.add(k)));
    $("fqCount").textContent=`${d.matched} occurrence${d.matched===1?"":"s"} · ${plans.length} plan${plans.length===1?"":"s"} · ${comms.size} communit${comms.size===1?"y":"ies"}`;

    if(!plans.length){
      body.innerHTML=`<div class="empty">No plans fall in this date range.${
        (f.comms.length||f.plans.length)?" Try clearing the community/plan filters.":""}</div>`;
      return;
    }
    const top=plans[0];
    const cap=f.showAll?plans.length:Math.min(FREQ_CHART_CAP,plans.length);
    const shown=plans.slice(0,cap);
    const rangeTxt=(f.from||f.to)?`${f.from?fmtDate(f.from):"start"} – ${f.to?fmtDate(f.to):"today onward"}`:"all dates";

    const cards=`<div class="fq-cards">
        <div class="fq-card"><div class="fq-card-n">${d.matched}</div><div class="fq-card-l">Plan / elevation occurrences</div></div>
        <div class="fq-card"><div class="fq-card-n">${plans.length}</div><div class="fq-card-l">Distinct plans</div></div>
        <div class="fq-card"><div class="fq-card-n">${comms.size}</div><div class="fq-card-l">Communities</div></div>
        <div class="fq-card"><div class="fq-card-n">${esc(top.plan)}</div><div class="fq-card-l">Most frequent · ${top.total}&times;${top.name?` · ${esc(top.name)}`:""}</div></div>
      </div>`;

    const legend=d.legend.slice(0,16).map(c=>
        `<span class="fq-leg"><i style="background:${freqColor(c.ck)}"></i>${esc(c.name)} <b>${c.n}</b></span>`).join("")
      + (d.legend.length>16?`<span class="fq-leg-more">+${d.legend.length-16} more</span>`:"");

    const bars=shown.map(e=>{
      const w=maxN?(e.total/maxN*100):0;
      const segs=e.commList.map(c=>
        `<span class="fq-seg" style="width:${(c.n/e.total*100).toFixed(4)}%;background:${freqColor(c.ck)}" title="${esc(c.name)} — ${c.n}"></span>`).join("");
      return `<div class="fq-row">
          <div class="fq-lab" title="${esc(e.plan)}${e.name?` — ${esc(e.name)}`:""}">${esc(e.plan)}${e.name?`<span class="fq-lab-n">${esc(e.name)}</span>`:""}</div>
          <div class="fq-bar" style="width:${w.toFixed(4)}%">${segs}</div>
          <span class="fq-val">${e.total}</span>
        </div>`;
    }).join("");

    const table=`<div class="table-wrap fq-table"><table><thead><tr>
        <th>Plan</th><th>Plan Name</th><th class="num">Count</th><th class="num">Share</th>
        <th class="num">Communities</th><th class="num">Elevations</th><th class="num">Released</th>
        <th>Earliest start</th><th>Latest start</th><th>Communities (count)</th>
      </tr></thead><tbody>${plans.map(e=>`<tr>
        <td><b>${esc(e.plan)}</b></td><td>${esc(e.name)}</td>
        <td class="num"><b>${e.total}</b></td>
        <td class="num">${d.matched?(e.total/d.matched*100).toFixed(1):"0.0"}%</td>
        <td class="num">${e.commList.length}</td><td class="num">${e.evs.size}</td>
        <td class="num">${e.rel} / ${e.total}</td>
        <td>${esc(fmtDate(e.first))}</td><td>${esc(fmtDate(e.last))}</td>
        <td class="fq-cw">${e.commList.map(c=>`<span class="chip"><i class="fq-dot" style="background:${freqColor(c.ck)}"></i>${esc(c.name)} ${c.n}</span>`).join("")}</td>
      </tr>`).join("")}</tbody></table></div>`;

    body.innerHTML=cards
      + `<div class="fq-panel"><div class="fq-panel-h">Frequency by plan <span class="fq-sub">${esc(rangeTxt)} · stacked by community</span></div>
           <div class="fq-legend">${legend}</div>
           <div class="fq-chart">${bars}</div>
           ${plans.length>FREQ_CHART_CAP?`<button class="linkbtn fq-more" id="fqMore">${f.showAll?"Show top "+FREQ_CHART_CAP+" only":`Show all ${plans.length} plans`}</button>`:""}
         </div>`
      + table;
    const more=$("fqMore"); if(more) more.onclick=()=>{ f.showAll=!f.showAll; paint(); };
    savePrefs();
  };

  // Toolbar wiring — these repaint the body only, so the open dropdown / focused
  // date field survives (a full render() would rebuild and close them).
  const syncPreset=()=>{ const p=freqPresets().find(p=>p.from===f.from&&p.to===f.to); $("fqPreset").value=p?p.v:"custom"; };
  $("fqBasis").onchange=e=>{ f.basis=e.target.value; paint(); };
  $("fqPreset").onchange=e=>{ const p=freqPresets().find(x=>x.v===e.target.value); if(!p) return;
    f.from=p.from; f.to=p.to; $("fqFrom").value=p.from; $("fqTo").value=p.to; paint(); };
  $("fqFrom").onchange=e=>{ f.from=e.target.value||""; syncPreset(); paint(); };
  $("fqTo").onchange  =e=>{ f.to  =e.target.value||""; syncPreset(); paint(); };
  bindMsel("fqCommDd",["community","communities"],v=>{ f.comms=v; f.showAll=false; paint(); });
  bindMsel("fqPlanDd",["plan","plans"],           v=>{ f.plans=v; f.showAll=false; paint(); });

  if(window._fqDdClose) document.removeEventListener("click",window._fqDdClose);
  window._fqDdClose=()=>{ document.querySelectorAll("#viewToolbar .pl-dd-panel").forEach(p=>p.classList.add("hidden")); };
  document.addEventListener("click",window._fqDdClose);

  paint();
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
/* Date columns filter by MONTH bucket ("YYYY-MM") so you can pick a whole month at once,
   rather than every distinct day. colFval = the value a filter matches on; colFlabel =
   how that value reads in the dropdown. */
const _MON=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function monthKey(v){ v=(v==null?"":String(v)); const m=v.match(/^(\d{4})-(\d{2})/); return m?m[1]+"-"+m[2]:""; }
function monthLabel(k){ if(!k) return ""; const p=String(k).split("-"); return (_MON[(+p[1])-1]||p[1])+" "+p[0]; }
function dayKey(v){ v=(v==null?"":String(v)); return /^\d{4}-\d{2}-\d{2}/.test(v)?v.slice(0,10):""; }
/* Date columns filter on the exact day; the dropdown groups those days under expandable
   months (Excel-style), so you can pick a whole month or drill in to specific dates. */
function colFval(col){
  if(col.fdate) return r=>dayKey(col.raw?col.raw(r):r[col.f]);
  return col.fval || (r=>{ const v=col.disp?col.disp(r):r[col.f]; return (v==null||v==="")?"":String(v); });
}
function colFlabel(col){ if(col.fdate) return v=>v===""?"":fmtDate(v); return col.flabel || (v=>v); }
function passFilters(rows, cols){
  const cf=colFilterMap();
  const active=cols.filter(c=>c.filterable!==false && cf[c.f] instanceof Set && cf[c.f].size);
  if(!active.length) return rows;
  return rows.filter(r=>active.every(c=>{ const fv=colFval(c); return cf[c.f].has(fv(r)); }));
}
/* rows a column's own filter dropdown should draw its options from: everything the OTHER
   active filters allow (so options reflect the currently-filtered view, Excel-style). */
function rowsExcept(rows, cols, exceptField){
  const cf=colFilterMap();
  const active=cols.filter(c=>c.f!==exceptField && c.filterable!==false && cf[c.f] instanceof Set && cf[c.f].size);
  if(!active.length) return rows;
  return rows.filter(r=>active.every(c=>{ const fv=colFval(c); return cf[c.f].has(fv(r)); }));
}
function anyFilters(){ const m=colFilterMap(); return !!state.filter || Object.keys(m).some(k=>m[k] instanceof Set && m[k].size); }
function clearViewFilters(){
  state.colFilters[state.view]={};
  state.filter=""; const gs=$("globalSearch"); if(gs) gs.value="";
  render();
}
/* Decorate-sort-undecorate. The comparator used to call val() — which for a blue
   column is effective(), a business-day walk — for BOTH operands of every
   comparison, so sorting 1591 rows meant ~34,000 date computations instead of
   1,591. That was the single largest cost in a Tampa render, and because
   state.sort is persisted to localStorage it was paid on every render forever
   once a user had sorted by a calculated column. */
function sortView(rows, cols){
  const s=getSort(); if(!s) return rows; const c=cols.find(x=>x.f===s.field); if(!c) return rows;
  const val=c.raw||c.disp||(r=>r[c.f]);
  const keyed=rows.map(r=>({r, k:val(r)}));          // one val() per row
  keyed.sort((a,b)=>cmpVal(a.k,b.k)*s.dir);
  return keyed.map(x=>x.r);
}
function distinctVals(rows, col){
  const f=colFval(col), set=new Set();
  rows.forEach(r=>set.add(f(r)));
  return [...set].sort(cmpVal);
}
function mselLabel(col){
  const sel=colFilterMap()[col.f];
  if(!(sel instanceof Set) || !sel.size) return "All";
  if(sel.size===1){ const v=[...sel][0]; return v===""?"(blank)":(colFlabel(col)(v)||v); }
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
    h+=`<th class="${c.cls||""} ${c.cellClass||""} ${sortable?"sorth":""}" ${sortable?`data-sort="${c.f}"`:""}>${esc(c.h)}${(c.calc||c.auto)?'<span class="calc-badge">auto</span>':""}<span class="sort-ind">${ind}</span></th>`;
  });
  h+="</tr><tr class=\"filterrow\">"; if(hasHandle) h+="<th></th>";
  cols.forEach(c=>h+=filterCellHTML(c));
  return h+"</tr>";
}
/* ---- multi-select filter dropdown (msel), lazily built on open ---- */
let _openMsel=null, _openMselW=null;
let _mselWork=null, _mselAll=null, _mselAllSet=null, _mselCol=null, _mselDirty=false, _mselLock=null;
/* Excel-style filter: a working selection Set drives everything. Typing in the search
   applies live (matches become the selection); "Add current selection to filter" makes a
   new search ADD its matches to what's already selected instead of replacing. */
function datePanelHTML(col, baseRows){
  const keys=distinctVals(baseRows, col);
  const hasBlank=keys.includes("");
  const groups=new Map();
  keys.filter(k=>k!=="").forEach(d=>{ const mk=monthKey(d); if(!groups.has(mk)) groups.set(mk,[]); groups.get(mk).push(d); });
  const months=[...groups.keys()].sort();
  let h="";
  if(hasBlank) h+=`<label class="msel-opt msel-day msel-opt-blank"><input type="checkbox" class="vchk dchk" value=""><i class="msel-blank">(Blanks)</i></label>`;
  months.forEach(mk=>{
    const ds=groups.get(mk).slice().sort();
    h+=`<div class="msel-month" data-mk="${esc(mk)}">
      <div class="msel-mhead"><button type="button" class="msel-exp" data-exp aria-label="Expand">&#9656;</button>`
      +`<label class="msel-opt msel-mlabel"><input type="checkbox" class="mchk"> ${esc(monthLabel(mk))} <span class="msel-count">(${ds.length})</span></label></div>`
      +`<div class="msel-days hidden">${ds.map(d=>`<label class="msel-opt msel-day"><input type="checkbox" class="vchk dchk" value="${esc(d)}"> ${esc(fmtDate(d))}</label>`).join("")}</div>`
      +`</div>`;
  });
  return h;
}
function refreshMonthStates(w){
  w.querySelectorAll(".msel-month").forEach(m=>{
    const days=[...m.querySelectorAll(".dchk")], on=days.filter(d=>d.checked).length, mc=m.querySelector(".mchk");
    mc.checked = days.length>0 && on===days.length;
    mc.indeterminate = on>0 && on<days.length;
  });
}
function buildMselPanel(w, col, baseRows){
  const panel=w.querySelector("[data-mpanel]");
  const ctl=`<label class="msel-opt msel-ctl msel-selall"><input type="checkbox" class="msel-allbox"> <span class="msel-alltext">(Select all)</span></label>`
    +`<div class="msel-opt msel-ctl msel-addfilter hidden"><button type="button" class="linkbtn msel-addbtn">&#10133; Add current results to filter</button><span class="msel-addnote"></span></div>`
    +`<div class="msel-sep"></div>`;
  let body;
  if(col.fdate){ body=datePanelHTML(col,baseRows); }
  else {
    let opts=distinctVals(baseRows, col);
    if(opts.includes("")){ opts=opts.filter(v=>v!==""); opts.unshift(""); }
    const flabel=colFlabel(col);
    body=opts.map(v=>{ const lbl=v===""?'<i class="msel-blank">(Blanks)</i>':esc(flabel(v));
      return `<label class="msel-opt${v===""?" msel-opt-blank":""}"><input type="checkbox" class="vchk" value="${esc(v)}">${lbl}</label>`; }).join("");
  }
  panel.innerHTML=`<input type="text" class="msel-search" placeholder="${col.fdate?"Search month or date…":"Search…"}">
    <div class="msel-list${col.fdate?" msel-tree":""}">${ctl}${body}</div>`;
}
function mselBoxes(w){ return [...w.querySelectorAll(".vchk")]; }
function mselVisible(b){ const o=b.closest(".msel-opt"); if(o&&o.style.display==="none") return false; const m=b.closest(".msel-month"); if(m&&m.style.display==="none") return false; return true; }
function mselSyncBoxes(w){ mselBoxes(w).forEach(b=>b.checked=_mselWork.has(b.value)); if(_mselCol&&_mselCol.fdate) refreshMonthStates(w); }
function mselSyncMaster(w){
  const q=(w.querySelector(".msel-search").value||"").trim();
  const at=w.querySelector(".msel-alltext"); if(at) at.textContent=q?"(Select all search results)":"(Select all)";
  const lockN=_mselLock?_mselLock.size:0;
  const af=w.querySelector(".msel-addfilter"); if(af) af.classList.toggle("hidden", !(q||lockN));
  const note=w.querySelector(".msel-addnote"); if(note) note.innerHTML=lockN?` &middot; ${lockN} kept &middot; <a href="#" class="msel-clearadd">clear</a>`:"";
  const vis=mselBoxes(w).filter(mselVisible), on=vis.filter(b=>b.checked).length, m=w.querySelector(".msel-allbox");
  if(m){ m.checked=vis.length>0&&on===vis.length; m.indeterminate=on>0&&on<vis.length; }
}
function mselApplyVisibility(w,col,q){
  if(col.fdate){
    const blank=w.querySelector(".msel-opt-blank"); if(blank) blank.style.display=(!q||blank.textContent.toLowerCase().includes(q))?"":"none";
    w.querySelectorAll(".msel-month").forEach(m=>{ const ml=m.querySelector(".msel-mlabel").textContent.toLowerCase(); let any=false;
      m.querySelectorAll(".msel-days .msel-day").forEach(d=>{ const show=!q||d.textContent.toLowerCase().includes(q)||ml.includes(q); d.style.display=show?"":"none"; if(show)any=true; });
      m.style.display=(!q||ml.includes(q)||any)?"":"none";
      if(q&&any){ m.querySelector(".msel-days").classList.remove("hidden"); const e=m.querySelector("[data-exp]"); if(e) e.innerHTML="&#9662;"; }
    });
  } else {
    w.querySelectorAll(".msel-opt:not(.msel-ctl)").forEach(o=>{ o.style.display=(!q||o.textContent.toLowerCase().includes(q))?"":"none"; });
  }
}
function mselSearch(w,col){
  const q=(w.querySelector(".msel-search").value||"").trim().toLowerCase();
  mselApplyVisibility(w,col,q);
  if(q){
    // The current search's matches become the selection; anything already "kept"
    // (added to the filter earlier) stays selected too — so searches accumulate.
    const matches=mselBoxes(w).filter(mselVisible).map(b=>b.value);
    _mselWork = new Set(matches);
    if(_mselLock) _mselLock.forEach(v=>_mselWork.add(v));
  }
  mselSyncBoxes(w); mselSyncMaster(w); mselCommit(w,col);
}
function mselCommit(w,col){
  /* _mselAllSet, not _mselAll.includes(). _mselAll is an array of every option
     value in the column, so .includes() inside this filter was a linear scan per
     selected value — O(D²) where D is the distinct values in the column. D grows
     with row count, so twice the rows was four times the work, and mselCommit
     fires on every checkbox click AND every keystroke in the filter search. */
  const covered = _mselAll.length>0 && _mselAll.every(v=>_mselWork.has(v));
  if(covered || _mselWork.size===0) delete colFilterMap()[col.f];
  else colFilterMap()[col.f]=new Set([..._mselWork].filter(v=>_mselAllSet.has(v)));
  const btn=w.querySelector("[data-mbtn]"); if(btn) btn.textContent=mselLabel(col);
  w.classList.toggle("active", colFilterMap()[col.f] instanceof Set);
  _mselDirty=true;
}
function wireMselPanel(w, col){
  const panel=w.querySelector("[data-mpanel]");
  panel.addEventListener("click",e=>e.stopPropagation());
  _mselCol=col; _mselAll=mselBoxes(w).map(b=>b.value); _mselAllSet=new Set(_mselAll); _mselLock=new Set();
  const committed=colFilterMap()[col.f];
  _mselWork = (committed instanceof Set) ? new Set([...committed]) : new Set(_mselAll);
  mselSyncBoxes(w); mselSyncMaster(w);
  const searchEl=panel.querySelector(".msel-search");
  searchEl.addEventListener("input",()=>mselSearch(w,col));
  searchEl.addEventListener("keydown",e=>{ if(e.key==="Enter"){ e.preventDefault(); panel.classList.add("hidden"); _openMsel=null; _openMselW=null; applyMselIfDirty(); } });
  const addBtn=panel.querySelector(".msel-addbtn");
  if(addBtn) addBtn.addEventListener("click",()=>{
    mselBoxes(w).filter(b=>mselVisible(b)&&b.checked).forEach(b=>_mselLock.add(b.value));  // keep current results
    searchEl.value=""; _mselWork=new Set(_mselLock);
    mselApplyVisibility(w,col,""); mselSyncBoxes(w); mselSyncMaster(w); mselCommit(w,col); searchEl.focus();
  });
  panel.addEventListener("click",e=>{ const c=e.target.closest(".msel-clearadd"); if(c){ e.preventDefault(); _mselLock=new Set(); mselSearch(w,col); } });
  panel.querySelector(".msel-allbox").addEventListener("change",e=>{ const on=e.target.checked;
    mselBoxes(w).filter(mselVisible).forEach(b=>{ if(on) _mselWork.add(b.value); else _mselWork.delete(b.value); });
    mselSyncBoxes(w); mselSyncMaster(w); mselCommit(w,col); });
  mselBoxes(w).forEach(b=>b.addEventListener("change",()=>{ if(b.checked) _mselWork.add(b.value); else _mselWork.delete(b.value);
    if(col.fdate) refreshMonthStates(w); mselSyncMaster(w); mselCommit(w,col); }));
  if(col.fdate){
    panel.querySelectorAll("[data-exp]").forEach(b=>b.addEventListener("click",()=>{ const days=b.closest(".msel-month").querySelector(".msel-days"); const nowHidden=days.classList.toggle("hidden"); b.innerHTML=nowHidden?"&#9656;":"&#9662;"; }));
    panel.querySelectorAll(".mchk").forEach(mc=>mc.addEventListener("change",()=>{ mc.closest(".msel-month").querySelectorAll(".dchk").forEach(d=>{ if(mc.checked)_mselWork.add(d.value); else _mselWork.delete(d.value); }); mselSyncBoxes(w); mselSyncMaster(w); mselCommit(w,col); }));
  }
}
function applyMselIfDirty(){ if(_mselDirty){ _mselDirty=false; render(); } }
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
      if(wasHidden){ buildMselPanel(w,col,rowsExcept(baseRows,cols,col.f)); wireMselPanel(w,col); panel.classList.remove("hidden"); positionMsel(w); _openMsel=col.f; _openMselW=w; const s=panel.querySelector(".msel-search"); if(s) s.focus(); }
      else { panel.classList.add("hidden"); _openMsel=null; _openMselW=null; applyMselIfDirty(); }
    });
  });
  // keep the open panel anchored to its button as the grid scrolls
  container.querySelectorAll(".grid-wrap").forEach(g=>g.addEventListener("scroll",()=>{ if(_openMselW) positionMsel(_openMselW); }));
}
if(!window._mselDocBound){ window._mselDocBound=true;
  document.addEventListener("click",()=>{ let any=false; document.querySelectorAll(".colmsel [data-mpanel]:not(.hidden)").forEach(p=>{ p.classList.add("hidden"); any=true; }); if(any){ _openMsel=null; _openMselW=null; applyMselIfDirty(); } });
  // reposition the open filter so it follows its button on any scroll (capture catches inner scrollers too) or resize
  window.addEventListener("scroll",()=>{ if(_openMselW) positionMsel(_openMselW); }, true);
  window.addEventListener("resize",()=>{ if(_openMselW) positionMsel(_openMselW); });
}
/* build a cols descriptor from a simple {f,h,type,calc} list (Flow / Changes) */
function descFromCols(list){
  return list.map(c=>({
    f:c.f, h:c.h, cls:(c.calc||c.auto)?"calc":"", calc:c.calc, auto:c.auto, fdate:c.type==="date",
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
  shInvalidate();   // the grid DOM was just replaced — drop the cached cell matrix
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
/* The cell matrix, cached per grid build.

   These four were each O(rows) per CALL, with no cache: one shRows() is a subtree
   querySelectorAll plus an individual tr.querySelector(".cell") for every row —
   1,591 of them for Tampa — and shCell then threw away all but one row. That made
   paintSelection O(selectedCells × rows) and the drag handler, which repaints on
   every mouseover, O(dragLength² × rows): dragging down 100 rows in Tampa was
   ~8 million row scans. Every render paid it too, via clampSel + paintSelection,
   even with a single cell selected.

   shCache is invalidated by bindGrid after it writes innerHTML (the only place the
   grid DOM is replaced), and defensively if the cached first row has been detached. */
let _shCache=null;
function shInvalidate(){ _shCache=null; }
function shMatrix(c){
  if(_shCache && _shCache.c===c && _shCache.rows.length && _shCache.rows[0].isConnected) return _shCache;
  const rows=[...c.querySelectorAll("table.grid tbody tr")].filter(tr=>tr.querySelector(".cell"));
  _shCache={ c, rows, cells:rows.map(tr=>[...tr.querySelectorAll(".cell")]) };
  return _shCache;
}
function shRows(c){ return shMatrix(c).rows; }
function shDims(c){ const m=shMatrix(c); return { R:m.rows.length, C:m.cells[0]?m.cells[0].length:0 }; }
function shCell(c,r,cc){ const m=shMatrix(c); return (m.cells[r] && m.cells[r][cc]) || null; }
function shCoord(cell){
  const m=shMatrix(sheet.container);
  const tr=cell.closest("tr");
  const r=m.rows.indexOf(tr); if(r<0) return null;
  const c=m.cells[r].indexOf(cell); if(c<0) return null;
  return {r,c};
}
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
  if(cell.matches(".longcell")){ openTextModal(cell, sheet.commit); return; }   // always open (read-only for viewers; editable if allowed)
  if(!cell.matches(".editable")) return;
  startEdit(cell, sheet.commit, dir=>{ if(dir) moveActive(dir,false); else paintSelection(); }, prefill);
}
/* `defer` suppresses the render so runEdits can render ONCE after every field,
   instead of once per field — a 14-column paste used to rebuild the whole grid 14
   times. The 500-cell cap is enforced by the caller now, across all fields. */
async function applyBulk(view, field, type, edits, opts){
  if(!edits.length) return 0;
  const table=view==="flow"?"flow_rows":"takeoff_changes";
  const arr=view==="flow"?state.flow:state.changes;
  const byId=new Map(arr.map(r=>[r.id,r]));   // was arr.find() per edit: O(edits × rows)
  let conflicts=0; const before=[];   // {id, prev} for successfully-changed cells (for undo)
  for(const {id,value} of edits){
    const r=byId.get(id); if(!r) continue;
    const oldVal=r[field]===undefined?null:r[field];
    const newVal=(value===""||value==null)?null:value;
    if(sameVal(oldVal,newVal)) continue;
    r[field]=newVal;
    const res=await saveField(table,id,field,newVal,oldVal);
    if(res && res.ok===false && "current" in res){ r[field]=res.current; conflicts++; }
    else before.push({id, prev:oldVal});
  }
  /* Undo is recorded for BOTH views now. The Takeoff Changes tab has had the full
     sheet model (Delete, Ctrl+D, Ctrl+R, fill, paste) since bindGrid covered it,
     but undo was recorded only for `flow` and the Undo button was only rendered on
     the Flow tab — so a Delete over a block of Takeoff Changes blanked up to 500
     cells per column permanently with nothing to press.

     It also goes through saveField rather than savePatch, so undoing a cell a
     colleague has since corrected is refused rather than silently overwriting
     their value. */
  if(before.length){
    const undoArr=()=>view==="flow"?state.flow:state.changes;
    pushUndo({ label:`${field.replace(/_/g," ")} × ${before.length}`, undo:async()=>{
      const m=new Map(undoArr().map(r=>[r.id,r]));
      let refused=0;
      for(const b of before){
        const rr=m.get(b.id);
        const cur=rr?(rr[field]===undefined?null:rr[field]):null;
        const res=await saveField(table, b.id, field, b.prev, cur);
        if(res && res.ok===false && "current" in res){ if(rr) rr[field]=res.current; refused++; }
        else if(rr) rr[field]=b.prev;
      }
      clearEffCache();
      if(refused) toast(refused+" cell(s) not undone — changed by someone else since.","err");
    }});
  }
  clearEffCache();
  if(!(opts&&opts.defer)) render();
  if(conflicts) toast(conflicts+" cell(s) weren't saved — changed by someone else. Latest values shown.","err");
  return conflicts;
}
function collectEdits(cells){ const byField={};
  cells.forEach(({el,value})=>{ if(!el||!el.matches(".editable,.editallowed")) return; const field=el.dataset.field,type=el.dataset.type||"text";
    (byField[field]=byField[field]||{type,list:[]}).list.push({id:el.dataset.id, value:normVal(type,value)}); });
  return byField;
}
/* The 500-cell cap lives HERE, across every field, because it used to be inside
   applyBulk — which runs once per column. A 14-column × 400-row paste was 5,600
   cells that each passed a per-column check of 400, and then made 5,600 serial
   round trips with no progress and no cancel. Renders once at the end, not per
   field. */
async function runEdits(byField){
  const fields=Object.keys(byField);
  const total=fields.reduce((n,f)=>n+byField[f].list.length,0);
  if(!total) return;
  if(total>500){
    toast(`That's ${total.toLocaleString()} cells across ${fields.length} column(s) — over the 500 limit. Please work in a smaller range.`,"err");
    return;
  }
  for(const f of fields) await applyBulk(sheet.view,f,byField[f].type,byField[f].list,{defer:true});
  render();
}
/* Confirm a large clear. Delete over a block had no prompt at all, and on the
   Takeoff Changes tab it also had no undo — so a stray keypress blanked requestor,
   community, plan and request text across hundreds of rows permanently. Undo is
   recorded for both views now (see applyBulk), but a destructive bulk action this
   easy to trigger should still ask. */
async function clearSelection(){ const s=selRect(), cells=[];
  for(let r=s.r1;r<=s.r2;r++) for(let cc=s.c1;cc<=s.c2;cc++){ const el=shCell(sheet.container,r,cc); if(el) cells.push({el,value:""}); }
  const editable=cells.filter(c=>c.el && (c.el.matches(".editable")||c.el.matches(".editallowed"))).length;
  if(editable>20 && !confirm(`Clear ${editable} cell(s)?\n\nThis blanks them for everyone. You can undo it from the Undo button, but only in this browser session.`)) return;
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
/* Paste is positional — it addresses rows by their on-screen position, because
   shRows reads the rendered tbody, which renderFlow built from
   sortView(passFilters(...)). There is no row-identity check, and there cannot
   really be one in a spreadsheet UI: pasting a block into the visible grid is what
   the gesture means.

   What makes it dangerous is doing it into a REORDERED view. Sort by Community,
   paste a column of dates copied from an export in a different order, and the
   dates land on the wrong plans — silently recomputing six derived dates each.
   applyBulk writes every cell whose value differs, so most of them do change, and
   it reports only conflicts, never "these went somewhere you didn't expect".

   So: confirm when a sort or a filter is active, and say which. Also report
   clipped cells instead of discarding them silently. */
async function doPaste(txt){ const c=sheet.container; if(!sheet.anchor) return;
  const matrix=txt.replace(/\r\n?/g,"\n").split("\n"); if(matrix.length && matrix[matrix.length-1]==="") matrix.pop();
  const {R,C}=shDims(c), sr=sheet.anchor.r, sc=sheet.anchor.c, cells=[];
  let clipped=0;
  matrix.forEach((line,ri)=>line.split("\t").forEach((val,ci)=>{ const r=sr+ri, cc=sc+ci;
    if(r>=R||cc>=C){ clipped++; return; } cells.push({el:shCell(c,r,cc),value:val}); }));
  if(!cells.length){ toast("Nothing pasted — the selection start is outside the grid.","err"); return; }
  const s=getSort(), reordered=!!s, filtered=anyFilters();
  if(reordered || filtered){
    const why=[reordered?"sorted":"", filtered?"filtered":""].filter(Boolean).join(" and ");
    if(!confirm(`This view is ${why}, so the rows are not in their underlying order.\n\n`
      + `Pasting ${cells.length} cell(s) writes them to the rows in the order shown on screen — `
      + `if your clipboard is in a different order, values will land on the wrong rows.\n\n`
      + `Paste anyway?`)) return;
  }
  const pr=matrix.length-1, pc=Math.max(...matrix.map(l=>l.split("\t").length))-1;
  sheet.anchor={r:sr,c:sc}; sheet.focus={r:Math.min(R-1,sr+pr),c:Math.min(C-1,sc+pc)};
  await runEdits(collectEdits(cells));
  if(clipped) toast(`${clipped} pasted cell(s) fell outside the grid and were not written.`,"err"); }
/* The container (#viewArea) outlives every render — only its innerHTML is replaced — so these
   listeners are wired ONCE and delegate off the live `sheet` model (container/commit/anchor are
   refreshed by bindGrid on each render). Re-attaching per render stacked a duplicate set every
   time. The view guard keeps them inert on the tabs that don't use the sheet model. */
function attachSheetMouse(c){
  if(c.dataset.sheetWired) return; c.dataset.sheetWired="1";
  const onSheet=()=>state.view==="flow"||state.view==="changes";
  c.addEventListener("mousedown", e=>{
    if(!onSheet()) return;
    if(e.target.closest(".fill-handle")){ e.preventDefault(); sheet.fill=true; sheet.fillTo=selRect().r2; return; }
    const cell=e.target.closest(".cell"); if(!cell) return; const co=shCoord(cell); if(!co) return;
    e.preventDefault();
    if(e.shiftKey && sheet.anchor){ sheet.focus=co; } else { sheet.anchor=co; sheet.focus=co; sheet.drag=true; }
    paintSelection();
  });
  c.addEventListener("mouseover", e=>{
    if(!onSheet() || (!sheet.drag && !sheet.fill)) return;
    const cell=e.target.closest(".cell"); if(!cell) return; const co=shCoord(cell); if(!co) return;
    if(sheet.fill){ sheet.fillTo=co.r; } else { sheet.focus=co; }
    paintSelection();
  });
  c.addEventListener("dblclick", e=>{ if(!onSheet()) return; const cell=e.target.closest(".cell"); if(!cell) return; const co=shCoord(cell); if(co){ sheet.anchor=co; sheet.focus=co; } editActive(); });
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
  await rtAuth();
  /* Re-auth the socket when the JWT rotates. setAuth was called once at boot and
     never again: the token expires in about an hour, TOKEN_REFRESHED is routed
     into onSignedIn which returns immediately on its _entered guard, so live
     updates could simply stop while the grid looked completely normal. That
     widens the window for every stale-cache write in the app. */
  try{ sb.auth.onAuthStateChange((ev)=>{ if(ev==="TOKEN_REFRESHED") rtAuth(); }); }catch(e){}
  /* Tables carrying a division column are filtered SERVER-SIDE. Without this a
     Tampa user received every Orlando flow_rows event, and each one cost them a
     full state.flow.filter() — a 1591-element array copy per foreign edit. The
     two pending_budget_* tables have no division column, so they cannot be
     filtered here; onRemote discards them by flow id instead. */
  const scoped=["flow_rows","pending_budget_cols","takeoff_changes","tf_plan_names"];
  const global=["pending_budget_checks","pending_budget_status","tf_change_log","tf_loc_locks"];
  let ch=sb.channel("tf-live");
  scoped.forEach(t=>{ ch=ch.on("postgres_changes",{event:"*",schema:"public",table:t,filter:"division=eq."+state.divKey},p=>onRemote(t,p)); });
  global.forEach(t=>{ ch=ch.on("postgres_changes",{event:"*",schema:"public",table:t},p=>onRemote(t,p)); });
  ch.subscribe(status=>setLive(status)); _rt=ch;
}
async function rtAuth(){
  try{ const { data } = await sb.auth.getSession(); const tok=data&&data.session&&data.session.access_token;
    if(tok && sb.realtime && sb.realtime.setAuth) sb.realtime.setAuth(tok); }catch(e){ console.warn("realtime auth failed",e); }
}
/* The division filter is baked into the subscription, so a division switch needs a
   fresh channel or the user keeps receiving the old division's events and none of
   the new one's. */
async function restartRealtime(){
  if(DEMO || !sb) return;
  if(_rt){ try{ await sb.removeChannel(_rt); }catch(e){} _rt=null; }
  await startRealtime();
}
/* Is this flow_id one of the rows currently loaded? Used to discard realtime
   events for the tables that have no division column of their own. */
function rowLoaded(flow_id){
  if(!flow_id) return false;
  if(!_loadedIds || _loadedIdsFor!==state.flow){ _loadedIds=new Set(state.flow.map(r=>r.id)); _loadedIdsFor=state.flow; }
  return _loadedIds.has(flow_id);
}
let _loadedIds=null, _loadedIdsFor=null;
function onRemote(table, p){
  const ev=p.eventType||p.event, row=(p.new && Object.keys(p.new).length)?p.new:null, old=p.old||{};
  clearEffCache();   // a remote row changed; memoised calc dates for it are stale
  if(table==="flow_rows"){
    if(ev==="DELETE") state.flow=state.flow.filter(x=>x.id!==old.id);
    else if(row){ if(row.division!==state.divKey) state.flow=state.flow.filter(x=>x.id!==row.id);
      else { const i=state.flow.findIndex(x=>x.id===row.id); if(i>=0) state.flow[i]=row; else { state.flow.push(row); state.flow.sort(bySort); } } }
  } else if(table==="pending_budget_cols"){
    if(ev==="DELETE") state.cols=state.cols.filter(x=>x.id!==old.id);
    else if(row){ if(row.division!==state.divKey) state.cols=state.cols.filter(x=>x.id!==row.id);
      else { const i=state.cols.findIndex(x=>x.id===row.id); if(i>=0) state.cols[i]=row; else { state.cols.push(row); state.cols.sort(bySort); } } }
  /* These two tables carry no division column, so the subscription cannot filter
     them server-side — discard by flow id here instead. Previously every tick in
     another division was written into state.checks / state.status and triggered a
     re-render of this division's grid, and the foreign keys stayed in local state
     polluting it (loadDivision filters by id on load; onRemote did not). */
  } else if(table==="pending_budget_checks"){
    const fid=(ev==="DELETE"?old:row||{}).flow_id;
    if(!rowLoaded(fid)) return;
    if(ev==="DELETE") delete state.checks[old.flow_id+"::"+old.col_id];
    else if(row) state.checks[row.flow_id+"::"+row.col_id]=!!row.checked;
  } else if(table==="pending_budget_status"){
    const fid=(ev==="DELETE"?old:row||{}).flow_id;
    if(!rowLoaded(fid)) return;
    if(ev==="DELETE") delete state.status[old.flow_id];
    else if(row) state.status[row.flow_id]={sim_reviewed:!!row.sim_reviewed, sent_to_loc:!!row.sent_to_loc};
  } else if(table==="takeoff_changes"){
    if(ev==="DELETE") state.changes=state.changes.filter(x=>x.id!==old.id);
    else if(row){ if(row.division!==state.divKey) state.changes=state.changes.filter(x=>x.id!==row.id);
      else { const i=state.changes.findIndex(x=>x.id===row.id); if(i>=0) state.changes[i]=row; else { state.changes.unshift(row); state.changes.sort((a,b)=>(b.req_date||"").localeCompare(a.req_date||"")); } } }
  } else if(table==="tf_plan_names"){ loadPlanNames().then(rtRender); return; }
  else if(table==="tf_loc_locks"){
    const r=(ev==="DELETE")?old:row;
    if(r && r.division===state.divKey){ state.locLock=(ev==="DELETE")?null:((row&&row.assigned_email&&String(row.assigned_email).trim())||null); rtRender(); }
    return;
  }
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
  else if(state.view==="budgets"){ cols=["Community","Community #","Plan","Plan Name","Elev","Estimating Release",...state.cols.map(c=>c.name),"SIM Reviewed","Sent to LOC","Pricing Due","LOC Upload","Tasks Start","Trench Date"]; name="pending_budgets";
    rows=flowRows().map(r=>{ const st=state.status[r.id]||{}; return [r.community_name,r.community_num,r.plan,planName(r),r.elevation,fmtDate(effective(r,"released")),
      ...state.cols.map(c=>state.checks[r.id+"::"+c.id]?"Y":""), st.sim_reviewed?"Y":"", st.sent_to_loc?"Y":"", fmtDate(workday(r.first_trench_date,-30,true)), fmtDate(effective(r,"loc_upload")), fmtDate(effective(r,"tasks_start")), fmtDate(r.first_trench_date)]; }); }
  else if(state.view==="changes"){ cols=CHG_COLS.map(c=>c.h); name="takeoff_changes";
    rows=chgRows().map(r=>CHG_COLS.map(c=>c.type==="check"?(r[c.f]?"Y":""):(c.type==="date"?fmtDate(r[c.f]):r[c.f]))); }
  else if(state.view==="plans"){ const pnm=(planLookup()[state.divKey])||{}; const nameOf=pl=>pnm[String(pl==null?"":pl).trim().toUpperCase()]||"";
    const sel=new Set(Array.isArray(state.plansSel)?state.plansSel:[]);
    if((state.plansMode||"community")==="community"){ cols=["Community","Comm #","Plan","Plan Name"]; name="plans_by_community";
      const m=new Map(); state.flow.forEach(r=>{ const k=r.community_num||r.community_name; if(!k||!r.plan) return; let e=m.get(k); if(!e){ e={name:r.community_name||"",num:r.community_num||"",plans:new Set()}; m.set(k,e);} e.plans.add(String(r.plan)); });
      rows=[]; [...m.values()].sort((a,b)=>String(a.name).localeCompare(String(b.name))).forEach(e=>{ if(sel.size && ![...e.plans].some(p=>sel.has(p))) return; [...e.plans].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})).forEach(p=>rows.push([e.name,e.num,p,nameOf(p)])); });
    } else { cols=["Plan","Plan Name","Community","Comm #"]; name="plans_by_plan";
      const m=new Map(); state.flow.forEach(r=>{ if(!r.plan) return; const p=String(r.plan); const ck=r.community_num||r.community_name; if(!ck) return; let e=m.get(p); if(!e){ e={plan:p,comms:new Map()}; m.set(p,e);} e.comms.set(ck,{name:r.community_name||"",num:r.community_num||""}); });
      rows=[]; [...m.values()].sort((a,b)=>a.plan.localeCompare(b.plan,undefined,{numeric:true})).forEach(e=>{ if(sel.size && ![...e.comms.keys()].some(k=>sel.has(k))) return; [...e.comms.values()].sort((a,b)=>String(a.name).localeCompare(String(b.name))).forEach(c=>rows.push([e.plan,nameOf(e.plan),c.name,c.num])); });
    } }
  else if(state.view==="freq"){
    const f=freqState(), d=freqData();
    const basisLbl=(FREQ_BASES.find(b=>b.v===f.basis)||{}).label||f.basis;
    name="plan_frequency";
    cols=["Plan","Plan Name","Count","Share %","Communities","Elevations","Released","Earliest Start","Latest Start","Community Breakdown","Date Basis","From","To"];
    rows=d.plans.map(e=>[e.plan, e.name, e.total,
      d.matched?(e.total/d.matched*100).toFixed(1):"0.0",
      e.commList.length, e.evs.size, `${e.rel} of ${e.total}`,
      fmtDate(e.first), fmtDate(e.last),
      e.commList.map(c=>`${c.name} (${c.n})`).join("; "),
      basisLbl, f.from||"(none)", f.to||"(none)"]);
  }
  else { cols=["Community","Comm #","Plan","Plan Name","Ele","Trench"]; name="todo_outstanding";
    rows=todoOutstanding().map(r=>[r.community_name,r.community_num,r.plan,planName(r),r.elevation,fmtDate(r.first_trench_date)]); }
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
  renderPlanNames();   // follows the header division (state.divKey)
  renderPerms();
  renderResetLinks();
}
function bindImport(){
  const tile=$("tileStarts"), input=$("startsInput");
  tile.onclick=()=>input.click();
  tile.onkeydown=e=>{ if(e.key==="Enter"||e.key===" ") input.click(); };
  input.onchange=e=>{ if(e.target.files[0]) loadStartsFile(e.target.files[0]); e.target.value=""; };
  ["dragover","dragenter"].forEach(ev=>tile.addEventListener(ev,e=>{e.preventDefault();tile.classList.add("drag");}));
  ["dragleave","drop"].forEach(ev=>tile.addEventListener(ev,e=>{e.preventDefault();tile.classList.remove("drag");}));
  tile.addEventListener("drop",e=>{ const f=e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files[0]; if(f) loadStartsFile(f); });
  // The preview (and Publish) is built for ONE division — switching the picker would otherwise
  // leave a stale preview whose Publish targets the newly-selected division. Drop the file again.
  $("adminDiv").onchange=()=>resetImportPreview("Division changed — drop the Starts Log again to preview it for this division.");
}
/* clear the parsed workbook + preview panel so nothing can be published from stale state */
function resetImportPreview(note){
  const had=!!(importState&&importState.wb);
  importState={ file:null, wb:null };
  $("previewPanel").classList.add("hidden"); $("previewBody").innerHTML="";
  $("tileStarts").classList.remove("filled"); $("startsName").textContent="Drop the Starts Log .xlsx here or click to browse";
  if(note && had) adminMsg(note,"info");
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
  const xlDate=v=>{ if(v==null||v==="")return null;
    if(v instanceof Date && !isNaN(v)) return new Date(Date.UTC(v.getFullYear(),v.getMonth(),v.getDate())).toISOString().slice(0,10);   // cellDates:true gives LOCAL Dates; take the calendar day, not the UTC shift
    if(typeof v==="number"){ const d=XLSX.SSF?XLSX.SSF.parse_date_code(v):null; if(d) return `${d.y}-${String(d.m).padStart(2,"0")}-${String(d.d).padStart(2,"0")}`; }
    const d=new Date(v); return isNaN(d)?null:d.toISOString().slice(0,10); };
  const find=n=>wb.SheetNames.find(s=>lc(s)===lc(n));
  /* REQUIRE the division's own tab. The old chain fell through to the other
     division's tab and finally to wb.SheetNames[0], so dropping a Tampa workbook
     with Orlando selected parsed Tampa's Start Log into Orlando: every combination
     looked new, the preview read "for orlando" and looked entirely plausible, and
     publishing wrote Tampa's communities in with division:"orlando" — where
     Tampa's own editors cannot even fix them, because flow_upd is division-scoped.
     One mis-drag. The SheetNames[0] fallback generalised the same hazard to any
     workbook missing all three named tabs.

     Throwing here is caught by loadStartsFile, which shows the message. */
  const want = div==="orlando" ? "Permit Log" : div==="tampa" ? "Start Log" : null;
  const sheet = (want && find(want)) || (!want && (find("Permit Log") || find("Start Log") || find("START SCHEDULE")));
  if(!sheet){
    throw new Error(want
      ? `This workbook has no "${want}" tab, so it doesn't look like a ${div} Starts Log. `
        + `It contains: ${wb.SheetNames.slice(0,8).join(", ")}${wb.SheetNames.length>8?", …":""}. `
        + `Check you picked the right division and the right file.`
      : `No "Permit Log", "Start Log" or "START SCHEDULE" tab in this workbook.`);
  }
  const rows=XLSX.utils.sheet_to_json(wb.Sheets[sheet],{defval:null});
  /* community_num must be a NUMBER. The old fallback returned S(r["Comm"]) — which
     holds the community NAME (the next line uses it as one) — so any OLH row with
     a short or blank Job produced community_num:"BronsonRidge 60". The dedupe key
     is [community_num, plan, elevation], so such a row never matches the
     numerically-keyed existing row and inserts a duplicate with a name sitting in
     the Comm # column, which then collides again on every later import. Count it
     as skipped instead. */
  let skipped=0;
  const commNum=r=>{ const job=digits(r["Job"]); return job.length>=7 ? job.slice(0,7)+"0000" : ""; };  // first 7 digits = community (handles model/spec jobs like 1116272S111)
  // Pre-count building sizes so plex lots become "{N}-PLEX". Count units per PHYSICAL
  // building = community + building id. (Community is already in the key, so reused
  // building ids across communities don't collide.) We deliberately do NOT split by
  // start date: a plex is one structure even when its lots have staggered projected
  // starts, so splitting produced bogus counts like a "1-PLEX" + "6-PLEX" from one 7-plex.
  // Real townhome/plex buildings are Z-prefixed (ZA07, Z157, Z225…). A single-family
  // community's "Bldg" is a phase/block code (e.g. "6", "R") spanning many lots and plans —
  // NOT a building — so it must not trigger the plex transform (that produced "42-PLEX").
  const isPlexBldg=b=>!!b && /^z/i.test(b);
  const bldgCount={};
  for(const r of rows){ const b=S(r["Bldg"]); if(isPlexBldg(b)){ const k=commNum(r)+"|"+b; bldgCount[k]=(bldgCount[k]||0)+1; } }
  const idName={}, nameCount={}; const groups=new Map();
  const noteName=(num,comm)=>{ if(num&&comm){ (nameCount[num]=nameCount[num]||{})[comm]=(nameCount[num][comm]||0)+1; } };
  for(const r of rows){
    let comm=null, num="", plan=null, ev=null, trench=null; const bldg=S(r["Bldg"]);
    if(r["Comm"]!=null || (r["Job"]!=null && r["Project"]==null)){       // OLH "Permit Log" format
      comm=S(r["Comm"]); num=commNum(r);
      plan = S(r["Plan"]); ev = S(r["EV"])||S(r["Elevation"]);
      trench = xlDate(r["TrenchKey"])||xlDate(r["Start (Prj)"])||xlDate(r["Start (Act)"]);
      if(num && comm) idName[num]=comm; noteName(num,comm);
    } else if(r["Project"]!=null){                                       // TPU "Start Log" format
      const proj=S(r["Project"])||""; comm = proj.includes(" - ") ? proj.split(" - ").slice(1).join(" - ").trim() : proj;
      num = commNum(r); plan = S(r["Plan"]); ev = S(r["EV"])||S(r["Elevation"]);
      trench = xlDate(r["ActStart"])||xlDate(r["PrjStart"]);
      noteName(num,comm);
    } else { skipped++; continue; }
    // plex transform: buildings → "{units}-PLEX", elevation → first letter (matches the Flow grid).
    const bp=isPlexBldg(bldg);                // only Z-prefixed buildings are plexes
    const srcPlan=plan;                       // the real plan on this lot (e.g. H009)
    if(bp){ const cnt=bldgCount[num+"|"+bldg]; if(cnt) plan=cnt+"-PLEX"; if(ev) ev=ev.charAt(0); }
    const name = comm || idName[num] || num;
    if(!num || !plan){ skipped++; continue; }
    const add=(planLabel, evv)=>{ if(!planLabel) return; const key=[num,lc(planLabel),lc(evv||"")].join("|");
      if(!groups.has(key)) groups.set(key,{ community_name:name, community_num:num, plan:planLabel, elevation:evv, first_trench_date:trench, last_trench_date:trench });
      else{ const g=groups.get(key); if(trench){
        if(!g.first_trench_date || trench<g.first_trench_date) g.first_trench_date=trench;
        if(!g.last_trench_date  || trench>g.last_trench_date ) g.last_trench_date =trench; } } };
    add(plan, ev);                            // the plex ("{N}-PLEX") line, or a normal home line
    if(bp && srcPlan && lc(srcPlan)!==lc(plan)) add(srcPlan, ev);   // ALSO a separate line for each plan in the plex
  }
  // one canonical name per community number (a start log can list the same number under
  // several names, e.g. "Angeline 50 T2" / "Angeline 50 CLA") — pick the most common.
  const canon={};
  for(const num in nameCount){ let best=null, bn=-1; for(const nm in nameCount[num]){ if(nameCount[num][nm]>bn){ bn=nameCount[num][nm]; best=nm; } } canon[num]=best; }
  const out=[...groups.values()];
  out.forEach(g=>{ const c=canon[g.community_num]; if(c) g.community_name=c; });
  /* Report what was dropped, and refuse outright when NOTHING parsed.
     sheet_to_json takes its keys from the first row, so a workbook with a title
     line above the header, or "Job #" instead of "Job", matched none of the format
     branches above and every row hit `continue` — yielding zero rows and a preview
     that read "Parsed 0 combination(s) — nothing new to add and nothing changed",
     which an admin reasonably reads as "this log has no new work". Silence is the
     wrong answer to a file we could not understand. */
  if(rows.length && !out.length){
    throw new Error(`Read ${rows.length} row(s) from the "${sheet}" tab but recognised none of them. `
      + `Expected either a Comm/Job/Plan/EV layout or a Project/Job/Plan/EV one; found columns: `
      + `${Object.keys(rows[0]||{}).slice(0,10).join(", ")||"(none)"}. `
      + `Usually a title row above the header, or a renamed column.`);
  }
  out._skipped=skipped;
  out._sheet=sheet;
  return out;
}
async function buildImportPreview(){
  const div=$("adminDiv").value;
  const isFlow=importState.kind==="flow";
  const proposed=isFlow?parseFlowWorkbook(importState.wb):parseStartSchedule(importState.wb, div);
  /* If we cannot read what already exists, there is no safe preview to show. Every
     row we failed to read would be reported as new and inserted a second time, and
     the preview would say so with total confidence ("N new row(s) · 0 already
     exist"). Refuse rather than offer a Publish button over a partial diff. */
  let existRows;
  try{
    existRows=await existingFlow(div);   // always compare against the TARGET division's rows in the DB
  }catch(e){
    console.error("import preview: could not read existing rows", e);
    const panel=$("previewPanel"), body=$("previewBody");
    panel.classList.remove("hidden");
    body.innerHTML=`<p class="tiny" style="text-align:left"><b>Couldn't read the existing ${esc(div)} rows, so there is nothing safe to preview.</b></p>`
      + `<p class="tiny" style="text-align:left">${esc(e.message||String(e))}</p>`
      + `<p class="tiny" style="text-align:left">An import decides what is new by comparing the file against what is already in the grid. `
      + `On a partial read every row it failed to see counts as new and gets inserted again — that is how duplicate rows are created. `
      + `Re-drop the file once this loads.</p>`;
    return;
  }
  // A combination = community NUMBER + plan + elevation. Only genuinely new combinations are added.
  // Plex plans are normalized (the "{N}-PLEX" unit count is unreliable between the log and the grid),
  // so a plex is matched by community + "PLEX" + elevation.
  // Canonicalize plex plans to "{N}-plex" (keeping the unit count) so a 7-PLEX only
  // matches a 7-PLEX — collapsing all sizes to "plex" made a 7-PLEX inherit the
  // community-wide earliest plex start (a smaller building), showing a wrong date.
  const normPlan=p=>{ const s=lc(p); const m=s.match(/^(\d+)\s*-?\s*plex$/); return m ? m[1]+"-plex" : s; };
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
  // ---- detect combinations whose EARLIEST trench date moved (existing rows only) ----
  const existByCombo=new Map(), existByNumPlan=new Map();
  existRows.forEach(r=>{ existByCombo.set(combo(r.community_num,r.plan,r.elevation), r);
    const k=String(r.community_num||"").trim()+"|"+normPlan(r.plan); if(!existByNumPlan.has(k)) existByNumPlan.set(k,r); });
  const findExisting=p=>{ const num=String(p.community_num||"").trim();
    return existByCombo.get(combo(num,p.plan,p.elevation)) || (!String(p.elevation||"").trim()?existByNumPlan.get(num+"|"+normPlan(p.plan)):null) || null; };
  // Several parsed combos can map to ONE existing row (plex plans collapse to "plex",
  // or an elevation-less start falls back to community+plan). Collapse them per row and
  // keep the EARLIEST date, so each row is updated once (also avoids a duplicate-id upsert).
  // existing rows: update the First Trench date when the earliest start moved (per row, once)
  const freshSet=new Set(fresh), agg=new Map();
  if(!isFlow) proposed.forEach(p=>{ if(freshSet.has(p)) return; const r=findExisting(p); if(!r) return;
    const nt=p.first_trench_date; if(!nt) return;
    const lt=p.last_trench_date||nt;
    let cur=agg.get(r.id);
    if(!cur){ agg.set(r.id,{row:r, earliest:nt, latest:lt}); }
    else{ if(nt<cur.earliest) cur.earliest=nt; if(lt>cur.latest) cur.latest=lt; } });
  const updates=[];
  // last_trench_date mirrors the CURRENT log's latest start per row (may move backward
  // when future lots are dropped). It drives the red status on the Plans tab.
  const lastUpd=new Map();
  agg.forEach(({row:r, earliest, latest})=>{
    if(earliest!==(r.first_trench_date||null))
      updates.push({ id:r.id, community_name:numName[String(r.community_num||"").trim()]||r.community_name, community_num:r.community_num, plan:r.plan, elevation:r.elevation||"", trFrom:r.first_trench_date||"", trTo:earliest });
    if(latest && latest!==(r.last_trench_date||null)) lastUpd.set(r.id, latest);
  });
  const panel=$("previewPanel"), body=$("previewBody");
  panel.classList.remove("hidden");
  const src=isFlow?"FLOW OF TAKEOFFS workbook":"Starts Log";
  /* The dropped-lot count used to be invisible: `proposed.length` is the count
     AFTER rows with a blank/short job number or no plan were skipped, so a log
     half of whose lots were unusable reported a clean, confident total. */
  const skipped=proposed._skipped||0;
  const sheetNm=proposed._sheet?` ("${esc(proposed._sheet)}" tab)`:"";
  const skipNote=skipped
    ? `<div class="tiny" style="text-align:left;margin:6px 0 0"><b>${skipped} row(s) in the file were skipped</b> — no usable community number (Job) or no plan. `
      + `They are not in the counts below and will not be imported.</div>`
    : "";
  if(!fresh.length && !updates.length && !lastUpd.size){
    body.innerHTML=`<p class="tiny" style="text-align:left">Parsed ${proposed.length} combination(s) from the ${src}${sheetNm} — nothing new to add and nothing changed in ${esc(div)}.</p>`+skipNote;
    return;
  }
  // ---- change summary ----
  const byComm=new Map();
  fresh.forEach(r=>byComm.set(r.community_name,(byComm.get(r.community_name)||0)+1));
  const newComms=[...new Set(fresh.filter(p=>!existingNums.has(String(p.community_num||"").trim())).map(p=>p.community_name))];
  const sumParts=[]; if(fresh.length) sumParts.push(`${fresh.length} new row(s)`); if(updates.length) sumParts.push(`${updates.length} trench update(s)`);
  if(lastUpd.size) sumParts.push(`${lastUpd.size} latest-start refresh(es)`);
  importState.summary=`Imported ${sumParts.join(" + ")} from ${src} → ${div}${byComm.size?` · ${byComm.size} communities`:""}${newComms.length?`, ${newComms.length} new`:""}`;
  importState.detail={ source:src, division:div, communities:byComm.size, newCommunities:newComms,
    added:fresh.map(r=>({community:r.community_name, plan:r.plan, elevation:r.elevation||"", trench:r.first_trench_date||""})),
    dateChanges:updates.map(u=>({community:u.community_name, plan:u.plan, elevation:u.elevation, from:u.trFrom, to:u.trTo})) };
  const pnMap=(state.planNames&&state.planNames[div])||{};
  const pnOf=r=>pnMap[String(r.plan==null?"":r.plan).trim().toUpperCase()]||"";
  let h=`<div class="import-summary">
    <div class="is-row">${fresh.length?`<span class="is-n">${fresh.length}</span> new row(s)`:""}${fresh.length&&updates.length?" &nbsp;·&nbsp; ":""}${updates.length?`<span class="is-n">${updates.length}</span> trench update(s)`:""} for <b>${esc(div)}</b></div>
    <div class="tiny" style="text-align:left;margin:2px 0 0">${proposed.length} parsed · ${proposed.length-fresh.length} already exist${newComms.length?` · <b>${newComms.length} new communities</b>`:""}</div>
    ${skipNote}
    ${newComms.length?`<div class="tiny" style="text-align:left;margin:6px 0 0">New communities: ${newComms.slice(0,12).map(esc).join(", ")}${newComms.length>12?` +${newComms.length-12} more`:""}</div>`:""}
    <div class="tiny" style="text-align:left;margin:6px 0 0">Each plex building adds an N-PLEX line <b>plus a line for every plan in it</b> (e.g. H009, N122). Existing rows are only changed when the earliest First Trench date moved (below).</div>
    ${lastUpd.size?`<div class="tiny" style="text-align:left;margin:6px 0 0">Also refreshes the <b>latest start date</b> on ${lastUpd.size} matched row(s) — this is what marks a plan red on the Plans tab when it has no starts from today forward.</div>`:""}
  </div>`;
  if(fresh.length){
    h+=`<div class="tiny" style="text-align:left;font-weight:700;margin:10px 0 4px">New rows to add</div>`;
    h+=`<div class="prev-scroll"><table class="prev-table"><thead><tr><th>Community</th><th>Comm #</th><th>Plan</th><th>Plan Name</th><th>Elevation</th><th>First Trench</th></tr></thead><tbody>`;
    fresh.slice(0,200).forEach(r=>h+=`<tr><td>${esc(r.community_name)}${newComms.includes(r.community_name)?' <span class="badge" style="background:var(--good)">new</span>':""}</td><td>${esc(r.community_num||"")}</td><td>${esc(r.plan)}</td><td>${esc(pnOf(r))}</td><td>${esc(r.elevation||"")}</td><td>${esc(fmtDate(r.first_trench_date))}</td></tr>`);
    h+=`</tbody></table></div>`;
    if(fresh.length>200) h+=`<p class="tiny" style="text-align:left">…and ${fresh.length-200} more.</p>`;
  }
  if(updates.length){
    h+=`<div class="tiny" style="text-align:left;font-weight:700;margin:12px 0 4px">First Trench date changes (earliest start moved)</div>`;
    h+=`<div class="prev-scroll"><table class="prev-table"><thead><tr><th>Community</th><th>Comm #</th><th>Plan</th><th>Elevation</th><th>Current</th><th>New (earliest)</th></tr></thead><tbody>`;
    updates.slice(0,200).forEach(u=>h+=`<tr><td>${esc(u.community_name)}</td><td>${esc(u.community_num||"")}</td><td>${esc(u.plan)}</td><td>${esc(u.elevation||"")}</td><td>${esc(fmtDate(u.trFrom))||'<span class="muted">—</span>'}</td><td><b>${esc(fmtDate(u.trTo))}</b></td></tr>`);
    h+=`</tbody></table></div>`;
    if(updates.length>200) h+=`<p class="tiny" style="text-align:left">…and ${updates.length-200} more.</p>`;
  }
  const btnLabel=[fresh.length?`add ${fresh.length} row(s)`:"", updates.length?`update ${updates.length} row(s)`:"", (!fresh.length&&!updates.length&&lastUpd.size)?`refresh ${lastUpd.size} latest-start date(s)`:""].filter(Boolean).join(" & ");
  h+=`<button class="btn" id="publishImport">Publish — ${btnLabel} to ${esc(div)}</button>`;
  body.innerHTML=h;
  $("publishImport").onclick=async()=>{ await publishImport(div, fresh, updates, lastUpd, importState.summary, importState.detail); };
}
/* The set the import diffs against. A SHORT ANSWER HERE INSERTS DUPLICATES: every
   existing row this fails to return is classified as new and re-added. sbAll now
   throws rather than returning a partial page, and callers must let that propagate
   rather than treating it as "nothing exists yet". Ordered by id for the same
   reason every other pager is — see sbAll. */
async function existingFlow(div){
  if(DEMO) return MEM.flow_rows.filter(r=>r.division===div);
  return await sbAll(()=>sb.from("flow_rows").select("id,community_name,community_num,plan,elevation,first_trench_date,last_trench_date,plan_name,sort_order").eq("division",div), "id");
}
/* One request per 500 rows instead of one per row. `op` is "insert" or "upsert". */
async function sbBulk(op, table, rows, extra){
  const CHUNK=500;
  for(let i=0;i<rows.length;i+=CHUNK){
    const slice=rows.slice(i,i+CHUNK);
    const { error } = op==="upsert" ? await sb.from(table).upsert(slice, extra) : await sb.from(table).insert(slice);
    if(error){ console.error(error); throw error; }
  }
}
async function publishImport(div, fresh, updates, lastUpd, summary, detail){
  $("publishImport").disabled=true; adminMsg("Publishing…","info");
  try{
    const existRows=await existingFlow(div);
    let n=existRows.reduce((m,r)=>Math.max(m, r.sort_order||0), 0);
    const now=new Date().toISOString();
    // build all new rows up front
    const newRows=fresh.map(p=>{ const row={ id:uid(), division:div, sort_order:++n, updated_at:now, updated_by:state.email };
      for(const k in p){ if(k!=="id"&&k!=="division"&&k!=="sort_order") row[k]=p[k]; } return row; });
    /* Partial upsert for existing-row changes: id + division (NOT NULL) + the two
       trench dates. One row per id so the batch never touches the same row twice.

       EVERY OBJECT IN THIS ARRAY MUST CARRY THE SAME KEYS. This used to set
       first_trench_date / last_trench_date only when that one had moved, which
       looked like a tidy partial write and was in fact a data-loss bug.
       postgrest-js resolves a mixed-key array by taking the UNION of all keys and
       sending it as ?columns=  (see @supabase/postgrest-js upsert()). That is what
       avoids PostgREST's "All object keys must match" error — so nothing errors.
       Instead, for an object missing a key in that union, PostgREST writes NULL,
       and resolution=merge-duplicates applies it. A row whose only change was
       last_trench_date therefore had first_trench_date overwritten with NULL —
       the column every calculated date derives from.

       It was not hypothetical: one Orlando import on 2026-09-14 nulled
       first_trench_date on 26 rows across CROSSPRARIE 50GC, Wellness 22GC,
       Springhead 25GC, Harvest Grove and others, blanking all six of their
       calculated columns. Nothing errored and nobody was told. It self-healed
       partially because the next import saw the NULL and restored it, while
       nulling a different set — so the dates churned on every run.

       So: carry both columns on every row, falling back to the row's CURRENT
       value when this import did not move that date. Same fix in blueprint/db.js.
       Anything added here must be added to both, per the root README.           */
    const curById=new Map(existRows.map(r=>[r.id,r]));
    const byId=new Map(); (updates||[]).forEach(u=>byId.set(u.id,{id:u.id, trTo:u.trTo}));
    if(lastUpd) lastUpd.forEach((lt,id)=>{ const cur=byId.get(id)||{id}; cur.lastTo=lt; byId.set(id,cur); });
    const updRows=[...byId.values()].map(u=>{
      const cur=curById.get(u.id)||{};
      return { id:u.id, division:div, updated_at:now, updated_by:state.email,
               first_trench_date: u.trTo  || cur.first_trench_date || null,
               last_trench_date:  u.lastTo || cur.last_trench_date  || null };
    });
    if(DEMO){
      newRows.forEach(r=>MEM.flow_rows.push(r));
      updRows.forEach(d=>{ const r=MEM.flow_rows.find(x=>x.id===d.id); if(r){ if(d.first_trench_date!==undefined) r.first_trench_date=d.first_trench_date; if(d.last_trench_date!==undefined) r.last_trench_date=d.last_trench_date; if(d.plan_name!==undefined) r.plan_name=d.plan_name; } });
    }else{
      if(newRows.length) await sbBulk("insert","flow_rows",newRows);            // one call per 500 new rows
      if(updRows.length) await sbBulk("upsert","flow_rows",updRows,{onConflict:"id"});  // one call per 500 row updates
    }
    await logChange(div, summary||`Imported ${fresh.length} row(s) into ${div}`, detail);
    adminMsg(`Published ${fresh.length} new row(s)${(updates&&updates.length)?` and updated ${updates.length} existing row(s)`:""} in ${div}.`,"ok");
    $("previewPanel").classList.add("hidden"); $("tileStarts").classList.remove("filled"); $("startsName").textContent="Drop the Starts Log .xlsx here or click to browse";
    if(div===state.divKey){ await loadDivisionGuarded(div); render(); }   // reload once, not per row
  }catch(e){
    adminMsg("Publish failed: "+(e.message||e),"err"); $("publishImport").disabled=false;
  }
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
      if(d.dateChanges&&d.dateChanges.length) detailHTML+=`<div class="chg-sec"><div class="chg-sec-h">Trench date updates (${d.dateChanges.length})</div><ul class="chg-list">${d.dateChanges.slice(0,300).map(c=>`<li>${esc(c.community)} — ${esc(c.plan)} ${esc(c.elevation||"")} <span class="chg-arrow">${esc(fmtDate(c.from))||"—"} → ${esc(fmtDate(c.to))}</span></li>`).join("")}${d.dateChanges.length>300?`<li class="tiny">…and ${d.dateChanges.length-300} more</li>`:""}</ul></div>`;
      if(d.planChanges&&d.planChanges.length) detailHTML+=`<div class="chg-sec"><div class="chg-sec-h">Plex plan updates (${d.planChanges.length})</div><ul class="chg-list">${d.planChanges.slice(0,300).map(c=>`<li>${esc(c.community)} — ${esc(c.plan)} ${esc(c.elevation||"")} <span class="chg-arrow">${esc(c.from)||"—"} → ${esc(c.to)}</span></li>`).join("")}${d.planChanges.length>300?`<li class="tiny">…and ${d.planChanges.length-300} more</li>`:""}</ul></div>`;
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

/* ---- Access & permissions (admin only) ---- */
async function renderPerms(){
  const p=$("permsPanel");
  if(!isAdmin()){ p.innerHTML=`<div class="panel"><div class="panel-h">Access</div><div style="padding:16px"><p class="tiny" style="text-align:left;margin:0">You can import and edit data for your division(s). Only an admin can change user roles.</p></div></div>`; return; }
  // load users — all login accounts (shared across apps) with their Takeoff-Flow role
  if(DEMO){ state.users=MEM.app_roles.slice(); }
  else{
    let list=[];
    try{ const { data, error }=await sb.rpc("tf_admin_list_users"); if(error) throw error;
      list=(data||[]).map(u=>({email:u.email,role:u.role,divisions:u.divisions||[]}));
    }catch(e){ console.warn("tf_admin_list_users failed, using tf_app_roles only",e); }
    // Always merge in tf_app_roles rows so people who were given a role but don't have a
    // login account yet (e.g. Tampa editors added before their first sign-in) still appear.
    /* Paged. Unpaginated this capped at 1000 with no error, so past that an admin
       simply could not see — or revoke — a user in Access & permissions. Latent at
       current scale, silent when it isn't. supabase-js resolves with {data,error}
       rather than rejecting, so the bare catch never fired either. */
    try{
      const roleRows=await sbAll(()=>sb.from("tf_app_roles").select("email,role,divisions"), "email");
      const have=new Set(list.map(u=>lc(u.email)));
      roleRows.forEach(r=>{ if(!have.has(lc(r.email))) list.push({email:r.email, role:r.role, divisions:r.divisions||[]}); });
    }catch(e){ console.error("role list load failed",e); toast("Couldn't load the full role list — some users may be missing below.","err"); }
    list.sort((a,b)=>String(a.email).localeCompare(String(b.email)));
    state.users=list;
  }
  const divChecks=CFG.DIVISIONS.map(d=>`<label class="permchk"><input type="checkbox" class="pdiv" value="${d.key}"> ${esc(d.label)}</label>`).join("");
  p.innerHTML=`<div class="panel"><div class="panel-h">Access &amp; permissions</div>
    <div style="padding:16px">
      <p class="tiny" style="text-align:left;margin:0 0 12px">Everyone at ${esc(CFG.ALLOWED_DOMAIN)} can view. Grant <b>editor</b> or <b>purchasing</b> (for the chosen divisions), or <b>admin</b> (full access).</p>
      <div class="permform">
        <input type="email" id="pEmail" placeholder="user@lennar.com">
        <select id="pRole"><option value="viewer">viewer</option><option value="editor">editor</option><option value="purchasing">purchasing</option><option value="admin">admin</option></select>
        <span class="permdivs" id="pDivs">${divChecks}</span>
        <button class="btn mini" id="pAdd">Save user</button>
      </div>
      <div id="permMsg" class="msg"></div>
      <input type="text" id="userSearch" class="permsearch" placeholder="Search users by email, role, or division…">
      <div class="table-wrap" id="userList"></div>
    </div></div>`;
  const toggleDivs=()=>{ $("pDivs").style.display = ["editor","purchasing"].includes($("pRole").value) ? "inline-flex":"none"; };
  $("pRole").addEventListener("change",toggleDivs); toggleDivs();
  $("pAdd").onclick=addUser;
  $("userSearch").oninput=drawUsers;
  drawUsers();
}
function permMsg(t,k){ const m=$("permMsg"); if(m){ m.className="msg "+(k||"info"); m.textContent=t; } }
function permTable(rows, filtered){
  if(!rows.length) return `<div class="empty">${filtered?"No users match your search.":`No explicit roles yet — everyone at ${esc(CFG.ALLOWED_DOMAIN)} is a viewer.`}</div>`;
  const dl=k=>(CFG.DIVISIONS.find(d=>d.key===k)||{}).label||k;
  return `<table><thead><tr><th>Email</th><th>Role</th><th>Divisions</th><th></th></tr></thead><tbody>${
    rows.map(r=>`<tr><td>${esc(r.email)}</td><td><span class="role-tag">${esc(r.role)}</span></td>
      <td>${(r.divisions&&r.divisions.length)? r.divisions.map(k=>`<span class="chip">${esc(dl(k))}</span>`).join("") : (r.role==="admin"?'<span class="cat-tag">all</span>':'—')}</td>
      <td class="acts">${DEMO?"":`<button class="linkbtn permEdit" data-email="${esc(r.email)}">Edit</button> <button class="linkbtn permInvite" data-email="${esc(r.email)}">Invite</button> <button class="linkbtn danger permDel" data-email="${esc(r.email)}">Remove</button>`}</td></tr>`).join("")
  }</tbody></table>`;
}
function drawUsers(){
  const list=$("userList"); if(!list) return;
  const q=lc(($("userSearch")&&$("userSearch").value)||"");
  const rows=q ? state.users.filter(u=>lc(u.email).includes(q)||lc(u.role).includes(q)||(u.divisions||[]).some(d=>lc(d).includes(q))) : state.users;
  list.innerHTML=permTable(rows, !!q);
  list.querySelectorAll(".permEdit").forEach(b=>b.onclick=()=>editUser(b.dataset.email));
  list.querySelectorAll(".permInvite").forEach(b=>b.onclick=()=>inviteUser(b.dataset.email));
  list.querySelectorAll(".permDel").forEach(b=>b.onclick=()=>deleteUser(b.dataset.email));
}
function editUser(email){
  const u=state.users.find(x=>x.email===email); if(!u) return;
  $("pEmail").value=u.email; $("pRole").value=u.role;
  const set=new Set(u.divisions||[]); document.querySelectorAll(".pdiv").forEach(c=>c.checked=set.has(c.value));
  $("pRole").dispatchEvent(new Event("change"));
  $("pEmail").focus();
}
async function deleteUser(email){
  email=lc(email);
  if(email===lc(state.email||"")) return permMsg("You can't remove your own account.","err");
  if(DEMO){ MEM.app_roles=MEM.app_roles.filter(u=>u.email!==email); state.users=state.users.filter(u=>u.email!==email); drawUsers(); return; }
  if(!confirm(`Delete the login for ${email}?\n\nThis removes their access to all sites on this account and can't be undone.`)) return;
  try{
    const { data, error }=await sb.rpc("tf_admin_delete_user",{ target_email:email });
    if(error) throw error;
    if(!data || !data.ok) throw new Error((data&&data.error)||"Remove failed.");
    state.users=state.users.filter(u=>u.email!==email); drawUsers();
    permMsg(`Removed ${email} — their login has been deleted.`,"ok");
  }catch(e){ permMsg("Remove failed: "+e.message,"err"); }
}
async function addUser(){
  const email=lc($("pEmail").value), role=$("pRole").value;
  if(!email.endsWith(CFG.ALLOWED_DOMAIN)) return permMsg("Email must be "+CFG.ALLOWED_DOMAIN,"err");
  const divisions=["editor","purchasing"].includes(role) ? [...document.querySelectorAll(".pdiv:checked")].map(c=>c.value) : [];
  const row={ email, role, divisions };
  if(DEMO){ const i=MEM.app_roles.findIndex(u=>u.email===email); if(i>=0)MEM.app_roles[i]=row; else MEM.app_roles.push(row); }
  else{ const { error }=await sb.from("tf_app_roles").upsert(row); if(error) return permMsg("Save failed: "+error.message,"err"); }
  const i=state.users.findIndex(u=>u.email===email); if(i>=0)state.users[i]=row; else state.users.push(row);
  $("pEmail").value=""; document.querySelectorAll(".pdiv:checked").forEach(c=>c.checked=false);
  permMsg("Saved "+email+" as "+role+".","ok"); drawUsers();
}
/* Add user / reset password — generates a one-time link (admin only). Relies on the
   shared Supabase RPCs admin_add_or_reset() and redeem_reset_token(). No email is sent. */
function renderResetLinks(){
  const p=$("resetPanel"); if(!p) return;
  if(!isAdmin()){ p.classList.add("hidden"); return; }
  p.classList.remove("hidden");
  p.innerHTML=`<div class="panel"><div class="panel-h">Add user / reset password</div>
    <div style="padding:16px">
      <p class="tiny" style="text-align:left;margin:0 0 12px">Enter any ${esc(CFG.ALLOWED_DOMAIN)} email. If it's a new person, the account is created automatically. Either way you get a one-time link (valid 24 hours) for them to set their own password — copy it and send it directly. No email is sent.</p>
      <div class="permform">
        <input type="email" id="resetEmail" placeholder="user@lennar.com">
        <button class="btn mini" id="resetGen">Generate link</button>
      </div>
      <div id="resetMsg" class="msg"></div>
      <div id="resetOut" class="hidden" style="margin-top:10px">
        <div class="linkrow"><input type="text" id="resetLink" readonly><button class="btn mini ghost" id="resetCopy">Copy</button></div>
      </div>
    </div></div>`;
  $("resetGen").onclick=genResetLink;
  $("resetEmail").addEventListener("keydown",e=>{ if(e.key==="Enter") genResetLink(); });
  $("resetCopy").onclick=()=>{ const i=$("resetLink"); i.select(); i.setSelectionRange(0,99999);
    if(navigator.clipboard) navigator.clipboard.writeText(i.value); else document.execCommand("copy");
    const b=$("resetCopy"); b.textContent="Copied"; setTimeout(()=>b.textContent="Copy",1500); };
}
function resetMsg(t,k){ const m=$("resetMsg"); if(m){ m.className="msg "+(k||"info"); m.textContent=t; } }
async function genResetLink(){
  const email=lc($("resetEmail").value); resetMsg("");
  $("resetOut").classList.add("hidden");
  if(!email || !email.endsWith(CFG.ALLOWED_DOMAIN)) return resetMsg("Enter a valid "+CFG.ALLOWED_DOMAIN+" email.","err");
  if(DEMO) return resetMsg("Reset links are disabled in demo mode.","err");
  $("resetGen").disabled=true; $("resetGen").textContent="Generating…";
  try{
    const { data, error }=await sb.rpc("tf_admin_add_or_reset",{ target_email:email });   // authorizes via tf_app_roles (Takeoff Flow's own admins)
    if(error) throw error;
    const token=data&&data.token; if(!token) throw new Error("No link was returned.");
    const url=((CFG.BLUEPRINT_URL||(location.origin+location.pathname)).replace(/#.*$/,""))+"#recover="+encodeURIComponent(token);
    $("resetLink").value=url; $("resetOut").classList.remove("hidden");
    resetMsg((data.created?"New account created for ":"Reset link ready for ")+email+" — copy the link and send it. It expires in 24 hours.","ok");
  }catch(e){ resetMsg(prettyErr(e,"Could not generate a link."),"err"); }
  finally{ $("resetGen").disabled=false; $("resetGen").textContent="Generate link"; }
}
/* Per-user "Invite": generate a one-time link for that email and show it to copy/send.
   (No email is sent — Lennar's gateway blocks the sender, so the admin sends it directly.) */
async function inviteUser(email){
  email=lc(email);
  if(DEMO) return showInviteModal(email, null, "Invites are disabled in demo mode.");
  try{
    const { data, error }=await sb.rpc("tf_admin_add_or_reset",{ target_email:email });
    if(error) throw error;
    const token=data&&data.token; if(!token) throw new Error("No link was returned.");
    const url=((CFG.BLUEPRINT_URL||(location.origin+location.pathname)).replace(/#.*$/,""))+"#recover="+encodeURIComponent(token);
    showInviteModal(email, url, (data.created?"New account created. ":"")+"Copy this one-time link (valid 24 hours) and send it to the user — it lets them set their own password. No email is sent.");
  }catch(e){ showInviteModal(email, null, "Couldn't create a link: "+prettyErr(e,"unknown error")); }
}
function showInviteModal(email, url, note){
  document.querySelectorAll(".modal-ov").forEach(m=>m.remove());
  const ov=document.createElement("div"); ov.className="modal-ov";
  ov.innerHTML=`<div class="modal-card" style="max-width:560px">
    <div class="modal-h">Invite ${esc(email)}<button class="linkbtn" data-x aria-label="Close">&times;</button></div>
    <div class="modal-body">
      <p class="tiny" style="text-align:left;margin:0 0 12px">${esc(note||"")}</p>
      ${url?`<div class="linkrow"><input type="text" id="inviteLink" readonly value="${esc(url)}"><button class="btn mini ghost" id="inviteCopy">Copy</button></div>`:""}
      <div class="modal-actions" style="margin-top:14px"><button class="btn ghost" id="inviteClose">Close</button></div>
    </div></div>`;
  document.body.appendChild(ov);
  const close=()=>ov.remove();
  ov.addEventListener("click",e=>{ if(e.target===ov) close(); });
  ov.querySelector("[data-x]").onclick=close;
  ov.querySelector("#inviteClose").onclick=close;
  if(url){ const i=ov.querySelector("#inviteLink"); i.focus(); i.select();
    ov.querySelector("#inviteCopy").onclick=()=>{ i.select(); i.setSelectionRange(0,99999);
      if(navigator.clipboard) navigator.clipboard.writeText(i.value); else document.execCommand("copy");
      const b=ov.querySelector("#inviteCopy"); b.textContent="Copied"; setTimeout(()=>b.textContent="Copy",1500); }; }
}

/* ---- Plan names (admin tile): editors/admins manage the plan# → name mapping (tf_plan_names)
   for the selected division. The Flow / Budgets / To-Do tabs show these names read-only. ---- */
function renderPlanNames(){
  const p=$("planNamesPanel"); if(!p) return;
  const div=state.divKey;   // follow the header division selector
  if(!div || !(isAdmin()||canEditDiv(div))){ p.innerHTML=""; return; }
  const label=(CFG.DIVISIONS.find(d=>d.key===div)||{}).label||div;
  p.innerHTML=`<div class="panel"><div class="panel-h">Plan names — ${esc(label)}</div>
    <div style="padding:16px">
      <p class="tiny" style="text-align:left;margin:0 0 12px">Plan names are consistent across divisions; only the <b>plan number</b> is division-specific. This list shows the numbers mapped for <b>${esc(label)}</b>. Names show read-only on the Flow, Pending Budgets, and To-Do tabs.</p>
      <div class="pn-toolbar">
        <input type="text" id="pnSearch" class="permsearch" placeholder="Search plan # or name…">
        <button class="btn mini pn-add" id="pnAddBtn" title="Add plan name" aria-label="Add plan name">+</button>
      </div>
      <div id="pnMsg" class="msg"></div>
      <div class="table-wrap" id="pnList"></div>
    </div></div>`;
  $("pnAddBtn").onclick=()=>openPlanNameModal(div, null);
  $("pnSearch").oninput=()=>drawPlanNames(div);
  drawPlanNames(div);
}
function pnMsg(t,k){ const m=$("pnMsg"); if(m){ m.className="msg "+(k||"info"); m.textContent=t; } }
function drawPlanNames(div){
  const list=$("pnList"); if(!list) return;
  const map=(state.planNames&&state.planNames[div])||{};
  const q=lc(($("pnSearch")&&$("pnSearch").value)||"");
  let rows=Object.keys(map).map(pn=>({plan_no:pn, name:map[pn]}));
  rows.sort((a,b)=>String(a.plan_no).localeCompare(String(b.plan_no),undefined,{numeric:true}));
  if(q) rows=rows.filter(r=>lc(r.plan_no).includes(q)||lc(r.name).includes(q));
  if(!rows.length){ list.innerHTML=`<div class="empty">${q?"No plans match your search.":"No plan names mapped yet for this division."}</div>`; return; }
  list.innerHTML=`<table><thead><tr><th>Plan #</th><th>Plan name</th><th></th></tr></thead><tbody>${
    rows.map(r=>`<tr><td>${esc(r.plan_no)}</td><td>${esc(r.name)}</td>
      <td class="acts"><button class="linkbtn pnEdit" data-no="${esc(r.plan_no)}">Edit</button> <button class="linkbtn pnDel" data-no="${esc(r.plan_no)}">Remove</button></td></tr>`).join("")
  }</tbody></table>`;
  list.querySelectorAll(".pnEdit").forEach(b=>b.onclick=()=>openPlanNameModal(div, {division:div, plan_no:b.dataset.no, name:map[b.dataset.no]||""}));
  list.querySelectorAll(".pnDel").forEach(b=>b.onclick=()=>delPlanNameRow(div,b.dataset.no));
}
/* Add / edit a plan-name mapping. Lets the user pick which division the plan NUMBER
   belongs to (numbers are division-specific); the plan NAME is shared across divisions. */
function openPlanNameModal(tileDiv, orig){
  document.querySelectorAll(".modal-ov").forEach(m=>m.remove());
  const divs=CFG.DIVISIONS.filter(d=>isAdmin()||canEditDiv(d.key));
  const selDiv=(orig&&orig.division)||tileDiv;
  const opts=divs.map(d=>`<option value="${d.key}" ${d.key===selDiv?"selected":""}>${esc(d.label)}</option>`).join("");
  const ov=document.createElement("div"); ov.className="modal-ov";
  ov.innerHTML=`<div class="modal-card" style="max-width:460px">
    <div class="modal-h">${orig?"Edit plan name":"Add plan name"}<button class="linkbtn" data-x aria-label="Close">&times;</button></div>
    <div class="modal-body">
      <label class="fld" for="pnmName">Plan name</label>
      <input type="text" id="pnmName" placeholder="e.g. Wellness Villa" value="${esc(orig?orig.name:"")}">
      <label class="fld" for="pnmNo" style="margin-top:12px">Plan number</label>
      <input type="text" id="pnmNo" placeholder="e.g. 1447" value="${esc(orig?orig.plan_no:"")}">
      <label class="fld" for="pnmDiv" style="margin-top:12px">Division</label>
      <select id="pnmDiv">${opts}</select>
      <p class="tiny" style="text-align:left;margin:12px 0 0">Plan names are considered consistent between divisions — the same plan name applies everywhere. Only the <b>plan number</b> is division-specific, so map each division's number to the shared name.</p>
      <div id="pnmMsg" class="msg"></div>
      <div class="modal-actions" style="margin-top:14px"><button class="btn" id="pnmSave">Save</button><button class="btn ghost" id="pnmCancel">Cancel</button></div>
    </div></div>`;
  document.body.appendChild(ov);
  const close=()=>ov.remove();
  ov.addEventListener("click",e=>{ if(e.target===ov) close(); });
  ov.querySelector("[data-x]").onclick=close; ov.querySelector("#pnmCancel").onclick=close;
  ov.querySelector("#pnmName").focus();
  const msg=(t,k)=>{ const m=ov.querySelector("#pnmMsg"); m.className="msg "+(k||"info"); m.textContent=t; };
  ov.querySelector("#pnmSave").onclick=async()=>{
    const name=String(ov.querySelector("#pnmName").value||"").trim();
    const no=String(ov.querySelector("#pnmNo").value||"").trim().toUpperCase();
    const division=ov.querySelector("#pnmDiv").value;
    if(!name) return msg("Enter a plan name.","err");
    if(!no) return msg("Enter a plan number.","err");
    const btn=ov.querySelector("#pnmSave"); btn.disabled=true;
    try{
      // editing and the key (division or number) changed → remove the old mapping first
      if(orig && (orig.division!==division || orig.plan_no!==no)){
        const om=(state.planNames&&state.planNames[orig.division])||{}; delete om[orig.plan_no];
        if(!DEMO) await sb.from("tf_plan_names").delete().eq("division",orig.division).eq("plan_no",orig.plan_no);
      }
      state.planNames=state.planNames||{}; const m2=state.planNames[division]=state.planNames[division]||{}; m2[no]=name;
      if(!DEMO){ const { error }=await sb.from("tf_plan_names").upsert({division, plan_no:no, name},{onConflict:"division,plan_no"}); if(error) throw error; }
      close();
      drawPlanNames(state.divKey);
      pnMsg("Saved "+no+" → "+name+" ("+((CFG.DIVISIONS.find(d=>d.key===division)||{}).label||division)+").","ok");
    }catch(e){ msg("Save failed: "+((e&&e.message)||e),"err"); btn.disabled=false; }
  };
}
async function delPlanNameRow(div, no){
  if(!confirm("Remove the plan name for "+no+"?")) return;
  const m=(state.planNames&&state.planNames[div])||{}; const prev=m[no]; delete m[no];
  if(!DEMO){ const { error }=await sb.from("tf_plan_names").delete().eq("division",div).eq("plan_no",no); if(error){ m[no]=prev; return pnMsg("Delete failed: "+error.message,"err"); } }
  pnMsg("Removed "+no+".","ok"); drawPlanNames(div);
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
if(!initRecovery()) tryRestore();
