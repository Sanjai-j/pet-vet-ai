import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { getDb, many } from '../db.js';
import { badRequest } from '../errors.js';
import { haversineKm } from '../util.js';

// ── Configuration ───────────────────────────────────────────────
const PLACES_BASE = 'https://places.googleapis.com/v1';
const GEOCODE_BASE = 'https://maps.googleapis.com/maps/api/geocode/json';
const REQUEST_TIMEOUT_MS = Math.max(2_000, Number(process.env.GOOGLE_MAPS_TIMEOUT_MS ?? 8_000));

export function mapsConfigured(): boolean {
  return Boolean(config.maps.apiKey);
}

/** True when nearby hospital search has a data source at all. */
export function nearbyConfigured(): boolean {
  return mapsConfigured() || config.nearby.enabled;
}

/** Setup guidance shown when every nearby-hospital source is switched off. */
export const MAPS_SETUP_MESSAGE =
  'Nearby hospital search is switched off on this server. Set OVERPASS_ENABLED=true to use the free OpenStreetMap lookup, ' +
  'or configure GOOGLE_MAPS_API_KEY for Google Places results.';

// ── Rate limiting (per-user, in-memory) ─────────────────────────
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;
const buckets = new Map<string, { count: number; resetAt: number }>();

function consumeRate(actorId: string): void {
  const now = Date.now();
  const bucket = buckets.get(actorId);
  if (!bucket || now > bucket.resetAt) {
    buckets.set(actorId, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return;
  }
  if (bucket.count >= RATE_LIMIT) {
    throw badRequest('Too many map searches this minute. Please wait a moment and try again.');
  }
  bucket.count += 1;
}

// ── Usage logging (no location data) ────────────────────────────
async function logUsage(
  endpoint: string,
  ok: boolean,
  httpStatus: number | null,
  latencyMs: number,
  resultCount: number | null,
  errorCode: string | null,
  actorId: string,
): Promise<void> {
  try {
    await (await getDb()).query(
      `INSERT INTO maps_api_log (id, endpoint, ok, http_status, latency_ms, result_count, error_code, actor_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [randomUUID(), endpoint, ok, httpStatus, latencyMs, resultCount, errorCode, actorId],
    );
  } catch {
    // Logging must never break a search.
  }
}

// ── Types ───────────────────────────────────────────────────────
export interface ClinicResult {
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
  /** Open 24×7 or accepts emergency cases, where the listing says so. */
  emergencyAvailable: boolean;
  isDemo: boolean;
  distanceKm: number | null;
  speciesSupported: string[] | null;
  speciesNote: string;
  bookableVetIds: string[];
}

interface GooglePlace {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  nationalPhoneNumber?: string;
  websiteUri?: string;
  rating?: number;
  userRatingCount?: number;
  regularOpeningHours?: { weekdayDescriptions?: string[] };
  googleMapsUri?: string;
}

function directionsUrlFor(place: GooglePlace): string {
  if (place.googleMapsUri) return place.googleMapsUri;
  if (place.location?.latitude != null && place.location?.longitude != null) {
    return `https://www.google.com/maps/dir/?api=1&destination=${place.location.latitude},${place.location.longitude}`;
  }
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place.displayName?.text ?? '')}`;
}

function toResult(place: GooglePlace, origin: { lat: number; lng: number } | null): ClinicResult {
  const lat = place.location?.latitude ?? null;
  const lng = place.location?.longitude ?? null;
  return {
    id: place.id ?? randomUUID(),
    name: place.displayName?.text ?? 'Unnamed listing',
    address: place.formattedAddress ?? 'Address not provided',
    latitude: lat,
    longitude: lng,
    phone: place.nationalPhoneNumber ?? null,
    website: place.websiteUri ?? null,
    rating: place.rating ?? null,
    reviewCount: place.userRatingCount ?? null,
    openingHours: place.regularOpeningHours?.weekdayDescriptions?.join('; ') ?? null,
    placeId: place.id ?? null,
    directionsUrl: directionsUrlFor(place),
    dataSource: 'google_places',
    verificationStatus: 'listing_only',
    emergencyAvailable: false,
    isDemo: false,
    distanceKm:
      origin && lat != null && lng != null ? haversineKm(origin.lat, origin.lng, lat, lng) : null,
    speciesSupported: null,
    speciesNote:
      'Species capabilities come from the listing only where stated; confirm by phone. A Google listing is not a Pet Vet AI verification.',
    bookableVetIds: [],
  };
}

// ── Google Places text search (New) ─────────────────────────────
async function googleTextSearch(
  query: string,
  origin: { lat: number; lng: number } | null,
  radiusMeters: number,
  actorId: string,
): Promise<{ places: GooglePlace[]; status: number }> {
  const started = Date.now();
  const fieldMask = [
    'places.id',
    'places.displayName',
    'places.formattedAddress',
    'places.location',
    'places.nationalPhoneNumber',
    'places.websiteUri',
    'places.rating',
    'places.userRatingCount',
    'places.regularOpeningHours.weekdayDescriptions',
    'places.googleMapsUri',
  ].join(',');

  const body: Record<string, unknown> = { textQuery: query, languageCode: 'en', regionCode: 'IN' };
  if (origin) {
    body.locationBias = {
      circle: {
        center: { latitude: origin.lat, longitude: origin.lng },
        radius: Math.min(Math.max(radiusMeters, 100), 50_000),
      },
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${PLACES_BASE}/places:searchText`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': config.maps.apiKey,
        'X-Goog-FieldMask': fieldMask,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const latency = Date.now() - started;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const code = res.status === 403 ? 'quota_or_key_error' : `http_${res.status}`;
      await logUsage('places.searchText', false, res.status, latency, null, code, actorId);
      throw badRequest(
        res.status === 403
          ? 'Google Maps rejected the request. Check that the Places API is enabled and the key restrictions allow this server.'
          : `Google Maps search failed (${res.status}). ${text.slice(0, 200)}`,
      );
    }
    const json = (await res.json()) as { places?: GooglePlace[] };
    const places = json.places ?? [];
    await logUsage('places.searchText', true, res.status, latency, places.length, null, actorId);
    return { places, status: res.status };
  } catch (err) {
    const latency = Date.now() - started;
    if ((err as Error).name === 'AbortError') {
      await logUsage('places.searchText', false, null, latency, null, 'timeout', actorId);
      throw badRequest('Google Maps search timed out. Please try again.');
    }
    if ((err as { status?: number }).status) throw err;
    await logUsage('places.searchText', false, null, latency, null, 'network_error', actorId);
    throw badRequest('Could not reach Google Maps. Check the server network connection.');
  } finally {
    clearTimeout(timer);
  }
}

