import type { EmergencyMatch } from './emergency.js';

/**
 * Safety layer for *generated* text.
 *
 * The deterministic composer in services/ai.ts only ever prints approved
 * snippets, so it cannot invent a dose. A language model can. These checks run
 * on the model's answer before it reaches the owner, and an answer that fails
 * is discarded in favour of the deterministic fallback rather than edited —
 * silently patching clinical text would leave an answer nobody reviewed.
 *
 * The checks are deliberately narrow. Each pattern is something a careless
 * model actually says ("give 5 mg per kg", "your dog has arthritis", "you can
 * induce vomiting with salt water"), not a general style rule. Anything that
 * cannot be judged by pattern is left to the citation requirement and the
 * system prompt.
 */

export type Urgency = 'routine' | 'prompt' | 'urgent' | 'emergency';

export const URGENCY_LABEL: Record<Urgency, string> = {
  routine: 'Routine',
  prompt: 'Prompt',
  urgent: 'Urgent',
  emergency: 'Emergency',
};

/** One sentence an owner can act on, matched to the urgency level. */
export const URGENCY_ACTION: Record<Urgency, string> = {
  routine: 'No red flag was detected in what you wrote. Keep watching for changes, and book a normal appointment if the signs persist.',
  prompt: 'Arrange a veterinary appointment within about 24 hours.',
  urgent: 'Contact a veterinarian today. Go to an emergency hospital if the animal worsens.',
  emergency: 'Contact a veterinarian or a 24×7 emergency hospital now.',
};

/**
 * Red-flag rules carry a level. A blocked urethra, bloat, breathing difficulty
 * or active bleeding can kill within hours; an eaten grape or chocolate is
 * serious but not measured in minutes; "not eating" usually needs same-day
 * care rather than an ambulance.
 */
const RULE_URGENCY: Record<string, Urgency> = {
  chocolate: 'urgent',
  xylitol: 'emergency',
  grapes: 'urgent',
  allium: 'prompt',
  poison: 'emergency',
  breathing: 'emergency',
  collapse: 'emergency',
  heatstroke: 'emergency',
  bloat_dog: 'emergency',
  urinary_cat: 'emergency',
  bleeding: 'emergency',
  vomiting: 'urgent',
  rumen_bloat: 'emergency',
  bird_respiratory: 'urgent',
  not_eating: 'prompt',
};

/** Unknown rules escalate rather than relax: a new rule defaults to urgent. */
export function urgencyForEmergency(match: EmergencyMatch): Urgency {
  return RULE_URGENCY[match.ruleId] ?? 'urgent';
}

export type IssueCode =
  | 'dosage'
  | 'prescription'
  | 'diagnosis'
  | 'examination_claim'
  | 'home_remedy'
  | 'false_reassurance'
  | 'missing_referral'
  | 'urgency_downgrade'
  | 'home_treatment';

export interface AnswerIssue {
  code: IssueCode;
  /** The offending fragment, truncated — for server logs only. */
  detail: string;
}

/**
 * A sentence that forbids something is not a recommendation. "Do not give
 * human tablets", "never induce vomiting unless a veterinarian tells you to"
 * and "only a veterinarian can prescribe this" are exactly what we want the
 * model to say, so matches inside them are ignored.
 */
