-- ============================================================================
-- Plately Support — schema for the helpdesk behind https://plately.eu/support
--
-- Runs in the SAME Supabase project as the app (Project → SQL Editor → New
-- query → paste → Run). Safe to re-run: every statement is idempotent.
--
-- Security model, in one paragraph
-- --------------------------------
-- Nothing here is reachable from a browser. Every table has RLS enabled and
-- *no* policies, which in Postgres means "deny everything" for the anon and
-- authenticated roles — the panel talks to these tables exclusively from
-- Vercel Edge Functions holding SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS
-- by design. The single exception is my_staff(), a SECURITY DEFINER function
-- granted to authenticated users so the *app* can ask "what is my role?"
-- without being able to read anyone else's, and without seeing PIN material.
--
-- The PIN hash never leaves the server: it is written and compared only inside
-- the Edge Function, and hashed with a pepper that lives in an environment
-- variable, not in this database. A dump of this table is therefore not enough
-- to brute-force a four-digit PIN.
--
-- The authenticator secret (totp_secret) is the one value here that is *not*
-- hashed, because TOTP is symmetric — verifying a code requires the secret
-- itself. It is read only inside the Edge Function and never returned by any
-- route once enrolment is finished. Treat a leak of this column the way you
-- would treat a leak of the PIN pepper: reset every agent's authenticator.
-- ============================================================================


-- ============================================================================
-- staff — who may sign in to /support, and what they may do there
--
-- Keyed by e-mail, not by auth.users.id, because the panel authenticates
-- against Google directly (its own OAuth client) rather than through Supabase
-- Auth. A staff member who *also* uses the Plately app is linked through
-- app_user_id so the app can honour the same role — see my_staff() below.
--
-- Role ladder (descending power):
--   owner   — everything, plus managing staff roles and tiers
--   admin   — everything except role management: maintenance mode, settings,
--             deleting tickets, knowledge base
--   agent   — the day job: read, reply, note, assign, tag, change priority.
--             Bounded further by `tier` (see support_tier_allows below)
--   viewer  — read-only: tickets, customers, reports. No writes at all.
-- ============================================================================
create table if not exists public.staff (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  display_name text,
  avatar_url text,
  role text not null default 'agent' check (role in ('owner', 'admin', 'agent', 'viewer')),
  -- Only meaningful for agents; kept on every row so a demotion does not lose
  -- the value. 1 = first line, 2 = can refund and escalate, 3 = can close
  -- anything and edit other agents' replies.
  tier smallint not null default 1 check (tier between 1 and 3),
  -- PIN material. Both null until the person completes first-run enrolment.
  pin_hash text,
  pin_salt text,
  pin_set_at timestamptz,
  -- Authenticator app (RFC 6238). Enrolled straight after Google, on first
  -- sign-in, and asked for before the PIN on every later one. The secret is
  -- written when enrolment starts and only *counts* once totp_enrolled_at is
  -- set, which happens when the first code checks out.
  totp_secret text,
  totp_enrolled_at timestamptz,
  totp_last_step bigint,
  -- Online brute force protection. The Edge Function bumps the counter on a
  -- wrong PIN or code and sets locked_until once it crosses the threshold.
  failed_pin_attempts integer not null default 0,
  failed_totp_attempts integer not null default 0,
  locked_until timestamptz,
  -- Google's stable subject id, pinned on first successful sign-in. If Google
  -- later hands us the same e-mail with a different sub, that is a different
  -- account and the sign-in is refused.
  google_sub text,
  app_user_id uuid references auth.users(id) on delete set null,
  signature text,
  prefs jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  last_login_at timestamptz,
  created_at timestamptz not null default now()
);

-- E-mail is the login. Case never distinguishes two people.
create unique index if not exists staff_email_key on public.staff (lower(email));
create unique index if not exists staff_google_sub_key on public.staff (google_sub) where google_sub is not null;

alter table public.staff enable row level security;
-- No policies. Service role only — see the header.

-- Columns added after the first release need their own idempotent ALTER,
-- because `create table if not exists` above is a no-op on an existing install.
alter table public.staff add column if not exists signature text;
alter table public.staff add column if not exists prefs jsonb not null default '{}'::jsonb;
alter table public.staff add column if not exists app_user_id uuid references auth.users(id) on delete set null;

-- Third factor: the authenticator app. `totp_secret` is the shared base32
-- secret; `totp_enrolled_at` stays null until the person has proved they can
-- read a code off it, so a half-finished enrolment never locks anyone out and
-- can simply be started again.
--
-- `totp_last_step` is the replay guard. A TOTP code is valid for a whole
-- 30-second slot (90 with the drift window), so without recording the slot
-- that was accepted, a code read over someone's shoulder stays usable until it
-- expires. Storing it means every code works exactly once.
alter table public.staff add column if not exists totp_secret text;
alter table public.staff add column if not exists totp_enrolled_at timestamptz;
alter table public.staff add column if not exists totp_last_step bigint;
alter table public.staff add column if not exists failed_totp_attempts integer not null default 0;


