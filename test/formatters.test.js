import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatForecast,
  formatBusArrivals,
  haversineMetres,
  formatPlaces,
  CT_HUB_2,
} from "../src/tools.js";
import { formatSingaporeTime } from "../src/prompt.js";

test("formatPlaces keeps open status and drops places beyond the radius", () => {
  const places = [
    {
      displayName: { text: "Near and open" },
      rating: 4.2,
      location: { latitude: 1.3073, longitude: 103.8631 },
      currentOpeningHours: { openNow: true },
    },
    {
      displayName: { text: "Near and closed" },
      location: { latitude: 1.3115, longitude: 103.8620 },
      currentOpeningHours: { openNow: false },
    },
    {
      displayName: { text: "Bedok, too far" },
      rating: 4.8,
      location: { latitude: 1.3236, longitude: 103.9273 },
      currentOpeningHours: { openNow: true },
    },
    { displayName: { text: "No location" } },
  ];

  const result = formatPlaces(places, CT_HUB_2, 800);
  assert.deepEqual(result.map((p) => [p.name, p.open_now, p.rating]), [
    ["Near and open", true, 4.2],
    ["Near and closed", false, null],
  ]);
  assert.ok(result[0].distance_m > 400 && result[0].distance_m < 550);
});

test("formatPlaces reports unknown open status as null", () => {
  const [place] = formatPlaces(
    [{ displayName: { text: "X" }, location: CT_HUB_2 }],
    CT_HUB_2,
  );
  assert.equal(place.open_now, null);
  assert.equal(place.distance_m, 0);
});

test("formatSingaporeTime converts UTC to SGT, including the day", () => {
  // 04:30 UTC is 12:30 pm in Singapore.
  assert.match(formatSingaporeTime(new Date("2026-11-20T04:30:00Z")), /Friday.*20 November 2026.*12:30\s?pm SGT/i);
  // 16:30 UTC Friday is already 00:30 Saturday in Singapore.
  assert.match(formatSingaporeTime(new Date("2026-11-20T16:30:00Z")), /Saturday.*21 November 2026.*12:30\s?am SGT/i);
});

test("formatForecast picks the requested area", () => {
  const payload = {
    data: {
      items: [
        {
          valid_period: { text: "12 pm to 2 pm" },
          forecasts: [
            { area: "Geylang", forecast: "Fair" },
            { area: "Kallang", forecast: "Light Rain" },
          ],
        },
      ],
    },
  };

  assert.deepEqual(formatForecast(payload, "Kallang"), {
    area: "Kallang",
    forecast: "Light Rain",
    valid_period: "12 pm to 2 pm",
  });
});

test("formatBusArrivals converts durations to whole minutes", () => {
  const payload = {
    services: [
      {
        no: "13",
        next: { duration_ms: 100_798 },
        subsequent: { duration_ms: 1_210_000 },
      },
      { no: "107M", next: { duration_ms: 30_000 }, subsequent: null },
    ],
  };

  assert.deepEqual(formatBusArrivals(payload, "07371"), {
    stop_code: "07371",
    services: [
      { service: "13", next_min: 2, subsequent_min: 20 },
      { service: "107M", next_min: 1, subsequent_min: null },
    ],
  });
});

test("haversineMetres measures CT Hub 2 to Lavender MRT at under 600 m", () => {
  const ctHub2 = { latitude: 1.3115, longitude: 103.8615 };
  const lavenderMrt = { latitude: 1.3073, longitude: 103.8631 };
  const distance = haversineMetres(ctHub2, lavenderMrt);
  assert.ok(distance > 400 && distance < 550, `got ${distance}`);
});