const PROHIBITIVE =
  /\b(?:do not|don't|never|should not|shouldn't|must not|mustn't|avoid|not recommended|do NOT|won't|cannot|can't)\b|without (?:a )?veterinary|unless a veterinarian|only (?:a|your|under)|not (?:give|use|attempt)/i;

const AMOUNT =
  /\b\d+(?:\.\d+)?\s*(?:mg|mcg|µg|ug|ml|iu|units?|tablets?|capsules?|pills?|drops?)\b(?:\s*(?:\/|per)\s*kg)?/i;

const DRUG_NAMES =
  'paracetamol|acetaminophen|ibuprofen|diclofenac|aspirin|meloxicam|carprofen|prednisolone|prednisone|dexamethasone|amoxicillin|amoxicillin-clavulanate|clavulanate|metronidazole|doxycycline|enrofloxacin|cephalexin|ceftriaxone|azithromycin|tramadol|gabapentin|phenobarbital|insulin|ivermectin|praziquantel|albendazole|febantel|ondansetron|furosemide|metoclopramide|ketoconazole|itraconazole|chlorpheniramine|cetirizine|xylazine|ketamine|diazepam|alprazolam';

/**
 * Naming a drug is not the problem — telling the owner to give it is. A cited
 * reference may legitimately say xylitol "causes a rapid insulin release";
 * "give 1 ml of insulin" must never pass. So the drug name has to sit next to
 * an instruction, in either order.
 */
const DRUG_ADVICE = new RegExp(
  `\\b(?:give|giving|dose|dosing|administer|administering|prescribe|prescribing|start|starting|apply|put|take|use|using|mix|feeding)\\b[^.!?]{0,50}\\b(?:${DRUG_NAMES})\\b` +
    `|\\b(?:${DRUG_NAMES})\\b[^.!?]{0,50}\\b(?:\\d+\\s*(?:mg|ml|mcg|tablets?|capsules?)|dose|twice (?:a|daily)|once (?:a|daily)|every \\d+ hours)\\b`,
  'i',
);

const CONFIRMED_CONDITION =
  /\byour (?:pet|dog|cat|bird|puppy|kitten|animal)\b[^.!?]{0,30}\b(?:has|is suffering from|suffers from)\b[^.!?]{0,40}\b(?:a |an )?(?:condition|disease|infection|arthritis|diabetes|cancer|tumour|tumor|blockage|obstruction|allergy|parasites?|worms?|fracture|poisoning|hepatitis|pancreatitis|kidney (?:disease|failure))\b/i;

const EXAM_CLAIM =
  /\bI (?:have |'ve )?(?:examined|checked|looked at|felt|palpated)\b[^.!?]{0,40}\b(?:your|the)\b|\b(?:on|in) (?:my|this) examination\b/i;

const HOME_REMEDY =
  /\b(?:induce vomiting|make (?:him|her|it|them) vomit|force (?:him|her|it|them) to vomit|give (?:him|her|it|them)[^.!?]{0,30}(?:hydrogen peroxide|salt water|castor oil|turmeric paste))\b/i;

const FALSE_REASSURANCE =
  /\b(?:nothing to worry about|no (?:real )?(?:need|reason) to worry|it'?s (?:totally|completely|perfectly|absolutely) (?:fine|normal|safe)|definitely not (?:serious|an emergency|dangerous)|you (?:don't|do not) need (?:to see|a) (?:a )?(?:vet|veterinarian))\b/i;

const REFERRAL = /\b(?:veterinar\w*|vet)\b/i;

/**
 * Advice that sends an owner *away* from care. A supplementary emergency
 * explanation is only safe when it reinforces the red flag, so these phrases
 * discard the generated text and leave the deterministic safety instruction.
 *
 * Deliberately phrase-level: "monitor her breathing while you drive" is
 * correct emergency advice and must not match; "monitor at home" is not.
 */
const WAIT_ADVICE =
  /\b(?:wait (?:and see|and watch|it out|until (?:morning|tomorrow|it passes))|monitor (?:at|from) home|watch (?:him|her|it|them) at home|see (?:how|if) (?:it|he|she|things) (?:goes|improves?)|hold off (?:on|until)|not (?:an? )?(?:medical )?emergency|no (?:need|reason) to (?:rush|hurry)|you (?:can|may) (?:probably |safely )?(?:wait|delay)|should be (?:fine|okay|ok)|likely nothing (?:serious|to worry))\b/i;

const HOME_TREATMENT =
  /\b(?:treat (?:him|her|it|them|your pet) at home|home remedy|try (?:a |some )?(?:home|herbal|homeopathic) (?:remedy|treatment)|give (?:him|her|it|them)[^.!?]{0,40}(?:human (?:medicine|tablets?|painkillers?)|paracetamol|ibuprofen|aspirin|diclofenac))\b/i;

/**
 * For an emergency-level rule, "book a routine appointment" or "tomorrow" is
 * itself a downgrade, even though it names a veterinarian.
 */
const DELAYED_CARE =
  /\b(?:book (?:a|an) (?:routine )?appointment|schedule (?:a|an) (?:routine )?appointment|in the next (?:few|couple of|couple) days|within (?:a )?(?:few|couple of) days|call (?:them |your vet )?tomorrow|tomorrow (?:morning )?(?:is|should be) (?:fine|ok))\b/i;

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * True when every occurrence of `pattern` sits inside a prohibiting sentence,
 * i.e. the text mentions the thing only to warn against it.
 */
function onlyMentionsToForbid(text: string, pattern: RegExp): boolean {
  const parts = sentences(text);
  let seen = false;
  for (const part of parts) {
    if (!pattern.test(part)) continue;
    seen = true;
    if (!PROHIBITIVE.test(part)) return false;
  }
  return seen;
}

/**
 * Inspect a generated answer. Returns the issues found; an empty array means
 * the answer passed. Callers must treat a non-empty result as "discard".
 */
export function checkGeneratedAnswer(text: string): AnswerIssue[] {
  const issues: AnswerIssue[] = [];
  const push = (code: IssueCode, pattern: RegExp) => {
    const match = pattern.exec(text);
    if (match) issues.push({ code, detail: match[0].slice(0, 120) });
  };

  // A number carrying a drug unit is a dose. "Never give 5 mg" is a warning,
  // not a recommendation, so a prohibiting sentence is allowed to name one.
  if (AMOUNT.test(text) && !onlyMentionsToForbid(text, AMOUNT)) push('dosage', AMOUNT);
  // Recommending a prescription drug is refused unless the sentence warns
  // against it ("never give ibuprofen to a cat").
  if (DRUG_ADVICE.test(text) && !onlyMentionsToForbid(text, DRUG_ADVICE)) push('prescription', DRUG_ADVICE);

  push('diagnosis', CONFIRMED_CONDITION);
  push('examination_claim', EXAM_CLAIM);
  if (HOME_REMEDY.test(text) && !onlyMentionsToForbid(text, HOME_REMEDY)) push('home_remedy', HOME_REMEDY);
  push('false_reassurance', FALSE_REASSURANCE);

  // Every answer in this product has to leave the owner with a next step.
  if (!REFERRAL.test(text)) issues.push({ code: 'missing_referral', detail: 'answer names no veterinarian' });

  return issues;
}

export function describeIssues(issues: AnswerIssue[]): string {
  return issues.map((i) => `${i.code} ("${i.detail}")`).join('; ');
}

/**
 * Guard for the *supplementary* text added to an emergency reply.
 *
 * The deterministic red-flag instruction is already on screen and is never
 * generated, so a model answer here only has to do one thing: support it. It
 * is rejected when it would downgrade urgency, advise waiting at home, offer a
 * home treatment, state a diagnosis, name a medicine or dose, or claim an
 * examination. The referral requirement is dropped because the safety block
 * above already names the veterinarian — rejecting a whole explanation for
 * repeating it would lose the explanation and gain nothing.
 */
export function checkEmergencyAnswer(text: string, urgency: Urgency): AnswerIssue[] {
  const issues = checkGeneratedAnswer(text).filter((i) => i.code !== 'missing_referral');
  const push = (code: IssueCode, pattern: RegExp) => {
    const match = pattern.exec(text);
    if (match) issues.push({ code, detail: match[0].slice(0, 120) });
  };
  // "Do not wait and see" and "never try a home remedy" are warnings, not advice.
  if (WAIT_ADVICE.test(text) && !onlyMentionsToForbid(text, WAIT_ADVICE)) push('urgency_downgrade', WAIT_ADVICE);
  if (HOME_TREATMENT.test(text) && !onlyMentionsToForbid(text, HOME_TREATMENT)) push('home_treatment', HOME_TREATMENT);
  if (urgency === 'emergency' && DELAYED_CARE.test(text) && !onlyMentionsToForbid(text, DELAYED_CARE)) {
    push('urgency_downgrade', DELAYED_CARE);
  }
  return issues;
}
