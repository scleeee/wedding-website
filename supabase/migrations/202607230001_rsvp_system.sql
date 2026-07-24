-- Party-based RSVP access for the public wedding website.
-- The random code is the invitation's shared credential. Public clients never
-- receive direct table privileges; they can only call the two RPCs below.

alter table public.invites
  alter column code set default upper(encode(extensions.gen_random_bytes(15), 'hex')),
  alter column party_name set not null,
  add column rsvp_deadline timestamptz,
  add column rsvp_closed boolean not null default false,
  add column rsvp_submitted_at timestamptz,
  add column rsvp_updated_at timestamptz,
  add column rsvp_revision integer not null default 0;

alter table public.guests
  add column created_at timestamptz not null default now();

alter table public.invites
  add constraint invites_code_format_check
    check (code ~ '^[A-F0-9]{30}$'),
  add constraint invites_party_name_length_check
    check (char_length(btrim(party_name)) between 1 and 200),
  add constraint invites_num_seats_upper_bound_check
    check (num_seats <= 50),
  add constraint invites_rsvp_revision_check
    check (rsvp_revision >= 0);

alter table public.guests
  add constraint guests_expected_name_length_check
    check (expected_name is null or char_length(btrim(expected_name)) between 1 and 200),
  add constraint guests_name_length_check
    check (name is null or char_length(btrim(name)) between 1 and 200),
  add constraint guests_dietary_requirements_length_check
    check (dietary_requirements is null or char_length(dietary_requirements) <= 1000);

alter table public.invites enable row level security;
alter table public.guests enable row level security;

-- No direct browser access. SECURITY DEFINER RPCs below are the only public path.
revoke all on table public.invites from anon, authenticated;
revoke all on table public.guests from anon, authenticated;

create or replace function public.lookup_rsvp(p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_code text;
  v_invite public.invites%rowtype;
begin
  if p_code is null or char_length(p_code) > 128 then
    return null;
  end if;

  -- Printed codes may contain spaces or hyphens for readability.
  v_code := upper(regexp_replace(p_code, '[^A-Za-z0-9]', '', 'g'));

  select i.*
    into v_invite
    from public.invites as i
   where i.code = v_code
   limit 1;

  if not found then
    return null;
  end if;

  return jsonb_build_object(
    'party_label', v_invite.party_name,
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
            'expected_name', g.expected_name,
            'name', coalesce(g.name, g.expected_name),
            'name_editable', g.expected_name is null,
            'attending', g.attending,
            'dietary_requirements', g.dietary_requirements
          )
          order by g.seat_number
        )
        from public.guests as g
        where g.invite_id = v_invite.id
      ),
      '[]'::jsonb
    )
  );
end;
$$;

create or replace function public.submit_rsvp(p_code text, p_responses jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text;
  v_invite public.invites%rowtype;
  v_response_count integer;
  v_distinct_seats integer;
  v_all_seats_valid boolean;
  v_all_attendance_set boolean;
  v_all_lengths_valid boolean;
  v_all_required_names_present boolean;
  v_updated_rows integer;
begin
  if p_code is null or char_length(p_code) > 128 then
    raise exception using errcode = '22023', message = 'INVALID_RSVP_CODE';
  end if;

  if p_responses is null or jsonb_typeof(p_responses) <> 'array' then
    raise exception using errcode = '22023', message = 'INVALID_RSVP_RESPONSES';
  end if;

  v_code := upper(regexp_replace(p_code, '[^A-Za-z0-9]', '', 'g'));

  select i.*
    into v_invite
    from public.invites as i
   where i.code = v_code
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
    coalesce(bool_and(g.id is not null), false),
    coalesce(bool_and(response.attending is not null), false),
    coalesce(bool_and(
      (response.name is null or char_length(btrim(response.name)) <= 200)
      and (response.dietary_requirements is null
        or char_length(response.dietary_requirements) <= 1000)
    ), false),
    coalesce(bool_and(
      g.expected_name is not null
      or response.attending = false
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

  if v_response_count <> v_invite.num_seats
     or v_distinct_seats <> v_invite.num_seats
     or not v_all_seats_valid
     or not v_all_attendance_set
     or not v_all_lengths_valid
     or not v_all_required_names_present then
    raise exception using errcode = '22023', message = 'INVALID_RSVP_RESPONSES';
  end if;

  update public.guests as g
     set name = case
           when g.expected_name is not null then g.expected_name
           else nullif(btrim(response.name), '')
         end,
         attending = response.attending,
         dietary_requirements = case
           when response.attending then nullif(btrim(response.dietary_requirements), '')
           else null
         end
    from jsonb_to_recordset(p_responses) as response(
      seat_number integer,
      name text,
      attending boolean,
      dietary_requirements text
    )
   where g.invite_id = v_invite.id
     and g.seat_number = response.seat_number;

  get diagnostics v_updated_rows = row_count;
  if v_updated_rows <> v_invite.num_seats then
    raise exception using errcode = '22023', message = 'INVALID_RSVP_RESPONSES';
  end if;

  update public.invites
     set rsvp_submitted_at = coalesce(rsvp_submitted_at, now()),
         rsvp_updated_at = now(),
         rsvp_revision = rsvp_revision + 1
   where id = v_invite.id;

  return public.lookup_rsvp(p_code);
end;
$$;

revoke execute on function public.lookup_rsvp(text) from public;
revoke execute on function public.submit_rsvp(text, jsonb) from public;
grant execute on function public.lookup_rsvp(text) to anon, authenticated;
grant execute on function public.submit_rsvp(text, jsonb) to anon, authenticated;

-- Trigger helpers do not need to be callable through the API.
revoke execute on function public.set_updated_at() from public, anon, authenticated;
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;

comment on column public.invites.code is
  'Shared 120-bit RSVP access code. Treat as invitation-scoped confidential data.';
comment on function public.lookup_rsvp(text) is
  'Looks up exactly one invitation party by its shared random RSVP code.';
comment on function public.submit_rsvp(text, jsonb) is
  'Atomically validates and updates every reserved seat for one invitation code.';
