-- ============================================================================
--  POOL A ACCOUNT FUNCTIONS — SOURCE OF TRUTH
--  (Pool A = public.password_reset_tokens, shared by Takeoff Flow, the Vendor
--   Assignments Portal and Blueprint. Pool B = public.cdb_reset_tokens, defined
--   in community-db/supabase_setup.sql.)
--
--  Every function body below was pulled from the live database with
--  pg_get_functiondef on 2026-09-29 and matches production exactly. This is the
--  ONLY repo file that defines these functions — do not copy them elsewhere.
--  If you change one, change it here, run this file, and re-run the drift check
--  (_docs/security-fixes/03_drift_check.sql, section 11).
--
--    is_allowed_signup_domain(email)             -> boolean   (@lennar.com only)
--    is_admin_email(email)                       -> boolean   (admin of ANY app)
--    tf_admin_add_or_reset(target_email)         -> {token, created}   Takeoff Flow issuer
--    admin_add_or_reset(target_email)            -> {token, created}   Vendor Portal issuer
--    redeem_reset_token(p_token, p_new_password) -> {ok} | {ok:false, error}
--    admin_delete_user(target_email)             -> {ok} | {ok:false, error}   Vendor Portal
--    tf_admin_delete_user(target_email)          -> {ok} | {ok:false, error}   Takeoff Flow
--
--  Guarantees:
--    * Tokens are stored only as SHA-256 hashes; plaintext is returned once.
--    * Issuers refuse non-@lennar.com addresses and refuse to reset another admin.
--    * Delete functions refuse self-delete and refuse to delete any admin.
--    * The redeemer refuses admin accounts (admins are reset at the DB level),
--      burns the token atomically before setting the password, confirms the
--      email, and logs the user out of other sessions.
--
--  NOT defined here (live DB only / elsewhere):
--    * public.my_role(), public.jwt_email() — Vendor Portal helpers, live DB only
--    * public.tf_role(), public.tf_email()  — takeoff-flow/supabase_setup.sql
--    * role-table triggers — blueprint/harden_admin_lifecycle.sql
--
--  History: 2026-08-21 hashing; 2026-09-17 admin redeem check;
--  2026-09-21 domain guard + burn-first; 2026-09-29 fixed session revocation
--  (auth.refresh_tokens.user_id is varchar, auth.users.id is uuid — the uncast
--  comparison raised "operator does not exist" and broke every Pool A reset);
--  2026-09-29 delete-user admin guard applied.
--
--  Idempotent. Run the whole file in one paste.
-- ============================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- 1. Helpers. Only SECURITY DEFINER functions call these, as owner, so no
--    external role gets EXECUTE (is_admin_email would be an enumeration oracle).
-- ---------------------------------------------------------------------------
create or replace function public.is_allowed_signup_domain(p_email text)
returns boolean
language sql
immutable
set search_path to ''
as $$
  select lower(coalesce(p_email, '')) like '%@lennar.com'
$$;
revoke all on function public.is_allowed_signup_domain(text) from public, anon, authenticated;

create or replace function public.is_admin_email(p_email text) returns boolean
 language plpgsql stable security definer set search_path to '' as $$
declare t text; v boolean; begin
  foreach t in array array['app_roles','tf_app_roles','cdb_app_roles','pdb_app_roles'] loop
    if to_regclass('public.'||t) is not null then
      execute format('select exists(select 1 from public.%I where lower(email)=lower($1) and role=''admin'')', t)
        into v using p_email;
      if v then return true; end if;
    end if;
  end loop;
  return false;
end $$;
revoke all on function public.is_admin_email(text) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 2. Takeoff Flow issuer.
-- ---------------------------------------------------------------------------
create or replace function public.tf_admin_add_or_reset(target_email text)
returns json language plpgsql security definer set search_path = '' as $$
declare
  v_email   text := lower(trim(target_email));
  v_id      uuid;
  v_token   text;
  v_created boolean := false;
