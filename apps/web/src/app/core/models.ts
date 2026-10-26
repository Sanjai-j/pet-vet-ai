export type Role = 'owner' | 'vet' | 'admin';

export interface VetProfile {
  userId?: string;
  licenseNumber?: string;
  council?: string;
  experienceYears?: number | null;
  bio?: string | null;
  clinicName?: string | null;
  clinicAddress?: string | null;
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  specialties?: string[];
  species?: string[];
  availability?: { days?: string[]; slots?: string[] };
  consultationFeeInr?: number | null;
  verificationStatus?: 'pending' | 'verified' | 'rejected';
  verificationNotes?: string | null;
  verifiedAt?: string | null;
}

export interface User {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  phone?: string | null;
  city?: string | null;
  state?: string | null;
  notificationPrefs?: Record<string, boolean>;
  privacy?: Record<string, boolean>;
  vetProfile?: VetProfile | null;
  createdAt?: string;
}

export interface Species {
  code: string;
  name: string;
  category: string;
  icon: string;
  description: string;
  breedCount?: number;
}

export interface Breed {
  id: string;
  speciesCode: string;
  name: string;
  notes?: string | null;
  isUnknown: boolean;
}

export interface Pet {
  id: string;
  ownerId: string;
  name: string;
  speciesCode: string;
  speciesName: string;
  speciesIcon: string;
  speciesCategory?: string;
  breedId?: string | null;
  breedName?: string | null;
  customBreed?: string | null;
  birthDate?: string | null;
  ageEstimateMonths?: number | null;
  sex?: string | null;
  weightKg?: number | string | null;
  weightMeasuredOn?: string | null;
  activityLevel?: string | null;
  livingEnvironment?: string | null;
  lifestyle?: string | null;
  feedingNotes?: string | null;
  foodPreferences?: string | null;
  dietaryRestrictions?: string | null;
  allergies?: string | null;
  conditions?: string | null;
  medications?: string | null;
  lastGroomingOn?: string | null;
  currentVetName?: string | null;
  currentVetClinic?: string | null;
  photoFileId?: string | null;
  isHouseholdPet?: boolean | null;
  careTaskCount?: number;
  upcomingVaccinations?: number;
  ownerName?: string;
}

export interface CareTask {
  id: string;
  petId?: string;
  type: string;
  title: string;
  instructions?: string | null;
  frequency: string;
  times: string[];
  dueDate?: string | null;
  isActive: boolean;
  dueToday?: boolean;
  completed?: boolean;
  completedAt?: string | null;
  logs?: CareLog[];
}

export interface CareLog {
  id: string;
  taskId?: string | null;
  type: string;
  value?: Record<string, unknown>;
  notes?: string | null;
  loggedAt: string;
  loggedByName?: string;
}

export interface Vaccination {
  id: string;
  vaccineName: string;
  administeredOn?: string | null;
  nextDueOn?: string | null;
  batchNumber?: string | null;
  notes?: string | null;
  source: string;
  recordedBy?: string | null;
}

/** A row of the approved vaccination reference schedule (GET /pets/:id/vaccination-plan). */
export interface VaccineScheduleRow {
  id: string;
  speciesCode: string;
  vaccineName: string;
  firstDoseAgeText: string;
  primarySeriesText: string;
  boosterIntervalText: string;
  mustCheck?: string | null;
  guidanceLevel: 'general_guidance' | 'vet_decision' | 'programme_only' | 'avian_review';
  autoAssignable: boolean;
  referenceBasis: string;
  isDemo: boolean;
}

/** A vaccination to-do for one pet: mark it done or move the date. */
export interface VaccinationCheckpoint {
  id: string;
  petId: string;
  vaccineName: string;
  dueOn: string;
  previousDueOn?: string | null;
  status: 'pending' | 'done' | 'removed';
  completedOn?: string | null;
  origin: 'schedule' | 'owner' | 'follow_up';
  notes?: string | null;
  guidanceLevel?: string | null;
}

export interface VaccinationPlan {
  pet: { id: string; name: string; speciesCode: string; birthDate: string | null };
  checkpoints: VaccinationCheckpoint[];
  reference: VaccineScheduleRow[];
  canGenerate: boolean;
  message: string | null;
}

export interface Appointment {
  id: string;
  ownerId: string;
  vetId: string;
  petId: string;
  petName: string;
  petSpecies?: string;
  scheduledFor: string;
  mode: 'in_person' | 'video';
  reason: string;
  status: 'pending' | 'accepted' | 'rejected' | 'completed' | 'cancelled';
  responseNote?: string | null;
  ownerName?: string;
  vetName?: string;
  clinicName?: string | null;
  feeInr?: number | null;
  createdAt?: string;
}

