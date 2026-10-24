import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, notFound, parse } from '../errors.js';
import { many, one } from '../db.js';
import { requireAuth } from '../auth.js';
import { config } from '../config.js';
import { haversineKm } from '../util.js';
import { emailConfigured } from '../services/email.js';

export const providersRouter = Router();

providersRouter.get(
  '/providers',
  asyncHandler(async (req, res) => {
    const query = parse(
      z.object({
        lat: z.coerce.number().min(-90).max(90).optional(),
        lng: z.coerce.number().min(-180).max(180).optional(),
        city: z.string().max(80).optional(),
        q: z.string().max(80).optional(),
        species: z.enum(['dog', 'cat', 'bird', 'cow', 'goat', 'other']).optional(),
      }),
      req.query,
    );
    const lat = query.lat;
    const lng = query.lng;
    const city = query.city?.trim() ?? '';
    const q = query.q?.trim() ?? '';
    const species = query.species ?? '';

    const clinics = await many<{
      id: string; name: string; address: string; city: string; state: string; pincode: string | null;
      latitude: number; longitude: number; services: string[]; hours: string | null;
      isDemo: boolean; is24x7: boolean; phone: string | null;
    }>(
      `SELECT id, name, address, city, state, pincode, latitude, longitude, services, hours,
              is_demo AS "isDemo", is_24x7 AS "is24x7", phone
       FROM clinics
       WHERE ($1 = '' OR lower(city) = lower($1))
         AND ($2 = '' OR name ILIKE '%' || $2 || '%' OR city ILIKE '%' || $2 || '%')
       ORDER BY is_demo ASC, name`,
      [city, q],
    );

    const vets = await many<{
      id: string; fullName: string; licenseNumber: string; council: string; experienceYears: number | null;
      bio: string | null; clinicName: string | null; clinicAddress: string | null; city: string | null;
      state: string | null; latitude: number | null; longitude: number | null; specialties: string[];
      species: string[]; availability: unknown; consultationFeeInr: number | null; verifiedAt: string | null;
    }>(
      `SELECT u.id, u.full_name AS "fullName", v.license_number AS "licenseNumber", v.council,
              v.experience_years AS "experienceYears", v.bio, v.clinic_name AS "clinicName",
              v.clinic_address AS "clinicAddress", v.city, v.state, v.latitude, v.longitude,
              v.specialties, v.species, v.availability, v.consultation_fee_inr AS "consultationFeeInr",
              v.verified_at AS "verifiedAt"
       FROM vet_profiles v JOIN users u ON u.id = v.user_id
       WHERE v.verification_status = 'verified' AND u.disabled = false
         AND ($1 = '' OR $1 = ANY(v.species))
         AND ($2 = '' OR lower(v.city) = lower($2))
         AND ($3 = '' OR u.full_name ILIKE '%' || $3 || '%' OR v.clinic_name ILIKE '%' || $3 || '%'
              OR EXISTS (SELECT 1 FROM unnest(v.specialties) sp WHERE sp ILIKE '%' || $3 || '%'))`,
      [species, city, q],
    );

    const withDistance = <T extends { latitude?: number | null; longitude?: number | null }>(rows: T[]) =>
      rows
        .map((r) => ({
          ...r,
          distanceKm:
            lat != null && lng != null && r.latitude != null && r.longitude != null
              ? haversineKm(lat, lng, Number(r.latitude), Number(r.longitude))
              : null,
        }))
        .sort((a, b) => {
          if (a.distanceKm == null && b.distanceKm == null) return 0;
          if (a.distanceKm == null) return 1;
          if (b.distanceKm == null) return -1;
          return a.distanceKm - b.distanceKm;
        });

    res.json({
      clinics: withDistance(clinics),
      veterinarians: withDistance(vets),
      notice:
        'Clinic entries come from the directory table (imported listings, each labelled with its source). For live hospital listings near an address or the browser location, use Find care. “Open in Maps” uses your maps provider; this is not a live hospital feed.',
      geoSearch: lat != null && lng != null,
    });
  }),
);

providersRouter.get(
  '/providers/vets/:vetId',
  asyncHandler(async (req, res) => {
    const vet = await one(
      `SELECT u.id, u.full_name AS "fullName", v.council, v.experience_years AS "experienceYears",
              v.bio, v.clinic_name AS "clinicName", v.clinic_address AS "clinicAddress",
              v.city, v.state, v.specialties, v.species, v.availability,
              v.consultation_fee_inr AS "consultationFeeInr", v.verified_at AS "verifiedAt"
       FROM vet_profiles v JOIN users u ON u.id = v.user_id
       WHERE v.user_id = $1 AND v.verification_status = 'verified' AND u.disabled = false`,
      [req.params.vetId],
    );
    if (!vet) throw notFound('Verified veterinarian not found');
    res.json({ veterinarian: vet });
  }),
);

providersRouter.get(
  '/config/webrtc',
  requireAuth,
  (_req, res) => {
    const iceServers: Array<Record<string, unknown>> = [
      { urls: config.webrtc.stun },
    ];
    if (config.webrtc.turnUrl) {
      iceServers.push({
        urls: config.webrtc.turnUrl,
        username: config.webrtc.turnUsername || undefined,
        credential: config.webrtc.turnCredential || undefined,
      });
    }
    res.json({
      iceServers,
      turnConfigured: Boolean(config.webrtc.turnUrl),
      note: config.webrtc.turnUrl
        ? 'TURN relay is configured for restrictive networks.'
        : 'Only public STUN is configured. Some restrictive networks will not connect; add TURN for reliability.',
    });
  },
);

providersRouter.get('/config/public', (_req, res) => {
  res.json({
    appName: 'Pet Vet AI',
    timezone: config.timezone,
    aiMode: config.llm.provider !== 'none' && config.llm.apiKey ? 'llm' : 'rules',
    mapsConfigured: Boolean(config.maps.apiKey),
    // 'google_places' when a key is present, otherwise the free
    // OpenStreetMap lookup, or 'disabled' when that has been turned off.
    nearbyProvider: config.maps.apiKey ? 'google_places' : config.nearby.enabled ? 'openstreetmap' : 'disabled',
    // True for either transport: an HTTPS email API (production) or SMTP.
    emailConfigured: emailConfigured(),
    pushConfigured: Boolean(config.push.publicKey && config.push.privateKey),
    turnConfigured: Boolean(config.webrtc.turnUrl),
    disclaimer: 'Pet Vet AI is decision support and care coordination, not a veterinary diagnosis service.',
  });
});
