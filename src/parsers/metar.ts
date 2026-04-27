// src/parsers/metar.ts
//
// METAR text parser.
//
// Used by all three METAR upstream fetchers (aviationweather JSON,
// aviationweather raw, NWS observations). Each fetcher discovers the raw
// METAR text from a different source; once they have the text, parsing is
// shared.
//
// METAR format reference:
//   METAR KLAX 261853Z 26012KT 10SM FEW040 21/13 A2992 RMK ...
//   ^prefix  ^id  ^time  ^wind  ^vis ^sky    ^temp ^alt
//
// SPECI prefix (special non-routine report) is also accepted; the parsed
// shape is identical. The prefix ("METAR" or "SPECI", possibly preceded by
// "METAR" duplicated, or absent if the source already stripped it) is
// preserved verbatim in `raw_metar`.
//
// Field-level details follow ICAO Annex 3 / FAA AC 00-45H. We parse only
// the fields v1.2's RULE 2 schema requires:
//   wind: direction_deg, speed_kt, gust_kt, variable
//   atmosphere: visibility_sm, temperature_f, dewpoint_f, altimeter_inhg,
//               sea_level_pressure_mb, sky[]
//
// Anything else in the report (RVR, weather phenomena codes, runway state,
// trends, RMK section) is kept inside `raw_metar` but not parsed into
// structured fields. Reports needing that detail can pull from raw_metar.
//
// The parser is forgiving: partial reports yield partial output. Missing
// fields become undefined and the caller (fetcher) builds the
// MetarObservation's missing_fields/data_quality from what's present.

export interface ParsedMetar {
  // Identity
  station_id: string;            // ICAO code from the report itself
  observed_at: string;           // ISO 8601 UTC, derived from the DDHHMMZ token
  raw_metar: string;             // verbatim text including prefix if present

  // Wind
  wind_direction_deg: number | null;  // null when variable
  wind_speed_kt: number;
  wind_gust_kt: number | null;
  wind_variable: boolean;        // true for VRB or for V variation in ddd Vddd form
  wind_token_present: boolean;   // false if the METAR had no wind token at all

  // Atmosphere
  visibility_sm: number | null;
  temperature_f: number | null;  // converted from C
  dewpoint_f: number | null;     // converted from C
  altimeter_inhg: number | null;
  sea_level_pressure_mb: number | null;  // from RMK SLPxxx
  sky: SkyLayer[];

  // Diagnostics — populated when parsing encounters something it didn't fully
  // understand. Empty array on clean parses.
  parse_warnings: string[];
}

export interface SkyLayer {
  cover: SkyCover;
  altitude_ft: number;           // hundreds of feet, e.g. CLR/SKC layers omitted
}

export type SkyCover =
  | "FEW"   // 1-2 oktas
  | "SCT"   // 3-4 oktas
  | "BKN"   // 5-7 oktas
  | "OVC"   // 8 oktas
  | "VV";   // vertical visibility (obscured ceiling)

// =============================================================================
// Token regexes
// =============================================================================

// METAR/SPECI prefix is optional in some sources; ignore if present.
const PREFIX_REGEX = /^(METAR|SPECI)\s+/;

// 4-letter ICAO. We require it to be uppercase letters/digits (some ICAOs
// have a digit, e.g. K0G3 isn't standard but military/private fields exist).
const STATION_REGEX = /^([A-Z][A-Z0-9]{3})\s+/;

// Time: DDHHMMZ — day-of-month, hour, minute, "Z" for UTC.
const TIME_REGEX = /^(\d{2})(\d{2})(\d{2})Z\s+/;

// Optional AUTO/COR modifier — we don't surface it but skip past it.
const MODIFIER_REGEX = /^(AUTO|COR)\s+/;

// Wind: dddffKT or dddffGggKT, with VRB instead of ddd for variable.
// Speed/gust may be 2 or 3 digits.
//   VRB04KT
//   00000KT  (calm)
//   27015G25KT
//   270150KT (high speeds, 3-digit, e.g. typhoons)
const WIND_REGEX = /^(VRB|\d{3})(\d{2,3})(?:G(\d{2,3}))?(KT|MPS|KMH)\s+/;

// Wind direction variation: dddVddd, optional and follows the wind token.
//   240V300
const WIND_VARIATION_REGEX = /^(\d{3})V(\d{3})\s+/;

