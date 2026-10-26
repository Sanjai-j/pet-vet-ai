export interface EmergencyRule {
  id: string;
  species: string[];
  label: string;
  /** Keyword trigger. Used for the counterfactual window; skipped when `test` is set. */
  pattern?: RegExp;
  /**
   * Rule-specific matcher for a family of phrasings that one regex would
   * either miss or over-match. Returns the index of the trigger so the
   * counterfactual check still knows where the claim sits, or null when the
   * message does not report this sign.
   */
  test?: (text: string) => number | null;
  advice: string;
}

/* ── Refusing food or water ─────────────────────────────────────────────
 *
 * This is a family of phrasings rather than a phrase. "Not eating",
 * "hasn't eaten since yesterday", "refused to eat for 1 day", "refused
 * food", "not drinking" and the terse follow-up "refused for 1 day" all
 * report the same sign, and the old single regex caught only the first two
 * shapes. A live conversation showed the cost: turn one ("not eating for
 * days") raised the red flag, turn two ("refused for 1 day") did not, so the
 * urgent instruction silently disappeared from a worsening case.
 *
 * The parser is deliberately narrow in the other direction too: "refused to
 * walk for a day" and "refused the carrier" are not appetite reports, and a
 * duration only counts as an appetite report when nothing else sits between
 * the verb and the duration.
 */

/** Verbs that can introduce a reduction in intake. */
const INTAKE_VERB =
  /\b(?:refus\w*|reject\w*|declin\w*|stopped|quit|won.?t|will not|isn.?t|is not|hasn.?t|has not|hadn.?t|had not|not|unable to|can.?t|cannot|barely|hardly)\b/;

/** What an intake report is about: food, water, or the act of eating/drinking. */
const INTAKE_OBJECT =
  /\b(?:eat|eats|eating|eaten|ate|food|foods|meal|meals|kibble|water|drink|drinks|drinking|drunk|drank|bowl|dinner|breakfast|lunch|treat|treats|appetite|nibble|nibbles|nibbling|nibbled)\b/;

/** A duration turns a bare "refused" into a report of how long it has lasted. */
const DURATION =
  /\b(?:for|since|over)\s+(?:\d+|a|an|one|two|three|four|five|six|seven|several|many|couple of|few|past|last)\s*(?:hours?|hrs?|days?|nights?|d)\b|\bsince\s+(?:yesterday|last night|this morning|last week|yesterday morning|yesterday evening)\b/;

/** "refused to walk", "refused to go out" — refusal about something else. */
const OTHER_ACTION =
  /^\s*(?:to\s+)?(?:go|walk|play|come|take|leave|sleep|sit|stand|move|jump|run|be\s+(?:handled|picked|touched))\b/;

/** Statements that need no verb analysis at all. */
const EXPLICIT_NO_INTAKE =
  /\b(?:no appetite|anorexia|anorexic|off (?:his|her|its|their) food|(?:ate|eaten|had) nothing|nothing (?:to eat|eaten)|has had no (?:food|water)|have had no (?:food|water)|won.?t touch (?:his|her|its|their|the)? ?(?:food|water)|not eating (?:at all|anything)|stopped eating entirely)\b/;

/** Words allowed between the verb and a duration when no food word is present. */
const DURATION_GAP = /^\s*(?:it|them|all|any|his|her|its|their|the|anything)?\s*$/;

export function appetiteReportIndex(text: string): number | null {
  const explicit = EXPLICIT_NO_INTAKE.exec(text);
  if (explicit) return explicit.index;

  const verb = INTAKE_VERB.exec(text);
  if (!verb) return null;
  const after = text.slice(verb.index + verb[0].length, verb.index + verb[0].length + 90);
  const clause = after.split(/[.!?;]/)[0] ?? '';
  if (OTHER_ACTION.test(clause)) return null;
  if (INTAKE_OBJECT.test(clause)) return verb.index;
  const duration = DURATION.exec(clause);
  // "refused for 1 day" is an appetite report only when nothing sits between
  // the verb and the duration — "refused the carrier for 1 day" is not.
  if (duration && DURATION_GAP.test(clause.slice(0, duration.index))) return verb.index;
  return null;
}

