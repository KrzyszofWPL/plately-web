-- ============================================================================
-- Plately Status — the numbers behind https://www.plately.eu/status
--
-- Runs in the SAME Supabase project as the app and the help desk (Project →
-- SQL Editor → New query → paste → Run). Safe to re-run: every statement is
-- idempotent.
--
-- Where the samples come from
-- ---------------------------
-- There is no monitoring service and no cron job. /api/status checks the four
-- components live on request, and writes one row per component *at most once
-- every few minutes* — so the history is built out of ordinary traffic to the
-- status page, and costs nothing when nobody is looking.
--
-- That has an honest consequence worth writing down: a gap in this table means
-- "nobody asked", not "everything was fine". The page says so rather than
-- drawing a flat green line over a day it knows nothing about. What the table
-- does record is real: every row is a request that actually left Vercel and
-- came back, timed end to end.
--
-- Security: RLS on, no policies — the same posture as every other table in this
-- project. Only the Edge Function, holding SUPABASE_SERVICE_ROLE_KEY, reads or
-- writes it, and the service role bypasses RLS by design. Nothing here is
-- personal data: a component name, a boolean and a duration.
-- ============================================================================


-- ============================================================================
-- status_samples — one health check of one component, at one moment
-- ============================================================================
create table if not exists public.status_samples (
  id bigint generated always as identity primary key,
  -- 'site' | 'app' | 'database' | 'mail'. Deliberately not a foreign key or an
  -- enum: adding a fifth component should be a deploy, not a migration.
  component text not null,
  ok boolean not null,
  -- Round trip in milliseconds. Null when the check never got an answer —
  -- a timeout has no meaningful duration, and storing the timeout value
  -- itself would quietly poison every average that follows.
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  -- What the other end actually said, when it said anything. Kept because
  -- "down" covers both a 500 and a DNS failure, and those are not the same
  -- morning for whoever is on call.
  http_status integer,
  checked_at timestamptz not null default now()
);

-- The one query this table serves: "this component, recently, newest first".
create index if not exists status_samples_component_idx
  on public.status_samples (component, checked_at desc);

-- And the one the writer serves: "when did we last record anything at all?",
-- which is what rate-limits the writes.
create index if not exists status_samples_checked_idx
  on public.status_samples (checked_at desc);

alter table public.status_samples enable row level security;


-- ============================================================================
-- status_history — the daily roll-up the page draws
--
-- Aggregated in Postgres rather than in the Edge Function on purpose. Seven
-- days of four components sampled every five minutes is around eight thousand
-- rows; shipping those over the wire to compute an average of each day would
-- make the status page the slowest thing on the site, which would be a joke at
-- its own expense.
--
-- Plain SECURITY INVOKER: the only caller holds the service role, which
-- bypasses RLS anyway. A SECURITY DEFINER function here would hand the same
-- data to anon for no reason.
-- ============================================================================
create or replace function public.status_history(p_days integer default 7)
returns table (
  component text,
  day date,
  samples bigint,
  failures bigint,
  uptime numeric,
  avg_ms integer,
  max_ms integer
)
language sql
stable
as $$
  select
    s.component,
    (s.checked_at at time zone 'UTC')::date                              as day,
    count(*)                                                             as samples,
    count(*) filter (where not s.ok)                                     as failures,
    round(100.0 * count(*) filter (where s.ok) / count(*), 3)            as uptime,
    -- Averages over successful checks only. A failed check contributes to the
    -- uptime figure and to nothing else: mixing a timeout into "how fast is
    -- it" produces a number that describes neither.
    round(avg(s.latency_ms) filter (where s.ok))::integer                as avg_ms,
    max(s.latency_ms) filter (where s.ok)                                as max_ms
  from public.status_samples s
  where s.checked_at >= (now() - make_interval(days => greatest(coalesce(p_days, 7), 1)))
  group by 1, 2
  order by 1, 2;
$$;


-- ============================================================================
-- status_prune — retention
--
-- The page shows seven days; thirty is kept so a question asked at the end of
-- the month ("was it us, three weeks ago?") still has an answer. Called
-- occasionally by the same Edge Function that writes, because a table nobody
-- ever deletes from is how a free Supabase plan runs out of room quietly.
-- ============================================================================
create or replace function public.status_prune(p_keep_days integer default 30)
returns integer
language plpgsql
as $$
declare
  removed integer;
begin
  delete from public.status_samples
   where checked_at < (now() - make_interval(days => greatest(coalesce(p_keep_days, 30), 1)));
  get diagnostics removed = row_count;
  return removed;
end;
$$;


-- Neither function is for the browser. The service role can execute them
-- regardless of these grants; anon and authenticated have no business here.
revoke all on function public.status_history(integer) from public, anon, authenticated;
revoke all on function public.status_prune(integer) from public, anon, authenticated;
