-- PostgreSQL Database Schema for Wassup Journal

-- Enable UUID extension if available
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  google_sub VARCHAR(255) UNIQUE NOT NULL,
  email VARCHAR(255) NOT NULL,
  name VARCHAR(255),
  picture TEXT,
  recall_days INT NOT NULL DEFAULT 30,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Sessions table for HttpOnly cookie authentication
CREATE TABLE IF NOT EXISTS sessions (
  id VARCHAR(128) PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Journal entries table
CREATE TABLE IF NOT EXISTS journal_entries (
  id VARCHAR(64) PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  source VARCHAR(32) NOT NULL DEFAULT 'written',
  flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  entry_date TIMESTAMPTZ NOT NULL,
  date_display VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_entries_user_date ON journal_entries(user_id, entry_date);

-- AI Analyses cache table
CREATE TABLE IF NOT EXISTS ai_analyses (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cache_id VARCHAR(128) NOT NULL,
  scope VARCHAR(32) NOT NULL,
  label VARCHAR(255),
  recall_days INT NOT NULL DEFAULT 30,
  summary_data JSONB NOT NULL,
  similarities JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, cache_id)
);
CREATE INDEX IF NOT EXISTS idx_analyses_user ON ai_analyses(user_id);

-- Serverless-safe AI Rate Limiting table
CREATE TABLE IF NOT EXISTS ai_rate_limits (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_user_time ON ai_rate_limits(user_id, created_at);