/**
 * Deterministic safety layer. These rules escalate to urgent veterinary care.
 * They are intentionally conservative and never produce a diagnosis or a dose.
 */
const RULES: EmergencyRule[] = [
  {
    id: 'chocolate',
    species: ['dog', 'cat'],
    label: 'Possible chocolate exposure',
    pattern: /chocolat|cocoa|cacao/i,
    advice: 'Chocolate can be dangerous, especially dark chocolate or cocoa. Contact a veterinarian or emergency hospital now with the product type and estimated amount. Do not wait for symptoms.',
  },
  {
    id: 'xylitol',
    species: ['dog'],
    label: 'Possible xylitol exposure',
    pattern: /xylitol|sugar[- ]?free (gum|mints|candy)|sugarless gum/i,
    advice: 'Xylitol can cause a rapid, dangerous drop in blood sugar and liver injury in dogs. Treat this as an emergency and contact a veterinarian immediately.',
  },
  {
    id: 'grapes',
    species: ['dog', 'cat'],
    label: 'Possible grape or raisin exposure',
    pattern: /grape|raisin|sultana/i,
    advice: 'Grapes and raisins can cause kidney injury. There is no reliable safe amount. Contact a veterinarian or emergency hospital now.',
  },
  {
    id: 'allium',
    species: ['dog', 'cat'],
    label: 'Possible onion or garlic exposure',
    pattern: /\bonion|\bgarlic|shallot|leek/i,
    advice: 'Onions, garlic and similar alliums can damage red blood cells, especially in cats and with larger or repeated exposures. Contact a veterinarian for advice.',
  },
  {
    id: 'poison',
    species: ['dog', 'cat', 'bird', 'cow', 'goat', 'other'],
    label: 'Possible poison or pesticide exposure',
    pattern: /rat poison|rodenticide|pesticide|insecticide|antifreeze|coolant|snail bait|poison(ed|ing)?/i,
    advice: 'Poisoning can worsen quickly. Keep the packaging, move the animal away from the source, and contact a veterinarian or emergency hospital immediately. Do not induce vomiting unless a veterinarian tells you to.',
  },
  {
    id: 'breathing',
    species: ['dog', 'cat', 'bird', 'cow', 'goat', 'other'],
    label: 'Breathing difficulty',
    pattern: /(can.?t|cannot|difficulty|trouble|struggling|hard) (to )?breath|open[- ]?mouth breath|gasping|blue (gums|tongue)|choking/i,
    advice: 'Difficulty breathing is an emergency. Keep the animal calm and minimally handled, avoid the heat, and go to a veterinarian or emergency hospital now.',
  },
  {
    id: 'collapse',
    species: ['dog', 'cat', 'bird', 'cow', 'goat', 'other'],
    label: 'Collapse, seizure or unconsciousness',
    pattern: /collaps|unconscious|seizure|convuls|fitting|can.?t stand|unable to stand|downer/i,
    advice: 'Collapse, seizures and inability to stand are emergencies. Protect the animal from injury, do not put anything in the mouth, and contact a veterinarian immediately.',
  },
  {
    id: 'heatstroke',
    species: ['dog', 'cat'],
    label: 'Possible heatstroke',
    pattern: /heat ?stroke|overheat|panting (heavily|excessively)|left in (a )?(car|vehicle)|hot car/i,
    advice: 'Heatstroke is life-threatening. Move the animal to shade, begin gentle cooling with cool water while arranging transport, and go to a veterinarian immediately. Do not use ice-cold water or force fluids.',
  },
  {
    id: 'bloat_dog',
    species: ['dog'],
    label: 'Possible bloat (GDV)',
    pattern: /bloat|swollen (belly|abdomen)|distended (belly|abdomen)|unproductive (vomit|retching)|dry heaving/i,
    advice: 'A swollen abdomen with unproductive retching can indicate a life-threatening stomach torsion. Do not wait — go to an emergency veterinary hospital now.',
  },
  {
    id: 'urinary_cat',
    species: ['cat'],
    label: 'Possible urinary blockage',
    pattern: /(straining|strain|crying|can.?t|cannot|unable).{0,40}(urinate|urinating|pee|peeing|piss)|no urine|blocked (bladder|urethra)|litter (box).{0,30}(nothing|no urine)/i,
    advice: 'A male cat straining or unable to urinate may have a blockage that can be fatal within a day. Go to a veterinarian or emergency hospital now.',
  },
  {
    id: 'bleeding',
    species: ['dog', 'cat', 'bird', 'cow', 'goat', 'other'],
    label: 'Significant bleeding',
    pattern: /bleeding (heavily|a lot|profusely|non-?stop|won.?t stop|won.t stop|still)|won.?t stop bleeding|hasn.?t stopped bleeding|blood loss|deep (cut|wound)|hit by (a )?(car|vehicle)|bleeding from a (broken )?(nail|claw|toe|paw|cut|wound)|broken (nail|claw).{0,30}bleed|(nail|claw|toe|paw|cut|wound).{0,30}bleeding/i,
    advice: 'Apply gentle pressure with a clean cloth if safe to do so, keep the animal warm, and go to a veterinarian immediately. Do not remove an object stuck in a wound.',
  },
  {
    id: 'vomiting',
    species: ['dog', 'cat', 'bird', 'cow', 'goat', 'other'],
    label: 'Persistent vomiting or vomiting with blood',
    // Reported events only. The bare word "vomit" used to fire this rule,
    // so "what should I watch for after vaccination? Vomiting?" escalated as
    // if the animal were already vomiting.
    pattern: /\b(?:vomited|is vomiting|was vomiting|keeps? vomiting|keep vomiting|has been vomiting|have been vomiting|started vomiting|vomiting (?:repeatedly|constantly|all (?:night|day)|every|since|for|with blood|after)|blood in (?:the )?vomit|coffee[- ]?ground (?:vomit|stool)|throwing up|threw up|puked|puking|barfed|barfing|can.?t keep (?:water|food|anything) down|cannot keep (?:water|food|anything) down)\b/i,
    advice: 'Repeated vomiting, vomit containing blood, or vomiting that will not settle can be serious and dehydrate small animals quickly. Do not give human medicines and do not induce vomiting. Contact a veterinarian today; go to an emergency hospital if the vomiting is repeated over hours, the vomit contains blood, or the animal also collapses, cannot stand, or has a painful, swollen belly.',
  },
  {
    id: 'rumen_bloat',
    species: ['cow', 'goat'],
    label: 'Possible rumen bloat',
    pattern: /bloat|swollen (left )?(flank|belly|abdomen)|distended (flank|belly|abdomen)|difficult (calving|kidding)|downer/i,
    advice: 'Bloat and difficult calving/kidding are emergencies in cattle and goats. Remove suspected feed and contact a large-animal veterinarian immediately. Do not attempt to puncture the abdomen.',
  },
  {
    id: 'bird_respiratory',
    species: ['bird'],
    label: 'Possible avian respiratory distress',
    pattern: /open[- ]?mouth breath|tail bob|breathing (hard|heavily)|sitting on (the )?cage floor|fluffed.{0,30}(floor|bottom)/i,
    advice: 'Birds mask illness until they are very unwell. Open-mouth breathing, tail bobbing or sitting fluffed on the cage floor needs prompt avian veterinary care. Keep the bird warm, quiet and away from fumes.',
  },
  {
    id: 'not_eating',
    species: ['dog', 'cat', 'bird', 'cow', 'goat'],
    label: 'Not eating or drinking',
    test: appetiteReportIndex,
    advice: 'A pet that stops eating or drinking can deteriorate quickly, especially cats, small birds and young animals. Contact a veterinarian the same day; do not force food or water.',
  },
];

