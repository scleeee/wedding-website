-- Store invitation credentials as digests and keep guest access behind the
-- existing rate-limited Edge Function. The following seed migration imports
-- only digests and slot counts; CSV guest names never enter the database.

-- Keep the production database-backed, atomic rate limiter. Defining it here
-- also makes a fresh migration replay match the deployed security boundary.
create table if not exists public.rsvp_rate_limit_events (
  bucket text not null check (char_length(bucket) between 1 and 200),
  member uuid not null,
  attempted_at timestamptz not null default clock_timestamp(),
  primary key (bucket, member)
);

alter table public.rsvp_rate_limit_events enable row level security;
revoke all on table public.rsvp_rate_limit_events from public, anon, authenticated;

create or replace function public.reserve_rsvp_rate_limit(
  p_bucket text,
  p_limit integer,
  p_window_seconds integer,
  p_member uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_count integer;
  v_retry_after integer;
begin
  if p_bucket is null or char_length(p_bucket) not between 1 and 200
     or p_limit not between 1 and 1000
     or p_window_seconds not between 1 and 86400
     or p_member is null then
    raise exception using errcode = '22023', message = 'INVALID_RATE_LIMIT_REQUEST';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_bucket, 0)
  );

  delete from public.rsvp_rate_limit_events
   where attempted_at <= v_now - pg_catalog.make_interval(secs => 86400);

  delete from public.rsvp_rate_limit_events
   where bucket = p_bucket
     and attempted_at <= v_now - pg_catalog.make_interval(secs => p_window_seconds);

  select count(*)::integer
    into v_count
    from public.rsvp_rate_limit_events
   where bucket = p_bucket;

  if v_count >= p_limit then
    select greatest(
      1,
      ceil(extract(epoch from (
        min(attempted_at)
        + pg_catalog.make_interval(secs => p_window_seconds)
        - v_now
      )))::integer
    )
      into v_retry_after
      from public.rsvp_rate_limit_events
     where bucket = p_bucket;

    return jsonb_build_object(
      'allowed', false,
      'retry_after_seconds', v_retry_after
    );
  end if;

  insert into public.rsvp_rate_limit_events (bucket, member, attempted_at)
  values (p_bucket, p_member, v_now);

  return jsonb_build_object(
    'allowed', true,
    'retry_after_seconds', p_window_seconds
  );
end;
$$;

