import { getDb, many, one } from '../db.js';
import { chunkText } from '../util.js';
import { tokenize, type RetrievedSource } from './retrieval.js';

/**
 * RAG bridge for the nutrition knowledge base (workbook requirement 14):
 * the workbook is a structured RETRIEVAL source, never fine-tuning data.
 *
 * When a nutrition record is approved, its content is mirrored into
 * knowledge_documents/knowledge_chunks (category "nutrition") so the
 * existing AI-chat retrieval pipeline — which only reads approved
 * documents — can cite it. Rejection or re-queueing removes the mirror.
 */

export type NutritionRecordKind =
  | 'guidance' | 'hazard' | 'recipe' | 'breed' | 'health_rule' | 'source';

export async function syncNutritionRagMirror(
  kind: NutritionRecordKind,
  id: string,
  status: 'approved' | 'rejected' | 'pending',
): Promise<void> {
  const db = await getDb();
  const docId = `nut_${kind}_${id}`;
  await db.query('DELETE FROM knowledge_chunks WHERE document_id = $1', [docId]);
  if (status !== 'approved') {
    await db.query('DELETE FROM knowledge_documents WHERE id = $1', [docId]);
    return;
  }

  const table = {
    guidance: 'nutrition_guidance', hazard: 'nutrition_hazards', recipe: 'nutrition_recipes',
    breed: 'nutrition_breed_guidance', health_rule: 'nutrition_health_rules',
    source: 'nutrition_sources',
  }[kind];
  const rec = await one<Record<string, unknown>>(
    `SELECT * FROM ${table} WHERE id = $1`, [id],
  );
  if (!rec) return;

  const species: string[] = kind === 'hazard'
    ? ((rec.species_codes as string[]) ?? [])
    : rec.species_code ? [rec.species_code as string] : ['all'];
  const pgSpecies = `{${species.map((s) => `"${s}"`).join(',')}}`;
  const sourceUrl = (rec.source_url as string | null) ?? (rec.url as string | null) ?? null;

  let title = '';
  let content = '';
  if (kind === 'guidance') {
    title = `Nutrition — ${rec.species_code} ${rec.breed_or_type ?? ''} ${rec.life_stage} · ${rec.nutrition_goal}`;
    content = [
      `Species: ${rec.species_code}. Life stage: ${rec.life_stage}. Goal: ${rec.nutrition_goal}.`,
      rec.breed_or_type ? `Breed context: ${rec.breed_or_type}.` : '',
      `General diet guidance: ${rec.general_diet_guidance}`,
      `Suitable foods: ${rec.suitable_foods_text}`,
      `Foods/hazards to avoid: ${rec.hazards_to_avoid_text}`,
      `Preparation guidance: ${rec.recipe_guidance_text}`,
      `Goal-specific guidance: ${rec.goal_specific_guidance}`,
      `Safety cautions: ${rec.safety_cautions}`,
      `Individualization: ${rec.individualization_factors}`,
      `Disclaimer: ${rec.disclaimer}`,
    ].filter(Boolean).join('\n\n');
  } else if (kind === 'hazard') {
    title = `Food hazard (${(rec.species_codes as string[]).join('/')}) — ${rec.food_or_substance}`;
    content = [
      `Classification: ${rec.classification} (severity: ${rec.severity}).`,
      `Risk: ${rec.risk}`,
      `Recommended action: ${rec.recommended_action}`,
      'If this food has been eaten, contact a veterinarian promptly; do not wait for symptoms.',
    ].join('\n\n');
  } else if (kind === 'recipe') {
    title = `Nutrition recipe (${rec.species_code}) — ${rec.recipe_name} (${rec.diet_role})`;
    content = [
      `Diet role: ${rec.diet_role}. Treat or supplementary food only; never a complete diet unless nutritional adequacy is validated.`,
      `Applicability: ${rec.applicability}`,
      `Ingredients: ${(rec.ingredients as string[]).join('; ')}`,
      `Steps: ${(rec.steps as string[]).join(' ')}`,
      `Safety notes: ${rec.safety_notes}`,
    ].join('\n\n');
  } else if (kind === 'breed') {
    title = `Nutrition breed context (${rec.species_code}) — ${rec.breed_or_type} · ${rec.life_stage}`;
    content = [
      `Guidance: ${rec.general_guidance}`,
      `Limitation: ${rec.limitation}`,
      `Referral rule: ${rec.referral_rule}`,
      'Breed is context only and cannot by itself determine portions, allergy status or a therapeutic diet.',
    ].join('\n\n');
  } else if (kind === 'health_rule') {
    title = `Nutrition health rule — ${rec.condition_or_goal}`;
    content = [
      `Guidance: ${rec.general_guidance}`,
      `Safety rule: ${rec.safety_rule}`,
      `Referral rule: ${rec.referral_rule}`,
    ].join('\n\n');
  } else {
    return; // sources are metadata, not retrievable content
  }

  await db.query(
    `INSERT INTO knowledge_documents (id, title, species, category, source_org, source_url, content, status, is_demo)
     VALUES ($1,$2,$3::text[],'nutrition',$4,$5,$6,'approved',$7)
     ON CONFLICT (id) DO UPDATE SET
       title = excluded.title, species = excluded.species, source_org = excluded.source_org,
       source_url = excluded.source_url, content = excluded.content, status = excluded.status`,
    [docId, title.slice(0, 200), pgSpecies,
     'Pet Vet AI nutrition workbook (administrator-reviewed)',
     sourceUrl, content, Boolean(rec.is_demo)],
  );
  const chunks = chunkText(content);
  for (let i = 0; i < chunks.length; i++) {
    await db.query(
      'INSERT INTO knowledge_chunks (id, document_id, chunk_index, content) VALUES ($1,$2,$3,$4)',
      [crypto.randomUUID(), docId, i, chunks[i]],
    );
  }
}