export interface EmergencyMatch {
  ruleId: string;
  label: string;
  advice: string;
}

/**
 * What a genuinely relevant approved reference looks like for each red flag.
 *
 * Lexical retrieval matches words, not topics: "not eating for days" scored a
 * vomiting document (it contains "refusing food") and a diabetes nutrition
 * rule, and both were attached to an anorexia red flag as if the app had
 * decided on a cause. These patterns are tested against a reference's own
 * title and category, so a document qualifies only when it is *about* the red
 * flag, not when it happens to mention one of the words. A rule with no topic
 * here cites nothing rather than guessing.
 */
const REFERENCE_TOPIC: Record<string, RegExp> = {
  chocolate: /chocolat|xylitol|methylxanthine|toxicolog/i,
  xylitol: /xylitol|sugar[- ]?free|hypoglyc|insulin|toxicolog/i,
  grapes: /grape|raisin|sultana|kidney/i,
  allium: /onion|garlic|allium|an(a)?emia|red blood cell/i,
  poison: /poison|toxic|rodenticide|pesticide|antifreeze|toxicolog/i,
  breathing: /breath|respirat|choking|dyspn/i,
  collapse: /seizure|collapse|convuls|unconscious|neurolog/i,
  heatstroke: /heat ?stroke|hyperthermia|heat/i,
  bloat_dog: /bloat|torsion|gdv|stomach|abdomen/i,
  urinary_cat: /urin|bladder|urethra|blockage|obstruct|litter/i,
  bleeding: /bleed|wound|h(a)?emorrhage|cut|injur/i,
  vomiting: /vomit|gastro|digestive|regurgit|diarrh/i,
  rumen_bloat: /bloat|rumen|flank|calving|kidding/i,
  bird_respiratory: /bird|avian|respirat|breath|husbandry/i,
  // Appetite vocabulary only. "Feeding practice" and "diabetes" documents
  // are adjacent topics, not answers to why an animal has stopped eating.
  not_eating: /appetit|anorex|not eating|food refusal|refus\w* (?:food|to eat)|weight loss|dehydrat/i,
};

