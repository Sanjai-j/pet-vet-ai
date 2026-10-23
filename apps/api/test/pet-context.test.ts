import { test } from 'node:test';
import assert from 'node:assert/strict';

// Pure functions only; no database is opened by this file.
process.env.DATABASE_URL = '';

import {
  recordPromptBlock,
  relevantRecordLines,
  type PetRecordFacts,
} from '../src/services/pet-context.js';

function facts(overrides: Partial<PetRecordFacts> = {}): PetRecordFacts {
  return {
    petId: 'pet_test',
    name: 'Bruno',
    speciesCode: 'dog',
    profile: ['Dog · Labrador Retriever · male · about 4 years old (born 2022-08-01)', 'Weight 28.4 kg'],
    medical: ['Recorded conditions: hip stiffness'],
    vaccinations: ['Rabies — given 2025-11-04, next due 2026-11-04 (owner-reported)'],
    checkpoints: ['Rabies — 2026-11-04 (in 30 days, pending)'],
    care: ['Today (2026-10-23): 1 of 3 care task(s) done — Breakfast 07:30 ✓, Dinner 19:00'],
    weight: ['28.1 kg on 2026-10-02'],
    appointments: ['2026-11-02 16:30 — video consult, accepted, with Dr. Arjun'],
    hasRecords: true,
    ...overrides,
  };
}

test('the record prompt block labels itself as facts, not evidence', () => {
  const block = recordPromptBlock(facts());
  assert.match(block, /Pet record from the owner's account \(Bruno\)/);
  assert.match(block, /factual data, not clinical evidence/i);
  assert.match(block, /Vaccination records:\n- Rabies — given 2025-11-04/);
  assert.match(block, /Appointments:\n- 2026-11-02 16:30/);
});

test('the prompt block stays bounded even with a long record', () => {
  const long = facts({
    vaccinations: Array.from({ length: 40 }, (_, i) => `Vaccine ${i} — given 2025-01-01, next due 2026-01-01`),
  });
  assert.ok(recordPromptBlock(long).length <= 2400);
});

test('only the topics a question is about are pulled from the record', () => {
  const vaccine = relevantRecordLines(facts(), "When is Bruno's rabies booster due?");
  assert.ok(vaccine.some((line) => line.includes('Rabies')));
  assert.ok(!vaccine.some((line) => line.includes('kg on')), 'weight lines stay out of a vaccine question');

  const appointment = relevantRecordLines(facts(), 'When is my next appointment with the vet?');
  assert.ok(appointment.some((line) => line.includes('video consult')));
  assert.ok(!appointment.some((line) => line.includes('Vaccination records')));

  const unrelated = relevantRecordLines(facts(), 'He keeps scratching his ear');
  assert.deepEqual(unrelated, [], 'an unrelated symptom question is not padded with record data');
});

test('record lines are capped so an answer stays readable', () => {
  const many = facts({
    profile: Array.from({ length: 10 }, (_, i) => `profile ${i}`),
    vaccinations: Array.from({ length: 10 }, (_, i) => `vaccine ${i}`),
  });
  assert.ok(relevantRecordLines(many, 'vaccinations and records').length <= 6);
});