begin
  if public.tf_role() <> 'admin' then
    raise exception 'not authorized';
  end if;
  if v_email is null or position('@' in v_email) = 0 then
    raise exception 'invalid email';
  end if;

  -- >>> ADDED: refuse to mint an account outside the company domain. <<<
  -- auth.users is shared by all five apps, so an account created here is an
  -- account everywhere. Previously any address with an '@' was accepted.
  if not public.is_allowed_signup_domain(v_email) then
    raise exception 'email must be @lennar.com';
  end if;

  -- >>> ADDED: an admin may not issue a reset for another admin. <<<
  -- Matches the Community-DB guard; prevents lateral takeover of the suite
  -- super-admin from a single-app admin seat. Self-reset stays allowed.
  if public.is_admin_email(v_email) and v_email <> lower(public.tf_email()) then
    raise exception 'cannot issue a reset for another admin';
  end if;

  select id into v_id from auth.users where lower(email) = v_email;

  if v_id is null then
    v_id := gen_random_uuid();
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, created_at, updated_at,
      raw_app_meta_data, raw_user_meta_data,
      confirmation_token, recovery_token, email_change, email_change_token_new
    ) values (
      '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', v_email,
      extensions.crypt(encode(extensions.gen_random_bytes(18), 'hex'), extensions.gen_salt('bf')),
      now(), now(), now(),
      '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
      '', '', '', ''
    );
    insert into auth.identities (
      id, user_id, identity_data, provider, provider_id,
      last_sign_in_at, created_at, updated_at
    ) values (
      gen_random_uuid(), v_id,
      jsonb_build_object('sub', v_id::text, 'email', v_email),
      'email', v_id::text,
      now(), now(), now()
    );
    v_created := true;
  end if;

  v_token := encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.password_reset_tokens (token, email, created_by, expires_at)
  values (encode(extensions.digest(v_token, 'sha256'), 'hex'), v_email,
          public.tf_email(), now() + interval '24 hours');

  return json_build_object('token', v_token, 'created', v_created);
end;
$$;
revoke all    on function public.tf_admin_add_or_reset(text) from public, anon;
grant  execute on function public.tf_admin_add_or_reset(text) to authenticated;


-- ---------------------------------------------------------------------------
-- 3. Vendor Portal issuer. (The Vendor Portal's own schema is in no repo, so
--    this is the only written record of this function.)
-- ---------------------------------------------------------------------------
create or replace function public.admin_add_or_reset(target_email text)
returns json language plpgsql security definer set search_path to '' as $$
declare
  v_email   text := lower(trim(target_email));
  v_id      uuid;
  v_token   text;
  v_created boolean := false;
begin
  if public.my_role() <> 'admin' then
    raise exception 'not authorized';
  end if;
  if v_email is null or position('@' in v_email) = 0 then
    raise exception 'invalid email';
  end if;

  -- >>> ADDED <<<
  if not public.is_allowed_signup_domain(v_email) then
    raise exception 'email must be @lennar.com';
  end if;
  if public.is_admin_email(v_email) and v_email <> lower(public.jwt_email()) then
    raise exception 'cannot issue a reset for another admin';
  end if;

  select id into v_id from auth.users where lower(email) = v_email;

  if v_id is null then
    v_id := gen_random_uuid();
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, created_at, updated_at,
      raw_app_meta_data, raw_user_meta_data,
      confirmation_token, recovery_token, email_change, email_change_token_new
    ) values (
      '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', v_email,
      extensions.crypt(encode(extensions.gen_random_bytes(18), 'hex'), extensions.gen_salt('bf')),
      now(), now(), now(),
      '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
      '', '', '', ''
    );
    insert into auth.identities (
      id, user_id, identity_data, provider, provider_id,
      last_sign_in_at, created_at, updated_at
    ) values (
      gen_random_uuid(), v_id,
      jsonb_build_object('sub', v_id::text, 'email', v_email),
      'email', v_id::text,
      now(), now(), now()
    );
    v_created := true;
  end if;

  v_token := encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.password_reset_tokens (token, email, created_by, expires_at)
  values (encode(extensions.digest(v_token, 'sha256'), 'hex'), v_email,
          public.jwt_email(), now() + interval '24 hours');

  return json_build_object('token', v_token, 'created', v_created);
end;
$$;
revoke all    on function public.admin_add_or_reset(text) from public, anon;
grant  execute on function public.admin_add_or_reset(text) to authenticated;


-- ---------------------------------------------------------------------------
-- 4. Shared redeemer. Blueprint is the landing page for every Pool A link.
--    anon must keep EXECUTE: redemption happens before sign-in.
-- ---------------------------------------------------------------------------
create or replace function public.redeem_reset_token(p_token text, p_new_password text)
returns json language plpgsql security definer set search_path to '' as $$
declare
  r      record;
  v_hash text;
  v_uid  text;