create or replace function public.release_rsvp_rate_limit(
  p_bucket text,
  p_member uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_bucket is null or char_length(p_bucket) not between 1 and 200
     or p_member is null then
    raise exception using errcode = '22023', message = 'INVALID_RATE_LIMIT_REQUEST';
  end if;

  delete from public.rsvp_rate_limit_events
   where bucket = p_bucket
     and member = p_member;
end;
$$;

revoke execute on function public.reserve_rsvp_rate_limit(text, integer, integer, uuid)
  from public, anon, authenticated;
revoke execute on function public.release_rsvp_rate_limit(text, uuid)
  from public, anon, authenticated;
grant execute on function public.reserve_rsvp_rate_limit(text, integer, integer, uuid)
  to service_role;
grant execute on function public.release_rsvp_rate_limit(text, uuid)
  to service_role;

drop view if exists public.rsvp_submissions;
drop function if exists public.submit_rsvp(text, jsonb);
drop function if exists public.lookup_rsvp(text);

alter table public.invites
  add column code_digest text,
  add column access_enabled boolean not null default false;

-- Preserve existing invitations without retaining their plaintext code.
update public.invites
   set code_digest = encode(
     extensions.digest(
       upper(regexp_replace(code, '[^A-Za-z0-9]', '', 'g')),
       'sha256'
     ),
     'hex'
   );

alter table public.invites
  alter column code_digest set not null,
  add constraint invites_code_digest_format_check
    check (code_digest ~ '^[0-9a-f]{64}$'),
  add constraint invites_code_digest_key unique (code_digest);

alter table public.invites drop column code;

alter table public.guests
  add column submitted_at timestamptz;

-- The former submit function copied expected_name into name for named seats.
-- Clear those derived values so a valid lookup can never reveal a private-list
-- name. Attendance and dietary responses remain intact and editable.
update public.guests
   set name = null
 where expected_name is not null;

-- Keep already-submitted RSVP rows visible in the new admin view.
update public.guests as guest
   set submitted_at = coalesce(
     invitation.rsvp_updated_at,
     invitation.rsvp_submitted_at,
     guest.updated_at
   )
  from public.invites as invitation
 where guest.invite_id = invitation.id
   and invitation.rsvp_submitted_at is not null;

comment on column public.invites.code_digest is
  'SHA-256 digest of the normalized friendly code. Plaintext codes are not stored.';
comment on column public.invites.access_enabled is
  'Only groups present in the current private guest-list import are enabled.';
comment on column public.guests.invite_id is
  'Normalized guest-group association. The related access-code digest remains protected.';
comment on column public.guests.name is
  'Name entered by the guest during RSVP; never prefilled from the private guest list.';
comment on column public.guests.attending is
  'Guest-entered RSVP status.';
comment on column public.guests.dietary_requirements is
  'Guest-entered dietary requirements, stored only for attending guests.';
comment on column public.guests.submitted_at is
  'Time this individual RSVP row was most recently submitted.';

-- Direct browser access remains denied. No permissive RLS policy is added.
alter table public.invites enable row level security;
alter table public.guests enable row level security;
revoke all on table public.invites from public, anon, authenticated;
revoke all on table public.guests from public, anon, authenticated;

create or replace function public.lookup_rsvp(p_code_digest text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_invite public.invites%rowtype;
begin
  if p_code_digest is null or p_code_digest !~ '^[0-9a-f]{64}$' then
    return null;
  end if;

  select i.*
    into v_invite
    from public.invites as i
   where i.code_digest = p_code_digest
     and i.access_enabled
   limit 1;

  if not found then
    return null;
  end if;

  return jsonb_build_object(
    'reserved_seats', v_invite.num_seats,
    'submitted', v_invite.rsvp_submitted_at is not null,
    'submitted_at', v_invite.rsvp_submitted_at,
    'updated_at', v_invite.rsvp_updated_at,
    'revision', v_invite.rsvp_revision,
    'deadline', v_invite.rsvp_deadline,
    'closed', v_invite.rsvp_closed
      or (v_invite.rsvp_deadline is not null and v_invite.rsvp_deadline <= now()),
    'guests', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'seat_number', g.seat_number,
            -- Only a name previously submitted by this group can be returned.
            -- expected_name is deliberately never exposed.
            'name', case
              when v_invite.rsvp_submitted_at is not null then g.name
              else null
            end,
            'attending', case
              when v_invite.rsvp_submitted_at is not null then g.attending
              else null
            end,
            'dietary_requirements', case
              when v_invite.rsvp_submitted_at is not null then g.dietary_requirements
              else null
            end
          )
          order by g.seat_number
        )
        from public.guests as g
        where g.invite_id = v_invite.id
          and g.seat_number between 1 and v_invite.num_seats
      ),
      '[]'::jsonb
    )
  );
end;
$$;