// ── Geocoding for manual address / city / PIN searches ──────────
export async function geocodeAddress(query: string, actorId: string): Promise<{ lat: number; lng: number; formatted: string }> {
  if (!mapsConfigured()) {
    if (!config.nearby.enabled) throw badRequest(MAPS_SETUP_MESSAGE);
    consumeRate(actorId);
    const geo = await nominatimGeocode(query, actorId);
    if (!geo) throw badRequest('That address could not be found. Try a city name or PIN code.');
    return geo;
  }
  consumeRate(actorId);
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const url = `${GEOCODE_BASE}?address=${encodeURIComponent(query)}&key=${config.maps.apiKey}&region=in`;
    const res = await fetch(url, { signal: controller.signal });
    const latency = Date.now() - started;
    if (!res.ok) {
      await logUsage('geocode', false, res.status, latency, null, `http_${res.status}`, actorId);
      throw badRequest(`Address lookup failed (${res.status}).`);
    }
    const json = (await res.json()) as { status: string; results?: Array<{ formatted_address?: string; geometry?: { location?: { lat?: number; lng?: number } } }> };
    const first = json.results?.[0];
    const lat = first?.geometry?.location?.lat;
    const lng = first?.geometry?.location?.lng;
    if (lat == null || lng == null) {
      await logUsage('geocode', true, res.status, latency, 0, null, actorId);
      throw badRequest('That address could not be found. Try a city name or PIN code.');
    }
    await logUsage('geocode', true, res.status, latency, 1, null, actorId);
    return { lat, lng, formatted: first?.formatted_address ?? query };
  } catch (err) {
    const latency = Date.now() - started;
    if ((err as Error).name === 'AbortError') {
      await logUsage('geocode', false, null, latency, null, 'timeout', actorId);
      throw badRequest('Address lookup timed out. Please try again.');
    }
    if ((err as { status?: number }).status) throw err;
    await logUsage('geocode', false, null, latency, null, 'network_error', actorId);
    throw badRequest('Could not reach Google Maps for address lookup.');
  } finally {
    clearTimeout(timer);
  }
}

