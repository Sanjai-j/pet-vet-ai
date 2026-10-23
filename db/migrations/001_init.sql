-- Pet Vet AI — core PostgreSQL schema
-- Compatible with PostgreSQL 14+ and PGlite (no extensions required).

CREATE TABLE IF NOT EXISTS users (
  id                 text PRIMARY KEY,
  email              text NOT NULL,
  password_hash      text NOT NULL,
  full_name          text NOT NULL,
  role               text NOT NULL CHECK (role IN ('owner', 'vet', 'admin')),
  phone              text,
  city               text,
  state              text,
  notification_prefs jsonb NOT NULL DEFAULT '{"feeding":false,"grooming":false,"vaccination":false,"email":false,"push":false,"inApp":true}'::jsonb,
  privacy            jsonb NOT NULL DEFAULT '{"shareRecordsWithVet":true,"allowAiTraining":false}'::jsonb,
  disabled           boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));

CREATE TABLE IF NOT EXISTS species (
  code        text PRIMARY KEY,
  name        text NOT NULL,
  category    text NOT NULL CHECK (category IN ('companion', 'poultry', 'farm', 'other')),
  icon        text NOT NULL DEFAULT '🐾',
  description text NOT NULL DEFAULT '',
  is_active   boolean NOT NULL DEFAULT true,
  sort_order  int NOT NULL DEFAULT 100
);

CREATE TABLE IF NOT EXISTS breeds (
  id            text PRIMARY KEY,
  species_code  text NOT NULL REFERENCES species(code) ON DELETE CASCADE,
  name          text NOT NULL,
  notes         text,
  is_unknown    boolean NOT NULL DEFAULT false,
  is_active     boolean NOT NULL DEFAULT true,
  sort_order    int NOT NULL DEFAULT 100
);
CREATE UNIQUE INDEX IF NOT EXISTS breeds_species_name_idx ON breeds (species_code, lower(name));
CREATE INDEX IF NOT EXISTS breeds_species_idx ON breeds (species_code, sort_order);