// Visibility: SM units in US METARs.
//   10SM
//   1 1/2SM
//   1/2SM
//   M1/4SM (less-than-quarter-mile)
//   9999  (international: meters, 9999 = 10km+)
const VISIBILITY_SM_REGEX = /^(M)?(\d+)(?:\s+(\d+)\/(\d+))?SM\s+/;
const VISIBILITY_FRAC_ONLY_REGEX = /^(M)?(\d+)\/(\d+)SM\s+/;
const VISIBILITY_METERS_REGEX = /^(\d{4})\s+/;

// Sky cover: COVALT or just CLR/SKC/NSC.
//   FEW040, SCT250, BKN012, OVC008
//   VV004  (obscured, vertical visibility 400 ft)
//   CLR, SKC, NSC, NCD  (clear / no significant cloud)
const SKY_LAYER_REGEX = /^(FEW|SCT|BKN|OVC|VV)(\d{3})(?:CB|TCU)?\s+/;
const SKY_CLEAR_REGEX = /^(CLR|SKC|NSC|NCD)\s+/;

// Temperature/dewpoint: TT/DD, where TT and DD are degrees C, optionally
// prefixed by M for negative.
//   21/13
//   M03/M07
const TEMP_DEWPOINT_REGEX = /^(M)?(\d{2})\/(M)?(\d{2})\s+/;

// Altimeter: inches of mercury, e.g. A2992 = 29.92 inHg.
const ALTIMETER_INHG_REGEX = /^A(\d{4})\s+/;

// QNH in hPa: Q1013, used in international METARs.
const ALTIMETER_HPA_REGEX = /^Q(\d{4})\s+/;

// Sea-level pressure from RMK: SLPxxx, where xxx is the last three digits
// of the pressure in tenths of millibars. SLP182 = 1018.2 mb.
// SLPNO appears when SLP is unavailable.
const SLP_REGEX = /\bSLP(\d{3})\b/;

// =============================================================================
// Parser
// =============================================================================

/**
 * Parse a single-line METAR text into structured fields.
 *
 * Throws if the text is so malformed that station_id or time can't be
 * extracted — those are the bare-minimum identifying fields. Anything else
 * missing yields undefined/null in the result with a parse_warnings entry.
 *
 * The text may include or exclude the METAR/SPECI prefix; both are accepted.
 */
