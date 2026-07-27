-- NMF2026-2 Supabase schema
-- Run this entire file in the Supabase SQL Editor.
-- The script is designed to be safely re-run.

begin;

create table if not exists public.seminar_plans (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  payload jsonb not null default '{}'::jsonb,
  revision bigint not null default 1,
  view_token uuid not null default pg_catalog.gen_random_uuid(),
  edit_token uuid not null default pg_catalog.gen_random_uuid(),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint seminar_plans_title_check
    check (
      pg_catalog.char_length(pg_catalog.btrim(title)) between 1 and 200
    ),
  constraint seminar_plans_payload_check
    check (pg_catalog.jsonb_typeof(payload) = 'object'),
  constraint seminar_plans_revision_check
    check (revision > 0),
  constraint seminar_plans_distinct_share_tokens_check
    check (view_token <> edit_token)
);

create unique index if not exists seminar_plans_view_token_uidx
  on public.seminar_plans (view_token);

create unique index if not exists seminar_plans_edit_token_uidx
  on public.seminar_plans (edit_token);

create index if not exists seminar_plans_owner_updated_idx
  on public.seminar_plans (owner_id, updated_at desc);

create table if not exists public.seminar_plan_history (
  id bigint generated always as identity primary key,
  plan_id uuid not null
    references public.seminar_plans(id) on delete cascade,
  owner_id uuid not null,
  title text not null,
  payload jsonb not null,
  revision bigint not null,
  changed_by uuid not null,
  change_source text not null,
  saved_at timestamptz not null default pg_catalog.now(),
  constraint seminar_plan_history_payload_check
    check (pg_catalog.jsonb_typeof(payload) = 'object'),
  constraint seminar_plan_history_revision_check
    check (revision > 0),
  constraint seminar_plan_history_source_check
    check (change_source in ('owner_create', 'owner_save', 'shared_save'))
);

create unique index if not exists seminar_plan_history_plan_revision_uidx
  on public.seminar_plan_history (plan_id, revision);

create index if not exists seminar_plan_history_owner_saved_idx
  on public.seminar_plan_history (owner_id, saved_at desc);

alter table public.seminar_plans enable row level security;
alter table public.seminar_plan_history enable row level security;

drop policy if exists seminar_plans_owner_select
  on public.seminar_plans;
create policy seminar_plans_owner_select
  on public.seminar_plans
  for select
  to authenticated
  using ((select auth.uid()) = owner_id);

drop policy if exists seminar_plans_owner_delete
  on public.seminar_plans;
create policy seminar_plans_owner_delete
  on public.seminar_plans
  for delete
  to authenticated
  using ((select auth.uid()) = owner_id);

drop policy if exists seminar_plan_history_owner_select
  on public.seminar_plan_history;
create policy seminar_plan_history_owner_select
  on public.seminar_plan_history
  for select
  to authenticated
  using ((select auth.uid()) = owner_id);

-- The browser can only list/delete its own plans and read its own history.
-- Inserts and updates are intentionally limited to the RPCs below so every
-- write performs authorization, optimistic locking, and history recording.
revoke all privileges on table public.seminar_plans
  from public, anon, authenticated;
revoke all privileges on table public.seminar_plan_history
  from public, anon, authenticated;
revoke all privileges on sequence public.seminar_plan_history_id_seq
  from public, anon, authenticated;

grant select, delete on table public.seminar_plans to authenticated;
grant select on table public.seminar_plan_history to authenticated;