CREATE TABLE IF NOT EXISTS vet_profiles (
  user_id             text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  license_number      text NOT NULL,
  council             text NOT NULL,
  experience_years    int CHECK (experience_years >= 0),
  bio                 text,
  clinic_name         text,
  clinic_address      text,
  city                text,
  state               text,
  pincode             text,
  latitude            double precision,
  longitude           double precision,
  specialties         text[] NOT NULL DEFAULT '{}',
  species             text[] NOT NULL DEFAULT '{}',
  availability        jsonb NOT NULL DEFAULT '{}'::jsonb,
  consultation_fee_inr int CHECK (consultation_fee_inr >= 0),
  verification_status text NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending', 'verified', 'rejected')),
  verification_notes  text,
  verified_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS vet_license_idx ON vet_profiles (lower(license_number));
CREATE INDEX IF NOT EXISTS vet_status_idx ON vet_profiles (verification_status);

CREATE TABLE IF NOT EXISTS pets (
  id                       text PRIMARY KEY,
  owner_id                 text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                     text NOT NULL,
  species_code             text NOT NULL REFERENCES species(code),
  breed_id                 text REFERENCES breeds(id),
  custom_breed             text,
  birth_date               date,
  age_estimate_months      int CHECK (age_estimate_months >= 0 AND age_estimate_months <= 600),
  sex                      text CHECK (sex IN ('male', 'female', 'unknown')),
  weight_kg                numeric(6,2) CHECK (weight_kg > 0 AND weight_kg < 1500),
  weight_measured_on       date,
  activity_level           text CHECK (activity_level IN ('low', 'moderate', 'high', 'unknown')),
  living_environment       text,
  lifestyle                text,
  feeding_notes            text,
  food_preferences         text,
  dietary_restrictions     text,
  allergies                text,
  conditions               text,
  medications              text,
  last_grooming_on         date,
  current_vet_name         text,
  current_vet_clinic       text,
  photo_file_id            text,
  is_household_pet         boolean,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pets_owner_idx ON pets (owner_id);
CREATE INDEX IF NOT EXISTS pets_species_idx ON pets (species_code);

CREATE TABLE IF NOT EXISTS vaccinations (
  id                 text PRIMARY KEY,
  pet_id             text NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  vaccine_name       text NOT NULL,
  administered_on    date,
  next_due_on        date,
  batch_number       text,
  notes              text,
  source             text NOT NULL DEFAULT 'owner_reported' CHECK (source IN ('owner_reported', 'vet_recorded', 'demo')),
  recorded_by        text REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vaccinations_pet_idx ON vaccinations (pet_id, administered_on DESC);

CREATE TABLE IF NOT EXISTS care_tasks (
  id            text PRIMARY KEY,
  pet_id        text NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  type          text NOT NULL CHECK (type IN ('feeding', 'water', 'grooming', 'medication', 'walk', 'vaccination', 'observation', 'other')),
  title         text NOT NULL,
  instructions  text,
  frequency     text NOT NULL DEFAULT 'daily' CHECK (frequency IN ('daily', 'weekly', 'monthly', 'once')),
  times         jsonb NOT NULL DEFAULT '[]'::jsonb,
  due_date      date,
  is_active     boolean NOT NULL DEFAULT true,
  created_by    text REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS care_tasks_pet_idx ON care_tasks (pet_id, is_active);

CREATE TABLE IF NOT EXISTS care_logs (
  id          text PRIMARY KEY,
  pet_id      text NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  task_id     text REFERENCES care_tasks(id) ON DELETE SET NULL,
  type        text NOT NULL,
  value       jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes       text,
  logged_by   text REFERENCES users(id),
  logged_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS care_logs_pet_idx ON care_logs (pet_id, logged_at DESC);

CREATE TABLE IF NOT EXISTS reminders (
  id           text PRIMARY KEY,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pet_id       text REFERENCES pets(id) ON DELETE CASCADE,
  task_id      text REFERENCES care_tasks(id) ON DELETE CASCADE,
  kind         text NOT NULL,
  title        text NOT NULL,
  scheduled_for timestamptz NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'cancelled', 'failed')),
  channel      text NOT NULL DEFAULT 'in_app',
  dedupe_key   text NOT NULL,
  sent_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS reminders_dedupe_idx ON reminders (dedupe_key);
CREATE INDEX IF NOT EXISTS reminders_due_idx ON reminders (status, scheduled_for);

CREATE TABLE IF NOT EXISTS notifications (
  id         text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      text NOT NULL,
  body       text NOT NULL,
  kind       text NOT NULL DEFAULT 'info',
  link       text,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   text NOT NULL,
  keys       jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS push_endpoint_idx ON push_subscriptions (endpoint);

CREATE TABLE IF NOT EXISTS knowledge_documents (
  id            text PRIMARY KEY,
  title         text NOT NULL,
  species       text[] NOT NULL DEFAULT '{all}',
  category      text NOT NULL DEFAULT 'general',
  source_org    text NOT NULL,
  source_url    text,
  published_year int,
  content       text NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  is_demo       boolean NOT NULL DEFAULT false,
  submitted_by  text REFERENCES users(id),
  reviewed_by   text REFERENCES users(id),
  reviewed_at   timestamptz,
  review_notes  text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS knowledge_status_idx ON knowledge_documents (status, category);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id          text PRIMARY KEY,
  document_id text NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  chunk_index int NOT NULL,
  content     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chunks_doc_idx ON knowledge_chunks (document_id);

CREATE TABLE IF NOT EXISTS capability_registry (
  id               text PRIMARY KEY,
  species_code     text NOT NULL REFERENCES species(code) ON DELETE CASCADE,
  task             text NOT NULL,
  status           text NOT NULL CHECK (status IN ('validated', 'limited', 'not_supported')),
  evidence_summary text NOT NULL,
  evaluation_notes text,
  updated_by       text REFERENCES users(id),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS capability_unique_idx ON capability_registry (species_code, task);

CREATE TABLE IF NOT EXISTS food_items (
  id           text PRIMARY KEY,
  name         text NOT NULL,
  species_code text NOT NULL REFERENCES species(code),
  safety       text NOT NULL CHECK (safety IN ('safe', 'caution', 'toxic', 'unknown')),
  notes        text NOT NULL,
  source_note  text,
  is_demo      boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX IF NOT EXISTS food_unique_idx ON food_items (species_code, lower(name));
CREATE INDEX IF NOT EXISTS food_name_idx ON food_items (lower(name));

CREATE TABLE IF NOT EXISTS clinics (
  id         text PRIMARY KEY,
  name       text NOT NULL,
  address    text NOT NULL,
  city       text NOT NULL,
  state      text NOT NULL,
  pincode    text,
  latitude   double precision NOT NULL,
  longitude  double precision NOT NULL,
  phone      text,
  services   text[] NOT NULL DEFAULT '{}',
  hours      text,
  is_demo    boolean NOT NULL DEFAULT true,
  is_24x7    boolean NOT NULL DEFAULT false,
  verified   boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS clinics_city_idx ON clinics (lower(city));

CREATE TABLE IF NOT EXISTS appointments (
  id            text PRIMARY KEY,
  owner_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vet_id        text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pet_id        text NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  scheduled_for timestamptz NOT NULL,
  mode          text NOT NULL DEFAULT 'in_person' CHECK (mode IN ('in_person', 'video')),
  reason        text NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'completed', 'cancelled')),
  response_note text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS appointments_owner_idx ON appointments (owner_id, scheduled_for DESC);
CREATE INDEX IF NOT EXISTS appointments_vet_idx ON appointments (vet_id, scheduled_for DESC);

CREATE TABLE IF NOT EXISTS consultation_notes (
  id             text PRIMARY KEY,
  appointment_id text NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  vet_id         text NOT NULL REFERENCES users(id),
  notes          text NOT NULL,
  care_plan      text,
  follow_up_on   date,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS consult_notes_idx ON consultation_notes (appointment_id);

CREATE TABLE IF NOT EXISTS threads (
  id             text PRIMARY KEY,
  owner_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vet_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pet_id         text NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  appointment_id text REFERENCES appointments(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS thread_unique_idx ON threads (owner_id, vet_id, pet_id);

CREATE TABLE IF NOT EXISTS messages (
  id         text PRIMARY KEY,
  thread_id  text NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  sender_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       text NOT NULL,
  file_id    text,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_thread_idx ON messages (thread_id, created_at);

CREATE TABLE IF NOT EXISTS files (
  id            text PRIMARY KEY,
  owner_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pet_id        text REFERENCES pets(id) ON DELETE SET NULL,
  original_name text NOT NULL,
  stored_name   text NOT NULL,
  mime          text NOT NULL,
  size          int NOT NULL,
  purpose       text NOT NULL DEFAULT 'record' CHECK (purpose IN ('pet_photo', 'record', 'chat', 'avatar', 'credential')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS files_owner_idx ON files (owner_id);

CREATE TABLE IF NOT EXISTS ai_conversations (
  id           text PRIMARY KEY,
  owner_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pet_id       text REFERENCES pets(id) ON DELETE SET NULL,
  species_code text,
  title        text NOT NULL DEFAULT 'New conversation',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_conv_owner_idx ON ai_conversations (owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_messages (
  id                text PRIMARY KEY,
  conversation_id   text NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  role              text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content           text NOT NULL,
  citations         jsonb NOT NULL DEFAULT '[]'::jsonb,
  emergency         boolean NOT NULL DEFAULT false,
  capability_status text,
  is_demo           boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_messages_conv_idx ON ai_messages (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS ai_evaluation_runs (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  capability  text NOT NULL,
  dataset_size int NOT NULL,
  passed      int NOT NULL,
  failed      int NOT NULL,
  cases       jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by  text REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS content_reports (
  id          text PRIMARY KEY,
  reporter_id text REFERENCES users(id) ON DELETE SET NULL,
  target_type text NOT NULL,
  target_id   text NOT NULL,
  reason      text NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  resolution  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by text REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id         text PRIMARY KEY,
  actor_id   text REFERENCES users(id) ON DELETE SET NULL,
  action     text NOT NULL,
  entity     text NOT NULL,
  entity_id  text,
  meta       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_created_idx ON audit_logs (created_at DESC);
