-- osarAI 初期スキーマ（CLAUDE.md §6）
-- ========== 拡張 ==========
create extension if not exists "pgcrypto";

-- ========== 組織（テナント） ==========
create table organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

-- ========== プロフィール（auth.users と 1:1） ==========
create table profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  org_id        uuid not null references organizations(id),
  role          text not null default 'member' check (role in ('member','leader')),
  display_name  text,
  industry      text,                          -- 業種（将来の着せ替え用）。例: sales/beauty/trainer
  created_at    timestamptz not null default now()
);
create index on profiles(org_id);

-- ========== 顧客 ==========
create table customers (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id),
  owner_id      uuid not null references profiles(id),
  name          text not null,
  status        text not null default 'active', -- active/archived
  temperature   text check (temperature in ('hot','warm','cold')),
  needs         text,
  custom_fields jsonb not null default '{}',    -- 業種別追加項目の着せ替え
  last_met_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index on customers(org_id);
create index on customers(owner_id);

-- ========== 対応履歴（入口は複数・処理は共通） ==========
create table interactions (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id),
  customer_id uuid not null references customers(id) on delete cascade,
  author_id   uuid not null references profiles(id),
  source      text not null check (source in ('ai_dialogue','in_person_rec','zoom_rec','manual')),
  type        text not null check (type in ('audio','text')),
  raw_text    text,
  audio_url   text,
  transcript  text,
  ai_summary  jsonb,                            -- {points:[], needs:[], next_actions:[]}
  met_at      timestamptz,
  created_at  timestamptz not null default now()
);
create index on interactions(customer_id);
create index on interactions(org_id);

-- ========== おさらいセッション（AI対話ログ） ==========
create table osarai_sessions (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null references organizations(id),
  user_id                 uuid not null references profiles(id),
  customer_id             uuid references customers(id),
  messages                jsonb not null default '[]', -- [{role, content}]
  status                  text not null default 'in_progress' check (status in ('in_progress','done')),
  resulting_interaction_id uuid references interactions(id),
  created_at              timestamptz not null default now()
);
create index on osarai_sessions(user_id);

-- ========== AI戦略相談 ==========
create table ai_chats (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id),
  user_id     uuid not null references profiles(id),
  scope       text not null check (scope in ('all','customer')),
  customer_id uuid references customers(id),
  title       text,
  created_at  timestamptz not null default now()
);
create table ai_chat_messages (
  id          uuid primary key default gen_random_uuid(),
  chat_id     uuid not null references ai_chats(id) on delete cascade,
  role        text not null check (role in ('user','assistant')),
  content     text not null,
  created_at  timestamptz not null default now()
);
create index on ai_chat_messages(chat_id);

-- ========== 課金（Stripe） ==========
create table subscriptions (
  user_id              uuid primary key references profiles(id) on delete cascade,
  stripe_customer_id   text,
  stripe_subscription_id text,
  plan                 text check (plan in ('light','standard','pro')),
  status               text,            -- trialing/active/past_due/canceled...
  promo_code           text,            -- 適用チャネル割引コード（流入トラッキング）
  trial_end            timestamptz,
  current_period_end   timestamptz,
  updated_at           timestamptz not null default now()
);

-- ========== プッシュトークン ==========
create table push_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references profiles(id) on delete cascade,
  token       text not null,
  platform    text not null check (platform in ('ios','android')),
  created_at  timestamptz not null default now(),
  unique(user_id, token)
);