export interface ConsultationNote {
  id: string;
  notes: string;
  carePlan?: string | null;
  followUpOn?: string | null;
  createdAt: string;
  vetName?: string;
}

export interface Thread {
  id: string;
  ownerId: string;
  vetId: string;
  petId: string;
  petName: string;
  ownerName: string;
  vetName: string;
  clinicName?: string | null;
  appointmentId?: string | null;
  lastMessage?: string | null;
  lastMessageAt?: string | null;
  unread: number;
}

export interface ChatMessage {
  id: string;
  threadId?: string;
  senderId: string;
  senderName?: string;
  body: string;
  fileId?: string | null;
  fileName?: string | null;
  fileMime?: string | null;
  createdAt: string;
}

export interface Clinic {
  id: string;
  name: string;
  address: string;
  city: string;
  state: string;
  pincode?: string | null;
  latitude: number;
  longitude: number;
  phone?: string | null;
  services: string[];
  hours?: string | null;
  isDemo: boolean;
  is24x7: boolean;
  distanceKm?: number | null;
}

export interface VetDirectoryEntry {
  id: string;
  fullName: string;
  licenseNumber?: string;
  council: string;
  experienceYears?: number | null;
  bio?: string | null;
  clinicName?: string | null;
  clinicAddress?: string | null;
  city?: string | null;
  state?: string | null;
  specialties: string[];
  species: string[];
  availability?: { days?: string[]; slots?: string[] };
  consultationFeeInr?: number | null;
  verifiedAt?: string | null;
  distanceKm?: number | null;
}

export interface DirectoryVet {
  id: string;
  fullName: string;
  city?: string | null;
  state?: string | null;
  clinicName?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  species: string[];
  specialties: string[];
  languages: string[];
  consultationTypes: string[];
  experienceYears?: number | null;
  qualification?: string | null;
  registrationAuthority?: string | null;
  consultationFeeInr?: number | null;
  verifiedAt?: string | null;
  bio?: string | null;
  serviceArea?: string | null;
  distanceKm?: number | null;
  verified: boolean;
}

/** A hospital or clinic returned by GET /maps/clinics (OpenStreetMap or Google listing). */
export interface NearbyClinic {
  id: string;
  name: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  phone: string | null;
  website: string | null;
  rating: number | null;
  reviewCount: number | null;
  openingHours: string | null;
  placeId: string | null;
  directionsUrl: string;
  dataSource: 'google_places' | 'openstreetmap' | 'independently_verified';
  verificationStatus: 'listing_only' | 'unverified' | 'independently_verified';
  /** 24×7 or accepts emergencies, where the listing states it. */
  emergencyAvailable: boolean;
  isDemo: boolean;
  distanceKm: number | null;
  speciesSupported: string[] | null;
  speciesNote: string;
  bookableVetIds: string[];
}

/** A bookable availability window created by a veterinarian. */
export interface VetSlot {
  id: string;
  slotDate: string;
  startTime: string;
  endTime: string;
  consultationType: 'in_person' | 'video' | 'chat';
  status: 'available' | 'booked' | 'blocked';
}

export interface MapsConfig {
  placesConfigured: boolean;
  nearbyProvider: 'google_places' | 'openstreetmap' | 'disabled';
  nearbyConfigured: boolean;
  placesEnabled: boolean;
  browserKey: string | null;
  mapId: string | null;
  setupMessage: string | null;
}

export interface AppNotification {
  id: string;
  title: string;
  body: string;
  kind: string;
  link?: string | null;
  readAt?: string | null;
  createdAt: string;
}

export interface Capability {
  id: string;
  speciesCode: string;
  speciesName: string;
  task: string;
  status: 'validated' | 'limited' | 'not_supported';
  evidenceSummary: string;
  evaluationNotes?: string | null;
}

export interface CitedSource {
  documentId: string;
  chunkId: string;
  title: string;
  sourceOrg: string;
  sourceUrl?: string | null;
  isDemo: boolean;
  category: string;
  snippet: string;
  score: number;
}

