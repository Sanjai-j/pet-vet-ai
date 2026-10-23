import { test } from 'node:test';
import assert from 'node:assert/strict';

// These are pure parsing helpers; no database is opened by this file.
process.env.DATABASE_URL = '';
process.env.PGLITE_DIR = '.data/test-pg-vaccine-unit';

import {
  addMonths,
  guidanceLevel,
  monthsBetween,
  parseBoosterMonths,
  parseFirstDoseDays,
  parseSeriesIntervalWeeks,
  seriesOffsets,
  vaccineKey,
} from '../src/services/vaccine-schedule.js';

test('first-dose age text is only turned into a number when an age is stated', () => {
  assert.equal(parseFirstDoseDays('6–8 weeks'), 42);
  assert.equal(parseFirstDoseDays('Often from 12 weeks / 3 months; minimum age depends on product'), 84);
  assert.equal(parseFirstDoseDays('From 4 months of age (NDDB schedule)'), 122);
  assert.equal(parseFirstDoseDays('Species-specific; no generic age/month schedule'), null);
  assert.equal(parseFirstDoseDays('Age and primary course depend on licensed product'), null);
});

test('primary series interval is read from the workbook wording', () => {
  const series = 'Repeat every 3–4 weeks until final puppy dose at ≥16 weeks (sometimes 18–20 weeks)';
  assert.equal(parseSeriesIntervalWeeks(series), 4);
  assert.deepEqual(seriesOffsets(42, '6–8 weeks', series), [42, 70, 98, 126]);
  assert.equal(parseSeriesIntervalWeeks('Product-specific'), null);
  assert.deepEqual(seriesOffsets(84, '12 weeks', 'Product-specific'), [84]);
});

test('booster intervals are only parsed when stated plainly', () => {
  assert.equal(parseBoosterMonths('Every 6 months per NDDB reference'), 6);
  assert.equal(parseBoosterMonths('Annually in endemic areas'), 12);
  assert.equal(parseBoosterMonths('1 year after the primary dose'), 12);
  // Prose that depends on a product or local rules must not be auto-scheduled.
  assert.equal(parseBoosterMonths('Commonly at 1 year after primary dose, then per product label/local rules'), null);
  assert.equal(parseBoosterMonths('Around 6 months after puppy series, then every 3 years'), null);
});

test('review status maps to a guidance level', () => {
  assert.equal(guidanceLevel('GENERAL GUIDANCE — VET CONFIRMATION REQUIRED'), 'general_guidance');
  assert.equal(guidanceLevel('VET DECISION REQUIRED'), 'vet_decision');
  assert.equal(guidanceLevel('LIVESTOCK VET / GOVERNMENT PROGRAMME CONFIRMATION'), 'programme_only');
  assert.equal(guidanceLevel('OFFICIAL PROGRAMME ONLY'), 'programme_only');
  assert.equal(guidanceLevel('AVIAN VET REVIEW REQUIRED'), 'avian_review');
});

test('vaccine keys ignore the parenthetical antigen list', () => {
  assert.equal(vaccineKey('Canine core combination (distemper, adenovirus, parvovirus)'), 'canine_core_combination');
  assert.equal(vaccineKey('Rabies'), 'rabies');
  assert.equal(vaccineKey('Haemorrhagic septicaemia (HS)'), 'haemorrhagic_septicaemia');
});

test('month arithmetic does not drift past the end of a month', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2025-12-15', 6), '2026-06-15');
  assert.equal(monthsBetween('2026-01-31', '2026-02-28'), 0);
  assert.equal(monthsBetween('2025-01-10', '2026-01-10'), 12);
});