/**
 * Structured nutrition retrieval for the AI chat pipeline.
 *
 * The mirrored chunks (above) are found by lexical search like any other
 * knowledge document. This function adds what lexical search cannot do:
 * filter the approved nutrition tables by the pet's species, life stage and
 * recorded conditions, then rank by token overlap with the question. It
 * returns the same RetrievedSource shape so callers can merge and dedupe.
 *
 * Only `review_status = 'approved'` rows are read — pending workbook rows are
 * invisible here exactly as they are in the mirror.
 */
export interface NutritionChatPet {
  speciesCode: string;
  breedName?: string | null;
  ageEstimateMonths?: number | null;
  conditions?: string | null;
}

function scoreTokens(queryTokens: string[], textTokens: string[]): number {
  if (!queryTokens.length) return 0;
  const counts = new Map<string, number>();
  for (const t of textTokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  let hits = 0;
  for (const q of queryTokens) if (counts.has(q)) hits++;
  return hits / queryTokens.length;
}

export async function retrieveNutritionForChat(
  pet: NutritionChatPet,
  message: string,
  limit = 3,
): Promise<RetrievedSource[]> {
  const queryTokens = tokenize(message);
  if (!queryTokens.length) return [];

  const conditionTokens = tokenize(pet.conditions ?? '');
  const months = pet.ageEstimateMonths ?? null;
  // Life stage gates guidance rows; unknown age falls back to 'all' rows only.
  const stage = months === null
    ? 'unknown'
    : months < 12 ? 'young'
    : months >= ({ dog: 84, cat: 132, bird: 120, cow: 96, goat: 72 }[pet.speciesCode] ?? 96) ? 'senior'
    : 'adult';

  const [hazards, guidance, rules] = await Promise.all([
    many<{
      id: string; food: string; classification: string; severity: string; risk: string;
      action: string; sourceUrl: string | null; isDemo: boolean;
    }>(
      `SELECT h.id, h.food_or_substance AS food, h.classification, h.severity,
              h.risk, h.recommended_action AS action,
              s.url AS "sourceUrl", h.is_demo AS "isDemo"
       FROM nutrition_hazards h
       LEFT JOIN nutrition_sources s ON s.id = h.source_id AND s.review_status = 'approved'
       WHERE h.review_status = 'approved'
         AND ($1 = ANY(h.species_codes) OR 'other' = ANY(h.species_codes))
       ORDER BY CASE h.severity
         WHEN 'toxic' THEN 0 WHEN 'dangerous' THEN 1 WHEN 'potentially_toxic' THEN 2
         WHEN 'caution' THEN 3 ELSE 4 END
       LIMIT 200`,
      [pet.speciesCode],
    ),
    many<{
      id: string; goal: string; general: string; suitable: string; avoid: string;
      cautions: string; lifeStage: string; sourceUrl: string | null; isDemo: boolean;
    }>(
      `SELECT g.id, g.nutrition_goal AS goal, g.general_diet_guidance AS general,
              g.suitable_foods_text AS suitable, g.hazards_to_avoid_text AS avoid,
              g.safety_cautions AS cautions, g.life_stage AS "lifeStage",
              s.url AS "sourceUrl", g.is_demo AS "isDemo"
       FROM nutrition_guidance g
       LEFT JOIN nutrition_sources s ON s.id = g.source_id AND s.review_status = 'approved'
       WHERE g.review_status = 'approved' AND g.species_code = $1
         AND (g.breed_or_type IS NULL OR lower(g.breed_or_type) = lower($2))
         AND (g.life_stage = 'all' OR g.life_stage = $3)
       LIMIT 200`,
      [pet.speciesCode, pet.breedName ?? null, stage],
    ),
    many<{
      id: string; condition: string; keywords: string[]; guidance: string;
      safety: string; referral: string; isDemo: boolean;
    }>(
      `SELECT id, condition_or_goal AS condition, keywords,
              general_guidance AS guidance, safety_rule AS safety,
              referral_rule AS referral, is_demo AS "isDemo"
       FROM nutrition_health_rules
       WHERE review_status = 'approved'`,
    ),
  ]);

  const out: RetrievedSource[] = [];

  for (const h of hazards) {
    const textTokens = tokenize(`${h.food} ${h.classification} ${h.risk} ${h.action}`);
    const score = scoreTokens(queryTokens, textTokens);
    if (score === 0) continue;
    out.push({
      documentId: `nut_hazard_${h.id}`,
      chunkId: `nut_hazard_${h.id}_0`,
      title: `Food hazard (${pet.speciesCode}) — ${h.food}`,
      sourceOrg: 'Pet Vet AI nutrition workbook (administrator-reviewed)',
      sourceUrl: h.sourceUrl,
      isDemo: h.isDemo,
      category: 'nutrition',
      snippet: `Classification: ${h.classification} (severity: ${h.severity}). ${h.risk} Action: ${h.action}`,
      score: Number((score * 2).toFixed(4)),
    });
  }

  for (const g of guidance) {
    const textTokens = tokenize(`${g.goal} ${g.general} ${g.suitable} ${g.avoid} ${g.cautions}`);
    const score = scoreTokens(queryTokens, textTokens);
    if (score === 0) continue;
    out.push({
      documentId: `nut_guidance_${g.id}`,
      chunkId: `nut_guidance_${g.id}_0`,
      title: `Nutrition guidance (${pet.speciesCode}${g.lifeStage !== 'all' ? `, ${g.lifeStage}` : ''}) — ${g.goal}`,
      sourceOrg: 'Pet Vet AI nutrition workbook (administrator-reviewed)',
      sourceUrl: g.sourceUrl,
      isDemo: g.isDemo,
      category: 'nutrition',
      snippet: `${g.general} Suitable foods: ${g.suitable} Avoid: ${g.avoid}`,
      score: Number(score.toFixed(4)),
    });
  }

  // Health rules match on the pet's recorded conditions, not the question text:
  // a rule applies because of who the animal is, not what was asked.
  for (const r of rules) {
    const matched = (r.keywords ?? []).filter((k) =>
      conditionTokens.includes(k.toLowerCase()) || (pet.conditions ?? '').toLowerCase().includes(k.toLowerCase()),
    );
    if (!matched.length) continue;
    out.push({
      documentId: `nut_health_rule_${r.id}`,
      chunkId: `nut_health_rule_${r.id}_0`,
      title: `Nutrition rule for recorded condition — ${r.condition}`,
      sourceOrg: 'Pet Vet AI nutrition workbook (administrator-reviewed)',
      sourceUrl: null,
      isDemo: r.isDemo,
      category: 'nutrition',
      snippet: `Applies to ${matched.join(', ')} on this pet. ${r.guidance} Safety rule: ${r.safety}`,
      score: 1.5,
    });
  }

  return out
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