create or replace function public.submit_rsvp(
  p_code_digest text,
  p_responses jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invite public.invites%rowtype;
  v_response_count integer;
  v_distinct_seats integer;
  v_all_seats_valid boolean;
  v_all_attendance_set boolean;
  v_all_lengths_valid boolean;
  v_all_required_names_present boolean;
  v_updated_rows integer;
begin
  if p_code_digest is null or p_code_digest !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'INVALID_RSVP_CODE';
  end if;

  if p_responses is null or jsonb_typeof(p_responses) <> 'array' then
    raise exception using errcode = '22023', message = 'INVALID_RSVP_RESPONSES';
  end if;

  select i.*
    into v_invite
    from public.invites as i
   where i.code_digest = p_code_digest
     and i.access_enabled
   for update;

  if not found then
    raise exception using errcode = '22023', message = 'INVALID_RSVP_CODE';
  end if;

  if v_invite.rsvp_closed
     or (v_invite.rsvp_deadline is not null and v_invite.rsvp_deadline <= now()) then
    raise exception using errcode = 'P0001', message = 'RSVP_CLOSED';
  end if;

  select
    count(*)::integer,
    count(distinct response.seat_number)::integer,
    coalesce(bool_and(
      response.seat_number between 1 and v_invite.num_seats
      and g.id is not null
    ), false),
    coalesce(bool_and(response.attending is not null), false),
    coalesce(bool_and(
      (response.name is null or char_length(btrim(response.name)) <= 200)
      and (response.dietary_requirements is null
        or char_length(response.dietary_requirements) <= 1000)
    ), false),
    coalesce(bool_and(
      response.attending = false
      or nullif(btrim(response.name), '') is not null
    ), false)
    into
      v_response_count,
      v_distinct_seats,
      v_all_seats_valid,
      v_all_attendance_set,
      v_all_lengths_valid,
      v_all_required_names_present
    from jsonb_to_recordset(p_responses) as response(
      seat_number integer,
      name text,
      attending boolean,
      dietary_requirements text
    )
    left join public.guests as g
      on g.invite_id = v_invite.id
     and g.seat_number = response.seat_number;

  -- Exactly one response for every allowed slot is required. Extra, missing,
  -- duplicate, or out-of-group seat numbers fail inside this transaction.
  if v_response_count <> v_invite.num_seats
     or v_distinct_seats <> v_invite.num_seats
     or not v_all_seats_valid
     or not v_all_attendance_set
     or not v_all_lengths_valid
     or not v_all_required_names_present then
    raise exception using errcode = '22023', message = 'INVALID_RSVP_RESPONSES';
  end if;

  update public.guests as g
     set name = nullif(btrim(response.name), ''),
         attending = response.attending,
         dietary_requirements = case
           when response.attending then nullif(btrim(response.dietary_requirements), '')
           else null
         end,
         submitted_at = now()
    from jsonb_to_recordset(p_responses) as response(
      seat_number integer,
      name text,
      attending boolean,
      dietary_requirements text
    )
   where g.invite_id = v_invite.id
     and g.seat_number = response.seat_number
     and g.seat_number between 1 and v_invite.num_seats;

  get diagnostics v_updated_rows = row_count;
  if v_updated_rows <> v_invite.num_seats then
    raise exception using errcode = '22023', message = 'INVALID_RSVP_RESPONSES';
  end if;

  update public.invites
     set rsvp_submitted_at = coalesce(rsvp_submitted_at, now()),
         rsvp_updated_at = now(),
         rsvp_revision = rsvp_revision + 1
   where id = v_invite.id;

  return public.lookup_rsvp(p_code_digest);
end;
$$;

revoke execute on function public.lookup_rsvp(text) from public, anon, authenticated;
revoke execute on function public.submit_rsvp(text, jsonb) from public, anon, authenticated;
grant execute on function public.lookup_rsvp(text) to service_role;
grant execute on function public.submit_rsvp(text, jsonb) to service_role;

comment on function public.lookup_rsvp(text) is
  'Trusted-server lookup by normalized code digest; never returns private guest-list names or codes.';
comment on function public.submit_rsvp(text, jsonb) is
  'Trusted-server atomic RSVP update, restricted to exactly one row per allowed group slot.';

-- A dashboard-friendly, protected view with one row per submitted guest.
create view public.rsvp_submissions
with (security_invoker = true, security_barrier = true)
as
select
  g.id,
  g.invite_id as guest_group_id,
  g.seat_number,
  g.name as submitted_name,
  g.attending,
  g.dietary_requirements,
  g.submitted_at,
  g.updated_at
from public.guests as g
where g.submitted_at is not null;

revoke all on table public.rsvp_submissions from public, anon, authenticated;
grant select (
  id,
  invite_id,
  seat_number,
  name,
  attending,
  dietary_requirements,
  submitted_at,
  updated_at
) on public.guests to service_role;
grant select on table public.rsvp_submissions to service_role;

comment on view public.rsvp_submissions is
  'Admin-facing RSVP rows. One row per submitted guest slot; protected by underlying RLS and grants.';