begin
  if p_new_password is null or length(p_new_password) < 8 then
    return json_build_object('ok', false, 'error', 'Password must be at least 8 characters.');
  end if;

  v_hash := encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');

  -- Admin passwords are never set via a link (harden_admin_lifecycle.sql).
  select email into r from public.password_reset_tokens where token = v_hash;
  if found and public.is_admin_email(r.email) then
    return json_build_object('ok', false, 'error',
      'Admin passwords must be reset by an administrator directly, not via a reset link.');
  end if;

  -- Burn first, atomically.
  update public.password_reset_tokens
     set used_at = now()
   where token = v_hash and used_at is null and expires_at >= now()
  returning * into r;

  if not found then
    return json_build_object('ok', false, 'error', 'This link is invalid, expired, or already used.');
  end if;

  update auth.users
     set encrypted_password = extensions.crypt(p_new_password, extensions.gen_salt('bf')),
         email_confirmed_at = coalesce(email_confirmed_at, now()),
         updated_at         = now()
   where lower(email) = lower(r.email)
  returning id::text into v_uid;

  if v_uid is null then
    return json_build_object('ok', false, 'error', 'This link is invalid, expired, or already used.');
  end if;

  -- Revoke other sessions. user_id is varchar in refresh_tokens and uuid in
  -- sessions, so compare as text. Never let this fail the redemption.
  begin
    delete from auth.refresh_tokens where user_id::text = v_uid;
    delete from auth.sessions       where user_id::text = v_uid;
  exception when undefined_table or undefined_column or undefined_function
                 or insufficient_privilege then null;
  end;

  return json_build_object('ok', true);
end;
$$;
grant execute on function public.redeem_reset_token(text, text) to anon, authenticated;


-- ---------------------------------------------------------------------------
-- 5. Delete-user functions. auth.users is shared, so these remove the login
--    from every app: an admin may not delete another admin of ANY app (the
--    trg_protect_admin trigger alone missed Community-DB-only admins).
-- ---------------------------------------------------------------------------
create or replace function public.admin_delete_user(target_email text)
returns json language plpgsql security definer set search_path to '' as $$
declare v_email text := lower(target_email);
begin
  if public.my_role() <> 'admin' then
    raise exception 'not authorized';
  end if;
  if v_email = lower(public.jwt_email()) then
    return json_build_object('ok', false, 'error', 'You cannot remove your own account.');
  end if;
  -- >>> ADDED: no deleting another admin (of any app) <<<
  if public.is_admin_email(v_email) then
    return json_build_object('ok', false, 'error', 'Cannot delete another admin''s account.');
  end if;

  delete from public.app_roles where lower(email) = v_email;
  if to_regclass('public.tf_app_roles') is not null then
    delete from public.tf_app_roles where lower(email) = v_email;
  end if;
  delete from public.password_reset_tokens where lower(email) = v_email;
  delete from auth.users where lower(email) = v_email;
  if not found then
    return json_build_object('ok', false, 'error', 'No account with that email.');
  end if;
  return json_build_object('ok', true);
end;
$$;

create or replace function public.tf_admin_delete_user(target_email text)
returns json language plpgsql security definer set search_path to '' as $$
declare v_email text := lower(target_email);
begin
  if public.tf_role() <> 'admin' then
    raise exception 'not authorized';
  end if;
  if v_email = public.tf_email() then
    return json_build_object('ok', false, 'error', 'You cannot remove your own account.');
  end if;
  -- >>> ADDED: no deleting another admin (of any app) <<<
  if public.is_admin_email(v_email) then
    return json_build_object('ok', false, 'error', 'Cannot delete another admin''s account.');
  end if;

  delete from public.tf_app_roles where lower(email) = v_email;
  if to_regclass('public.app_roles') is not null then
    delete from public.app_roles where lower(email) = v_email;
  end if;
  if to_regclass('public.password_reset_tokens') is not null then
    delete from public.password_reset_tokens where lower(email) = v_email;
  end if;
  delete from auth.users where lower(email) = v_email;
  if not found then
    return json_build_object('ok', false, 'error', 'No account with that email.');
  end if;
  return json_build_object('ok', true);
end;
$$;


-- ---------------------------------------------------------------------------
-- 6. One-time conversion of any plaintext tokens (48 hex chars) to SHA-256
--    (64). Idempotent: a re-run matches nothing.
-- ---------------------------------------------------------------------------
update public.password_reset_tokens
   set token = encode(extensions.digest(token, 'sha256'), 'hex')
 where length(token) = 48;


-- ---------------------------------------------------------------------------
-- 7. Verify. None of this consumes a real token.
-- ---------------------------------------------------------------------------
select public.redeem_reset_token('not-a-real-token', 'correcthorsebattery') as garbage_token;
--  expect: {"ok":false,"error":"This link is invalid, expired, or already used."}

select public.is_allowed_signup_domain('someone@lennar.com')        as lennar_allowed,       -- t
       not public.is_allowed_signup_domain('x@lennar.com.evil.io')  as suffix_spoof_refused, -- t
       (select count(*) from public.password_reset_tokens where length(token) <> 64) as unhashed_rows, -- 0
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname in ('admin_delete_user', 'tf_admin_delete_user')
           and position('is_admin_email' in pg_get_functiondef(p.oid)) > 0) as guarded_delete_fns; -- 2
