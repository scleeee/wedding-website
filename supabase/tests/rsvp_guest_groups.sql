begin;

do $$
declare
  v_digest constant text := '3cfa2a01ab1c877fcd6e520b78a295a0083baa0e08a6fe911654e868bb8c073c';
  v_admin_id uuid;
  v_invite_id uuid;
  v_lookup jsonb;
  v_count integer;
begin
  if has_function_privilege('anon', 'public.lookup_rsvp(text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.submit_rsvp(text, jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.lookup_rsvp(text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.submit_rsvp(text, jsonb)', 'EXECUTE') then
    raise exception 'browser roles must not execute RSVP RPCs';
  end if;

  if not has_function_privilege('service_role', 'public.lookup_rsvp(text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.submit_rsvp(text, jsonb)', 'EXECUTE') then
    raise exception 'service_role must execute RSVP RPCs';
  end if;

  select id into strict v_invite_id
  from public.invites
  where code_digest = v_digest and access_enabled;

  select count(*) into v_count
  from public.guests
  where invite_id = v_invite_id;
  if v_count <> 2 then
    raise exception 'acceptance group must have exactly two guest slots';
  end if;

  v_lookup := public.lookup_rsvp(v_digest);
  if (v_lookup->>'reserved_seats')::integer <> 2
     or jsonb_array_length(v_lookup->'guests') <> 2
     or (v_lookup->'guests'->0 ? 'expected_name')
     or (v_lookup->'guests'->1 ? 'expected_name')
     or v_lookup->'guests'->0->>'name' is not null
     or v_lookup->'guests'->1->>'name' is not null then
    raise exception 'initial lookup must expose two blank, anonymous slots';
  end if;

  begin
    perform public.submit_rsvp(
      v_digest,
      '[
        {"seat_number":1,"name":"One","attending":true,"dietary_requirements":""},
        {"seat_number":2,"name":"Two","attending":true,"dietary_requirements":""},
        {"seat_number":3,"name":"Three","attending":true,"dietary_requirements":""}
      ]'::jsonb
    );
    raise exception 'over-limit submission unexpectedly succeeded';
  exception
    when sqlstate '22023' then
      if sqlerrm <> 'INVALID_RSVP_RESPONSES' then
        raise;
      end if;
  end;

  perform public.submit_rsvp(
    v_digest,
    '[
      {"seat_number":1,"name":"Entered Guest One","attending":true,"dietary_requirements":"Vegetarian"},
      {"seat_number":2,"name":"Entered Guest Two","attending":false,"dietary_requirements":"ignored"}
    ]'::jsonb
  );

  select count(*) into v_count
  from public.rsvp_submissions
  where guest_group_id = v_invite_id
    and submitted_at is not null;
  if v_count <> 2 then
    raise exception 'admin view must contain one row per submitted guest slot';
  end if;

  if public.lookup_rsvp(repeat('0', 64)) is not null then
    raise exception 'invalid digest unexpectedly resolved';
  end if;

  insert into public.rsvp_invite_admin (invite_code, reserved_seats)
  values ('RSVPTESTADMIN', 1)
  returning id into v_admin_id;

  insert into public.rsvp_invite_admin (invite_code, reserved_seats)
  values ('RSVPTESTADMIN', 2)
  on conflict (invite_code) do update
  set reserved_seats = excluded.reserved_seats;

  update public.rsvp_invite_admin
     set reserved_seats = 3,
         invite_code = 'rsvp-test-admin-2'
   where id = v_admin_id;

  select count(*) into v_count
  from public.guests
  where invite_id = v_admin_id;
  if v_count <> 3 then
    raise exception 'dashboard seat change must reconcile RSVP slots';
  end if;

  if not exists (
    select 1
    from public.invites
    where id = v_admin_id
      and code_digest = encode(extensions.digest('RSVPTESTADMIN2', 'sha256'), 'hex')
      and num_seats = 3
  ) then
    raise exception 'dashboard code change must synchronize API digest';
  end if;

  delete from public.rsvp_invite_admin where id = v_admin_id;
  if exists (select 1 from public.invites where id = v_admin_id) then
    raise exception 'deleting an admin invite must retire its API invitation';
  end if;
end;
$$;

rollback;