create or replace function public.save_owned_seminar_plan(
  p_plan_id uuid,
  p_title text,
  p_payload jsonb,
  p_expected_revision bigint
)
returns table (
  id uuid,
  title text,
  payload jsonb,
  revision bigint,
  view_token uuid,
  edit_token uuid,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_actor uuid := auth.uid();
  v_plan public.seminar_plans%rowtype;
  v_view_token uuid;
  v_edit_token uuid;
begin
  if v_actor is null then
    raise exception using
      errcode = '42501',
      message = 'AUTHENTICATION_REQUIRED';
  end if;

  if p_title is null
     or pg_catalog.char_length(pg_catalog.btrim(p_title)) not between 1 and 200 then
    raise exception using
      errcode = '22023',
      message = 'TITLE_MUST_BE_BETWEEN_1_AND_200_CHARACTERS';
  end if;

  if p_payload is null
     or pg_catalog.jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception using
      errcode = '22023',
      message = 'PAYLOAD_MUST_BE_A_JSON_OBJECT';
  end if;

  if p_plan_id is null then
    if p_expected_revision is not null then
      raise exception using
        errcode = '22023',
        message = 'EXPECTED_REVISION_MUST_BE_NULL_WHEN_CREATING';
    end if;

    loop
      v_view_token := pg_catalog.gen_random_uuid();
      v_edit_token := pg_catalog.gen_random_uuid();

      exit when v_view_token <> v_edit_token
        and not exists (
          select 1
          from public.seminar_plans as existing_plan
          where existing_plan.view_token in (v_view_token, v_edit_token)
             or existing_plan.edit_token in (v_view_token, v_edit_token)
        );
    end loop;

    insert into public.seminar_plans (
      owner_id,
      title,
      payload,
      revision,
      view_token,
      edit_token
    )
    values (
      v_actor,
      pg_catalog.btrim(p_title),
      p_payload,
      1,
      v_view_token,
      v_edit_token
    )
    returning * into v_plan;

    insert into public.seminar_plan_history (
      plan_id,
      owner_id,
      title,
      payload,
      revision,
      changed_by,
      change_source
    )
    values (
      v_plan.id,
      v_plan.owner_id,
      v_plan.title,
      v_plan.payload,
      v_plan.revision,
      v_actor,
      'owner_create'
    );
  else
    if p_expected_revision is null or p_expected_revision < 1 then
      raise exception using
        errcode = '22023',
        message = 'EXPECTED_REVISION_IS_REQUIRED_WHEN_UPDATING';
    end if;

    select plan_row.*
      into v_plan
      from public.seminar_plans as plan_row
     where plan_row.id = p_plan_id
       and plan_row.owner_id = v_actor
     for update;

    if not found then
      raise exception using
        errcode = 'P0002',
        message = 'PLAN_NOT_FOUND_OR_NOT_OWNED';
    end if;

    if v_plan.revision <> p_expected_revision then
      raise exception using
        errcode = '40001',
        message = 'REVISION_CONFLICT',
        detail = pg_catalog.format(
          'expected=%s,current=%s',
          p_expected_revision,
          v_plan.revision
        );
    end if;

    update public.seminar_plans as plan_row
       set title = pg_catalog.btrim(p_title),
           payload = p_payload,
           revision = plan_row.revision + 1,
           updated_at = pg_catalog.now()
     where plan_row.id = v_plan.id
    returning plan_row.* into v_plan;

    insert into public.seminar_plan_history (
      plan_id,
      owner_id,
      title,
      payload,
      revision,
      changed_by,
      change_source
    )
    values (
      v_plan.id,
      v_plan.owner_id,
      v_plan.title,
      v_plan.payload,
      v_plan.revision,
      v_actor,
      'owner_save'
    );
  end if;

  return query
  select
    plan_row.id,
    plan_row.title,
    plan_row.payload,
    plan_row.revision,
    plan_row.view_token,
    plan_row.edit_token,
    plan_row.updated_at
  from public.seminar_plans as plan_row
  where plan_row.id = v_plan.id;
end;
$function$;

create or replace function public.load_shared_seminar_plan(
  p_token uuid
)
returns table (
  id uuid,
  title text,
  payload jsonb,
  revision bigint,
  updated_at timestamptz,
  can_edit boolean
)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    raise exception using
      errcode = '42501',
      message = 'AUTHENTICATION_REQUIRED';
  end if;

  if p_token is null then
    raise exception using
      errcode = '22023',
      message = 'SHARE_TOKEN_IS_REQUIRED';
  end if;

  return query
  select
    plan_row.id,
    plan_row.title,
    plan_row.payload,
    plan_row.revision,
    plan_row.updated_at,
    plan_row.edit_token = p_token
  from public.seminar_plans as plan_row
  where plan_row.view_token = p_token
     or plan_row.edit_token = p_token
  limit 1;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'SHARED_PLAN_NOT_FOUND';
  end if;
end;
$function$;

create or replace function public.save_shared_seminar_plan(
  p_token uuid,
  p_title text,
  p_payload jsonb,
  p_expected_revision bigint
)
returns table (
  id uuid,
  title text,
  payload jsonb,
  revision bigint,
  updated_at timestamptz,
  can_edit boolean
)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_actor uuid := auth.uid();
  v_plan public.seminar_plans%rowtype;
begin
  if v_actor is null then
    raise exception using
      errcode = '42501',
      message = 'AUTHENTICATION_REQUIRED';
  end if;

  if p_token is null then
    raise exception using
      errcode = '22023',
      message = 'EDIT_TOKEN_IS_REQUIRED';
  end if;

  if p_title is null
     or pg_catalog.char_length(pg_catalog.btrim(p_title)) not between 1 and 200 then
    raise exception using
      errcode = '22023',
      message = 'TITLE_MUST_BE_BETWEEN_1_AND_200_CHARACTERS';
  end if;

  if p_payload is null
     or pg_catalog.jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception using
      errcode = '22023',
      message = 'PAYLOAD_MUST_BE_A_JSON_OBJECT';
  end if;

  if p_expected_revision is null or p_expected_revision < 1 then
    raise exception using
      errcode = '22023',
      message = 'EXPECTED_REVISION_IS_REQUIRED';
  end if;

  select plan_row.*
    into v_plan
    from public.seminar_plans as plan_row
   where plan_row.edit_token = p_token
   for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'EDIT_TOKEN_INVALID';
  end if;

  if v_plan.revision <> p_expected_revision then
    raise exception using
      errcode = '40001',
      message = 'REVISION_CONFLICT',
      detail = pg_catalog.format(
        'expected=%s,current=%s',
        p_expected_revision,
        v_plan.revision
      );
  end if;

  update public.seminar_plans as plan_row
     set title = pg_catalog.btrim(p_title),
         payload = p_payload,
         revision = plan_row.revision + 1,
         updated_at = pg_catalog.now()
   where plan_row.id = v_plan.id
  returning plan_row.* into v_plan;

  insert into public.seminar_plan_history (
    plan_id,
    owner_id,
    title,
    payload,
    revision,
    changed_by,
    change_source
  )
  values (
    v_plan.id,
    v_plan.owner_id,
    v_plan.title,
    v_plan.payload,
    v_plan.revision,
    v_actor,
    'shared_save'
  );

  return query
  select
    plan_row.id,
    plan_row.title,
    plan_row.payload,
    plan_row.revision,
    plan_row.updated_at,
    true
  from public.seminar_plans as plan_row
  where plan_row.id = v_plan.id;
end;
$function$;

create or replace function public.rotate_seminar_plan_share_tokens(
  p_plan_id uuid
)
returns table (
  id uuid,
  title text,
  payload jsonb,
  revision bigint,
  view_token uuid,
  edit_token uuid,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_actor uuid := auth.uid();
  v_plan public.seminar_plans%rowtype;
  v_view_token uuid;
  v_edit_token uuid;
begin
  if v_actor is null then
    raise exception using
      errcode = '42501',
      message = 'AUTHENTICATION_REQUIRED';
  end if;

  if p_plan_id is null then
    raise exception using
      errcode = '22023',
      message = 'PLAN_ID_IS_REQUIRED';
  end if;

  select plan_row.*
    into v_plan
    from public.seminar_plans as plan_row
   where plan_row.id = p_plan_id
     and plan_row.owner_id = v_actor
   for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'PLAN_NOT_FOUND_OR_NOT_OWNED';
  end if;

  loop
    v_view_token := pg_catalog.gen_random_uuid();
    v_edit_token := pg_catalog.gen_random_uuid();

    exit when v_view_token <> v_edit_token
      and not exists (
        select 1
        from public.seminar_plans as existing_plan
        where existing_plan.id <> v_plan.id
          and (
            existing_plan.view_token in (v_view_token, v_edit_token)
            or existing_plan.edit_token in (v_view_token, v_edit_token)
          )
      );
  end loop;

  update public.seminar_plans as plan_row
     set view_token = v_view_token,
         edit_token = v_edit_token,
         updated_at = pg_catalog.now()
   where plan_row.id = v_plan.id
  returning plan_row.* into v_plan;

  return query
  select
    plan_row.id,
    plan_row.title,
    plan_row.payload,
    plan_row.revision,
    plan_row.view_token,
    plan_row.edit_token,
    plan_row.updated_at
  from public.seminar_plans as plan_row
  where plan_row.id = v_plan.id;
end;
$function$;

revoke all privileges
  on function public.save_owned_seminar_plan(uuid, text, jsonb, bigint)
  from public, anon, authenticated;
revoke all privileges
  on function public.load_shared_seminar_plan(uuid)
  from public, anon, authenticated;
revoke all privileges
  on function public.save_shared_seminar_plan(uuid, text, jsonb, bigint)
  from public, anon, authenticated;
revoke all privileges
  on function public.rotate_seminar_plan_share_tokens(uuid)
  from public, anon, authenticated;

grant execute
  on function public.save_owned_seminar_plan(uuid, text, jsonb, bigint)
  to authenticated;
grant execute
  on function public.load_shared_seminar_plan(uuid)
  to authenticated;
grant execute
  on function public.save_shared_seminar_plan(uuid, text, jsonb, bigint)
  to authenticated;
grant execute
  on function public.rotate_seminar_plan_share_tokens(uuid)
  to authenticated;

comment on table public.seminar_plans is
  'NMF2026-2 seminar plans. Owner access uses RLS; shared access uses authenticated RPCs.';
comment on table public.seminar_plan_history is
  'Immutable content snapshots. Share tokens are deliberately excluded.';
comment on function public.save_owned_seminar_plan(uuid, text, jsonb, bigint) is
  'Creates or optimistically updates an authenticated user-owned seminar plan.';
comment on function public.load_shared_seminar_plan(uuid) is
  'Loads a shared seminar plan for an authenticated user without exposing either token.';
comment on function public.save_shared_seminar_plan(uuid, text, jsonb, bigint) is
  'Optimistically updates a seminar plan using its edit token without returning tokens.';
comment on function public.rotate_seminar_plan_share_tokens(uuid) is
  'Owner-only rotation of both share tokens; all prior share links become invalid.';

commit;
