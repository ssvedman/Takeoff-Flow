-- ===========================================================================
-- One-off: collapse duplicate Tampa flow_rows back to one row per combination.
--
-- WHY THESE EXIST
--   Blueprint's Data Intake read the existing rows it diffs an import against
--   with a plain select. PostgREST caps that at 1000 rows and does not error
--   when it truncates. Tampa's flow_rows holds 1150; the importer saw 1000,
--   decided the other 150+ combinations were new, and inserted them again on
--   every Starts Log import. The query had no ORDER BY, so a different slice
--   fell off each run — which is why some combinations have 2 copies and others
--   up to 6, rather than every row being doubled. Orlando (636 rows) never
--   crossed the cap.
--
--   The code fix is blueprint/db.js — selectAll() + flowExisting(). Apply that
--   FIRST, or this cleanup will be undone by the next import.
--
-- SCOPE
--   division = 'tampa' only.
--
--   Orlando is deliberately untouched. It has two duplicate combinations
--   (11150720000 / 6-PLEX / A and B, WELLNESS VILLA) but they are not from this
--   bug — they came in with the original July seed, and each pair is one legacy
--   2025-01-01 placeholder plus one hand-entered forward date carrying a note
--   ("NEW PLAN. MOVED UP BUT NOT A REAL DATE", "NEEDS ELEV B ADDED AND
--   UPDATED."). Merging those would destroy what someone typed on purpose.
--
-- WHAT A MERGE DOES (not a plain delete — the FKs cascade)
--   Survivor = the OLDEST row in the group: lowest sort_order, then oldest
--   updated_at, then id. That keeps the row id the grid has been showing.
--     · first_trench_date -> EARLIEST across the group (matches what the
--       importer itself means by this column)
--     · last_trench_date  -> LATEST across the group
--     · every manual field -> the survivor's value if it has one, otherwise the
--       first non-blank value from a duplicate, in survivor-first order. Nothing
--       typed into a duplicate is lost just because it landed on the wrong copy.
--     · pending_budget_checks -> a tick on ANY copy becomes a tick on the
--       survivor (bool_or), then the duplicates' rows go with them
--     · pending_budget_status -> same, for sim_reviewed and sent_to_loc
--
-- HOW TO RUN
--   Run this file's contents in the Supabase SQL editor as the owner (RLS on
--   flow_rows would otherwise filter what you can see and delete). Run STEP 0
--   on its own first and read it. STEP 1-6 are one transaction: all or nothing.
--   Re-running after a successful run is a no-op — there will be no groups left.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- STEP 0 · REPORT ONLY. Run this by itself first. Writes nothing.
-- ---------------------------------------------------------------------------
with norm as (
  select r.id, r.division, r.community_name, r.community_num, r.plan, r.elevation,
         r.sort_order, r.first_trench_date, r.last_trench_date,
         btrim(coalesce(r.community_num, '')) as k_num,
         case
           when lower(btrim(coalesce(r.plan, ''))) ~ '^[0-9]+[[:space:]]*-?[[:space:]]*plex$'
             then regexp_replace(lower(btrim(r.plan)),
                                 '^([0-9]+)[[:space:]]*-?[[:space:]]*plex$', '\1-plex')
           else lower(btrim(coalesce(r.plan, '')))
         end as k_plan,
         lower(btrim(coalesce(r.elevation, ''))) as k_elev
  from public.flow_rows r
  where r.division = 'tampa'
),
grp as (
  select k_num, k_plan, k_elev, count(*) as copies,
         min(community_name) as community_name,
         min(plan) as plan, min(elevation) as elevation,
         min(first_trench_date) as earliest_trench,
         max(last_trench_date)  as latest_trench,
         string_agg(sort_order::text, ', ' order by sort_order) as sort_orders
  from norm
  group by k_num, k_plan, k_elev
)
select
  (select count(*) from norm)                                   as tampa_rows_now,
  (select count(*) from grp)                                    as unique_combinations,
  (select count(*) from grp where copies > 1)                   as duplicated_combinations,
  (select coalesce(sum(copies - 1), 0) from grp where copies > 1) as rows_this_will_delete,
  (select coalesce(max(copies), 1) from grp)                    as worst_multiplicity;

