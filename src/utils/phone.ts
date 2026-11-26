import { getCountries, parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';

/**
 * Numéros de téléphone : stockage au format international E.164 (+21623108065) lorsque le numéro est valide,
 * affichage lisible (+216 23 108 065). Un numéro non reconnu est CONSERVÉ tel quel et signalé « à vérifier » :
 * aucune valeur n'est devinée ni réécrite.
 */
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');

let byName: Map<string, CountryCode> | undefined;
function countryIndex() {
  if (byName) return byName;
  byName = new Map();
  const names = (['fr', 'en'] as const).map((l) => new Intl.DisplayNames([l], { type: 'region' }));
  for (const code of getCountries()) {
    for (const n of names) { const label = n.of(code); if (label) byName.set(fold(label), code); }
    byName.set(code.toLowerCase(), code);
  }
  const aliases: [string, CountryCode][] = [['tunisia', 'TN'], ['usa', 'US'], ['etatsunisdamerique', 'US'], ['uk', 'GB'], ['angleterre', 'GB'], ['grandebretagne', 'GB'], ['hollande', 'NL'], ['turkey', 'TR']];
  for (const [k, v] of aliases) byName.set(k, v);
  return byName;
}

/** Pays par défaut d'un numéro local : pays non renseigné → Tunisie ; pays renseigné mais inconnu → aucun (rien n'est présumé). */
export function phoneCountry(country: string | null | undefined): CountryCode | undefined {
  const k = fold(country ?? '');
  return k ? countryIndex().get(k) : 'TN';
}

function parse(raw: string, country?: string | null) {
  const defaultCountry = phoneCountry(country);
  const n = parsePhoneNumberFromString(raw.trim(), { ...(defaultCountry && { defaultCountry }), extract: false });
  // Un poste (« poste 4 ») serait perdu au format E.164 : la saisie d'origine est conservée
  return n && n.isValid() && !n.ext ? n : undefined;
}

/** Valeur à enregistrer : E.164 si le numéro est reconnu, sinon la saisie d'origine (sans espaces de bord). */
export function normalizePhone<T extends string | null | undefined>(raw: T, country?: string | null): T | string {
  if (!raw || !raw.trim()) return raw;
  return parse(raw, country)?.number ?? raw.trim();
}

export interface PhoneInfo { display: string; href: string; valid: boolean }

/** Représentation d'affichage d'un numéro enregistré (lien `tel:` compris). */
export function phoneInfo(raw: string | null | undefined, country?: string | null): PhoneInfo | null {
  if (!raw || !raw.trim()) return null;
  const n = parse(raw, country);
  if (n) return { display: n.formatInternational(), href: `tel:${n.number}`, valid: true };
  return { display: raw.trim(), href: `tel:${raw.replace(/[^\d+]/g, '')}`, valid: false };
}

export const phoneDisplay = (raw: string | null | undefined, country?: string | null) => phoneInfo(raw, country)?.display ?? '';
