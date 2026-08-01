// ---------------------------------------------------------------------------
// Caption language helpers — ports CC_NAMES / CC_ALIAS / normCc / ccName from
// public/app.js (~1578-1587). Pure data + functions; the imperative cue
// rendering lives in watch-view.tsx (our-own-cue rendering into #ccBox).
// ---------------------------------------------------------------------------

export const CC_NAMES: Record<string, string> = {
  en: "English", ja: "Japanese", es: "Spanish", "es-la": "Spanish (LA)", pt: "Portuguese",
  "pt-br": "Portuguese (BR)", fr: "French", de: "German", it: "Italian", ru: "Russian", ar: "Arabic",
  zh: "Chinese", ko: "Korean", id: "Indonesian", ms: "Malay", vi: "Vietnamese", th: "Thai",
  tr: "Turkish", hi: "Hindi", pl: "Polish",
};

// Map 3-letter / regional codes to the 2-letter form so tracks tagged
// "eng"/"jpn" display cleanly and match the preferred-language setting.
export const CC_ALIAS: Record<string, string> = {
  eng: "en", en: "en", jpn: "ja", jp: "ja", ja: "ja", spa: "es", es: "es",
  fre: "fr", fra: "fr", fr: "fr", ger: "de", deu: "de", de: "de", por: "pt", pt: "pt",
  rus: "ru", ru: "ru", ara: "ar", ar: "ar", ita: "it", it: "it", kor: "ko", ko: "ko",
  chi: "zh", zho: "zh", zh: "zh",
};

export function normCc(lang: string | null | undefined): string {
  const l = (lang || "").toLowerCase();
  return CC_ALIAS[l] || l;
}

export function ccName(lang: string | null | undefined): string {
  const l = (lang || "").toLowerCase();
  return CC_NAMES[l] || CC_NAMES[normCc(l)] || (l ? l.toUpperCase() : "Unknown");
}
