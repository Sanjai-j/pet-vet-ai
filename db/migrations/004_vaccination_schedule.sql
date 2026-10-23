-- Vaccination schedule reference + per-pet checkpoints.
--
-- The reference rows come from a candidate workbook
-- (Pet_Vet_AI_Age_Breed_Vaccination_Schedule_India.xlsx). Like the nutrition
-- imports they land as 'pending' and only become usable after a veterinarian
-- or administrator approves them. The workbook states that breed is not a
-- timing modifier, so rows are keyed by species, not breed.
--
-- Checkpoints are the owner-facing to-do items: "this vaccine is due on this
-- date". The owner can mark one done (which writes a normal vaccination
-- record) or move it to a date their veterinarian advised, and the reminder
-- worker notifies them as that date approaches.

CREATE TABLE IF NOT EXISTS vaccine_schedules (
  id                            text PRIMARY KEY,
  species_code                  text NOT NULL REFERENCES species(code),
  species_label                 text NOT NULL,
  vaccine_key                   text NOT NULL,
  vaccine_name                  text NOT NULL,
  first_dose_age_text           text NOT NULL,
  first_dose_age_days           integer,
  primary_series_text           text NOT NULL,
  booster_interval_text         text NOT NULL,
  booster_interval_months       integer,
  must_check_before_scheduling  text,
  app_guidance                  text,
  guidance_level                text NOT NULL DEFAULT 'vet_decision'
    CHECK (guidance_level IN ('general_guidance', 'vet_decision', 'programme_only', 'avian_review')),
  series_interval_weeks         integer,
  auto_assignable               boolean NOT NULL DEFAULT false,
  reference_basis               text NOT NULL DEFAULT '',
  status                        text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  is_demo                       boolean NOT NULL DEFAULT false,
  review_notes                  text,
  reviewed_by                   text REFERENCES users(id),
  reviewed_at                   timestamptz,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (species_code, vaccine_key)
);
CREATE INDEX IF NOT EXISTS vaccine_schedules_lookup_idx
  ON vaccine_schedules (species_code, status);

CREATE TABLE IF NOT EXISTS vaccination_checkpoints (
  id              text PRIMARY KEY,
  pet_id          text NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  schedule_id     text REFERENCES vaccine_schedules(id) ON DELETE SET NULL,
  vaccine_name    text NOT NULL,
  due_on          date NOT NULL,
  previous_due_on date,
  status          text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'done', 'removed')),
  completed_on    date,
  vaccination_id  text REFERENCES vaccinations(id) ON DELETE SET NULL,
  origin          text NOT NULL DEFAULT 'schedule'
    CHECK (origin IN ('schedule', 'owner', 'follow_up')),
  notes           text,
  created_by      text REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vaccination_checkpoints_pet_idx
  ON vaccination_checkpoints (pet_id, status, due_on);
CREATE INDEX IF NOT EXISTS vaccination_checkpoints_due_idx
  ON vaccination_checkpoints (status, due_on);
