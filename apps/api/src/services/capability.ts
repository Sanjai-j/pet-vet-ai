import { one } from '../db.js';

export type CapabilityStatus = 'validated' | 'limited' | 'not_supported';

export interface Capability {
  status: CapabilityStatus;
  evidenceSummary: string;
  task: string;
  speciesCode: string;
}

const TASK_LABELS: Record<string, string> = {
  symptom_check: 'symptom review',
  emergency_triage: 'emergency triage',
  food_safety: 'food safety',
  general_care: 'general care guidance',
  image_analysis: 'image analysis',
  medication_guidance: 'medication guidance',
};

export function taskLabel(task: string): string {
  return TASK_LABELS[task] ?? task.replace(/_/g, ' ');
}

export function detectTask(text: string): string {
  const t = text.toLowerCase();
  if (/(medicine|medication|dose|dosage|tablet|antibiotic|painkiller|paracetamol|ibuprofen)/.test(t)) {
    return 'medication_guidance';
  }
  if (/(food|feed|ate|eating|diet|toxic|poison|safe to eat|chocolate|grape|onion)/.test(t)) {
    return 'food_safety';
  }
  if (/(groom|brush|bath|coat|shed|tick|flea|nail|ear clean)/.test(t)) {
    return 'general_care';
  }
  if (/(vaccin|booster|deworm|check.?up|prevent)/.test(t)) {
    return 'general_care';
  }
  return 'symptom_check';
}

export async function getCapability(speciesCode: string, task: string): Promise<Capability> {
  const row = await one<{ status: CapabilityStatus; evidenceSummary: string }>(
    `SELECT status, evidence_summary AS "evidenceSummary"
     FROM capability_registry WHERE species_code = $1 AND task = $2`,
    [speciesCode, task],
  );
  if (row) return { ...row, task, speciesCode };
  return {
    status: 'not_supported',
    evidenceSummary: 'No capability entry exists for this species and task.',
    task,
    speciesCode,
  };
}

export const speciesDisplayNames: Record<string, string> = {
  dog: 'dogs',
  cat: 'cats',
  bird: 'birds',
  cow: 'cattle',
  goat: 'goats',
  other: 'this species',
};
