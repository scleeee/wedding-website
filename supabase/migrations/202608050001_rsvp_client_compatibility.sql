-- Keep already-published/cached static clients usable during the frontend
-- rollout. These fields are generic and never contain private guest-list data.
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
    'party_label', 'guest group',
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
            'name', case
              when v_invite.rsvp_submitted_at is not null then g.name
              else null
            end,
            'name_editable', true,
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

revoke execute on function public.lookup_rsvp(text)
  from public, anon, authenticated;
grant execute on function public.lookup_rsvp(text) to service_role;

comment on function public.lookup_rsvp(text) is
  'Trusted-server lookup by normalized code digest; returns editable anonymous slots and never private guest-list names or codes.';
