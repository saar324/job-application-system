import { plainText } from "./text.js";

const AMOUNT = String.raw`([$€£]?\s*\d[\d,]*(?:\.\d+)?\s*[kK]?)`;
const RANGE = new RegExp(String.raw`\b(annual\s+)?(?:base\s+)?salary(?:\s+range)?\s*[:\-–]?\s*${AMOUNT}\s*(?:-|–|—|to)\s*${AMOUNT}\s*\b(USD|EUR|GBP|CAD|AUD)\b\s*(per\s+year|a\s+year|\/\s*year|annually|yearly)?`, "gi");

function amount(value) {
  const compact = value.replace(/[\s,$€£]/g, "").toLowerCase();
  const thousands = compact.endsWith("k");
  const number = Number(thousands ? compact.slice(0, -1) : compact);
  return Number.isFinite(number) ? number * (thousands ? 1000 : 1) : NaN;
}

function symbolMatchesCurrency(value, currency) {
  const symbol = value.match(/[$€£]/)?.[0];
  return !symbol || symbol === (currency === "EUR" ? "€" : currency === "GBP" ? "£" : "$");
}

// Only a labeled annual base salary with an explicit ISO currency is usable
// for the pay-floor gate. Benefits, bonuses, equity and unlabeled money stay unknown.
export function greenhouseAnnualSalary(content) {
  const text = plainText(content);
  const matches = [...text.matchAll(RANGE)].filter((match) => {
    const annualLabel = Boolean(match[1]);
    const annualSuffix = Boolean(match[5]);
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 18);
    return (annualLabel || annualSuffix) && !/\b(?:monthly|per\s+month|hourly|per\s+hour)\b/i.test(after);
  }).filter((match) => symbolMatchesCurrency(match[2], match[4].toUpperCase())
    && symbolMatchesCurrency(match[3], match[4].toUpperCase()))
    .map((match) => ({ minimum: amount(match[2]), maximum: amount(match[3]),
      currency: match[4].toUpperCase(), period: "year" }))
    .filter((entry) => entry.minimum >= 10_000 && entry.maximum <= 2_000_000
      && entry.minimum <= entry.maximum);
  if (!matches.length) return undefined;
  const first = matches[0];
  return matches.every((entry) => entry.minimum === first.minimum && entry.maximum === first.maximum
    && entry.currency === first.currency) ? first : undefined;
}
