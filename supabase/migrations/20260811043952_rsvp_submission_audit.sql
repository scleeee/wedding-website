-- Preserve an immutable, full-party snapshot for each successful RSVP revision.
-- Existing RSVP records are backfilled once at their current revision; historical
-- edits made before this migration cannot be reconstructed.

create table public.rsvp_submission_audit (
  id bigint generated always as identity primary key,
  invite_id uuid not null references public.invites(id) on delete restrict,
  revision integer not null check (revision > 0),
  submitted_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  constraint rsvp_submission_audit_invite_revision_key unique (invite_id, revision)
);

create index rsvp_submission_audit_latest_idx
  on public.rsvp_submission_audit (invite_id, revision desc);

alter table public.rsvp_submission_audit enable row level security;
revoke all on table public.rsvp_submission_audit from public, anon, authenticated, service_role;
grant select on table public.rsvp_submission_audit to service_role;

create or replace function public.prevent_rsvp_submission_audit_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception using
    errcode = '55000',
    message = 'RSVP_AUDIT_IMMUTABLE';
end;
$$;

create trigger rsvp_submission_audit_immutable
before update or delete on public.rsvp_submission_audit
for each row
execute function public.prevent_rsvp_submission_audit_mutation();

create or replace function public.capture_rsvp_submission_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_snapshot jsonb;
begin
  if new.rsvp_revision <= old.rsvp_revision then
    return new;
  end if;

  if new.rsvp_revision <> old.rsvp_revision + 1 then
    raise exception using
      errcode = '22023',
      message = 'INVALID_RSVP_REVISION';
  end if;

  select jsonb_build_object(
    'reserved_seats', new.num_seats,
    'guests', coalesce(
      jsonb_agg(
        jsonb_build_object(
          'seat_number', guest.seat_number,
          'name', guest.name,
          'attending', guest.attending,
          'dietary_requirements', guest.dietary_requirements,
          'submitted_at', guest.submitted_at
        )
        order by guest.seat_number
      ),
      '[]'::jsonb
    )
  )
    into v_snapshot
    from public.guests as guest
   where guest.invite_id = new.id
     and guest.seat_number between 1 and new.num_seats;

  insert into public.rsvp_submission_audit (
    invite_id,
    revision,
    submitted_at,
    snapshot
  ) values (
    new.id,
    new.rsvp_revision,
    coalesce(new.rsvp_updated_at, now()),
    v_snapshot
  );

  return new;
end;
$$;

create trigger rsvp_submission_audit_capture
after update of rsvp_revision on public.invites
for each row
execute function public.capture_rsvp_submission_audit();

-- Retain one current-state baseline for RSVPs submitted before auditing existed.
insert into public.rsvp_submission_audit (
  invite_id,
  revision,
  submitted_at,
  snapshot
)
select
  invitation.id,
  invitation.rsvp_revision,
  coalesce(invitation.rsvp_updated_at, invitation.rsvp_submitted_at, now()),
  jsonb_build_object(
    'reserved_seats', invitation.num_seats,
    'guests', coalesce(
      jsonb_agg(
        jsonb_build_object(
          'seat_number', guest.seat_number,
          'name', guest.name,
          'attending', guest.attending,
          'dietary_requirements', guest.dietary_requirements,
          'submitted_at', guest.submitted_at
        )
        order by guest.seat_number
      ) filter (where guest.id is not null),
      '[]'::jsonb
    )
  )
from public.invites as invitation
left join public.guests as guest
  on guest.invite_id = invitation.id
 and guest.seat_number between 1 and invitation.num_seats
where invitation.rsvp_revision > 0
group by
  invitation.id,
  invitation.rsvp_revision,
  invitation.rsvp_updated_at,
  invitation.rsvp_submitted_at,
  invitation.num_seats;

revoke execute on function public.prevent_rsvp_submission_audit_mutation()
  from public, anon, authenticated;
revoke execute on function public.capture_rsvp_submission_audit()
  from public, anon, authenticated;

comment on table public.rsvp_submission_audit is
  'Append-only, protected snapshot of every full RSVP revision. Existing submissions were backfilled at their current revision.';
comment on column public.rsvp_submission_audit.snapshot is
  'Full RSVP payload for the revision: reserved seat count and one ordered guest record per current seat.';
