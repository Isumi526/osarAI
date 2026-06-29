---
title: Additive-only migrations
severity: high
paths:
  - supabase/migrations/**
---
既存テーブルへの column 削除／rename、default 無しの NOT NULL 追加、既存型の変更（ALTER ... TYPE）を
含む migration を high として指摘する。追加のみ DDL（ADD COLUMN / CREATE TABLE / CREATE INDEX /
ADD CONSTRAINT 等の非破壊）が前提。
