-- ============================================================================
--  Pool A (Vendor Portal + Takeoff Flow) — an admin may not issue a password
--  reset for another admin.
--
--  WHY: auth.users is shared across all apps. Before this, any single-app admin
--  could mint a reset token for ANY @lennar.com address, including the suite
--  super-admin, and take over that login everywhere. These RPCs check only the
--  CALLER's role; they never checked the TARGET's privilege. This adds that
--  check. Self-reset is still allowed (target == caller).
--
--  Idempotent. Safe to re-run. The helper is defined here and (identically) in
--  community-db/harden_admin_no_peer_reset.sql so either file runs standalone.
-- ============================================================================

create or replace function public.is_admin_email(p_email text) returns boolean
 language sql stable security definer set search_path to '' as $$
 select exists(select 1 from public.app_roles     where lower(email)=lower(p_email) and role='admin')
     or exists(select 1 from public.tf_app_roles  where lower(email)=lower(p_email) and role='admin')
     or exists(select 1 from public.cdb_app_roles where lower(email)=lower(p_email) and role='admin') $$;
revoke all on function public.is_admin_email(text) from public;
grant execute on function public.is_admin_email(text) to authenticated;

-- Vendor Portal issuer (pool A)
create or replace function public.admin_add_or_reset(target_email text)
 returns json language plpgsql security definer set search_path to '' as $function$
declare v_email text := lower(target_email); v_id uuid; v_token text; v_created boolean := false; begin
  if public.my_role() <> 'admin' then raise exception 'not authorized'; end if;
  if v_email is null or position('@' in v_email) = 0 then raise exception 'invalid email'; end if;
  if public.is_admin_email(v_email) and v_email <> lower(public.jwt_email()) then
    raise exception 'Cannot issue a password reset for another admin'; end if;
  select id into v_id from auth.users where lower(email) = v_email;
  if v_id is null then
    v_id := gen_random_uuid();
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at,
      raw_app_meta_data, raw_user_meta_data, confirmation_token, recovery_token, email_change, email_change_token_new)
    values ('00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', v_email,
      extensions.crypt(encode(extensions.gen_random_bytes(18), 'hex'), extensions.gen_salt('bf')), now(), now(), now(),
      '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, '', '', '', '');
    insert into auth.identities (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), v_id, jsonb_build_object('sub', v_id::text, 'email', v_email), 'email', v_id::text, now(), now(), now());
    v_created := true;
  end if;
  v_token := encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.password_reset_tokens (token, email, created_by, expires_at)
  values (encode(extensions.digest(v_token, 'sha256'), 'hex'), v_email, public.jwt_email(), now() + interval '24 hours');
  return json_build_object('token', v_token, 'created', v_created);
end; $function$;

-- Takeoff Flow issuer (pool A)
create or replace function public.tf_admin_add_or_reset(target_email text)
 returns json language plpgsql security definer set search_path to '' as $function$
declare v_email text := lower(target_email); v_id uuid; v_token text; v_created boolean := false; begin
  if public.tf_role() <> 'admin' then raise exception 'not authorized'; end if;
  if v_email is null or position('@' in v_email) = 0 then raise exception 'invalid email'; end if;
  if public.is_admin_email(v_email) and v_email <> lower(public.tf_email()) then
    raise exception 'Cannot issue a password reset for another admin'; end if;
  select id into v_id from auth.users where lower(email) = v_email;
  if v_id is null then
    v_id := gen_random_uuid();
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at,
      raw_app_meta_data, raw_user_meta_data, confirmation_token, recovery_token, email_change, email_change_token_new)
    values ('00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', v_email,
      extensions.crypt(encode(extensions.gen_random_bytes(18), 'hex'), extensions.gen_salt('bf')), now(), now(), now(),
      '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, '', '', '', '');
    insert into auth.identities (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), v_id, jsonb_build_object('sub', v_id::text, 'email', v_email), 'email', v_id::text, now(), now(), now());
    v_created := true;
  end if;
  v_token := encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.password_reset_tokens (token, email, created_by, expires_at)
  values (encode(extensions.digest(v_token, 'sha256'), 'hex'), v_email, public.tf_email(), now() + interval '24 hours');
  return json_build_object('token', v_token, 'created', v_created);
end; $function$;
