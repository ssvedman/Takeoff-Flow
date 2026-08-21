-- ============================================================================
--  HARDEN POOL A RESET TOKENS — store SHA-256 hashes, never plaintext
--  (Pool A = public.password_reset_tokens, shared by Takeoff Flow, the Vendor
--   Assignments Portal and Blueprint. Pool B = public.cdb_reset_tokens, which
--   has its own migration in the Community-DB repo.)
--
--  Today the table holds the bearer token in plaintext: anyone who reads one row
--  (a dump, a backup, a mis-scoped grant) can set that account's password. After
--  this migration the column holds only the SHA-256 of the token, so a leak of
--  the table is worthless. The plaintext is returned to the admin exactly once,
--  at mint time, and never persisted.
--
--  THREE functions touch the table. Only the first lives in a repo file:
--    * public.tf_admin_add_or_reset()  Takeoff Flow issuer (supabase_setup.sql)
--    * public.admin_add_or_reset()     Vendor Portal issuer — live DB only
--    * public.redeem_reset_token()     shared redeemer      — live DB only
--
--  Sections 2 and 3 below are the LIVE BODIES (pulled via pg_get_functiondef on
--  2026-08-21 and verified) with the minimum edits for hashing — the token-column
--  lookups and the insert. Nothing else about their behavior was changed, so the
--  contracts every client depends on are preserved exactly:
--    admin_add_or_reset(target_email)            -> {token, created}
--    redeem_reset_token(p_token, p_new_password) -> {ok} | {ok:false, error}
--  Both are replaced with CREATE OR REPLACE (signature and return type confirmed
--  identical), so their existing grants — including anon execute on the
--  redeemer, needed because redemption happens before sign-in — carry over
--  untouched.
--
--  ORDER OF OPERATIONS — run this WHOLE FILE in one paste (one transaction).
--  Issuers must start hashing at the same moment the redeemer starts hashing
--  the presented token, and section 4 converts the rows already stored. Links
--  already emailed or pasted into chat KEEP WORKING: the plaintext token in the
--  URL is hashed at redeem time and matched against the converted row.
--
--  Unaffected: Blueprint's public.hub_pending_invites() reads only email /
--  created_at / expires_at / used_at from this table, never the token column.
-- ============================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- 1. Takeoff Flow issuer. Identical to the copy now in supabase_setup.sql:
--    hash on insert, still return the plaintext to the admin.
-- ---------------------------------------------------------------------------
create or replace function public.tf_admin_add_or_reset(target_email text)
returns json language plpgsql security definer set search_path = '' as $$
declare
  v_email   text := lower(target_email);
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

  -- Only the SHA-256 of the token is stored: a dump of password_reset_tokens is
  -- then useless for account takeover. The plaintext goes back to the caller
  -- (once) so the admin can hand out the link. search_path is '' here, so every
  -- pgcrypto call is schema-qualified.
  v_token := encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.password_reset_tokens (token, email, created_by, expires_at)
  values (encode(extensions.digest(v_token, 'sha256'), 'hex'), v_email, public.tf_email(), now() + interval '24 hours');

  return json_build_object('token', v_token, 'created', v_created);
end;
$$;
revoke all on function public.tf_admin_add_or_reset(text) from public;
grant execute on function public.tf_admin_add_or_reset(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Shared redeemer — the live body verbatim, with exactly two edits, both
--    marked HASHED below: the lookup hashes the presented token before
--    comparing, and the burn reuses the stored hash from the fetched row.
--    Everything else (error wording, the Account-not-found guard, what is and
--    is not written to auth.users) is untouched.
-- ---------------------------------------------------------------------------
create or replace function public.redeem_reset_token(p_token text, p_new_password text)
returns json language plpgsql security definer set search_path to '' as $$
declare r record;
begin
  if p_new_password is null or length(p_new_password) < 8 then
    return json_build_object('ok', false, 'error', 'Password must be at least 8 characters.');
  end if;

  select * into r from public.password_reset_tokens
   where token = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');  -- HASHED
  if not found then
    return json_build_object('ok', false, 'error', 'Invalid or unknown link.');
  end if;
  if r.used_at is not null then
    return json_build_object('ok', false, 'error', 'This link has already been used.');
  end if;
  if r.expires_at < now() then
    return json_build_object('ok', false, 'error', 'This link has expired.');
  end if;

  update auth.users
     set encrypted_password = extensions.crypt(p_new_password, extensions.gen_salt('bf')),
         updated_at = now()
   where lower(email) = r.email;
  if not found then
    return json_build_object('ok', false, 'error', 'Account not found.');
  end if;

  update public.password_reset_tokens set used_at = now() where token = r.token;  -- HASHED (r.token is the stored hash)
  return json_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Vendor Portal issuer — the live body verbatim (it authorizes via the live
--    helper public.my_role() and stamps public.jwt_email(), both left as-is),
--    with exactly one edit, marked HASHED: the insert stores the SHA-256 of the
--    token while the plaintext still goes back to the admin.
-- ---------------------------------------------------------------------------
create or replace function public.admin_add_or_reset(target_email text)
returns json language plpgsql security definer set search_path to '' as $$
declare
  v_email   text := lower(target_email);
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
  values (encode(extensions.digest(v_token, 'sha256'), 'hex'), v_email, public.jwt_email(), now() + interval '24 hours');  -- HASHED

  return json_build_object('token', v_token, 'created', v_created);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. One-time conversion of the rows already in the table.
--    Issued tokens are 24 random bytes hex-encoded = 48 chars; a SHA-256 hex
--    digest is 64 chars. The length filter therefore selects exactly the
--    not-yet-converted rows, which makes this statement idempotent and safe to
--    re-run (a second run matches nothing). Because it lands in the same
--    transaction as the redeemer switch above, outstanding links keep working
--    without interruption.
-- ---------------------------------------------------------------------------
update public.password_reset_tokens
   set token = encode(extensions.digest(token, 'sha256'), 'hex')
 where length(token) = 48;

-- ---------------------------------------------------------------------------
-- 5. Verify. Expect: first query zero, second query t / t / t.
-- ---------------------------------------------------------------------------
select count(*) as unconverted_rows
  from public.password_reset_tokens where length(token) <> 64;

select
  exists(select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'redeem_reset_token')   as redeemer_present,
  exists(select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'admin_add_or_reset')   as vp_issuer_present,
  exists(select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'tf_admin_add_or_reset') as tf_issuer_present;