-- The offending combinations themselves, worst first.
with norm as (
  select r.id, r.community_name, r.community_num, r.plan, r.elevation, r.sort_order,
         r.first_trench_date, r.last_trench_date,
         btrim(coalesce(r.community_num, '')) as k_num,
         case
           when lower(btrim(coalesce(r.plan, ''))) ~ '^[0-9]+[[:space:]]*-?[[:space:]]*plex$'
             then regexp_replace(lower(btrim(r.plan)),
                                 '^([0-9]+)[[:space:]]*-?[[:space:]]*plex$', '\1-plex')
           else lower(btrim(coalesce(r.plan, '')))
         end as k_plan,
         lower(btrim(coalesce(r.elevation, ''))) as k_elev
  from public.flow_rows r
  where r.division = 'tampa'
)
select k_num as community_num,
       min(community_name) as community_name,
       k_plan as plan, k_elev as elevation,
       count(*) as copies,
       string_agg(sort_order::text, ', ' order by sort_order) as sort_orders,
       min(first_trench_date) as earliest_trench,
       max(first_trench_date) as latest_trench_seen
from norm
group by k_num, k_plan, k_elev
having count(*) > 1
order by count(*) desc, k_num, k_plan, k_elev;


-- ===========================================================================
-- STEP 1-6 · THE MERGE. One transaction.
-- ===========================================================================
begin;

-- STEP 1 · Map every row in a duplicated group to its survivor.
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
  where r.division = 'tampa'
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

-- STEP 2 · Merge the dates and every manual field onto the survivor.
--   array_agg(...) filter(...) ordered by rn takes the survivor's own value when
--   it has one and the first duplicate that does when it does not. nullif on the
--   text columns treats '' and '   ' as "no value", the same as the app does.
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
         -- dates the importer owns: earliest start, latest start
         min(f.first_trench_date) as first_trench_date,
         max(f.last_trench_date)  as last_trench_date,
         -- survivor-first coalesce across the group
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

-- STEP 3 · A tick on any copy is a tick on the survivor.
insert into public.pending_budget_checks (flow_id, col_id, checked, updated_at, updated_by)
select m.keep_id, c.col_id, bool_or(c.checked), now(), 'dedupe-merge'
from tf_dedupe_map m
join public.pending_budget_checks c on c.flow_id = m.id
group by m.keep_id, c.col_id
on conflict (flow_id, col_id) do update
  set checked    = pending_budget_checks.checked or excluded.checked,
      updated_at = now(),
      updated_by = excluded.updated_by;

-- STEP 4 · Same for the two fixed status checkboxes.
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

-- STEP 5 · Drop the duplicates. Their remaining checks/status cascade.
--   sort_order is left with gaps on purpose: it only orders the grid, the order
--   of what survives is unchanged, and max(sort_order) still gives the importer
--   a safe next number. Renumbering would churn every row for no gain.
delete from public.flow_rows f
using tf_dedupe_map m
where f.id = m.id
  and m.rn > 1;

-- STEP 6 · Self-enforcing check. This does not ask you to read a number and
--   decide — if any duplicated combination survives, it raises, which aborts the
--   transaction and makes the commit below a rollback. Nothing is written unless
--   the invariant actually holds.
do $$
declare
  v_rows int;
  v_combos int;
  v_dupes int;
begin
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
    where r.division = 'tampa'
  ),
  grp as (select k_num, k_plan, k_elev, count(*) as copies from norm group by 1, 2, 3)
  select (select count(*) from norm),
         (select count(*) from grp),
         (select count(*) from grp where copies > 1)
    into v_rows, v_combos, v_dupes;

  raise notice 'tampa rows after: %  ·  unique combinations: %  ·  duplicated remaining: %',
    v_rows, v_combos, v_dupes;

  if v_dupes > 0 then
    raise exception 'dedupe left % duplicated combination(s) — nothing committed', v_dupes;
  end if;

  if v_rows <> v_combos then
    raise exception 'row count (%) does not equal combination count (%) — nothing committed',
      v_rows, v_combos;
  end if;
end $$;

commit;


-- ---------------------------------------------------------------------------
-- AFTERWARDS · log it where the app shows it, so the row-count drop in the
-- Tampa grid has an explanation attached. "What's New" renders summary as the
-- headline and expands detail, so both are set.
-- ---------------------------------------------------------------------------
insert into public.tf_change_log (id, at, by, division, summary, detail)
values (
  gen_random_uuid(), now(), 'dedupe-merge', 'tampa',
  'Removed duplicate rows — one row per community/plan/elevation restored',
  jsonb_build_object(
    'source', 'one_off_dedupe_tampa.sql',
    'division', 'tampa',
    'cause', 'Blueprint Data Intake read only the first 1000 existing rows (PostgREST cap) and re-inserted the rest as new on every Starts Log import',
    'fix', 'blueprint/db.js — selectAll() pages the read; flowExisting() uses it',
    'note', 'Duplicates were merged, not deleted: earliest first trench date, latest last trench date, and every non-blank manual field and budget tick were kept on the surviving row'
  )
);