-- ============================================================================
-- my_staff — the one door the app is allowed to open
--
-- Returns the caller's own staff role, or nulls if they are not staff. Never
-- returns pin_hash, pin_salt or anyone else's row, so it is safe to grant to
-- every signed-in user. The app uses it to unlock privileged UI; the *server*
-- still re-checks every privileged action, because a client-side check is a
-- convenience, never a control.
--
-- Matching is by e-mail rather than app_user_id so that a staff member who
-- signs into the app for the first time is recognised immediately, without an
-- explicit linking step. app_user_id is then filled in opportunistically.
-- ============================================================================
create or replace function public.my_staff()
returns table (role text, tier smallint, display_name text)
language sql
stable
security definer
set search_path = public
as $$
  select s.role, s.tier, s.display_name
  from public.staff s
  where s.active
    and lower(s.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  limit 1;
$$;

revoke all on function public.my_staff() from public;
grant execute on function public.my_staff() to authenticated;

-- Existing installs already have is_admin(); widen it so a staff owner/admin
-- counts as an admin in the app too, without anyone editing profiles.role by
-- hand. Kept as a separate function so the original definition is untouched.
create or replace function public.is_support_admin(p_user uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.staff s
    join auth.users u on lower(u.email) = lower(s.email)
    where u.id = p_user and s.active and s.role in ('owner', 'admin')
  );
$$;

revoke all on function public.is_support_admin(uuid) from public;
grant execute on function public.is_support_admin(uuid) to authenticated;


-- ============================================================================
-- support_customers — the person on the other side of the thread
--
-- Deliberately *not* a foreign key to auth.users: most people who write in are
-- identified only by the address they wrote from, and some never had an
-- account at all. app_user_id is filled in when the address happens to match a
-- registered user, which is what lets the ticket view show a real plan and
-- real invoices instead of guesses.
-- ============================================================================
create table if not exists public.support_customers (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  name text,
  app_user_id uuid references auth.users(id) on delete set null,
  locale text,
  timezone text,
  notes text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create unique index if not exists support_customers_email_key on public.support_customers (lower(email));
create index if not exists support_customers_app_user_idx on public.support_customers (app_user_id);

alter table public.support_customers enable row level security;


-- ============================================================================
-- support_tickets — one conversation
--
-- `number` is what the customer sees ("SUP-1042"). It comes from a sequence
-- rather than a count so that deleting a ticket can never make two tickets
-- share a reference, and it is embedded in the outgoing subject line, which is
-- how a reply that loses its In-Reply-To header still finds its way home.
-- ============================================================================
create sequence if not exists public.support_ticket_number_seq start with 1000;

create table if not exists public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  number integer not null unique default nextval('public.support_ticket_number_seq'),
  customer_id uuid not null references public.support_customers(id) on delete cascade,
  subject text not null default '(no subject)',
  status text not null default 'open' check (status in ('open', 'pending', 'solved', 'closed', 'spam')),
  priority text not null default 'normal' check (priority in ('urgent', 'high', 'normal', 'low')),
  tag text,
  assignee_id uuid references public.staff(id) on delete set null,
  channel text not null default 'email' check (channel in ('email', 'form', 'app', 'manual')),
  locale text,
  -- Threading. `email_message_id` is the Message-ID of the last message we know
  -- about, used as In-Reply-To on the next outbound mail.
  email_message_id text,
  -- Denormalised so the inbox list is one query with no aggregates.
  message_count integer not null default 0,
  last_message_at timestamptz not null default now(),
  last_customer_message_at timestamptz,
  first_response_at timestamptz,
  solved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists support_tickets_status_idx on public.support_tickets (status, last_message_at desc);
create index if not exists support_tickets_assignee_idx on public.support_tickets (assignee_id, status);
create index if not exists support_tickets_customer_idx on public.support_tickets (customer_id, created_at desc);
create index if not exists support_tickets_created_idx on public.support_tickets (created_at desc);

alter table public.support_tickets enable row level security;


-- ============================================================================
-- support_messages — every turn of the conversation
--
-- kind:
--   customer — inbound mail from the person who wrote in
--   reply    — outbound mail we sent them
--   note     — internal, never leaves the building
--   system   — "status changed to solved", assignments, escalations
--
-- provider_id is unique-when-present: Resend retries a webhook until it gets a
-- 2xx, and without this a slow first attempt would file the same mail twice.
-- ============================================================================
create table if not exists public.support_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.support_tickets(id) on delete cascade,
  kind text not null check (kind in ('customer', 'reply', 'note', 'system')),
  author_staff_id uuid references public.staff(id) on delete set null,
  author_name text,
  author_email text,
  body text not null default '',
  html text,
  provider_id text,
  provider_message_id text,
  attachments jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists support_messages_ticket_idx on public.support_messages (ticket_id, created_at);
create unique index if not exists support_messages_provider_key on public.support_messages (provider_id) where provider_id is not null;

alter table public.support_messages enable row level security;


-- ============================================================================
-- support_events — the audit trail the login screen promises
--
-- Append-only in practice: nothing in the panel updates or deletes a row here.
-- ============================================================================
create table if not exists public.support_events (
  id bigint generated always as identity primary key,
  ticket_id uuid references public.support_tickets(id) on delete cascade,
  staff_id uuid references public.staff(id) on delete set null,
  actor text,
  action text not null,
  detail jsonb not null default '{}'::jsonb,
  ip_hash text,
  created_at timestamptz not null default now()
);

create index if not exists support_events_ticket_idx on public.support_events (ticket_id, created_at desc);
create index if not exists support_events_created_idx on public.support_events (created_at desc);

alter table public.support_events enable row level security;


-- ============================================================================
-- support_articles — knowledge base
-- ============================================================================
create table if not exists public.support_articles (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  slug text not null,
  category text not null default 'General',
  body text not null default '',
  state text not null default 'draft' check (state in ('draft', 'published', 'archived')),
  views integer not null default 0,
  link_count integer not null default 0,
  author_staff_id uuid references public.staff(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists support_articles_slug_key on public.support_articles (lower(slug));

alter table public.support_articles enable row level security;


-- ============================================================================
-- support_macros — canned replies offered under the composer
-- ============================================================================
create table if not exists public.support_macros (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  body text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

alter table public.support_macros enable row level security;

insert into public.support_macros (label, body, sort_order)
select * from (values
  ('Refund started', E'I have started the refund on my side. It goes back to the original payment method and usually lands within 3 business days — you will get a confirmation from the payment provider as soon as it clears.', 10),
  ('Ask for details', E'To dig into this I need two things: the e-mail address on the account, and roughly when you first noticed the problem. A screenshot helps if you have one.', 20),
  ('Known bug', E'Thanks for reporting this — I can reproduce it, so it is a confirmed bug rather than something on your side. Engineering has it, and I will write back on this thread as soon as a fix ships.', 30),
  ('Escalating', E'This one needs someone with deeper access than I have, so I am passing it to the next line. You keep this same thread — no need to write in again.', 40),
  ('Closing', E'I am marking this as solved. If anything about it comes back, just reply here and the thread reopens with all the history intact.', 50)
) as seed(label, body, sort_order)
where not exists (select 1 from public.support_macros);


-- ============================================================================
-- support_settings — one row, the desk's own configuration
-- ============================================================================
create table if not exists public.support_settings (
  id boolean primary key default true check (id),
  from_name text not null default 'Plately Support',
  from_email text not null default 'contact@plately.eu',
  signature text not null default E'— Plately Support\nplately.eu',
  auto_ack boolean not null default true,
  auto_ack_body text not null default E'Thanks for writing in — your message reached the Plately support desk and is now ticket {{ref}}.\n\nA person reads every ticket; you will get a real answer here, usually within one business day. Replying to this e-mail adds to the same thread.',
  auto_assign boolean not null default false,
  updated_at timestamptz not null default now()
);

insert into public.support_settings (id) values (true) on conflict (id) do nothing;

alter table public.support_settings enable row level security;


-- ============================================================================
-- support_tier_allows — the tier rules, in one place
--
-- Kept as a function rather than scattered `if tier >= 2` checks so that the
-- panel, the API and any future automation all answer the question the same
-- way. The Edge Function calls the same rules before it acts.
-- ============================================================================
create or replace function public.support_tier_allows(p_role text, p_tier smallint, p_action text)
returns boolean
language sql
immutable
as $$
  select case
    when p_role = 'viewer' then p_action in ('read')
    when p_role in ('owner', 'admin') then true
    when p_role = 'agent' then case p_action
      when 'read'          then true
      when 'reply'         then true
      when 'note'          then true
      when 'assign_self'   then true
      when 'set_priority'  then true
      when 'set_tag'       then true
      when 'solve'         then true
      -- Tier 2 and up: money and hand-offs.
      when 'refund'        then p_tier >= 2
      when 'escalate'      then p_tier >= 2
      when 'assign_other'  then p_tier >= 2
      -- Tier 3 only: destructive or cross-agent.
      when 'reopen_closed' then p_tier >= 3
      when 'edit_others'   then p_tier >= 3
      when 'delete'        then p_tier >= 3
      when 'spam'          then p_tier >= 3
      else false
    end
    else false
  end;
$$;


-- ============================================================================
-- support_ingest_email — inbound mail becomes a ticket, atomically
--
-- Everything the Resend webhook needs to do lives here rather than in five
-- REST round-trips from the Edge Function: find-or-create the customer,
-- decide whether this belongs to an existing thread, append the message and
-- move the ticket's counters. One statement, one transaction, no half-filed
-- mail if the function times out midway.
--
-- Thread matching, in order of trust:
--   1. an explicit "SUP-1042" reference in the subject (survives every client)
--   2. In-Reply-To / References pointing at a Message-ID we sent
--   3. same customer, same normalised subject, ticket touched in the last 14
--      days and not closed
-- Otherwise: a new ticket.
-- ============================================================================
create or replace function public.support_ingest_email(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email        text := lower(trim(p_payload ->> 'from_email'));
  v_name         text := nullif(trim(coalesce(p_payload ->> 'from_name', '')), '');
  v_subject      text := coalesce(nullif(trim(p_payload ->> 'subject'), ''), '(no subject)');
  v_body         text := coalesce(p_payload ->> 'text', '');
  v_html         text := p_payload ->> 'html';
  v_provider_id  text := p_payload ->> 'provider_id';
  v_message_id   text := p_payload ->> 'message_id';
  v_in_reply_to  text := p_payload ->> 'in_reply_to';
  v_references   text := coalesce(p_payload ->> 'references', '');
  v_attachments  jsonb := coalesce(p_payload -> 'attachments', '[]'::jsonb);
  v_clean_subject text;
  v_ref_number   integer;
  v_customer_id  uuid;
  v_ticket_id    uuid;
  v_number       integer;
  v_created      boolean := false;
  v_app_user     uuid;
begin
  if v_email is null or v_email = '' then
    return jsonb_build_object('ok', false, 'error', 'missing from_email');
  end if;

  -- Already filed? Resend retries until it sees a 2xx, so this is the normal
  -- path for a duplicate, not an error.
  if v_provider_id is not null then
    select m.ticket_id into v_ticket_id
    from public.support_messages m
    where m.provider_id = v_provider_id
    limit 1;

    if v_ticket_id is not null then
      select t.number into v_number from public.support_tickets t where t.id = v_ticket_id;
      return jsonb_build_object('ok', true, 'duplicate', true, 'ticket_id', v_ticket_id, 'number', v_number);
    end if;
  end if;

  -- Subject without the Re:/Fwd: noise and without our own reference tag.
  v_clean_subject := regexp_replace(v_subject, '\[SUP-[0-9]+\]', '', 'gi');
  v_clean_subject := regexp_replace(v_clean_subject, '^((re|aw|odp|fwd|fw|wg)\s*(\[[0-9]+\])?\s*:\s*)+', '', 'i');
  v_clean_subject := trim(v_clean_subject);
  if v_clean_subject = '' then v_clean_subject := '(no subject)'; end if;

  select id into v_app_user from auth.users where lower(email) = v_email limit 1;

  insert into public.support_customers (email, name, app_user_id, last_seen_at)
  values (v_email, v_name, v_app_user, now())
  on conflict (lower(email)) do update
    -- The target table is referenced unqualified inside ON CONFLICT; keeping
    -- the existing name means a later mail signed only "sent from my phone"
    -- cannot blank out a name we already learned.
    set name         = coalesce(support_customers.name, excluded.name),
        app_user_id  = coalesce(support_customers.app_user_id, excluded.app_user_id),
        last_seen_at = now()
  returning id into v_customer_id;

  -- 1. explicit reference in the subject
  v_ref_number := nullif((regexp_match(v_subject, 'SUP-([0-9]+)', 'i'))[1], '')::integer;
  if v_ref_number is not null then
    select t.id into v_ticket_id
    from public.support_tickets t
    where t.number = v_ref_number and t.customer_id = v_customer_id;
  end if;

  -- 2. a Message-ID we sent
  if v_ticket_id is null and (v_in_reply_to is not null or v_references <> '') then
    select m.ticket_id into v_ticket_id
    from public.support_messages m
    where m.kind = 'reply'
      and m.provider_message_id is not null
      and (m.provider_message_id = v_in_reply_to
           or position(m.provider_message_id in v_references) > 0)
    order by m.created_at desc
    limit 1;
  end if;

  -- 3. same person, same subject, recent, still live
  if v_ticket_id is null then
    select t.id into v_ticket_id
    from public.support_tickets t
    where t.customer_id = v_customer_id
      and t.status <> 'closed'
      and t.last_message_at > now() - interval '14 days'
      and lower(regexp_replace(t.subject, '^((re|aw|odp|fwd|fw|wg)\s*:\s*)+', '', 'i')) = lower(v_clean_subject)
    order by t.last_message_at desc
    limit 1;
  end if;

  if v_ticket_id is null then
    insert into public.support_tickets (customer_id, subject, channel, last_message_at, last_customer_message_at)
    values (v_customer_id, v_clean_subject, 'email', now(), now())
    returning id, number into v_ticket_id, v_number;
    v_created := true;
  else
    -- A reply to something we had already put to bed reopens it. Anything
    -- else would quietly lose the follow-up.
    update public.support_tickets
       set status = case when status in ('solved', 'closed') then 'open' else status end,
           solved_at = case when status in ('solved', 'closed') then null else solved_at end,
           last_message_at = now(),
           last_customer_message_at = now(),
           updated_at = now()
     where id = v_ticket_id
     returning number into v_number;
  end if;

  insert into public.support_messages
    (ticket_id, kind, author_name, author_email, body, html, provider_id, provider_message_id, attachments)
  values
    (v_ticket_id, 'customer', v_name, v_email, v_body, v_html, v_provider_id, v_message_id, v_attachments);

  update public.support_tickets
     set message_count = (select count(*) from public.support_messages m where m.ticket_id = v_ticket_id),
         email_message_id = coalesce(v_message_id, email_message_id)
   where id = v_ticket_id;

  insert into public.support_events (ticket_id, actor, action, detail)
  values (v_ticket_id, v_email, case when v_created then 'ticket.created' else 'ticket.reopened_by_reply' end,
          jsonb_build_object('subject', v_clean_subject, 'channel', 'email'));

  return jsonb_build_object('ok', true, 'duplicate', false, 'created', v_created,
                            'ticket_id', v_ticket_id, 'number', v_number,
                            'customer_id', v_customer_id);
end;
$$;

revoke all on function public.support_ingest_email(jsonb) from public;


-- ============================================================================
-- support_ingest_form — REMOVED
--
-- It filed a /help submission straight as a ticket. That was the design before
-- the form gained a confirmation step; support_stage_form and
-- support_confirm_request replaced it, and nothing calls it any more.
--
-- Dropped rather than left lying around: a SECURITY DEFINER function that
-- creates tickets and bypasses RLS is not the kind of thing to leave behind
-- 'just in case', and an installed database keeps it until told otherwise.
-- ============================================================================
drop function if exists public.support_ingest_form(jsonb, integer);


-- ============================================================================
-- support_pending_requests — the /help form, before the address is proved
--
-- A form that takes an address and sends mail to it is a machine for mailing
-- strangers: type somebody else's address in, and we deliver to a person who
-- never asked. The reputation damage lands on us, not on whoever typed it. So
-- a form submission waits here until one click from that mailbox proves it is
-- real, and only then becomes a ticket.
--
-- A SEPARATE TABLE rather than a flag on support_tickets, and that is the
-- whole design. Every view, every count, every report already written selects
-- from support_tickets; if unconfirmed rows lived there, each one would need a
-- new filter and the first one anybody forgot would put unverified junk in the
-- inbox — or worse, in the reports. Nothing unconfirmed can leak into the desk
-- if the desk's tables never hold it.
--
-- The token is stored hashed for the same reason a password is: this table is
-- the one place an attacker could read a confirmation link out of, and a hash
-- is not a link.
-- ============================================================================
create table if not exists public.support_pending_requests (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null,
  email text not null,
  name text,
  subject text not null,
  body text not null,
  tag text,
  locale text,
  ip_hash text,
  -- Whether the address came from a Google sign-in on the form. Carried across
  -- to the event log when the ticket is finally created.
  email_verified boolean not null default false,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days'
);

create unique index if not exists support_pending_token_key on public.support_pending_requests (token_hash);
create index if not exists support_pending_email_idx on public.support_pending_requests (email, created_at desc);
create index if not exists support_pending_expiry_idx on public.support_pending_requests (expires_at);

alter table public.support_pending_requests enable row level security;


-- ============================================================================
-- support_stage_form — a form submission, parked until it is confirmed
--
-- The only way a /help submission enters the system. Same validation and rate
-- limit the old support_ingest_form had; the difference is that it produces a
-- pending row and a token instead of a ticket, so nothing is visible to the
-- desk until the address has been proved by a click.
--
-- Returns { ok, request_id } or { ok:false, error:'rate_limited' }.
-- ============================================================================
create or replace function public.support_stage_form(p_payload jsonb, p_max_per_hour integer default 5)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email    text := lower(trim(p_payload ->> 'email'));
  v_ip_hash  text := nullif(trim(coalesce(p_payload ->> 'ip_hash', '')), '');
  v_recent   integer;
  v_id       uuid;
begin
  if v_email is null or v_email = '' then
    return jsonb_build_object('ok', false, 'error', 'missing email');
  end if;

  -- Self-cleaning: a link nobody clicked is rubbish after a week, and doing it
  -- here means the table stays small without a scheduled job to forget about.
  delete from public.support_pending_requests where expires_at < now();

  -- The limit counts unconfirmed attempts as well as tickets, or the whole
  -- rate limit could be walked around by simply never confirming.
  select
    (select count(*) from public.support_pending_requests r
      where r.created_at > now() - interval '1 hour'
        and (r.email = v_email or (v_ip_hash is not null and r.ip_hash = v_ip_hash)))
    +
    (select count(*) from public.support_events e
      where e.action = 'ticket.created_form'
        and e.created_at > now() - interval '1 hour'
        and (e.actor = v_email or (v_ip_hash is not null and e.ip_hash = v_ip_hash)))
  into v_recent;

  if v_recent >= p_max_per_hour then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;

  insert into public.support_pending_requests
    (token_hash, email, name, subject, body, tag, locale, ip_hash, email_verified)
  values (
    p_payload ->> 'token_hash',
    v_email,
    nullif(trim(coalesce(p_payload ->> 'name', '')), ''),
    coalesce(nullif(trim(p_payload ->> 'subject'), ''), '(no subject)'),
    coalesce(p_payload ->> 'text', ''),
    nullif(trim(coalesce(p_payload ->> 'tag', '')), ''),
    nullif(trim(coalesce(p_payload ->> 'locale', '')), ''),
    v_ip_hash,
    coalesce((p_payload ->> 'email_verified')::boolean, false)
  )
  returning id into v_id;

  return jsonb_build_object('ok', true, 'request_id', v_id);
end;
$$;

revoke all on function public.support_stage_form(jsonb, integer) from public;


-- ============================================================================
-- support_confirm_request — the click, and the ticket it creates
--
-- Idempotent on purpose. Mail clients pre-fetch links, people double-click,
-- and a scanner in a corporate mail gateway will follow every URL in a message
-- before the human ever sees it. Consuming the pending row inside the same
-- statement that creates the ticket means the second visit finds the ticket
-- already there and says so, rather than filing a duplicate.
--
-- Returns { ok, number, ticket_id, already } or { ok:false, error }.
-- ============================================================================
create or replace function public.support_confirm_request(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req         public.support_pending_requests%rowtype;
  v_customer_id uuid;
  v_ticket_id   uuid;
  v_number      integer;
  v_app_user    uuid;
begin
  -- Deleting on the way out is what makes a second click a no-op rather than a
  -- second ticket. RETURNING gives us the row we just consumed.
  delete from public.support_pending_requests
   where token_hash = p_token_hash and expires_at > now()
  returning * into v_req;

  if v_req.id is null then
    -- Either already used, or expired, or never existed. The caller cannot
    -- tell those apart and neither should a visitor holding a stale link.
    return jsonb_build_object('ok', false, 'error', 'not_pending');
  end if;

  select id into v_app_user from auth.users where lower(email) = v_req.email limit 1;

  insert into public.support_customers (email, name, app_user_id, locale, last_seen_at)
  values (v_req.email, v_req.name, v_app_user, v_req.locale, now())
  on conflict (lower(email)) do update
    set name         = coalesce(support_customers.name, excluded.name),
        app_user_id  = coalesce(support_customers.app_user_id, excluded.app_user_id),
        locale       = coalesce(excluded.locale, support_customers.locale),
        last_seen_at = now()
  returning id into v_customer_id;

  insert into public.support_tickets
    (customer_id, subject, channel, tag, locale, last_message_at, last_customer_message_at, message_count)
  values
    (v_customer_id, v_req.subject, 'form', v_req.tag, v_req.locale, now(), now(), 1)
  returning id, number into v_ticket_id, v_number;

  insert into public.support_messages (ticket_id, kind, author_name, author_email, body)
  values (v_ticket_id, 'customer', v_req.name, v_req.email, v_req.body);

  insert into public.support_events (ticket_id, actor, action, detail, ip_hash)
  values (v_ticket_id, v_req.email, 'ticket.created_form',
          jsonb_build_object('subject', v_req.subject, 'tag', v_req.tag,
                             'email_verified', v_req.email_verified,
                             'confirmed', true,
                             'waited_seconds', round(extract(epoch from (now() - v_req.created_at)))),
          v_req.ip_hash);

  return jsonb_build_object('ok', true, 'ticket_id', v_ticket_id, 'number', v_number,
                            'customer_id', v_customer_id, 'email', v_req.email,
                            'subject', v_req.subject, 'locale', v_req.locale);
end;
$$;

revoke all on function public.support_confirm_request(text) from public;


-- ============================================================================
-- support_ai_drafts — every AI-written draft, and what the agent did with it
--
-- Two things are recorded, and the second is the valuable one:
--
--   rating     the agent's thumb, up or down. Cheap to give, coarse.
--   sent_body  what was ACTUALLY sent, when the draft was used. The difference
--              between `draft` and `sent_body` is an agent silently correcting
--              the model, which is a far stronger signal than a thumb and
--              costs nobody an extra click.
--
-- What this is NOT: fine-tuning. Nothing here changes model weights. The rows
-- are read back by support_ai_examples() and put in front of the next request
-- as worked examples — the model is shown how this desk answered similar
-- questions well, and told what it got wrong before. That genuinely moves the
-- output, because it is the same mechanism that makes any example-led prompt
-- work; it just is not magic, and it is worth being precise about which of the
-- two is on offer.
-- ============================================================================
create table if not exists public.support_ai_drafts (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid references public.support_tickets(id) on delete cascade,
  staff_id uuid references public.staff(id) on delete set null,
  model text,
  -- What the customer had asked at the moment of drafting, so an example is
  -- readable later without walking the whole thread.
  question text not null default '',
  draft text not null,
  -- Which knowledge-base articles were in the prompt. Lets you see whether a
  -- bad answer came from a bad article or from the model.
  article_ids jsonb not null default '[]'::jsonb,
  rating smallint check (rating in (-1, 1)),
  rated_at timestamptz,
  -- Filled in when a reply is sent while a draft was on screen.
  sent_body text,
  edited boolean,
  created_at timestamptz not null default now()
);

create index if not exists support_ai_drafts_ticket_idx on public.support_ai_drafts (ticket_id, created_at desc);
create index if not exists support_ai_drafts_rating_idx on public.support_ai_drafts (rating, created_at desc)
  where rating is not null;

alter table public.support_ai_drafts enable row level security;


-- ============================================================================
-- support_ai_examples — the feedback, on its way back into the next prompt
--
-- This is the function that makes the thumbs mean something. It returns two
-- lists:
--
--   good  answers this desk approved. Where an agent edited before sending,
--         the EDITED text is returned, not the draft — the point is to show
--         the model what the right answer looked like, and the agent's version
--         is the right answer by definition.
--   bad   drafts that were thumbed down, returned as things to avoid.
--
-- Ordered newest first so the desk's current voice wins over its old one, and
-- capped, because a prompt is not a database and twenty examples cost tokens
-- on every single draft.
-- ============================================================================
create or replace function public.support_ai_examples(p_limit integer default 6)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'good', coalesce((
      select jsonb_agg(jsonb_build_object('question', question, 'answer', answer) order by created_at desc)
      from (
        select d.question,
               -- The agent's edit is the correction; prefer it over the draft.
               coalesce(nullif(trim(d.sent_body), ''), d.draft) as answer,
               d.created_at
        from public.support_ai_drafts d
        where d.rating = 1 and length(trim(d.question)) > 0
        order by d.created_at desc
        limit p_limit
      ) g
    ), '[]'::jsonb),
    'bad', coalesce((
      select jsonb_agg(jsonb_build_object('question', question, 'rejected', rejected) order by created_at desc)
      from (
        select d.question, d.draft as rejected, d.created_at
        from public.support_ai_drafts d
        where d.rating = -1 and length(trim(d.question)) > 0
        order by d.created_at desc
        limit greatest(1, p_limit / 2)
      ) b
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.support_ai_examples(integer) from public;


-- ============================================================================
-- support_view_counts — the numbers next to every entry in the sidebar
--
-- One round trip instead of ten HEAD requests with Prefer: count=exact.
-- ============================================================================
create or replace function public.support_view_counts(p_staff_id uuid default null)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'open',        count(*) filter (where status = 'open'),
    'pending',     count(*) filter (where status = 'pending'),
    'unassigned',  count(*) filter (where status in ('open','pending') and assignee_id is null),
    'mine',        count(*) filter (where status in ('open','pending') and assignee_id = p_staff_id),
    'urgent',      count(*) filter (where status in ('open','pending') and priority = 'urgent'),
    'billing',     count(*) filter (where status in ('open','pending') and tag = 'Billing'),
    'bug',         count(*) filter (where status in ('open','pending') and tag = 'Bug'),
    'feature',     count(*) filter (where status in ('open','pending') and tag = 'Feature request'),
    'solved_today',count(*) filter (where status = 'solved' and solved_at >= date_trunc('day', now())),
    'spam',        count(*) filter (where status = 'spam'),
    'all',         count(*),
    'overdue',     count(*) filter (where status in ('open','pending') and last_customer_message_at < now() - interval '24 hours')
  )
  from public.support_tickets;
$$;


-- ============================================================================
-- support_reports — everything the Reports screen draws, in one call
-- ============================================================================
create or replace function public.support_reports(p_days integer default 14)
returns jsonb
language sql
stable
as $$
  with days as (
    select generate_series(date_trunc('day', now()) - ((p_days - 1) || ' days')::interval,
                           date_trunc('day', now()),
                           '1 day')::date as day
  ),
  series as (
    select d.day,
           (select count(*) from public.support_tickets t
             where t.created_at::date = d.day) as received,
           (select count(*) from public.support_tickets t
             where t.solved_at is not null and t.solved_at::date = d.day) as solved
    from days d
  ),
  responded as (
    select extract(epoch from (first_response_at - created_at)) / 60 as minutes
    from public.support_tickets
    where first_response_at is not null
      and created_at > now() - (p_days || ' days')::interval
  ),
  workload as (
    select s.id, coalesce(s.display_name, s.email) as name,
           count(t.id) filter (where t.status in ('open', 'pending')) as open_count
    from public.staff s
    left join public.support_tickets t on t.assignee_id = s.id
    where s.active and s.role <> 'viewer'
    group by s.id, s.display_name, s.email
    order by open_count desc
  )
  select jsonb_build_object(
    'range_days', p_days,
    'received', (select count(*) from public.support_tickets where created_at > now() - (p_days || ' days')::interval),
    'solved', (select count(*) from public.support_tickets where solved_at > now() - (p_days || ' days')::interval),
    'open_now', (select count(*) from public.support_tickets where status in ('open', 'pending')),
    'median_first_response_minutes', (select percentile_cont(0.5) within group (order by minutes) from responded),
    'avg_first_response_minutes', (select avg(minutes) from responded),
    'series', (select coalesce(jsonb_agg(jsonb_build_object('day', day, 'received', received, 'solved', solved) order by day), '[]'::jsonb) from series),
    'agents', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'open', open_count) order by open_count desc), '[]'::jsonb) from workload),
    'by_tag', (select coalesce(jsonb_object_agg(coalesce(tag, 'Untagged'), n), '{}'::jsonb)
               from (select tag, count(*) as n from public.support_tickets
                     where created_at > now() - (p_days || ' days')::interval
                     group by tag) x)
  );
$$;


-- ============================================================================
-- support_customer_context — the right-hand panel of a ticket
--
-- Joins the helpdesk's own record of a person to whatever the *app* knows
-- about the same e-mail: plan, invoices, lifetime value. This is the reason
-- the support desk lives in the same Supabase project as the product.
-- ============================================================================
create or replace function public.support_customer_context(p_customer_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'customer', to_jsonb(c) - 'app_user_id',
    'plan', coalesce((select e.plan from public.entitlements e where e.user_id = c.app_user_id), 'free'),
    'plan_expires_at', (select e.expires_at from public.entitlements e where e.user_id = c.app_user_id),
    'since', coalesce((select u.created_at from auth.users u where u.id = c.app_user_id), c.first_seen_at),
    'has_account', c.app_user_id is not null,
    'ltv_pln', coalesce((select sum(p.amount_pln) from public.payments p
                          where p.user_id = c.app_user_id and p.status = 'paid'), 0),
    'orders', coalesce((select jsonb_agg(jsonb_build_object(
                          'id', p.provider_payment_id, 'plan', p.plan, 'period', p.period,
                          'amount_pln', p.amount_pln, 'status', p.status, 'created_at', p.created_at)
                          order by p.created_at desc)
                        from (select * from public.payments p2
                              where p2.user_id = c.app_user_id
                              order by p2.created_at desc limit 5) p), '[]'::jsonb),
    'history', coalesce((select jsonb_agg(jsonb_build_object(
                          'id', t.id, 'number', t.number, 'subject', t.subject,
                          'status', t.status, 'created_at', t.created_at, 'messages', t.message_count)
                          order by t.created_at desc)
                        from (select * from public.support_tickets t2
                              where t2.customer_id = c.id
                              order by t2.created_at desc limit 6) t), '[]'::jsonb)
  )
  from public.support_customers c
  where c.id = p_customer_id;
$$;

revoke all on function public.support_customer_context(uuid) from public;


-- ============================================================================
-- support_customers_overview — the Customers screen
-- ============================================================================
create or replace function public.support_customers_overview(p_search text default null, p_limit integer default 60)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.last_seen_at desc), '[]'::jsonb)
  from (
    select c.id, c.email, c.name, c.last_seen_at,
           c.app_user_id is not null as has_account,
           coalesce((select e.plan from public.entitlements e where e.user_id = c.app_user_id), 'free') as plan,
           (select count(*) from public.support_tickets t where t.customer_id = c.id) as tickets,
           (select count(*) from public.support_tickets t where t.customer_id = c.id and t.status in ('open','pending')) as open_tickets,
           coalesce((select sum(p.amount_pln) from public.payments p where p.user_id = c.app_user_id and p.status = 'paid'), 0) as ltv_pln,
           c.notes
    from public.support_customers c
    where p_search is null or p_search = ''
       or c.email ilike '%' || p_search || '%'
       or coalesce(c.name, '') ilike '%' || p_search || '%'
    order by c.last_seen_at desc
    limit p_limit
  ) x;
$$;

revoke all on function public.support_customers_overview(text, integer) from public;


-- ============================================================================
-- support_recount — keeps message_count and the response clock honest
--
-- Called from the Edge Function after it writes a reply or a note, so the
-- inbox list never has to count messages at read time.
-- ============================================================================
create or replace function public.support_recount(p_ticket_id uuid)
returns void
language sql
as $$
  update public.support_tickets t
     set message_count = (select count(*) from public.support_messages m where m.ticket_id = t.id),
         last_message_at = coalesce((select max(created_at) from public.support_messages m where m.ticket_id = t.id), t.last_message_at),
         first_response_at = coalesce(t.first_response_at,
           (select min(created_at) from public.support_messages m where m.ticket_id = t.id and m.kind = 'reply')),
         updated_at = now()
   where t.id = p_ticket_id;
$$;


-- ============================================================================
-- support_ticket_list — the inbox, filtered and sorted in one call
--
-- The named views are the sidebar. They live here rather than in the Edge
-- Function because "urgent" and "waiting on us" are *product* definitions:
-- reports, the panel and anything added later must agree on them, and the only
-- way to guarantee that is to write them down once.
--
-- Sorting by 'age' means oldest *unanswered* first — a ticket the customer
-- touched three days ago outranks one that an agent replied to a minute ago,
-- which is the order a support desk actually works in.
-- ============================================================================
create or replace function public.support_ticket_list(
  p_view text default 'all_open',
  p_search text default null,
  p_staff_id uuid default null,
  p_sort text default 'age',
  p_limit integer default 120
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with ranked as (
    -- The rank is computed in the same pass as the filter, because a plain
    -- ORDER BY inside a CTE is not carried through the aggregate below: only
    -- an explicit `order by x.rn` on jsonb_agg keeps the inbox in the order
    -- the agent asked for.
    select t.*,
           row_number() over (
             order by
               case when p_sort = 'newest'   then t.last_message_at end desc nulls last,
               case when p_sort = 'priority' then
                 case t.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end
               end asc nulls last,
               case when p_sort not in ('newest','priority')
                 then coalesce(t.last_customer_message_at, t.created_at) end asc nulls last,
               t.number desc
           ) as rn
    from public.support_tickets t
    join public.support_customers c on c.id = t.customer_id
    where
      case p_view
        when 'unassigned'   then t.status in ('open','pending') and t.assignee_id is null
        when 'mine'         then t.status in ('open','pending') and t.assignee_id = p_staff_id
        when 'urgent'       then t.status in ('open','pending') and t.priority = 'urgent'
        when 'billing'      then t.status in ('open','pending') and t.tag = 'Billing'
        when 'bug'          then t.status in ('open','pending') and t.tag = 'Bug'
        when 'feature'      then t.status in ('open','pending') and t.tag = 'Feature request'
        when 'pending'      then t.status = 'pending'
        when 'solved_today' then t.status = 'solved' and t.solved_at >= date_trunc('day', now())
        when 'spam'         then t.status = 'spam'
        when 'all'          then true
        when 'overdue'      then t.status in ('open','pending')
                                 and t.last_customer_message_at < now() - interval '24 hours'
        else t.status in ('open','pending')
      end
      and (
        p_search is null or p_search = ''
        or t.subject ilike '%' || p_search || '%'
        or c.email ilike '%' || p_search || '%'
        or coalesce(c.name, '') ilike '%' || p_search || '%'
        or ('SUP-' || t.number) ilike '%' || p_search || '%'
        or exists (select 1 from public.support_messages m
                    where m.ticket_id = t.id and m.body ilike '%' || p_search || '%')
      )
  ),
  filtered as (
    select * from ranked order by rn limit greatest(1, least(p_limit, 400))
  )
  select coalesce(jsonb_agg(to_jsonb(x) order by x.rn), '[]'::jsonb)
  from (
    select f.rn, f.id, f.number, f.subject, f.status, f.priority, f.tag, f.channel,
           f.message_count, f.created_at, f.last_message_at,
           f.last_customer_message_at, f.first_response_at, f.solved_at,
           f.assignee_id,
           c.id as customer_id, c.email as customer_email, c.name as customer_name,
           s.display_name as assignee_name, s.email as assignee_email,
           (select m.body from public.support_messages m
             where m.ticket_id = f.id order by m.created_at desc limit 1) as preview
    from filtered f
    join public.support_customers c on c.id = f.customer_id
    left join public.staff s on s.id = f.assignee_id
  ) x;
$$;

revoke all on function public.support_ticket_list(text, text, uuid, text, integer) from public;


-- ============================================================================
-- support_ticket_detail — one conversation, everything the screen draws
-- ============================================================================
create or replace function public.support_ticket_detail(p_ticket_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'ticket', jsonb_build_object(
      'id', t.id, 'number', t.number, 'subject', t.subject, 'status', t.status,
      'priority', t.priority, 'tag', t.tag, 'channel', t.channel,
      'assignee_id', t.assignee_id, 'assignee_name', s.display_name,
      'assignee_email', s.email,
      'created_at', t.created_at, 'last_message_at', t.last_message_at,
      'first_response_at', t.first_response_at, 'solved_at', t.solved_at,
      'message_count', t.message_count, 'email_message_id', t.email_message_id,
      'customer_id', c.id, 'customer_email', c.email, 'customer_name', c.name
    ),
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', m.id, 'kind', m.kind, 'body', m.body,
               'author_name', coalesce(m.author_name, ms.display_name, m.author_email),
               'author_email', m.author_email,
               'staff_id', m.author_staff_id,
               'attachments', m.attachments,
               'created_at', m.created_at) order by m.created_at)
      from public.support_messages m
      left join public.staff ms on ms.id = m.author_staff_id
      where m.ticket_id = t.id), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
               'action', e.action, 'actor', e.actor, 'detail', e.detail,
               'created_at', e.created_at) order by e.created_at desc)
      from (select * from public.support_events e2
            where e2.ticket_id = t.id order by e2.created_at desc limit 25) e), '[]'::jsonb),
    'context', public.support_customer_context(c.id)
  )
  from public.support_tickets t
  join public.support_customers c on c.id = t.customer_id
  left join public.staff s on s.id = t.assignee_id
  where t.id = p_ticket_id;
