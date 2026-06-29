---
title: Multi-tenant RLS isolation
severity: critical
paths:
  - supabase/migrations/**
  - supabase/functions/**
---
クライアントに露出する全 Supabase テーブルは、認証テナント／組織ID（org_id）および
所有者（owner_id / author_id / user_id = auth.uid()）で行レベルにスコープされた RLS を持つこと。
組織（org）跨ぎ・他ユーザー跨ぎで行を read/write しうる新テーブル・ポリシー・クエリ
（service_role の不用意な使用・RLS 未設定・org_id / owner_id 条件の欠落を含む）を critical として指摘する。