/** Never matches: an unknown rule must cite nothing rather than guess. */
const NO_MATCH = /$^/;

export function emergencyReferenceTopic(ruleId: string): RegExp {
  return REFERENCE_TOPIC[ruleId] ?? NO_MATCH;
}

/**
 * "What if my dog ate chocolate?" asks about a risk; "my dog ate chocolate"
 * reports an exposure. Only the second needs emergency instructions, and
 * treating the first as an incident trains owners to ignore the banner.
 *
 * A conditional is only counterfactual when the owner does not already
 * suspect it happened — "I'm not sure if my dog ate chocolate" is a real
 * possible exposure and must still escalate.
 */
const CONDITIONAL =
  /\bwhat if\b|\bif (?:my|the|he|she|it|they|your)\b[^.!?]{0,40}\b(?:eats?|ate|drinks?|drank|gets?|got|swallows?|swallowed|has|had)\b|\bwould (?:it|that|this) be\b|\bis it (?:safe|okay|ok|normal) (?:to|if)\b/i;
const KNOWN_OR_SUSPECTED = /\b(?:don'?t know|do not know|not sure|unsure|wonder\w*|whether|maybe|might have|possibly|i think|i suspect|think (?:he|she|it|they))\b/i;

/**
 * A general question about a hazard ("which foods are toxic?", "is chocolate
 * safe for cats?") is information-seeking, not a report that it happened.
 * Without this, every food-safety question opened with an emergency banner,
 * which is how real emergencies stop being noticed.
 *
 * Suppression is deliberately narrow: the message must be a question, must not
 * refer to the owner's own animal ("my", "our", "his", "her", "their", 's),
 * and must actually use hazard vocabulary. "Did he eat chocolate?" therefore
 * still escalates — the owner does not know, so neither do we.
 */
const ADVISORY = /\b(?:toxic|poisonous|dangerous|harmful|safe|unsafe|which foods?|what foods?|warning signs?|signs of|symptoms of|prevent)\b/i;
const QUESTION_OPENING = /^\s*(?:what|which|is|are|can|could|should|how|when|why|do|does|did|will|would)\b/i;
const OWN_ANIMAL = /\b(?:my|our|his|her|their)\b|'s\b/i;

function isCounterfactual(normalized: string, index: number, petName: string): boolean {
  const window = normalized.slice(Math.max(0, index - 90), index);
  if (CONDITIONAL.test(window) && !KNOWN_OR_SUSPECTED.test(window)) return true;
  // A question that names this pet ("is chocolate safe for Bruno to eat?")
  // is about a real animal in front of the owner, not a general query.
  if (petName.length >= 2 && normalized.includes(petName)) return false;
  const informational = QUESTION_OPENING.test(normalized) && !OWN_ANIMAL.test(normalized) && ADVISORY.test(normalized);
  return informational;
}

export function detectEmergency(
  text: string,
  speciesCode: string,
  petName?: string | null,
): EmergencyMatch | null {
  const normalized = text.toLowerCase();
  const name = (petName ?? '').trim().toLowerCase();
  for (const rule of RULES) {
    if (!rule.species.includes(speciesCode)) continue;
    const index = rule.test ? rule.test(normalized) : rule.pattern ? rule.pattern.exec(normalized)?.index : undefined;
    if (index === undefined || index === null) continue;
    if (isCounterfactual(normalized, index, name)) continue;
    return { ruleId: rule.id, label: rule.label, advice: rule.advice };
  }
  return null;
}

/* ── Conversation-level safety context ─────────────────────────────────
 *
 * The red-flag check is stateless by design — it only ever sees the message in
 * front of it — but an owner describes one problem over several turns. When
 * the previous assistant turn raised a red flag and the owner answers a
 * follow-up question about it, the concern is still the same concern, and an
 * answer that quietly drops back to "routine" is a downgrade nobody asked for.
 *
 * Only the immediately preceding assistant turn is consulted. Every emergency
 * reply repeats the banner, so a conversation that continues to describe the
 * same problem keeps the context without carrying it forever; one ordinary
 * answer ends it.
 */

export interface PriorEmergency extends EmergencyMatch {
  /** index in the history array of the assistant message that raised it */
  historyIndex: number;
}

/** The red flag raised by the last assistant turn, if it raised one. */
export function priorEmergencyFromHistory(
  history: Array<{ role: string; content: string }>,
): PriorEmergency | null {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]!.role !== 'assistant') continue;
    const banner = /^\s*⚠️[^\n:]*:\s*(.+)$/m.exec(history[i]!.content ?? '');
    if (!banner) return null;
    const label = banner[1]!.trim().toLowerCase();
    const rule = RULES.find((r) => r.label.toLowerCase() === label);
    if (!rule) return null;
    return { ruleId: rule.id, label: rule.label, advice: rule.advice, historyIndex: i };
  }
  return null;
}