$$;

revoke all on function public.support_ticket_detail(uuid) from public;


-- ============================================================================
-- Locking it all down
--
-- `revoke ... from public` above is NOT enough on Supabase. The project's
-- default privileges hand SELECT and EXECUTE to `anon` and `authenticated`
-- *explicitly*, and an explicit grant survives a revoke aimed at PUBLIC.
-- Without the loop below, a SECURITY DEFINER function like
-- support_ticket_list() would be one anonymous POST away from dumping every
-- ticket the desk has ever seen — RLS does not apply inside a definer
-- function, that is the whole point of one.
--
-- The tables are revoked too. RLS already denies them (no policies), so this
-- is belt and braces: a policy added carelessly later cannot open a door that
-- was never granted in the first place.
--
-- my_staff() and is_support_admin() are the deliberate exceptions — the app
-- calls them, and they only ever answer about the caller.
-- ============================================================================
do $$
declare
  fn record;
  has_service_role boolean := exists (select 1 from pg_roles where rolname = 'service_role');
begin
  for fn in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname like 'support\_%'
  loop
    execute format('revoke all on function %s from public', fn.sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on function %s from anon', fn.sig);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on function %s from authenticated', fn.sig);
    end if;
    if has_service_role then
      execute format('grant execute on function %s to service_role', fn.sig);
    end if;
  end loop;

  for fn in
    select c.oid::regclass as sig
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and (c.relname like 'support\_%' or c.relname = 'staff')
  loop
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on table %s from anon', fn.sig);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on table %s from authenticated', fn.sig);
    end if;
    if has_service_role then
      execute format('grant all on table %s to service_role', fn.sig);
    end if;
  end loop;
end $$;


-- ============================================================================
-- First owner
--
-- Chicken-and-egg: nobody can sign in until a staff row exists, and the panel
-- refuses to create one for an unknown address. Set your Google address here
-- and run it once. The PIN is set by you on first sign-in, in the browser.
-- ============================================================================
-- insert into public.staff (email, display_name, role, tier)
-- values ('krzyszofwpl@gmail.com', 'Krzysztof', 'owner', 3)
-- on conflict (lower(email)) do update set role = 'owner', tier = 3, active = true;