// ── OpenStreetMap: geocoding + nearby veterinary amenities ──────
interface NominatimPlace {
  place_id: number;
  osm_type?: string;
  osm_id?: number;
  lat: string;
  lon: string;
  category?: string;
  type?: string;
  name?: string;
  display_name?: string;
  address?: Record<string, string>;
  extratags?: Record<string, string> | null;
}

/** amenity=* values that describe a place an owner can bring an animal to. */
const VET_AMENITY_TYPES = new Set(['veterinary', 'clinic', 'hospital', 'doctors']);

interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat?: number; lon?: number };
  tags?: Record<string, string>;
}

let lastNominatimAt = 0;

/** Nominatim's usage policy allows at most one request per second per app. */
async function nominatimGate(): Promise<void> {
  const wait = Math.max(0, lastNominatimAt + 1100 - Date.now());
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastNominatimAt = Date.now();
}

async function nominatimGeocode(
  query: string,
  actorId: string,
): Promise<{ lat: number; lng: number; formatted: string } | null> {
  await nominatimGate();
  const started = Date.now();
  const url = `${config.nearby.nominatimUrl}/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.nearby.timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': config.nearby.userAgent, Accept: 'application/json' },
      signal: controller.signal,
    });
    const latency = Date.now() - started;
    if (!res.ok) {
      await logUsage('nominatim.search', false, res.status, latency, null, `http_${res.status}`, actorId);
      if (res.status === 429) {
        throw badRequest('OpenStreetMap is rate-limiting address lookups. Please wait a minute and try again.');
      }
      throw badRequest(`Address lookup failed (${res.status}).`);
    }
    const list = (await res.json()) as Array<{ lat?: string; lon?: string; display_name?: string }>;
    const first = list?.[0];
    const lat = Number(first?.lat);
    const lng = Number(first?.lon);
    if (!first || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      await logUsage('nominatim.search', true, res.status, latency, 0, null, actorId);
      return null;
    }
    await logUsage('nominatim.search', true, res.status, latency, 1, null, actorId);
    return { lat, lng, formatted: first.display_name ?? query };
  } catch (err) {
    const latency = Date.now() - started;
    if ((err as Error).name === 'AbortError') {
      await logUsage('nominatim.search', false, null, latency, null, 'timeout', actorId);
      throw badRequest('Address lookup timed out. Please try again.');
    }
    if ((err as { status?: number }).status) throw err;
    await logUsage('nominatim.search', false, null, latency, null, 'network_error', actorId);
    throw badRequest('Could not reach OpenStreetMap for the address lookup. Enter a city or try again.');
  } finally {
    clearTimeout(timer);
  }
}

async function overpassNearby(
  origin: { lat: number; lng: number },
  radiusKm: number,
  actorId: string,
): Promise<OsmElement[]> {
  const radius = Math.round(Math.min(Math.max(radiusKm, 1), 50) * 1000);
  const around = `(around:${radius},${origin.lat},${origin.lng})`;
  const query =
    '[out:json][timeout:25];(' +
    `node["amenity"="veterinary"]${around};` +
    `way["amenity"="veterinary"]${around};` +
    `relation["amenity"="veterinary"]${around};` +
    `node["healthcare"="veterinary"]${around};` +
    `way["healthcare"="veterinary"]${around};` +
    ');out center tags 120;';

  const started = Date.now();
  const urls = config.nearby.overpassUrls.filter(Boolean);
  if (!urls.length) {
    throw badRequest(
      'No OpenStreetMap mirror is configured. Set OVERPASS_URL, or set OVERPASS_ENABLED=false to switch nearby search off.',
    );
  }

  // Race the mirrors instead of stacking their timeouts: public mirrors vary
  // wildly, and the first non-empty answer wins. This is the rich-data path
  // (opening hours, phone, emergency flag); the caller also runs a Nominatim
  // listing search and merges the two, so a slow mirror never blocks the list.
  return await new Promise<OsmElement[]>((resolve, reject) => {
    const controllers = new Map<string, AbortController>();
    const failures: string[] = [];
    let pending = urls.length;
    let emptyCount = 0;
    let timedOut = false;
    let settled = false;

    /** Stop the mirrors that lost the race so they stop costing quota. */
    const stopOthers = (winnerUrl: string) => {
      for (const [url, controller] of controllers) {
        if (url !== winnerUrl) controller.abort();
      }
    };

    const settle = () => {
      if (settled) return;
      if (pending > 0) return;
      settled = true;
      // An empty answer from a mirror is not an error: the Nominatim listing
      // search covers the same OpenStreetMap data and decides the final word.
      if (emptyCount > 0) {
        resolve([]);
        return;
      }
      console.warn(`[maps] Overpass search failed on all mirrors: ${failures.join('; ') || 'no mirror answered'}`);
      reject(
        badRequest(
          timedOut ? 'The OpenStreetMap search timed out on every mirror.' : 'Could not reach OpenStreetMap.',
        ),
      );
    };

    for (const url of urls) {
      const controller = new AbortController();
      controllers.set(url, controller);
      const timer = setTimeout(() => controller.abort(), config.nearby.timeoutMs);

      fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': config.nearby.userAgent,
          Accept: 'application/json',
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: controller.signal,
      })
        .then(async (res): Promise<OsmElement[] | null> => {
          const latency = Date.now() - started;
          if (!res.ok) {
            failures.push(`${url} returned ${res.status}`);
            await logUsage('overpass.search', false, res.status, latency, null, `http_${res.status}`, actorId);
            return null;
          }
          const json = (await res.json()) as { elements?: OsmElement[] };
          const elements = json.elements ?? [];
          await logUsage('overpass.search', true, res.status, latency, elements.length, null, actorId);
          return elements;
        })
        .then((elements) => {
          if (elements === null || settled) return;
          if (elements.length > 0) {
            settled = true;
            stopOthers(url);
            resolve(elements);
            return;
          }
          // A healthy mirror with no local coverage answers instantly with
          // zero rows; that alone does not prove the area is unmapped.
          emptyCount += 1;
        })
        .catch((err) => {
          if (settled) return; // aborted because another mirror already won
          if ((err as Error).name === 'AbortError') {
            timedOut = true;
            failures.push(`${url} timed out after ${config.nearby.timeoutMs}ms`);
            void logUsage('overpass.search', false, null, Date.now() - started, null, 'timeout', actorId);
          } else {
            failures.push(`${url} unreachable: ${(err as Error).message}`);
            void logUsage('overpass.search', false, null, Date.now() - started, null, 'network_error', actorId);
          }
        })
        .finally(() => {
          clearTimeout(timer);
          controllers.delete(url);
          pending -= 1;
          settle();
        });
    }
  });
}

// ── Nominatim listing search (fast path over the same OSM data) ─
/**
 * Named veterinary places inside a box around the origin. Nominatim answers in
 * about a second where public Overpass mirrors routinely hang, and it reports
 * the same OpenStreetMap objects, so both answers merge cleanly.
 */
async function nominatimNearby(
  origin: { lat: number; lng: number },
  radiusKm: number,
  actorId: string,
): Promise<NominatimPlace[]> {
  await nominatimGate();
  const latDelta = radiusKm / 111;
  const lngDelta = radiusKm / (111 * Math.max(0.2, Math.cos((origin.lat * Math.PI) / 180)));
  const viewbox = [
    origin.lng - lngDelta, origin.lat + latDelta, origin.lng + lngDelta, origin.lat - latDelta,
  ].join(',');
  const url =
    `${config.nearby.nominatimUrl}/search?format=jsonv2&limit=50&bounded=1` +
    `&viewbox=${encodeURIComponent(viewbox)}&extratags=1&addressdetails=1&q=veterinary`;

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.nearby.timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': config.nearby.userAgent, Accept: 'application/json' },
      signal: controller.signal,
    });
    const latency = Date.now() - started;
    if (!res.ok) {
      await logUsage('nominatim.nearby', false, res.status, latency, null, `http_${res.status}`, actorId);
      if (res.status === 429) throw badRequest('OpenStreetMap is rate-limiting searches. Please wait a minute and try again.');
      throw badRequest(`OpenStreetMap listing search failed (${res.status}).`);
    }
    const rows = (await res.json()) as NominatimPlace[];
    const places = (Array.isArray(rows) ? rows : []).filter(
      (row) => row.category === 'amenity' && VET_AMENITY_TYPES.has(row.type ?? ''),
    );
    await logUsage('nominatim.nearby', true, res.status, latency, places.length, null, actorId);
    return places;
  } catch (err) {
    const latency = Date.now() - started;
    if ((err as Error).name === 'AbortError') {
      await logUsage('nominatim.nearby', false, null, latency, null, 'timeout', actorId);
      throw badRequest('The OpenStreetMap listing search timed out.');
    }
    if ((err as { status?: number }).status) throw err;
    await logUsage('nominatim.nearby', false, null, latency, null, 'network_error', actorId);
    throw badRequest('Could not reach OpenStreetMap.');
  } finally {
    clearTimeout(timer);
  }
}

function fromNominatim(place: NominatimPlace, origin: { lat: number; lng: number }): ClinicResult | null {
  const lat = Number(place.lat);
  const lng = Number(place.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const extra = place.extratags ?? {};
  const hours = extra.opening_hours ?? null;
  const address = place.address ?? {};
  const street = [address.house_number, address.road, address.suburb ?? address.neighbourhood]
    .filter(Boolean)
    .join(', ');
  const cityLine = [address.city ?? address.town ?? address.village, address.state, address.postcode]
    .filter(Boolean)
    .join(', ');
  const composed = [street, cityLine].filter(Boolean).join(', ');
  return {
    id: `osm-${place.osm_type ?? 'place'}/${place.osm_id ?? place.place_id}`,
    name: place.name || place.display_name?.split(',')[0] || 'Veterinary clinic (unnamed on OpenStreetMap)',
    address: composed || place.display_name || 'Address not listed on OpenStreetMap',
    latitude: lat,
    longitude: lng,
    phone: extra.phone ?? extra['contact:phone'] ?? null,
    website: extra.website ?? extra['contact:website'] ?? null,
    rating: null,
    reviewCount: null,
    openingHours: hours,
    placeId: null,
    directionsUrl: `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`,
    dataSource: 'openstreetmap',
    verificationStatus: 'listing_only',
    emergencyAvailable: extra.emergency === 'yes' || (hours ?? '').includes('24/7'),
    isDemo: false,
    distanceKm: haversineKm(origin.lat, origin.lng, lat, lng),
    speciesSupported: null,
    speciesNote:
      'Listing only, from OpenStreetMap. Confirm species, emergency cover and opening hours by phone before travelling.',
    bookableVetIds: [],
  };
}

/**
 * Nearby veterinary listings from OpenStreetMap. The two lookups run together:
 * Overpass carries richer tags, Nominatim answers far more reliably, and both
 * describe the same objects, so the merged list is deduplicated by OSM id.
 */
async function nearbyListings(
  origin: { lat: number; lng: number },
  radiusKm: number,
  actorId: string,
): Promise<ClinicResult[]> {
  const merged = new Map<string, ClinicResult>();
  const failures: string[] = [];
  let answered = 0;

  const overpassTask = overpassNearby(origin, radiusKm, actorId).then(
    (rows) => {
      answered += 1;
      return rows;
    },
    (err: Error) => {
      failures.push(`overpass: ${err.message}`);
      return null;
    },
  );
  const nominatimTask = nominatimNearby(origin, radiusKm, actorId).then(
    (rows) => {
      answered += 1;
      return rows;
    },
    (err: Error) => {
      failures.push(`nominatim: ${err.message}`);
      return null;
    },
  );

  // Nominatim usually answers in about a second. Once it has listings, give
  // Overpass only a short grace period for its richer tags instead of holding
  // the owner for the full mirror timeout.
  const nominatimRows = await nominatimTask;
  if (nominatimRows) {
    for (const place of nominatimRows) {
      const clinic = fromNominatim(place, origin);
      if (clinic) merged.set(clinic.id, clinic);
    }
  }

  const overpassRows = merged.size
    ? await Promise.race([
        overpassTask,
        new Promise<null>((resolve) => {
          setTimeout(() => resolve(null), 1_500).unref?.();
        }),
      ])
    : await overpassTask;
  if (overpassRows) {
    for (const element of overpassRows) {
      const clinic = fromOsm(element, origin);
      // Overpass wins on a tie: it carries hours, phone and the emergency flag.
      if (clinic) merged.set(clinic.id, clinic);
    }
  }

  // Nominatim searches a bounding box, whose corners reach beyond the radius.
  // Keep the promise the radius makes.
  const within = [...merged.values()].filter((clinic) => clinic.distanceKm == null || clinic.distanceKm <= radiusKm);
  if (within.length) return within;
  if (merged.size) return [];

  // Nothing found. Only claim the area is unmapped when a source actually
  // answered; otherwise the honest answer is that the lookup failed.
  if (answered > 0) return [];
  console.warn(`[maps] Both OpenStreetMap lookups failed: ${failures.join('; ') || 'no answer'}`);
  throw badRequest(
    'Could not reach OpenStreetMap for the hospital search. Please try again in a moment, or search by city.',
  );
}

function osmAddress(tags: Record<string, string>): string {
  const parts = [
    tags['addr:housenumber'], tags['addr:street'], tags['addr:suburb'] ?? tags['addr:neighbourhood'],
    tags['addr:city'] ?? tags['addr:town'] ?? tags['addr:village'], tags['addr:state'], tags['addr:postcode'],
  ].filter((part) => Boolean(part && part.trim()));
  return parts.length ? parts.join(', ') : 'Address not listed on OpenStreetMap';
}

function fromOsm(element: OsmElement, origin: { lat: number; lng: number } | null): ClinicResult | null {
  const tags = element.tags ?? {};
  const lat = element.lat ?? element.center?.lat;
  const lng = element.lon ?? element.center?.lon;
  if (lat == null || lng == null) return null;
  const hours = tags.opening_hours ?? null;
  return {
    id: `osm-${element.type}/${element.id}`,
    name: tags.name ?? tags['name:en'] ?? tags.operator ?? 'Veterinary clinic (unnamed on OpenStreetMap)',
    address: osmAddress(tags),
    latitude: lat,
    longitude: lng,
    phone: tags.phone ?? tags['contact:phone'] ?? null,
    website: tags.website ?? tags['contact:website'] ?? null,
    rating: null,
    reviewCount: null,
    openingHours: hours,
    placeId: null,
    directionsUrl: `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`,
    dataSource: 'openstreetmap',
    verificationStatus: 'listing_only',
    emergencyAvailable: tags.emergency === 'yes' || (hours ?? '').includes('24/7'),
    isDemo: false,
    distanceKm: origin ? haversineKm(origin.lat, origin.lng, lat, lng) : null,
    speciesSupported: null,
    speciesNote:
      'Listing only, from OpenStreetMap. Confirm species, emergency cover and opening hours by phone before travelling.',
    bookableVetIds: [],
  };
}

// ── Attach bookable vets for each clinic (via approved associations) ──
async function attachBookableVets(results: ClinicResult[]): Promise<ClinicResult[]> {
  const placeIds = results.map((r) => r.placeId).filter((p): p is string => Boolean(p));
  if (!placeIds.length) return results;
  const links = await many<{ place_id: string; vet_user_id: string }>(
    `SELECT ca.place_id, ca.vet_user_id
     FROM clinic_associations ca
     JOIN vet_profiles vp ON vp.user_id = ca.vet_user_id
     JOIN users u ON u.id = ca.vet_user_id
     WHERE ca.status = 'approved' AND vp.verification_status = 'verified' AND u.disabled = false
       AND ca.place_id = ANY($1)`,
    [placeIds],
  );
  const byPlace = new Map<string, string[]>();
  for (const l of links) {
    const arr = byPlace.get(l.place_id) ?? [];
    arr.push(l.vet_user_id);
    byPlace.set(l.place_id, arr);
  }
  return results.map((r) => (r.placeId ? { ...r, bookableVetIds: byPlace.get(r.placeId) ?? [] } : r));
}

// ── Public entry points ─────────────────────────────────────────
export interface SearchParams {
  lat?: number;
  lng?: number;
  city?: string;
  q?: string;
  radiusKm?: number;
  limit?: number;
}

export async function searchClinics(params: SearchParams, actorId: string): Promise<{
  clinics: ClinicResult[];
  source: 'google_places' | 'openstreetmap' | 'none';
  configured: boolean;
  notice: string;
  attribution: { text: string; url: string } | null;
  origin: { lat: number; lng: number } | null;
}> {
  consumeRate(actorId);
  const initialOrigin = params.lat != null && params.lng != null ? { lat: params.lat, lng: params.lng } : null;
  const city = (params.city ?? '').trim();
  const q = (params.q ?? '').trim();
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 50);
  const radiusKm = Math.min(Math.max(params.radiusKm ?? 10, 1), 50);
  const speciesHint = 'veterinary clinic animal hospital pet doctor';
  const query = q ? `${q} ${speciesHint}` : speciesHint;

  if (mapsConfigured()) {
    const { places } = await googleTextSearch(
      initialOrigin ? `${query} near ${initialOrigin.lat},${initialOrigin.lng}` : city ? `${query} in ${city}` : query,
      initialOrigin,
      radiusKm * 1000,
      actorId,
    );
    const results = places.slice(0, limit).map((p) => toResult(p, initialOrigin));
    return {
      clinics: await attachBookableVets(results),
      source: 'google_places',
      configured: true,
      notice:
        'Results come from the Google Places API. A listing is not a Pet Vet AI verification. Coverage varies by area — this is not a complete register of Indian veterinary facilities.',
      attribution: { text: 'Powered by Google', url: 'https://maps.google.com' },
      origin: initialOrigin,
    };
  }

  if (!config.nearby.enabled) {
    return {
      clinics: [],
      source: 'none',
      configured: false,
      notice: MAPS_SETUP_MESSAGE,
      attribution: null,
      origin: initialOrigin,
    };
  }

  // Free OpenStreetMap lookup: coordinates from the browser when shared,
  // otherwise geocoded from the city or area the owner typed.
  let origin = initialOrigin;
  let resolvedFrom = '';
  if (!origin) {
    const place = (city || q).trim();
    if (!place) throw badRequest('Share your location or enter a city to search for nearby hospitals.');
    const geo = await nominatimGeocode(place, actorId);
    if (!geo) throw badRequest(`Could not find "${place}". Try a city name or a PIN code.`);
    origin = { lat: geo.lat, lng: geo.lng };
    resolvedFrom = geo.formatted;
  }
  const centre = origin;

  let results: ClinicResult[] = await nearbyListings(centre, radiusKm, actorId);

  // A typed search term narrows the mapped results; it never invents any.
  if (q) {
    const terms = q.toLowerCase().split(/\s+/).filter((term) => term.length > 2);
    const matched = results.filter((clinic) =>
      terms.every((term) => `${clinic.name} ${clinic.address}`.toLowerCase().includes(term)),
    );
    if (matched.length) results = matched;
  }

  results.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
  results = results.slice(0, limit);

  return {
    clinics: results,
    source: 'openstreetmap',
    configured: true,
    notice:
      `Veterinary clinics and hospitals mapped in OpenStreetMap within ${radiusKm} km of ` +
      `${resolvedFrom || 'your location'}. Mapping is community-maintained and incomplete — ` +
      'call ahead to confirm hours and emergency cover.',
    attribution: { text: '© OpenStreetMap contributors', url: 'https://www.openstreetmap.org/copyright' },
    origin,
  };
}