/**
 * Signs the owner is describing the problem as over. Deliberately strict: a
 * message that still contains any negation keeps the red flag open, because
 * "not eating again" and "still refusing" read like recovery and mean the
 * opposite.
 */
const RESOLVED =
  /\b(?:is |has |'s )?(?:eating|drinking|ate|drank|feeding)\b[^.!?]{0,30}\b(?:again|normally|well|fine|properly)\b|\b(?:appetite|interest in food)\b[^.!?]{0,20}\b(?:is |came )?back\b|\bback to (?:normal|eating|himself|herself|itself)\b|\b(?:all better|feeling better|much better|improving|improved|recovered|perked up|out of danger|doing fine)\b|\b(?:saw|seen|visited|took (?:him|her|it|them) to|been to) (?:the )?(?:vet|veterinarian|veterinary|hospital|clinic)\b|\b(?:vet|veterinarian)\b[^.!?]{0,20}\b(?:said|says)\b[^.!?]{0,30}\b(?:fine|okay|ok|normal|nothing)\b/i;

const STILL_NEGATIVE = /n['’]t\b|\bnot\b|\bnever\b|\bstill\b|\brefus\w*|\bno appetite\b|\bworse|\bworsening\b|\bno (?:change|improvement)\b/;

export function riskLooksResolved(text: string): boolean {
  const normalized = text.toLowerCase();
  // "no longer refusing food" is a resolution even though it contains a negative.
  if (/\b(?:no longer|not any ?more|no more)\b[^.!?]{0,30}\b(?:refus\w*|a problem|an issue|worried|concerned|unwell)\b/.test(normalized)) {
    return true;
  }
  if (STILL_NEGATIVE.test(normalized)) return false;
  return RESOLVED.test(normalized);
}

export const emergencyRuleSummaries = RULES.map((r) => ({
  id: r.id,
  species: r.species,
  label: r.label,
}));