export interface AiReply {
  id?: string;
  answer: string;
  citations: CitedSource[];
  emergency: { ruleId: string; label: string; advice: string } | null;
  capability: {
    task: string;
    taskLabel: string;
    status: 'validated' | 'limited' | 'not_supported';
    evidenceSummary: string;
  };
  mode: 'deterministic' | 'llm' | 'blocked';
  /** why this answer was produced this way — see docs/API.md */
  modeReason?: string;
  urgency?: 'routine' | 'prompt' | 'urgent' | 'emergency';
  needsClarification?: boolean;
  /**
   * Optional questions shown with an emergency reply. They are never a
   * prerequisite for seeking care, and the safety instruction does not wait
   * on an answer.
   */
  followUps?: string[];
  /** true when the red flag continued from the previous turn of the conversation */
  emergencyContinued?: boolean;
  /** whether the configured model was called for this reply */
  llmAttempted?: boolean;
  /** sanitised provider failure when the model call failed — never a key */
  providerError?: string | null;
  disclaimer: string;
  referral: string;
  createdAt?: string;
}

export interface AiMessageRow {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations: CitedSource[];
  emergency: boolean;
  capabilityStatus?: string | null;
  isDemo?: boolean;
  createdAt: string;
}

/**
 * One live web result from GET /ai/web-search (Exa).
 * Supplementary reading only — never an approved reference or clinical guidance.
 */
export interface WebSearchResult {
  title: string | null;
  url: string;
  publishedDate: string | null;
  author: string | null;
  highlights: string[];
}

export interface WebSearchResponse {
  query: string;
  results: WebSearchResult[];
  notice: string;
}

/** A food-safety entry returned by GET /nutrition/hazards. */
export interface NutritionHazard {
  id: string;
  speciesCodes: string[];
  foodOrSubstance: string;
  classification: string;
  severity: 'toxic' | 'potentially_toxic' | 'dangerous' | 'caution' | 'nutritionally_inappropriate' | 'unknown';
  risk: string;
  recommendedAction: string;
  sourceUrl: string | null;
  version: number;
  reviewedAt: string | null;
}

export interface NutritionGuidance {
  id: string;
  recordKey: string;
  speciesCode: string;
  breedOrType: string | null;
  lifeStage: string;
  nutritionGoal: string;
  generalDietGuidance: string;
  suitableFoodsText: string;
  hazardsToAvoidText: string;
  recipeGuidanceText: string;
  goalSpecificGuidance: string;
  safetyCautions: string;
  individualizationFactors: string;
  disclaimer: string;
  dataQualityNote: string;
  sourceUrl: string | null;
  sourceName: string | null;
  version: number;
  reviewedAt: string | null;
  allergenWarnings: string[];
}

export interface NutritionRecipe {
  id: string;
  speciesCode: string;
  recipeName: string;
  dietRole: string;
  applicability: string;
  ingredients: string[];
  steps: string[];
  safetyNotes: string;
  storageInstructions: string | null;
  storageKnown: boolean;
  isCompleteDiet: boolean;
  nutritionalAdequacy: string;
  adequacyNote: string | null;
  version: number;
  reviewedAt: string | null;
  allergenWarnings: string[];
  roleLabel: string;
  isSupplementary: boolean;
  completeDietWarning: string | null;
  storageNote: string;
}

/** Personalized profile from GET /pets/:petId/nutrition. */
export interface PetNutritionProfile {
  pet: {
    id: string; name: string; speciesCode: string; speciesName: string;
    speciesIcon: string; breedName: string | null;
    lifeStage: 'young' | 'adult' | 'senior' | 'all' | 'unknown';
  };
  knowledge: { approvedGuidanceCount: number; approvedHazardCount: number; approvedRecipeCount: number; note: string };
  missingInfo: string[];
  guidance: NutritionGuidance[];
  breedContext: {
    applied: boolean;
    basis: 'approved_breed_evidence' | 'no_breed_on_file' | 'no_approved_evidence';
    guidance?: {
      id: string; speciesCode: string; breedOrType: string; lifeStage: string;
      generalGuidance: string; limitation: string; referralRule: string; version: number;
    };
    note: string;
  };
  hazards: NutritionHazard[];
  hazardCoverageKnown: boolean;
  recipes: NutritionRecipe[];
  healthRules: Array<{
    id: string; conditionOrGoal: string; keywords: string[];
    generalGuidance: string; safetyRule: string; referralRule: string;
    version: number; matchedOn: string[];
  }>;
  livestock: null | { feedPlanRequired: true; planNote: string };
  emergencyNotice: null | { title: string; body: string };
  disclaimer: string;
}

export interface FoodItem {
  id: string;
  name: string;
  speciesCode: string;
  safety: 'safe' | 'caution' | 'toxic' | 'unknown';
  notes: string;
  sourceNote?: string | null;
  isDemo: boolean;
}
