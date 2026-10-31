-- ReadAloud quizzes and "Don't get it" explanations (see docs/TUTOR.md).
-- Adds only ra_* objects. Additive: nothing else in the project is touched.

-- One quiz = the questions (made by the ra-tutor-quiz function from the book's
-- own pieces) and the reader's answers.
-- questions = [{ question, options: [4], correct: 0-3, explanation, source: { chunk_id, chapter, page, start_word, end_word, quote } }]
-- answers   = [chosen option per question, or null]
create table public.ra_quizzes (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  document_id  uuid not null references public.ra_documents (id) on delete cascade,
  scope        text not null check (scope in ('book', 'chapter', 'confused')),
  title        text not null default '',
  questions    jsonb not null check (jsonb_typeof(questions) = 'array'),
  answers      jsonb not null default '[]'::jsonb check (jsonb_typeof(answers) = 'array'),
  score        int,
  total        int not null default 0,
  created_at   timestamptz not null default now(),
  finished_at  timestamptz
);
comment on table public.ra_quizzes is 'ReadAloud quizzes: questions from the book''s own pieces, and the reader''s answers.';

create index ra_quizzes_doc_idx on public.ra_quizzes (user_id, document_id, created_at desc);

alter table public.ra_quizzes enable row level security;
create policy ra_quizzes_select on public.ra_quizzes for select to authenticated
  using (user_id = (select auth.uid()));
create policy ra_quizzes_insert on public.ra_quizzes for insert to authenticated
  with check (user_id = (select auth.uid())
              and exists (select 1 from public.ra_documents d
                          where d.id = document_id and d.user_id = (select auth.uid())));
create policy ra_quizzes_update on public.ra_quizzes for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy ra_quizzes_delete on public.ra_quizzes for delete to authenticated
  using (user_id = (select auth.uid()));

-- A "Don't get it" highlight remembers the tutor's explanation of it.
alter table public.ra_highlights
  add column if not exists explained_message_id uuid references public.ra_tutor_messages (id) on delete set null;
