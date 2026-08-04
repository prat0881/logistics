// Static reference lists for the FF Master (Technical Design O-S4-2).
// An admin-managed screen is deferred; this is the MVP static set, easily extended.

export const COUNTRIES = [
  { code: "US", name: "United States" }, { code: "CA", name: "Canada" },
  { code: "MX", name: "Mexico" }, { code: "BR", name: "Brazil" },
  { code: "AR", name: "Argentina" }, { code: "CL", name: "Chile" },
  { code: "GB", name: "United Kingdom" }, { code: "IE", name: "Ireland" },
  { code: "FR", name: "France" }, { code: "DE", name: "Germany" },
  { code: "NL", name: "Netherlands" }, { code: "BE", name: "Belgium" },
  { code: "ES", name: "Spain" }, { code: "PT", name: "Portugal" },
  { code: "IT", name: "Italy" }, { code: "CH", name: "Switzerland" },
  { code: "AT", name: "Austria" }, { code: "SE", name: "Sweden" },
  { code: "NO", name: "Norway" }, { code: "DK", name: "Denmark" },
  { code: "FI", name: "Finland" }, { code: "PL", name: "Poland" },
  { code: "CZ", name: "Czechia" }, { code: "HU", name: "Hungary" },
  { code: "RO", name: "Romania" }, { code: "GR", name: "Greece" },
  { code: "TR", name: "Turkey" }, { code: "RU", name: "Russia" },
  { code: "AE", name: "United Arab Emirates" }, { code: "SA", name: "Saudi Arabia" },
  { code: "QA", name: "Qatar" }, { code: "KW", name: "Kuwait" },
  { code: "BH", name: "Bahrain" }, { code: "OM", name: "Oman" },
  { code: "IL", name: "Israel" }, { code: "EG", name: "Egypt" },
  { code: "ZA", name: "South Africa" }, { code: "NG", name: "Nigeria" },
  { code: "KE", name: "Kenya" }, { code: "MA", name: "Morocco" },
  { code: "IN", name: "India" }, { code: "PK", name: "Pakistan" },
  { code: "BD", name: "Bangladesh" }, { code: "LK", name: "Sri Lanka" },
  { code: "CN", name: "China" }, { code: "HK", name: "Hong Kong" },
  { code: "TW", name: "Taiwan" }, { code: "JP", name: "Japan" },
  { code: "KR", name: "South Korea" }, { code: "SG", name: "Singapore" },
  { code: "MY", name: "Malaysia" }, { code: "TH", name: "Thailand" },
  { code: "VN", name: "Vietnam" }, { code: "ID", name: "Indonesia" },
  { code: "PH", name: "Philippines" }, { code: "AU", name: "Australia" },
  { code: "NZ", name: "New Zealand" },
] as const;

export type CountryCode = (typeof COUNTRIES)[number]["code"];
export const COUNTRY_CODES = COUNTRIES.map((c) => c.code) as [CountryCode, ...CountryCode[]];

export const CURRENCIES = [
  { code: "USD", name: "US Dollar" }, { code: "EUR", name: "Euro" },
  { code: "GBP", name: "British Pound" }, { code: "JPY", name: "Japanese Yen" },
  { code: "CNY", name: "Chinese Yuan" }, { code: "HKD", name: "Hong Kong Dollar" },
  { code: "INR", name: "Indian Rupee" }, { code: "AED", name: "UAE Dirham" },
  { code: "SAR", name: "Saudi Riyal" }, { code: "QAR", name: "Qatari Riyal" },
  { code: "KWD", name: "Kuwaiti Dinar" }, { code: "SGD", name: "Singapore Dollar" },
  { code: "MYR", name: "Malaysian Ringgit" }, { code: "THB", name: "Thai Baht" },
  { code: "IDR", name: "Indonesian Rupiah" }, { code: "PHP", name: "Philippine Peso" },
  { code: "KRW", name: "South Korean Won" }, { code: "TWD", name: "Taiwan Dollar" },
  { code: "AUD", name: "Australian Dollar" }, { code: "NZD", name: "New Zealand Dollar" },
  { code: "CAD", name: "Canadian Dollar" }, { code: "CHF", name: "Swiss Franc" },
  { code: "SEK", name: "Swedish Krona" }, { code: "NOK", name: "Norwegian Krone" },
  { code: "DKK", name: "Danish Krone" }, { code: "ZAR", name: "South African Rand" },
  { code: "BRL", name: "Brazilian Real" }, { code: "TRY", name: "Turkish Lira" },
  { code: "PLN", name: "Polish Zloty" }, { code: "EGP", name: "Egyptian Pound" },
] as const;

export type CurrencyCode = (typeof CURRENCIES)[number]["code"];
export const CURRENCY_CODES = CURRENCIES.map((c) => c.code) as [CurrencyCode, ...CurrencyCode[]];

const COUNTRY_NAME_BY_CODE: Map<string, string> = new Map(COUNTRIES.map((c) => [c.code, c.name]));
export function getCountryName(code: string): string {
  return COUNTRY_NAME_BY_CODE.get(code) ?? code;
}

// Common colloquial abbreviations/variants that differ from the canonical name,
// so legacy free-text like "UK"/"USA"/"UAE"/"Czech Republic" still resolves.
const COUNTRY_ALIASES: Record<string, CountryCode> = {
  UK: "GB",
  "U.K.": "GB",
  BRITAIN: "GB",
  "GREAT BRITAIN": "GB",
  ENGLAND: "GB",
  USA: "US",
  "U.S.": "US",
  "U.S.A.": "US",
  AMERICA: "US",
  UAE: "AE",
  "U.A.E.": "AE",
  "CZECH REPUBLIC": "CZ",
  HOLLAND: "NL",
  KOREA: "KR",
};

// Keyed by the uppercased ISO code, the uppercased full name, AND common aliases,
// so a free-text country (code, name, or common abbreviation, any case) resolves.
const COUNTRY_CODE_BY_KEY: Map<string, CountryCode> = new Map([
  ...COUNTRIES.flatMap(
    (c) =>
      [
        [c.code.toUpperCase(), c.code],
        [c.name.toUpperCase(), c.code],
      ] as [string, CountryCode][],
  ),
  ...Object.entries(COUNTRY_ALIASES).map(([k, v]) => [k.toUpperCase(), v] as [string, CountryCode]),
]);

/**
 * Resolve a free-text country value — an ISO 2-letter code OR a full country
 * name, in any case — to its canonical ISO code. Returns null for empty or
 * unknown input.
 *
 * Bridges legacy free-text `Point.country` values (e.g. "United Kingdom",
 * entered via the point editor's plain-text field) to the ISO codes used by
 * `FreightForwarder.availableCountries`, so RFQ eligibility can compare them.
 */
export function resolveCountryCode(input: string | null | undefined): CountryCode | null {
  if (!input) return null;
  return COUNTRY_CODE_BY_KEY.get(input.trim().toUpperCase()) ?? null;
}
