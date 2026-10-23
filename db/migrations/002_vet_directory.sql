-- Pet Vet AI — veterinary discovery & verified veterinarian directory
-- Extends 001_init.sql. Compatible with PostgreSQL 14+ and PGlite.

-- ─────────────────────────────────────────────────────────────
-- 1. Clinics: our own records (demo, imported, independently sourced).
--    Google Places results are served live through the API proxy and are
--    NOT copied into this table (Google Places API terms). Only the
--    external place_id reference is stored when a vet links a profile.
-- ─────────────────────────────────────────────────────────────
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS place_id text;
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS data_source text NOT NULL DEFAULT 'demo';
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS website text;
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'unverified';
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS last_verified_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS clinics_place_id_idx ON clinics (place_id) WHERE place_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────
-- 2. Veterinarians: extend profiles for the public directory.
-- ─────────────────────────────────────────────────────────────
ALTER TABLE vet_profiles ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE vet_profiles ADD COLUMN IF NOT EXISTS qualification text;
ALTER TABLE vet_profiles ADD COLUMN IF NOT EXISTS registration_authority text;
ALTER TABLE vet_profiles ADD COLUMN IF NOT EXISTS languages text[] NOT NULL DEFAULT '{}';
ALTER TABLE vet_profiles ADD COLUMN IF NOT EXISTS consultation_types text[] NOT NULL DEFAULT '{}';
ALTER TABLE vet_profiles ADD COLUMN IF NOT EXISTS service_area text;
ALTER TABLE vet_profiles ADD COLUMN IF NOT EXISTS photo_file_id text;
ALTER TABLE vet_profiles ADD COLUMN IF NOT EXISTS profile_status text NOT NULL DEFAULT 'submitted';
ALTER TABLE vet_profiles ADD COLUMN IF NOT EXISTS suspended_reason text;
ALTER TABLE vet_profiles ADD COLUMN IF NOT EXISTS reverify_due_on date;

-- Full workflow statuses required by the directory spec, mapped onto the
-- existing verification_status column (which booking already enforces):
--   draft → submitted → under_review → additional_info_required
--        → approved (verification_status='verified') | rejected | suspended
ALTER TABLE vet_profiles DROP CONSTRAINT IF EXISTS vet_profiles_verification_status_check;
ALTER TABLE vet_profiles ADD CONSTRAINT vet_profiles_verification_status_check
  CHECK (verification_status IN
    ('draft', 'pending', 'submitted', 'under_review', 'additional_info_required',
     'verified', 'rejected', 'suspended'));

-- ─────────────────────────────────────────────────────────────
-- 3. Verification applications (documents, reviewer, timestamps).
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vet_applications (
  id             text PRIMARY KEY,
  vet_user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status         text NOT NULL DEFAULT 'submitted'
                 CHECK (status IN ('submitted', 'under_review', 'additional_info_required',
                                   'approved', 'rejected')),
  summary        text NOT NULL DEFAULT '',
  document_ids   jsonb NOT NULL DEFAULT '[]'::jsonb,
  reviewer_id    text REFERENCES users(id) ON DELETE SET NULL,
  review_notes   text,
  submitted_at   timestamptz NOT NULL DEFAULT now(),
  reviewed_at    timestamptz,
  reverify_due_on date
);
CREATE INDEX IF NOT EXISTS vet_app_status_idx ON vet_applications (status, submitted_at DESC);
CREATE INDEX IF NOT EXISTS vet_app_vet_idx ON vet_applications (vet_user_id);

-- ─────────────────────────────────────────────────────────────
-- 4. Clinic associations: a verified vet links their profile to a
--    Google Place listing (or our own clinic record). Always reviewed.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clinic_associations (
  id            text PRIMARY KEY,
  vet_user_id   text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  clinic_id     text REFERENCES clinics(id) ON DELETE SET NULL,
  place_id      text NOT NULL,
  clinic_name   text NOT NULL DEFAULT '',
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'rejected')),
  evidence      text,
  reviewer_id   text REFERENCES users(id) ON DELETE SET NULL,
  review_notes  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  reviewed_at   timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS clinic_assoc_unique_idx
  ON clinic_associations (vet_user_id, place_id);
CREATE INDEX IF NOT EXISTS clinic_assoc_status_idx ON clinic_associations (status, created_at DESC);

-- ─────────────────────────────────────────────────────────────
-- 5. Appointment availability slots.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vet_slots (
  id             text PRIMARY KEY,
  vet_user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slot_date      date NOT NULL,
  start_time     text NOT NULL,
  end_time       text NOT NULL,
  consultation_type text NOT NULL DEFAULT 'in_person'
                CHECK (consultation_type IN ('in_person', 'video', 'chat')),
  status         text NOT NULL DEFAULT 'available'
                CHECK (status IN ('available', 'booked', 'blocked')),
  appointment_id text REFERENCES appointments(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS vet_slots_unique_idx
  ON vet_slots (vet_user_id, slot_date, start_time);
CREATE INDEX IF NOT EXISTS vet_slots_lookup_idx ON vet_slots (vet_user_id, slot_date, status);

-- ─────────────────────────────────────────────────────────────
-- 6. Maps API usage log for the admin dashboard.
--    Stores endpoint, status and latency only — never user location.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS maps_api_log (
  id          text PRIMARY KEY,
  endpoint    text NOT NULL,
  ok          boolean NOT NULL,
  http_status int,
  latency_ms  int,
  result_count int,
  error_code  text,
  actor_id    text REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS maps_log_recent_idx ON maps_api_log (created_at DESC);

-- ─────────────────────────────────────────────────────────────
-- 8. Appointments: slot-linked booking + rescheduled status.
-- ─────────────────────────────────────────────────────────────
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS slot_id text REFERENCES vet_slots(id) ON DELETE SET NULL;
ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_status_check;
ALTER TABLE appointments ADD CONSTRAINT appointments_status_check
  CHECK (status IN ('pending', 'accepted', 'rejected', 'completed', 'cancelled', 'rescheduled'));
-- One active booking per slot; enforced by the database.
CREATE UNIQUE INDEX IF NOT EXISTS appointments_slot_active_idx
  ON appointments (slot_id) WHERE slot_id IS NOT NULL AND status IN ('pending', 'accepted');

-- ─────────────────────────────────────────────────────────────
-- 7. Independent directory import jobs (government/OSM/vet-submitted).
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS directory_imports (
  id           text PRIMARY KEY,
  source_name  text NOT NULL,
  license_note text NOT NULL DEFAULT '',
  record_count int NOT NULL DEFAULT 0,
  accepted_count int NOT NULL DEFAULT 0,
  duplicate_count int NOT NULL DEFAULT 0,
  rejected_count int NOT NULL DEFAULT 0,
  status       text NOT NULL DEFAULT 'pending_review'
               CHECK (status IN ('pending_review', 'approved', 'rejected')),
  imported_by  text REFERENCES users(id) ON DELETE SET NULL,
  reviewed_by  text REFERENCES users(id) ON DELETE SET NULL,
  review_notes text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
