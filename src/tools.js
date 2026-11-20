/**
 * Tool definitions and implementations for Lunch Uncle.
 *
 * Each tool is split in two: a fetch function that talks to the network,
 * and a pure format function that shapes the response for the model.
 * The format functions are the ones covered by tests.
 */

// CT Hub 2, 114 Lavender Street.
export const CT_HUB_2 = { latitude: 1.3115, longitude: 103.8615 };

const SEARCH_RADIUS_METRES = 800;
const MAX_PLACES = 10;
const FORECAST_AREA = "Kallang";

const FETCH_TIMEOUT_MS = 8_000;
// Results are cached per Worker isolate to save repeat API calls.
const PLACES_CACHE_MS = 10 * 60_000;
const FORECAST_CACHE_MS = 5 * 60_000;
const PLACES_CACHE_MAX = 50;

const PLACES_URL = "https://places.googleapis.com/v1/places:searchText";
const FORECAST_URL =
  "https://api-open.data.gov.sg/v2/real-time/api/two-hr-forecast";
const BUS_URL = "https://arrivelah2.busrouter.sg/";

// ---------------------------------------------------------------------------
// Definitions sent to the model
// ---------------------------------------------------------------------------

export const toolDefinitions = [
  {
    type: "function",
    function: {
      name: "find_lunch_places",
      description:
        "Search for places to eat near CT Hub 2. Returns name, rating, distance and whether it is open now.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              'What to search for, e.g. "chicken rice", "japanese", "cheap lunch".',
          },
          open_now: {
            type: "boolean",
            description: "Only return places that are open right now.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_rain_forecast",
      description:
        "Get the two-hour weather forecast for the Kallang area, which covers CT Hub 2.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_bus_arrivals",
      description:
        "Get the next bus arrivals at a Singapore bus stop, by five-digit stop code.",
      parameters: {
        type: "object",
        properties: {
          stop_code: {
            type: "string",
            description: 'Five-digit bus stop code, e.g. "07371".',
          },
        },
        required: ["stop_code"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Run one tool call requested by the model and return the result as a string.
 */
export async function executeTool(name, args, env) {
  try {
    switch (name) {
      case "find_lunch_places":
        return JSON.stringify(await findLunchPlaces(args, env));
      case "get_rain_forecast":
        return JSON.stringify(await getRainForecast());
      case "get_bus_arrivals":
        return JSON.stringify(await getBusArrivals(args));
      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (err) {
    // Hand failures back to the model as a tool error instead of failing the turn.
    console.error(`tool ${name} failed:`, err?.message ?? err);
    return JSON.stringify({ error: `${name} failed, try again later` });
  }
}

/**
 * fetch + JSON parse with a timeout. Returns { data } or { error }.
 */
async function fetchJson(url, init = {}, label) {
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    const reason = err?.name === "TimeoutError" ? "timed out" : "could not be reached";
    return { error: `${label} ${reason}` };
  }
  if (!res.ok) {
    return { error: `${label} returned ${res.status}` };
  }
  try {
    return { data: await res.json() };
  } catch {
    return { error: `${label} returned a response that was not JSON` };
  }
}

/**
 * Tiny time-based cache, scoped to one Worker isolate.
 */
function createCache(ttlMs, maxEntries = Infinity) {
  const entries = new Map();
  return {
    get(key) {
      const hit = entries.get(key);
      if (!hit) return undefined;
      if (Date.now() - hit.at > ttlMs) {
        entries.delete(key);
        return undefined;
      }
      return hit.value;
    },
    set(key, value) {
      if (entries.size >= maxEntries) {
        entries.delete(entries.keys().next().value);
      }
      entries.set(key, { value, at: Date.now() });
    },
  };
}

const placesCache = createCache(PLACES_CACHE_MS, PLACES_CACHE_MAX);
const forecastCache = createCache(FORECAST_CACHE_MS, 1);

// ---------------------------------------------------------------------------
// find_lunch_places
// ---------------------------------------------------------------------------

async function findLunchPlaces({ query, open_now = false }, env) {
  if (!env.GOOGLE_PLACES_API_KEY) {
    // Only this tool needs the key; rain and bus questions still work.
    console.error("GOOGLE_PLACES_API_KEY is not set; find_lunch_places is unavailable");
    return { error: "Place search is not set up right now. Do not make up places." };
  }
  if (typeof query !== "string" || !query.trim()) {
    return { error: "query is required, e.g. \"chicken rice\"" };
  }

  const openNow = open_now === true;
  const cacheKey = `${query.trim().toLowerCase()}|${openNow}`;
  const cached = placesCache.get(cacheKey);
  if (cached) return cached;

  const centre = CT_HUB_2;
  // No includedType: "restaurant" would drop hawker centres, food courts and cafes.
  const body = {
    textQuery: query.trim(),
    openNow,
    pageSize: MAX_PLACES,
    locationBias: {
      circle: { center: centre, radius: SEARCH_RADIUS_METRES },
    },
  };

  const { data, error } = await fetchJson(PLACES_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Goog-Api-Key": env.GOOGLE_PLACES_API_KEY,
      "X-Goog-FieldMask":
        "places.displayName,places.location,places.rating,places.currentOpeningHours.openNow",
    },
    body: JSON.stringify(body),
  }, "Places API");
  if (error) return { error };

  const result = { places: formatPlaces(data?.places ?? [], centre, SEARCH_RADIUS_METRES) };
  placesCache.set(cacheKey, result);
  return result;
}

/**
 * Shape Places API results into the fields Uncle needs.
 * locationBias only nudges ranking, so places farther than maxDistance
 * (or without a location) are dropped here.
 */
export function formatPlaces(places, origin, maxDistance = Infinity) {
  return places
    .filter(({ location }) => location)
    .map(({ displayName, rating, location, currentOpeningHours }) => ({
      name: displayName?.text ?? "Unnamed",
      rating: rating ?? null,
      distance_m: Math.round(haversineMetres(origin, location)),
      open_now: currentOpeningHours?.openNow ?? null,
    }))
    .filter(({ distance_m }) => distance_m <= maxDistance);
}

/**
 * Great-circle distance between two {latitude, longitude} points, in metres.
 */
export function haversineMetres(a, b) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---------------------------------------------------------------------------
// get_rain_forecast
// ---------------------------------------------------------------------------

async function getRainForecast() {
  const cached = forecastCache.get(FORECAST_AREA);
  if (cached) return cached;

  const { data, error } = await fetchJson(FORECAST_URL, {}, "Forecast API");
  if (error) return { error };

  const result = formatForecast(data, FORECAST_AREA);
  if (!result.error) forecastCache.set(FORECAST_AREA, result);
  return result;
}

/**
 * Pull one area's forecast out of the data.gov.sg two-hour forecast payload.
 */
export function formatForecast(payload, area) {
  const item = payload?.data?.items?.[0];
  if (!item || !Array.isArray(item.forecasts)) {
    return { error: "No forecast available" };
  }
  const entry = item.forecasts.find((f) => f?.area === area);
  if (!entry?.forecast) {
    return { error: `No forecast for ${area} right now` };
  }
  return {
    area,
    forecast: entry.forecast,
    valid_period: item.valid_period?.text ?? null,
  };
}

// ---------------------------------------------------------------------------
// get_bus_arrivals
// ---------------------------------------------------------------------------

async function getBusArrivals({ stop_code }) {
  const code = normaliseStopCode(stop_code);
  if (!code) {
    return { error: "stop_code must be a five-digit bus stop code, e.g. \"07371\"" };
  }
  const { data, error } = await fetchJson(`${BUS_URL}?id=${code}`, {}, "Bus API");
  if (error) return { error };
  return formatBusArrivals(data, code);
}

/**
 * Turn a model-supplied stop code into five digits, restoring a leading
 * zero lost when it was sent as a number (7371 -> "07371").
 * Returns null when it cannot be a valid code.
 */
export function normaliseStopCode(value) {
  const text = typeof value === "number" && Number.isInteger(value) ? String(value)
    : typeof value === "string" ? value.trim() : "";
  if (!/^\d{1,5}$/.test(text)) return null;
  return text.padStart(5, "0");
}

/**
 * Reduce an arrivelah response to service numbers and minutes to arrival.
 */
export function formatBusArrivals(payload, stopCode) {
  const services = payload?.services ?? [];
  return {
    stop_code: stopCode,
    services: services.map((s) => ({
      service: s.no,
      next_min: minutesFromNow(s.next),
      subsequent_min: minutesFromNow(s.subsequent),
    })),
  };
}

function minutesFromNow(arrival) {
  if (!arrival || typeof arrival.duration_ms !== "number") {
    return null;
  }
  return Math.max(0, Math.round(arrival.duration_ms / 60000));
}
