-- API Keys table for project authentication
-- Run this on your Neon PostgreSQL database

CREATE TABLE IF NOT EXISTS api_keys (
    id SERIAL PRIMARY KEY,
    project_id VARCHAR(255) NOT NULL UNIQUE,
    key_hash VARCHAR(255) NOT NULL,           -- SHA-256 hash of the full API key
    key_prefix VARCHAR(20) NOT NULL,          -- First 12 chars for identification (e.g., sa_live_a1b2)
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_used_at TIMESTAMP WITH TIME ZONE,
    is_active BOOLEAN DEFAULT true,
    created_by VARCHAR(255),                  -- Optional: who created this key
    description VARCHAR(500)                  -- Optional: description for the key
);

-- Index for fast lookups by project_id
CREATE INDEX IF NOT EXISTS idx_api_keys_project_id ON api_keys(project_id);

-- Index for key prefix (useful for identifying keys in logs)
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix);

-- Index for active keys only
CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(project_id) WHERE is_active = true;