export function parseMetar(rawText: string): ParsedMetar {
  const original = rawText.trim();

  // Normalize whitespace so token regexes can use trailing \s+.
  // Append a trailing space so the last-token regex still matches.
  let remaining = original.replace(/\s+/g, " ").trim() + " ";
  const parseWarnings: string[] = [];

  // Skip prefix if present.
  const prefixMatch = remaining.match(PREFIX_REGEX);
  if (prefixMatch) {
    remaining = remaining.slice(prefixMatch[0].length);
  }

  // Station ID — required.
  const stationMatch = remaining.match(STATION_REGEX);
  if (!stationMatch) {
    throw new Error(`METAR missing station identifier: ${original}`);
  }
  const stationId = stationMatch[1];
  remaining = remaining.slice(stationMatch[0].length);

  // Observation time — required.
  const timeMatch = remaining.match(TIME_REGEX);
  if (!timeMatch) {
    throw new Error(`METAR missing time token: ${original}`);
  }
  const observedAt = ddhhmmZToISO(
    parseInt(timeMatch[1], 10),
    parseInt(timeMatch[2], 10),
    parseInt(timeMatch[3], 10)
  );
  remaining = remaining.slice(timeMatch[0].length);

  // Optional AUTO/COR modifier.
  const modifierMatch = remaining.match(MODIFIER_REGEX);
  if (modifierMatch) {
    remaining = remaining.slice(modifierMatch[0].length);
  }

  // Wind — usually present, but a malformed report may lack it.
  let windDirectionDeg: number | null = null;
  let windSpeedKt = 0;
  let windGustKt: number | null = null;
  let windVariable = false;
  let windParsed = false;

  const windMatch = remaining.match(WIND_REGEX);
  if (windMatch) {
    const dirToken = windMatch[1];
    const speedRaw = parseInt(windMatch[2], 10);
    const gustRaw = windMatch[3] ? parseInt(windMatch[3], 10) : null;
    const unit = windMatch[4];

    if (dirToken === "VRB") {
      windDirectionDeg = null;
      windVariable = true;
    } else {
      windDirectionDeg = parseInt(dirToken, 10) % 360;
    }

    windSpeedKt = convertSpeedToKt(speedRaw, unit);
    windGustKt = gustRaw !== null ? convertSpeedToKt(gustRaw, unit) : null;
    windParsed = true;
    remaining = remaining.slice(windMatch[0].length);

    // Optional wind direction variation: dddVddd.
    const variationMatch = remaining.match(WIND_VARIATION_REGEX);
    if (variationMatch) {
      windVariable = true;
      remaining = remaining.slice(variationMatch[0].length);
    }
  } else {
    parseWarnings.push("wind token not found");
  }

  // Visibility.
  let visibilitySm: number | null = null;
  const vsmMatch = remaining.match(VISIBILITY_SM_REGEX);
  if (vsmMatch) {
    const lessThan = vsmMatch[1] === "M";
    const whole = parseInt(vsmMatch[2], 10);
    const fracNum = vsmMatch[3] ? parseInt(vsmMatch[3], 10) : 0;
    const fracDen = vsmMatch[4] ? parseInt(vsmMatch[4], 10) : 1;
    const value = whole + (fracDen > 0 ? fracNum / fracDen : 0);
    // M-prefix means "less than"; we surface the upper bound.
    visibilitySm = lessThan ? value : value;
    remaining = remaining.slice(vsmMatch[0].length);
  } else {
    const fracOnlyMatch = remaining.match(VISIBILITY_FRAC_ONLY_REGEX);
    if (fracOnlyMatch) {
      const num = parseInt(fracOnlyMatch[2], 10);
      const den = parseInt(fracOnlyMatch[3], 10);
      visibilitySm = den > 0 ? num / den : null;
      remaining = remaining.slice(fracOnlyMatch[0].length);
    } else {
      const metersMatch = remaining.match(VISIBILITY_METERS_REGEX);
      if (metersMatch) {
        const meters = parseInt(metersMatch[1], 10);
        // 9999 is the ICAO "10km or more" sentinel.
        visibilitySm = meters >= 9999 ? 10 : meters / 1609.344;
        // Round to 1 decimal for cleanliness.
        visibilitySm = Math.round(visibilitySm * 10) / 10;
        remaining = remaining.slice(metersMatch[0].length);
      }
    }
  }

  // Skip weather phenomena tokens (RA, TSRA, +SHRA, BR, FG, HZ, etc.).
  // We don't parse these into structured fields, but they sit between
  // visibility and sky cover. Strip a few obvious ones so the sky-cover
  // regex can match.
  remaining = stripWeatherTokens(remaining);

  // Sky cover — multiple layers possible.
  const sky: SkyLayer[] = [];
  while (true) {
    const clearMatch = remaining.match(SKY_CLEAR_REGEX);
    if (clearMatch) {
      // CLR/SKC/NSC/NCD: no layers.
      remaining = remaining.slice(clearMatch[0].length);
      break;
    }
    const layerMatch = remaining.match(SKY_LAYER_REGEX);
    if (!layerMatch) break;
    sky.push({
      cover: layerMatch[1] as SkyCover,
      altitude_ft: parseInt(layerMatch[2], 10) * 100,
    });
    remaining = remaining.slice(layerMatch[0].length);
  }

  // Temperature / dewpoint.
  let temperatureF: number | null = null;
  let dewpointF: number | null = null;
  const tdMatch = remaining.match(TEMP_DEWPOINT_REGEX);
  if (tdMatch) {
    const tempC = parseInt(tdMatch[2], 10) * (tdMatch[1] === "M" ? -1 : 1);
    const dewC = parseInt(tdMatch[4], 10) * (tdMatch[3] === "M" ? -1 : 1);
    temperatureF = celsiusToFahrenheit(tempC);
    dewpointF = celsiusToFahrenheit(dewC);
    remaining = remaining.slice(tdMatch[0].length);
  }

  // Altimeter — A####### in inHg, or Q#### in hPa.
  let altimeterInhg: number | null = null;
  const altInhgMatch = remaining.match(ALTIMETER_INHG_REGEX);
  if (altInhgMatch) {
    altimeterInhg = parseInt(altInhgMatch[1], 10) / 100;
    remaining = remaining.slice(altInhgMatch[0].length);
  } else {
    const altHpaMatch = remaining.match(ALTIMETER_HPA_REGEX);
    if (altHpaMatch) {
      const hpa = parseInt(altHpaMatch[1], 10);
      altimeterInhg = Math.round((hpa / 33.8639) * 100) / 100;
      remaining = remaining.slice(altHpaMatch[0].length);
    }
  }

  // Sea-level pressure from RMK section. Search the entire remaining text
  // since RMK can have arbitrary token order before SLP appears.
  let seaLevelPressureMb: number | null = null;
  const slpMatch = remaining.match(SLP_REGEX);
  if (slpMatch) {
    const slpRaw = parseInt(slpMatch[1], 10);
    // SLP encoding: 3 digits in tenths of mb, prefixed implicitly with 9 or
    // 10 to give a value in roughly [950.0, 1049.9].
    //   xxx < 500 → 10xx.x  e.g. SLP132 → 1013.2
    //   xxx >= 500 → 9xx.x  e.g. SLP985 →  998.5
    // The xxx itself is in tenths, so divide-by-10 happens once after the
    // prefix is chosen.
    seaLevelPressureMb =
      slpRaw < 500 ? 1000 + slpRaw / 10 : 900 + slpRaw / 10;
    // Round to 1 decimal to drop floating-point cruft.
    seaLevelPressureMb = Math.round(seaLevelPressureMb * 10) / 10;
  }

  if (!windParsed) {
    // Already noted above.
  }

  return {
    station_id: stationId,
    observed_at: observedAt,
    raw_metar: original,
    wind_direction_deg: windDirectionDeg,
    wind_speed_kt: windSpeedKt,
    wind_gust_kt: windGustKt,
    wind_variable: windVariable,
    wind_token_present: windParsed,
    visibility_sm: visibilitySm,
    temperature_f: temperatureF,
    dewpoint_f: dewpointF,
    altimeter_inhg: altimeterInhg,
    sea_level_pressure_mb: seaLevelPressureMb,
    sky,
    parse_warnings: parseWarnings,
  };
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Convert METAR DDHHMMZ time token to an ISO 8601 UTC timestamp.
 *
 * METARs only encode day/hour/minute. The year and month must come from
 * "now" — METARs are observations, not historical records, so the report
 * is for the current month with rare wraparound at month boundaries.
 *
 * Wraparound rule: if the day-of-month in the report is greater than today's
 * day-of-month plus 1 (allowing for UTC-vs-local edge cases), assume the
 * report is from the previous month.
 */
function ddhhmmZToISO(day: number, hour: number, minute: number): string {
  const now = new Date();
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth(); // 0-indexed

  const todayDay = now.getUTCDate();
  if (day > todayDay + 1) {
    // Report day is later in the month than today — must be previous month.
    month -= 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
  }

  const reportDate = new Date(Date.UTC(year, month, day, hour, minute, 0, 0));
  return reportDate.toISOString();
}

function convertSpeedToKt(value: number, unit: string): number {
  if (unit === "KT") return value;
  if (unit === "MPS") return Math.round(value * 1.94384);
  if (unit === "KMH") return Math.round(value * 0.539957);
  return value;
}

function celsiusToFahrenheit(c: number): number {
  return Math.round((c * 9) / 5 + 32);
}

/**
 * Strip a small set of common weather-phenomena tokens that sit between
 * visibility and sky cover. We don't try to parse these — we just want them
 * out of the way so SKY_LAYER_REGEX can match.
 *
 * Phenomena tokens follow ICAO format with optional intensity (+/-/VC) and
 * descriptor + phenomenon characters.
 */
function stripWeatherTokens(text: string): string {
  // Tokens like RA, +SHRA, -SN, BR, FG, HZ, VCSH, TS, etc.
  // Match any token that's 2-7 letters with optional +/-/VC prefix and
  // contains common precipitation/obscuration codes. Liberal but bounded.
  const PHENOMENA_REGEX =
    /^(?:[+-]|VC)?(?:MI|PR|BC|DR|BL|SH|TS|FZ)?(?:DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS)+\s+/;
  let stripped = text;
  let safety = 0;
  while (safety++ < 6) {
    const match = stripped.match(PHENOMENA_REGEX);
    if (!match) break;
    stripped = stripped.slice(match[0].length);
  }
  return stripped;
}

// Helper exported for tests / debugging.
export const _internal = {
  ddhhmmZToISO,
  convertSpeedToKt,
  celsiusToFahrenheit,
  stripWeatherTokens,
};
