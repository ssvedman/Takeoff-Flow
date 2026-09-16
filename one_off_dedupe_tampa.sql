-- ===========================================================================
-- Collapse duplicate flow_rows back to one row per community/plan/elevation.
--
-- ALREADY RUN FOR TAMPA on 2026-09-15 (1591 rows, 1591 combinations, 0
-- duplicates). Kept tracked because the repository has to describe the
-- database, and because it is the tool if this ever recurs in another division.
--
-- ONE SHOT. Paste the whole file, run once. No sections to run separately, no
-- number to eyeball mid-way, no decision to make. It is one transaction: the
-- assertion near the end raises rather than returns, so a bad run rolls itself
-- back and writes nothing. Re-running when there is nothing to merge is a
-- no-op — it writes no rows and logs no change-log entry.
--
-- It returns ONE table: every group whose surviving row came out with a
-- different First Trench or Latest Start date than it had. Most groups don't
-- appear — their copies carried identical dates, so the merge is invisible.
-- Those that do matter, because first_trench_date drives cis_due,
-- master_tp_due, estimate_eta, pricing_stage, loc_upload and tasks_start, all
-- WORKDAY offsets from it. Keep that output; it is the record of what moved.
--
--
-- WHY THE DUPLICATES EXISTED
--   Blueprint's Data Intake read the existing rows it diffs an import against
--   with a plain select. PostgREST caps that at 1000 and does not error when it
--   truncates. Tampa was 1150 in July; the importer saw 1000, decided the other
--   150+ combinations were new, and inserted them again. No ORDER BY, so a
--   different slice fell off each run rather than the same tail.
--
--   It compounds, which is why this was far worse than a doubling: every import
--   grows the table, so more of it sits past the cap next time. 1150 -> sees
--   1000, adds 150 -> 1300 -> adds 300 -> 1600 -> adds 600. Six or seven Starts
--   Logs took Tampa past 4000 rows at up to 9 copies per combination, and
--   because the invisible slice moved, nearly everything got caught.
--
--   flowPublish derived max(sort_order) from the same truncated read, so
--   separate publishes numbered up from the same stale maximum — hence the
--   duplicate sort_order values (1943/1943, 2096/2096) in the pre-merge report.
--
--   Fixed in blueprint/db.js — selectAll() pages the read and flowExisting()
--   uses it (commit 7cef430). Apply the code fix BEFORE this, or the next
--   import undoes the cleanup.
--
-- SCOPE
--   The division named once, below. Orlando is deliberately excluded: its two
--   duplicate combinations (11150720000 / 6-PLEX / A and B, WELLNESS VILLA) are
--   not from this bug. They came in with the July seed, and each pair is one
--   legacy 2025-01-01 placeholder plus one hand-entered forward date carrying a
--   note ("NEW PLAN. MOVED UP BUT NOT A REAL DATE", "NEEDS ELEV B ADDED AND
--   UPDATED."). Merging those would destroy what someone typed on purpose.
--
-- WHAT A MERGE DOES  (not a plain delete — pending_budget_* cascade)
--   Survivor = the OLDEST row in the group: lowest sort_order, then oldest
--   updated_at, then id. That keeps the row id the grid has been showing.
--     · first_trench_date -> EARLIEST across the group (the importer's own
--       meaning for the column)
--     · last_trench_date  -> LATEST across the group
--     · every manual field -> the survivor's value if it has one, else the
--       first non-blank from a duplicate, survivor-first. Nothing typed into a
--       duplicate is lost because it landed on the wrong copy.
--     · pending_budget_checks  -> a tick on ANY copy becomes a tick on the
--       survivor (bool_or)
--     · pending_budget_status  -> same, for sim_reviewed and sent_to_loc
--
--   The map of which row survives is frozen in a temp table before anything is
--   written. That is load-bearing, not tidiness: survivors rank on
--   (sort_order, updated_at, id), this data contains real sort_order ties, and
--   the merge writes updated_at. Recomputing the ranking mid-script would pick
--   a different survivor than the later steps assume. Do not inline it as CTEs.
--
-- RUNNING IT
--   Supabase SQL editor, as the owner — RLS on flow_rows would otherwise filter
--   what you can see and delete. The editor warns about "destructive
--   operations" (correct: rows are deleted) and about tf_dedupe_map having no
--   RLS (a false positive — it is a TEMPORARY table, invisible to any other
--   connection and dropped on commit). Choose Run without RLS.
-- ===========================================================================

begin;

-- ---- the division this run targets, named once -----------------------------
create temporary table tf_dedupe_scope on commit drop as
select 'tampa'::text as division;


-- ---- 1. freeze which row survives each duplicated group --------------------
create temporary table tf_dedupe_map on commit drop as
with norm as (
  select r.*,
         btrim(coalesce(r.community_num, '')) as k_num,
         case
           when lower(btrim(coalesce(r.plan, ''))) ~ '^[0-9]+[[:space:]]*-?[[:space:]]*plex$'
             then regexp_replace(lower(btrim(r.plan)),
                                 '^([0-9]+)[[:space:]]*-?[[:space:]]*plex$', '\1-plex')
           else lower(btrim(coalesce(r.plan, '')))
         end as k_plan,
         lower(btrim(coalesce(r.elevation, ''))) as k_elev
  from public.flow_rows r
  where r.division = (select division from tf_dedupe_scope)
),
ranked as (
  select id, division, k_num, k_plan, k_elev,
         row_number() over (
           partition by division, k_num, k_plan, k_elev
           order by sort_order nulls last, updated_at nulls last, id
         ) as rn,
         count(*) over (partition by division, k_num, k_plan, k_elev) as copies
  from norm
)
select id, division, k_num, k_plan, k_elev, rn, copies,
       first_value(id) over (
         partition by division, k_num, k_plan, k_elev order by rn
       ) as keep_id
from ranked
where copies > 1;

create index on tf_dedupe_map (keep_id);
create index on tf_dedupe_map (id);


-- ---- 2. what the merge will do to each group's dates, captured BEFORE -------
create temporary table tf_dedupe_audit on commit drop as
with merged as (
  select m.keep_id,
         min(f.first_trench_date) as new_first,
         max(f.last_trench_date)  as new_last
  from tf_dedupe_map m
  join public.flow_rows f on f.id = m.id
  group by m.keep_id
)
select s.community_num, s.community_name, s.plan, s.elevation,
       m.copies, s.sort_order              as survivor_sort_order,
       s.first_trench_date                 as first_trench_before,
       g.new_first                         as first_trench_after,
       s.last_trench_date                  as last_trench_before,
       g.new_last                          as last_trench_after
from tf_dedupe_map m
join merged g          on g.keep_id = m.keep_id
join public.flow_rows s on s.id     = m.keep_id
where m.rn = 1
  and (g.new_first is distinct from s.first_trench_date
    or g.new_last  is distinct from s.last_trench_date);


-- ---- 3. merge dates and every manual field onto the survivor ---------------
--   array_agg(...) filter(...) ordered by rn takes the survivor's own value
--   when it has one and the first duplicate that does when it does not. nullif
--   on the text columns treats '' and '   ' as "no value", as the app does.
update public.flow_rows s set
  community_name    = g.community_name,
  plan_name         = g.plan_name,
  first_trench_date = g.first_trench_date,
  last_trench_date  = g.last_trench_date,
  released          = g.released,
  cis_due           = g.cis_due,
  master_tp_due     = g.master_tp_due,
  estimate_eta      = g.estimate_eta,
  pricing_stage     = g.pricing_stage,
  loc_upload        = g.loc_upload,
  tasks_start       = g.tasks_start,
  estimating_notes  = g.estimating_notes,
  mike_notes        = g.mike_notes,
  marlo_notes       = g.marlo_notes,
  cabs              = g.cabs,
  flooring          = g.flooring,
  missing_plans     = g.missing_plans,
  notes             = g.notes,
  updated_at        = now(),
  updated_by        = 'dedupe-merge'
from (
  select m.keep_id,
         min(f.first_trench_date) as first_trench_date,
         max(f.last_trench_date)  as last_trench_date,
         (array_agg(nullif(btrim(f.community_name), '')   order by m.rn) filter (where nullif(btrim(f.community_name), '')   is not null))[1] as community_name,
         (array_agg(nullif(btrim(f.plan_name), '')        order by m.rn) filter (where nullif(btrim(f.plan_name), '')        is not null))[1] as plan_name,
         (array_agg(nullif(btrim(f.estimating_notes), '') order by m.rn) filter (where nullif(btrim(f.estimating_notes), '') is not null))[1] as estimating_notes,
         (array_agg(nullif(btrim(f.mike_notes), '')       order by m.rn) filter (where nullif(btrim(f.mike_notes), '')       is not null))[1] as mike_notes,
         (array_agg(nullif(btrim(f.marlo_notes), '')      order by m.rn) filter (where nullif(btrim(f.marlo_notes), '')      is not null))[1] as marlo_notes,
         (array_agg(nullif(btrim(f.cabs), '')             order by m.rn) filter (where nullif(btrim(f.cabs), '')             is not null))[1] as cabs,
         (array_agg(nullif(btrim(f.flooring), '')         order by m.rn) filter (where nullif(btrim(f.flooring), '')         is not null))[1] as flooring,
         (array_agg(nullif(btrim(f.missing_plans), '')    order by m.rn) filter (where nullif(btrim(f.missing_plans), '')    is not null))[1] as missing_plans,
         (array_agg(nullif(btrim(f.notes), '')            order by m.rn) filter (where nullif(btrim(f.notes), '')            is not null))[1] as notes,
         (array_agg(f.released      order by m.rn) filter (where f.released      is not null))[1] as released,
         (array_agg(f.cis_due       order by m.rn) filter (where f.cis_due       is not null))[1] as cis_due,
         (array_agg(f.master_tp_due order by m.rn) filter (where f.master_tp_due is not null))[1] as master_tp_due,
         (array_agg(f.estimate_eta  order by m.rn) filter (where f.estimate_eta  is not null))[1] as estimate_eta,
         (array_agg(f.pricing_stage order by m.rn) filter (where f.pricing_stage is not null))[1] as pricing_stage,
         (array_agg(f.loc_upload    order by m.rn) filter (where f.loc_upload    is not null))[1] as loc_upload,
         (array_agg(f.tasks_start   order by m.rn) filter (where f.tasks_start   is not null))[1] as tasks_start
  from tf_dedupe_map m
  join public.flow_rows f on f.id = m.id
  group by m.keep_id
) g
where s.id = g.keep_id;


-- ---- 4. a tick on any copy is a tick on the survivor -----------------------
insert into public.pending_budget_checks (flow_id, col_id, checked, updated_at, updated_by)
select m.keep_id, c.col_id, bool_or(c.checked), now(), 'dedupe-merge'
from tf_dedupe_map m
join public.pending_budget_checks c on c.flow_id = m.id
group by m.keep_id, c.col_id
on conflict (flow_id, col_id) do update
  set checked    = pending_budget_checks.checked or excluded.checked,
      updated_at = now(),
      updated_by = excluded.updated_by;


-- ---- 5. same for the two fixed status checkboxes ---------------------------
insert into public.pending_budget_status (flow_id, sim_reviewed, sent_to_loc, updated_at, updated_by)
select m.keep_id, bool_or(p.sim_reviewed), bool_or(p.sent_to_loc), now(), 'dedupe-merge'
from tf_dedupe_map m
join public.pending_budget_status p on p.flow_id = m.id
group by m.keep_id
on conflict (flow_id) do update
  set sim_reviewed = pending_budget_status.sim_reviewed or excluded.sim_reviewed,
      sent_to_loc  = pending_budget_status.sent_to_loc  or excluded.sent_to_loc,
      updated_at   = now(),
      updated_by   = excluded.updated_by;


-- ---- 6. drop the duplicates; their remaining checks/status cascade ---------
--   sort_order is left sparse on purpose. It only orders the grid, the
--   surviving order is unchanged, and the duplicate sort_order values this bug
--   created disappear with the rows that held them. Renumbering would churn
--   every row for nothing.
delete from public.flow_rows f
using tf_dedupe_map m
where f.id = m.id
  and m.rn > 1;


-- ---- 7. log it, but ONLY if something was actually merged ------------------
--   Inside the transaction and conditional, so a re-run on a clean table does
--   not post a "removed duplicate rows" entry to What's New having removed
--   none. (An earlier version of this file was unconditional and did exactly
--   that; one spurious entry had to be deleted by hand afterwards.)
insert into public.tf_change_log (id, at, by, division, summary, detail)
select gen_random_uuid(), now(), 'dedupe-merge', (select division from tf_dedupe_scope),
       'Removed ' || (select count(*) from tf_dedupe_map where rn > 1)
         || ' duplicate row(s) — one row per community/plan/elevation restored',
       jsonb_build_object(
         'source',   'one_off_dedupe_tampa.sql',
         'division', (select division from tf_dedupe_scope),
         'groups',   (select count(distinct keep_id) from tf_dedupe_map),
         'deleted',  (select count(*) from tf_dedupe_map where rn > 1),
         'cause',    'Blueprint Data Intake read only the first 1000 existing rows (PostgREST cap) and re-inserted the rest as new on every Starts Log import',
         'fix',      'blueprint/db.js — selectAll() pages the read; flowExisting() uses it (commit 7cef430)',
         'note',     'Duplicates were merged, not deleted: earliest first trench date, latest last trench date, and every non-blank manual field and budget tick were kept on the surviving row',
         'dateChanges', coalesce((select jsonb_agg(to_jsonb(a)) from (select * from tf_dedupe_audit limit 200) a), '[]'::jsonb)
       )
where exists (select 1 from tf_dedupe_map where rn > 1);


-- ---- 8. prove the invariant. Raises (and so rolls back) if it does not hold.
do $$
declare
  v_div text;
  v_rows int;
  v_combos int;
  v_dupes int;
begin
  select division into v_div from tf_dedupe_scope;

  with norm as (
    select btrim(coalesce(r.community_num, '')) as k_num,
           case
             when lower(btrim(coalesce(r.plan, ''))) ~ '^[0-9]+[[:space:]]*-?[[:space:]]*plex$'
               then regexp_replace(lower(btrim(r.plan)),
                                   '^([0-9]+)[[:space:]]*-?[[:space:]]*plex$', '\1-plex')
             else lower(btrim(coalesce(r.plan, '')))
           end as k_plan,
           lower(btrim(coalesce(r.elevation, ''))) as k_elev
    from public.flow_rows r
    where r.division = v_div
  ),
  grp as (select k_num, k_plan, k_elev, count(*) as copies from norm group by 1, 2, 3)
  select (select count(*) from norm),
         (select count(*) from grp),
         (select count(*) from grp where copies > 1)
    into v_rows, v_combos, v_dupes;

  raise notice '% — rows: %  ·  unique combinations: %  ·  duplicated remaining: %',
    v_div, v_rows, v_combos, v_dupes;

  if v_dupes > 0 then
    raise exception 'dedupe left % duplicated combination(s) in % — nothing committed',
      v_dupes, v_div;
  end if;

  if v_rows <> v_combos then
    raise exception 'row count (%) <> combination count (%) in % — nothing committed',
      v_rows, v_combos, v_div;
  end if;
end $$;


-- ---- 9. the one table this script returns: every date that moved ----------
select * from tf_dedupe_audit
order by (first_trench_after - first_trench_before) nulls last,
         community_name, plan, elevation;

commit;
