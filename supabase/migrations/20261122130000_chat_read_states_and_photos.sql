-- Chat read receipts + photo messages (2026-11-22).
-- Implements the design memo in FIX_PREP_5 section 4:
--   * public.conversation_read_states — one row per (conversation, user)
--     holding how far that user has read. Writes go through the
--     SECURITY DEFINER RPC mark_conversation_read() only; participants
--     may SELECT both rows of their conversations (so a sender can see
--     whether the partner has read).
--   * public.messages.attachment_path — storage path of a chat photo.
--     NOTE: messages.body is NOT NULL with CHECK (char_length 1..4000),
--     verified against production on 2026-11-22, so a photo message
--     stores the placeholder body '📷 写真を送信しました' (which also
--     makes the conversation-list preview correct with no extra code)
--     plus the attachment_path. The constraint is intentionally NOT
--     relaxed.
--   * NEW private bucket `chat-images` (JPEG/PNG/WebP, 10MB). Object
--     paths are `<conversation_id>/<message_id>.jpg`; storage policies
--     allow access only to that conversation's buyer/seller. The client
--     displays photos through short-lived signed URLs, never public URLs.
--
-- APPLY ORDER: apply this migration BEFORE (or together with) deploying
-- the client that ships the read-receipt / photo UI. The client is
-- backward compatible in the other direction: until this migration runs,
-- the read-state calls fail quietly (localStorage read tracking keeps
-- working), photo sending fails at the upload step with an error
-- message, and chats render exactly as before.

-- ---------------------------------------------------------------- photos
alter table public.messages
  add column if not exists attachment_path text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chat-images', 'chat-images', false, 10485760, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

create policy "chat-images participant read"
  on storage.objects for select to authenticated
  using (bucket_id = 'chat-images' and exists (
    select 1 from public.conversations c
    where c.id::text = (storage.foldername(name))[1]
      and (c.buyer_id = (select auth.uid()) or c.seller_id = (select auth.uid()))
  ));

create policy "chat-images participant insert"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'chat-images' and exists (
    select 1 from public.conversations c
    where c.id::text = (storage.foldername(name))[1]
      and (c.buyer_id = (select auth.uid()) or c.seller_id = (select auth.uid()))
  ));

-- Delete is for cleaning up an upload whose message insert failed, and
-- for a sender removing their own photo. A participant may delete an
-- object only while no message references it (orphan cleanup) or when
-- the referencing message is their own.
create policy "chat-images participant delete"
  on storage.objects for delete to authenticated
  using (bucket_id = 'chat-images' and exists (
    select 1 from public.conversations c
    where c.id::text = (storage.foldername(name))[1]
      and (c.buyer_id = (select auth.uid()) or c.seller_id = (select auth.uid()))
  ) and (
    not exists (select 1 from public.messages m where m.attachment_path = name)
    or exists (select 1 from public.messages m where m.attachment_path = name and m.sender_id = (select auth.uid()))
  ));

-- ------------------------------------------------------------ read state
create table if not exists public.conversation_read_states (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

alter table public.conversation_read_states enable row level security;

-- Participants may read both rows of their own conversations (their own
-- state and the partner's, which drives the "既読" label). There are no
-- direct write policies: writes happen only via mark_conversation_read().
create policy "conversation_read_states participant select"
  on public.conversation_read_states for select to authenticated
  using (exists (
    select 1 from public.conversations c
    where c.id = conversation_id
      and (c.buyer_id = (select auth.uid()) or c.seller_id = (select auth.uid()))
  ));

create or replace function public.mark_conversation_read(p_conversation_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare
  uid uuid := (select auth.uid());
  latest timestamptz;
begin
  if uid is null then
    raise exception 'authentication required';
  end if;
  if not exists (select 1 from public.conversations c
                 where c.id = p_conversation_id and (c.buyer_id = uid or c.seller_id = uid)) then
    raise exception 'not a conversation participant';
  end if;
  -- Mirror the client's existing convention: the read watermark is the
  -- newest partner message timestamp as stored on the server, so device
  -- clock skew can never resurrect unread messages.
  select max(m.created_at) into latest
    from public.messages m
   where m.conversation_id = p_conversation_id and m.sender_id <> uid;
  insert into public.conversation_read_states (conversation_id, user_id, last_read_at, updated_at)
  values (p_conversation_id, uid, coalesce(latest, now()), now())
  on conflict (conversation_id, user_id) do update
    set last_read_at = greatest(public.conversation_read_states.last_read_at, excluded.last_read_at),
        updated_at = now();
end;
$$;
revoke all on function public.mark_conversation_read(uuid) from public;
grant execute on function public.mark_conversation_read(uuid) to authenticated;
