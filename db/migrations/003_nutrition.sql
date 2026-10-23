-- Pet Vet AI — food & nutrition knowledge base
-- Imports the structured breed/food workbook into normalized tables.
-- Every record arrives PENDING review: pending records are never served
-- as guidance. Approval publishes them to owners and syncs them into the
-- RAG knowledge index (knowledge_documents/chunks) used by AI chat.
-- Compatible with PostgreSQL 14+ and PGlite.

-- ─────────────────────────────────────────────────────────────
-- 1. Source references (URLs preserved verbatim).
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS nutrition_sources (
  id            text PRIMARY KEY,
  source_name   text NOT NULL,
  url           text,
  usage_notes   text NOT NULL DEFAULT '',
  review_status text NOT NULL DEFAULT 'pending'
                CHECK (review_status IN ('pending', 'approved', 'rejected')),
  version       int  NOT NULL DEFAULT 1,
  reviewed_by   text REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at   timestamptz,
  review_notes  text,
  is_demo       boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS nutrition_sources_name_idx
  ON nutrition_sources (lower(source_name));

-- ─────────────────────────────────────────────────────────────
-- 2. Master guidance: one row per species/breed/life-stage/goal.
--    Free-text guidance columns are preserved as imported; the
--    structured keys drive pet-specific filtering.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS nutrition_guidance (
  id                  text PRIMARY KEY,
  record_key          text NOT NULL,           -- workbook record_id (PVF-00001)
  species_code        text NOT NULL REFERENCES species(code),
  breed_or_type       text,                    -- context only; NULL = species-wide
  life_stage          text NOT NULL CHECK (life_stage IN ('young', 'adult', 'senior', 'all')),
  nutrition_goal      text NOT NULL,
  general_diet_guidance   text NOT NULL DEFAULT '',
  suitable_foods_text     text NOT NULL DEFAULT '',
  hazards_to_avoid_text   text NOT NULL DEFAULT '',
  recipe_guidance_text    text NOT NULL DEFAULT '',
  goal_specific_guidance text NOT NULL DEFAULT '',
  safety_cautions        text NOT NULL DEFAULT '',
  individualization_factors text NOT NULL DEFAULT '',
  disclaimer          text NOT NULL DEFAULT '',
  source_requirement  text NOT NULL DEFAULT '',
  data_quality_note   text NOT NULL DEFAULT '',
  source_id           text REFERENCES nutrition_sources(id) ON DELETE SET NULL,
  review_status       text NOT NULL DEFAULT 'pending'
                      CHECK (review_status IN ('pending', 'approved', 'rejected')),
  version             int  NOT NULL DEFAULT 1,
  reviewed_by         text REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at         timestamptz,
  review_notes        text,
  is_demo             boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS nutrition_guidance_record_idx
  ON nutrition_guidance (record_key);
CREATE INDEX IF NOT EXISTS nutrition_guidance_lookup_idx
  ON nutrition_guidance (review_status, species_code, life_stage);

-- ─────────────────────────────────────────────────────────────
-- 3. Foods/hazards to avoid. Species is an array because the
--    workbook mixes single species ("Dog"), grouped ("Dog/Cat",
--    "Cow/Goat") and "All species" rows. severity drives how the
--    UI prioritises veterinary advice after ingestion.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS nutrition_hazards (
  id               text PRIMARY KEY,
  species_codes    text[] NOT NULL DEFAULT '{}',
  food_or_substance text NOT NULL,
  classification   text NOT NULL DEFAULT '',
  severity         text NOT NULL DEFAULT 'unknown'
                   CHECK (severity IN ('toxic', 'potentially_toxic', 'dangerous',
                                       'caution', 'nutritionally_inappropriate', 'unknown')),
  risk             text NOT NULL DEFAULT '',
  recommended_action text NOT NULL DEFAULT '',
  source_id        text REFERENCES nutrition_sources(id) ON DELETE SET NULL,
  review_status    text NOT NULL DEFAULT 'pending'
                   CHECK (review_status IN ('pending', 'approved', 'rejected')),
  version          int  NOT NULL DEFAULT 1,
  reviewed_by      text REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at      timestamptz,
  review_notes     text,
  is_demo          boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS nutrition_hazards_unique_idx
  ON nutrition_hazards (lower(food_or_substance), species_codes);
CREATE INDEX IF NOT EXISTS nutrition_hazards_lookup_idx
  ON nutrition_hazards (review_status);

-- ─────────────────────────────────────────────────────────────
-- 4. Recipes. NEVER served as a complete diet: is_complete_diet
--    stays false unless a veterinary nutritionist validates
--    nutritional adequacy for the species + life stage (there is
--    no UI path to set it; only a reviewed DB edit can).
--    Storage instructions are not present in the source workbook,
--    so storage_instructions is NULL and storage_known=false —
--    the UI says so instead of guessing.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS nutrition_recipes (
  id                text PRIMARY KEY,
  species_code      text NOT NULL REFERENCES species(code),
  recipe_name       text NOT NULL,
  diet_role         text NOT NULL DEFAULT 'treat',
  applicability     text NOT NULL DEFAULT '',
  ingredients       text[] NOT NULL DEFAULT '{}',
  steps             text[] NOT NULL DEFAULT '{}',
  safety_notes      text NOT NULL DEFAULT '',
  storage_instructions text,
  storage_known     boolean NOT NULL DEFAULT false,
  is_complete_diet  boolean NOT NULL DEFAULT false,
  nutritional_adequacy text NOT NULL DEFAULT 'not_evaluated'
                      CHECK (nutritional_adequacy IN
                        ('not_evaluated', 'formulated', 'validated', 'rejected')),
  adequacy_note     text,
  source_id         text REFERENCES nutrition_sources(id) ON DELETE SET NULL,
  review_status     text NOT NULL DEFAULT 'pending'
                    CHECK (review_status IN ('pending', 'approved', 'rejected')),
  version           int  NOT NULL DEFAULT 1,
  reviewed_by       text REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at       timestamptz,
  review_notes      text,
  is_demo           boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS nutrition_recipes_unique_idx
  ON nutrition_recipes (species_code, lower(recipe_name));
CREATE INDEX IF NOT EXISTS nutrition_recipes_lookup_idx
  ON nutrition_recipes (review_status, species_code);

-- ─────────────────────────────────────────────────────────────
-- 5. Breed + life-stage guidance. Breed is CONTEXT ONLY: every
--    row carries its imported limitation text and is only ever
--    surfaced alongside it.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS nutrition_breed_guidance (
  id             text PRIMARY KEY,
  species_code   text NOT NULL REFERENCES species(code),
  breed_or_type  text NOT NULL,
  life_stage     text NOT NULL CHECK (life_stage IN ('young', 'adult', 'senior', 'all')),
  general_guidance text NOT NULL DEFAULT '',
  limitation     text NOT NULL DEFAULT '',
  referral_rule  text NOT NULL DEFAULT '',
  source_id      text REFERENCES nutrition_sources(id) ON DELETE SET NULL,
  review_status  text NOT NULL DEFAULT 'pending'
                 CHECK (review_status IN ('pending', 'approved', 'rejected')),
  version        int  NOT NULL DEFAULT 1,
  reviewed_by    text REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at    timestamptz,
  review_notes   text,
  is_demo        boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS nutrition_breed_unique_idx
  ON nutrition_breed_guidance (species_code, lower(breed_or_type), life_stage);
CREATE INDEX IF NOT EXISTS nutrition_breed_lookup_idx
  ON nutrition_breed_guidance (review_status, species_code, life_stage);

-- ─────────────────────────────────────────────────────────────
-- 6. Health-condition / goal rules (safety + referral rules).
--    Matched against a pet's recorded conditions, medications and
--    dietary restrictions to personalise guidance.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS nutrition_health_rules (
  id                text PRIMARY KEY,
  condition_or_goal text NOT NULL,
  keywords          text[] NOT NULL DEFAULT '{}',
  general_guidance  text NOT NULL DEFAULT '',
  safety_rule       text NOT NULL DEFAULT '',
  referral_rule     text NOT NULL DEFAULT '',
  source_id         text REFERENCES nutrition_sources(id) ON DELETE SET NULL,
  review_status     text NOT NULL DEFAULT 'pending'
                    CHECK (review_status IN ('pending', 'approved', 'rejected')),
  version           int  NOT NULL DEFAULT 1,
  reviewed_by       text REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at       timestamptz,
  review_notes      text,
  is_demo           boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS nutrition_health_rules_unique_idx
  ON nutrition_health_rules (lower(condition_or_goal));
CREATE INDEX IF NOT EXISTS nutrition_health_rules_lookup_idx
  ON nutrition_health_rules (review_status);

-- ─────────────────────────────────────────────────────────────
-- 7. Version history for every nutrition record type. Each edit,
--    approval or rejection appends an immutable snapshot.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS nutrition_record_versions (
  id          text PRIMARY KEY,
  record_type text NOT NULL CHECK (record_type IN
                ('guidance', 'hazard', 'recipe', 'breed', 'health_rule', 'source')),
  record_id   text NOT NULL,
  version     int  NOT NULL,
  action      text NOT NULL CHECK (action IN ('imported', 'edited', 'approved', 'rejected', 'reopened')),
  snapshot    jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_id    text REFERENCES users(id) ON DELETE SET NULL,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS nutrition_versions_unique_idx
  ON nutrition_record_versions (record_type, record_id, version, action);
CREATE INDEX IF NOT EXISTS nutrition_versions_record_idx
  ON nutrition_record_versions (record_type, record_id, created_at DESC);
