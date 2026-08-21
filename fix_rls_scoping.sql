-- ============================================================================
--  Takeoff Flow — RLS division-scoping fixes
--  Run this ONCE in Supabase Studio > SQL Editor (paste the whole file, Run).
--  Safe to re-run: every statement is DROP POLICY IF EXISTS / CREATE OR REPLACE.
--  Already folded into supabase_setup.sql — this file exists so a live database
--  can be brought up to date without re-running the whole setup script.
--
--  1. tf_plan_names       — pn_all had no division scoping (any editor could edit
--                           any division's plan list). Split into pn_ins/pn_upd/pn_del
--                           gated on tf_can_edit(division). pn_sel is unchanged.
--  2. takeoff_changes     — tc_upd's purchasing branch is now division-scoped on BOTH
--                           using and with check (mirroring tc_ins) and requires
--                           complete is not true on the NEW row, so a purchasing user
--                           can neither self-complete a request nor move it across
--                           divisions. Same division condition added to tc_del.
--  3. pending_budget_checks — the assignee branch never correlated the column's division
--                           with the flow row's division; it now joins both.
--  4. tf_set_sent_to_loc  — in the unlocked branch, a non-editor caller must also cover
--                           the row's division (viewers were already excluded).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. tf_plan_names: division-scoped writes (replaces the unscoped pn_all)
-- ---------------------------------------------------------------------------
drop policy if exists pn_all on public.tf_plan_names;
drop policy if exists pn_ins on public.tf_plan_names;
create policy pn_ins on public.tf_plan_names for insert to authenticated
  with check (public.tf_can_edit(division));
drop policy if exists pn_upd on public.tf_plan_names;
create policy pn_upd on public.tf_plan_names for update to authenticated
  using (public.tf_can_edit(division)) with check (public.tf_can_edit(division));
drop policy if exists pn_del on public.tf_plan_names;
create policy pn_del on public.tf_plan_names for delete to authenticated
  using (public.tf_can_edit(division));

-- ---------------------------------------------------------------------------
-- 2. takeoff_changes: purchasing branch is division-scoped + can't self-complete
-- ---------------------------------------------------------------------------
drop policy if exists tc_upd on public.takeoff_changes;
create policy tc_upd on public.takeoff_changes for update to authenticated
  using (
    public.tf_can_edit(division)
    or (public.tf_role()='purchasing' and lower(created_by)=public.tf_email() and complete is not true
        and (division = any(public.tf_divs()) or public.tf_divs()='{}'))
  )
  with check (
    public.tf_can_edit(division)
    or (public.tf_role()='purchasing' and lower(created_by)=public.tf_email() and complete is not true
        and (division = any(public.tf_divs()) or public.tf_divs()='{}'))
  );
drop policy if exists tc_del on public.takeoff_changes;
create policy tc_del on public.takeoff_changes for delete to authenticated
  using (
    public.tf_can_edit(division)
    or (public.tf_role()='purchasing' and lower(created_by)=public.tf_email() and complete is not true
        and (division = any(public.tf_divs()) or public.tf_divs()='{}'))
  );

-- ---------------------------------------------------------------------------
-- 3. pending_budget_checks: the assignee branch correlates column ↔ row division
-- ---------------------------------------------------------------------------
drop policy if exists pbchk_ins on public.pending_budget_checks;
create policy pbchk_ins on public.pending_budget_checks for insert to authenticated
  with check (
    exists (select 1 from public.flow_rows f where f.id=flow_id and public.tf_can_edit(f.division))
    or exists (select 1 from public.pending_budget_cols c join public.flow_rows f on f.id=flow_id
               where c.id=col_id and lower(c.assigned_email)=public.tf_email() and c.division=f.division)
  );
drop policy if exists pbchk_upd on public.pending_budget_checks;
create policy pbchk_upd on public.pending_budget_checks for update to authenticated
  using (
    exists (select 1 from public.flow_rows f where f.id=flow_id and public.tf_can_edit(f.division))
    or exists (select 1 from public.pending_budget_cols c join public.flow_rows f on f.id=flow_id
               where c.id=col_id and lower(c.assigned_email)=public.tf_email() and c.division=f.division)
  )
  with check (
    exists (select 1 from public.flow_rows f where f.id=flow_id and public.tf_can_edit(f.division))
    or exists (select 1 from public.pending_budget_cols c join public.flow_rows f on f.id=flow_id
               where c.id=col_id and lower(c.assigned_email)=public.tf_email() and c.division=f.division)
  );

-- ---------------------------------------------------------------------------
-- 4. tf_set_sent_to_loc: unlocked path also requires division membership
--    (identical to the definition in supabase_setup.sql; search_path='' so every
--    object stays schema-qualified)
-- ---------------------------------------------------------------------------
create or replace function public.tf_set_sent_to_loc(p_flow_id uuid, p_value boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_div text; v_lock text;
begin
  if not public.tf_is_domain() then raise exception 'not authorized'; end if;
  select division into v_div from public.flow_rows where id = p_flow_id;
  if v_div is null then raise exception 'row not found'; end if;
  if not public.tf_can_edit(v_div) then
    select nullif(trim(assigned_email),'') into v_lock from public.tf_loc_locks where division = v_div;
    if v_lock is not null then
      if lower(v_lock) <> public.tf_email() then raise exception 'Sent to LOC is locked to %', v_lock; end if;
    elsif public.tf_role() = 'viewer' then
      raise exception 'not authorized';   -- unlocked: anyone except a viewer
    elsif not (v_div = any(public.tf_divs()) or public.tf_divs() = '{}') then
      raise exception 'not authorized';   -- unlocked: and only in a division they cover
    end if;
  end if;
  insert into public.pending_budget_status (flow_id, sent_to_loc, updated_at, updated_by)
    values (p_flow_id, p_value, now(), public.tf_email())
  on conflict (flow_id) do update set sent_to_loc = excluded.sent_to_loc, updated_at = now(), updated_by = public.tf_email();
end $$;
revoke all on function public.tf_set_sent_to_loc(uuid, boolean) from public;
grant execute on function public.tf_set_sent_to_loc(uuid, boolean) to authenticated;
