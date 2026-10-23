import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, badRequest, notFound, parse } from '../errors.js';
import { many, one } from '../db.js';
import { requireAuth } from '../auth.js';
import { config } from '../config.js';
import {
  MAPS_SETUP_MESSAGE,
  geocodeAddress,
  mapsConfigured,
  nearbyConfigured,
  searchClinics,
} from '../services/maps.js';

export const mapsRouter = Router();

/**
 * GET /api/maps/config
 * Public shape only: never includes the server-side API key.
 */
mapsRouter.get(
  '/maps/config',
  asyncHandler(async (_req, res) => {
    res.json({
      placesConfigured: mapsConfigured(),
      // 'openstreetmap' is the free default; Google Places takes over when a
      // server key is configured.
      nearbyProvider: mapsConfigured() ? 'google_places' : config.nearby.enabled ? 'openstreetmap' : 'disabled',
      nearbyConfigured: nearbyConfigured(),
      placesEnabled: config.maps.placesEnabled,
      // Browser key is only safe when referrer-restricted in Google Cloud
      // Console; the server key stays on the server.
      browserKey: config.maps.browserKey || null,
      mapId: config.maps.mapId || null,
      setupMessage: nearbyConfigured() ? null : MAPS_SETUP_MESSAGE,
    });
  }),
);

/**
 * GET /api/maps/clinics?lat&lng&city&q&radiusKm&limit
 * Nearby veterinary clinics and animal hospitals: Google Places (New) when a
 * server key is configured, otherwise the free OpenStreetMap lookup.
 */
mapsRouter.get(
  '/maps/clinics',
  requireAuth,
  asyncHandler(async (req, res) => {
    const query = parse(
      z.object({
        lat: z.coerce.number().min(-90).max(90).optional(),
        lng: z.coerce.number().min(-180).max(180).optional(),
        city: z.string().max(80).optional(),
        q: z.string().max(120).optional(),
        radiusKm: z.coerce.number().min(1).max(50).optional(),
        limit: z.coerce.number().int().min(1).max(50).optional(),
      }),
      req.query,
    );
    if (query.lat != null !== (query.lng != null)) {
      throw badRequest('Provide both latitude and longitude, or neither.');
    }
    const result = await searchClinics(query, req.user!.id);
    res.json(result);
  }),
);

/**
 * GET /api/maps/geocode?q=<address | city | pincode>
 * Server-side geocoding for manual location entry.
 */
mapsRouter.get(
  '/maps/geocode',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { q } = parse(z.object({ q: z.string().min(3).max(200) }), req.query);
    const result = await geocodeAddress(q, req.user!.id);
    res.json(result);
  }),
);

/**
 * GET /api/maps/usage  (admin)
 * Aggregate Maps API usage — endpoint, success rate, latency. No locations.
 */
mapsRouter.get(
  '/maps/usage',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (req.user!.role !== 'admin') throw notFound();
    const rows = await many(
      `SELECT endpoint,
              count(*)::int AS total,
              count(*) FILTER (WHERE ok)::int AS succeeded,
              round(avg(latency_ms))::int AS avg_latency_ms,
              max(created_at) AS "lastAt"
       FROM maps_api_log
       GROUP BY endpoint ORDER BY endpoint`,
    );
    const recentErrors = await many(
      `SELECT endpoint, error_code AS "errorCode", http_status AS "httpStatus",
              created_at AS "createdAt"
       FROM maps_api_log WHERE ok = false ORDER BY created_at DESC LIMIT 20`,
    );
    res.json({ usage: rows, recentErrors });
  }),
);
