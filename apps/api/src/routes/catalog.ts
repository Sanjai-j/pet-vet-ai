import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, parse } from '../errors.js';
import { many, one } from '../db.js';

export const catalogRouter = Router();

catalogRouter.get(
  '/species',
  asyncHandler(async (_req, res) => {
    const species = await many(
      `SELECT s.code, s.name, s.category, s.icon, s.description,
              (SELECT count(*)::int FROM breeds b WHERE b.species_code = s.code AND b.is_active) AS "breedCount"
       FROM species s WHERE s.is_active = true ORDER BY s.sort_order, s.name`,
    );
    res.json({ species });
  }),
);

catalogRouter.get(
  '/species/:code/breeds',
  asyncHandler(async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const rows = await many(
      `SELECT id, species_code AS "speciesCode", name, notes, is_unknown AS "isUnknown"
       FROM breeds
       WHERE species_code = $1 AND is_active = true
         AND ($2 = '' OR name ILIKE '%' || $2 || '%')
       ORDER BY is_unknown ASC, sort_order, name`,
      [req.params.code, q],
    );
    res.json({ breeds: rows });
  }),
);

catalogRouter.get(
  '/capabilities',
  asyncHandler(async (req, res) => {
    const species = typeof req.query.species === 'string' ? req.query.species : '';
    const rows = await many(
      `SELECT c.id, c.species_code AS "speciesCode", s.name AS "speciesName", c.task,
              c.status, c.evidence_summary AS "evidenceSummary",
              c.evaluation_notes AS "evaluationNotes", c.updated_at AS "updatedAt"
       FROM capability_registry c JOIN species s ON s.code = c.species_code
       WHERE ($1 = '' OR c.species_code = $1)
       ORDER BY s.sort_order, c.task`,
      [species],
    );
    res.json({ capabilities: rows });
  }),
);

catalogRouter.get(
  '/food-safety',
  asyncHandler(async (req, res) => {
    const schema = z.object({
      species: z.enum(['dog', 'cat', 'bird', 'cow', 'goat', 'other']).default('dog'),
      q: z.string().max(80).default(''),
    });
    const parsed = parse(schema, req.query);
    const species = parsed.species ?? 'dog';
    const q = (parsed.q ?? '').trim();
    if (!q) {
      res.json({ species, matches: [], note: 'Search for a food to see its safety status.' });
      return;
    }
    const matches = await many(
      `SELECT id, name, species_code AS "speciesCode", safety, notes, source_note AS "sourceNote", is_demo AS "isDemo"
       FROM food_items
       WHERE species_code = $1 AND name ILIKE '%' || $2 || '%'
       ORDER BY name LIMIT 20`,
      [species, q],
    );
    if (!matches.length) {
      const speciesHasTable = await one<{ n: number }>(
        'SELECT count(*)::int AS n FROM food_items WHERE species_code = $1',
        [species],
      );
      res.json({
        species,
        matches: [],
        coverageKnown: Number(speciesHasTable?.n ?? 0) > 0,
        note: 'This food is not in the curated demo dataset. "Not listed" does not mean safe — check with a veterinarian before feeding it.',
      });
      return;
    }
    res.json({
      species,
      matches,
      note: 'Demo dataset based on general veterinary consensus. It is not a complete toxicity reference and does not account for amount eaten.',
    });
  }),
);
