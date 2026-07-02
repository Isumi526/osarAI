---
title: Idempotency on user actions
severity: medium
paths:
  - supabase/functions/**
  - apps/web/**
  - apps/mobile/**
  - packages/shared/**
---
ユーザー操作（おさらいセッション送信・課金/サブスク処理・AIチャット送信・プッシュ通知発火 等）が連打／再送で二重発火・二重送信しうる、
べき等ガード（一意制約・トークンの単回利用・状態チェック）の無い箇所を medium として指摘する。
