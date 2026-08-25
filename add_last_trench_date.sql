/* ==========================================================================
   Takeoff Flow — latest-start tracking for the Plans-tab status chips
   Run once in Supabase > SQL Editor. Idempotent — safe to re-run.

   flow_rows.first_trench_date holds the EARLIEST-ever start for a combo, so it
   cannot answer "does this plan appear on the start log going forward" — any
   plan that began building months ago has a past date even while future lots
   keep starting. last_trench_date holds the LATEST start seen for the combo in
   the most recent Starts Log import (the app stamps it on every Starts Log
   publish, moving it forward or backward to mirror the current log). The
   Plans tab flags a plan red only when this date is before today.

   Until the first Starts Log import after this change, the column is null and
   the app flags nothing red (it can't yet tell who dropped off the log).
   ========================================================================== */

alter table public.flow_rows add column if not exists last_trench_date date;

comment on column public.flow_rows.last_trench_date is
  'Latest start for this community+plan+elevation in the most recent Starts Log import; drives the red "not on start log going forward" status on the Plans tab.';
