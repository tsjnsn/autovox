/**
 * Languages supported by OpenAI audio models (Whisper / TTS family).
 * gpt-audio-mini can narrate text in these languages; voices are English-optimized
 * but generally handle other languages well.
 */
export type OutputLanguage =
  | 'auto'
  | 'af'
  | 'ar'
  | 'hy'
  | 'az'
  | 'be'
  | 'bn'
  | 'bs'
  | 'bg'
  | 'ca'
  | 'zh'
  | 'hr'
  | 'cs'
  | 'da'
  | 'nl'
  | 'en'
  | 'et'
  | 'fi'
  | 'fr'
  | 'gl'
  | 'de'
  | 'el'
  | 'he'
  | 'hi'
  | 'hu'
  | 'is'
  | 'id'
  | 'it'
  | 'ja'
  | 'kn'
  | 'kk'
  | 'ko'
  | 'lv'
  | 'lt'
  | 'mk'
  | 'ms'
  | 'mr'
  | 'mi'
  | 'ne'
  | 'no'
  | 'fa'
  | 'pl'
  | 'pt'
  | 'ro'
  | 'ru'
  | 'sr'
  | 'sk'
  | 'sl'
  | 'es'
  | 'sw'
  | 'sv'
  | 'te'
  | 'tl'
  | 'ta'
  | 'th'
  | 'tr'
  | 'uk'
  | 'ur'
  | 'vi'
  | 'cy';

export const DEFAULT_OUTPUT_LANGUAGE: OutputLanguage = 'auto';

export const OUTPUT_LANGUAGES: { code: OutputLanguage; label: string }[] = [
  { code: 'auto', label: 'Auto (match article language)' },
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'it', label: 'Italian' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'nl', label: 'Dutch' },
  { code: 'pl', label: 'Polish' },
  { code: 'ru', label: 'Russian' },
  { code: 'uk', label: 'Ukrainian' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'zh', label: 'Chinese' },
  { code: 'ar', label: 'Arabic' },
  { code: 'hi', label: 'Hindi' },
  { code: 'tr', label: 'Turkish' },
  { code: 'vi', label: 'Vietnamese' },
  { code: 'th', label: 'Thai' },
  { code: 'id', label: 'Indonesian' },
  { code: 'sv', label: 'Swedish' },
  { code: 'da', label: 'Danish' },
  { code: 'no', label: 'Norwegian' },
  { code: 'fi', label: 'Finnish' },
  { code: 'cs', label: 'Czech' },
  { code: 'ro', label: 'Romanian' },
  { code: 'hu', label: 'Hungarian' },
  { code: 'el', label: 'Greek' },
  { code: 'he', label: 'Hebrew' },
  { code: 'fa', label: 'Persian' },
  { code: 'ur', label: 'Urdu' },
  { code: 'bn', label: 'Bengali' },
  { code: 'ta', label: 'Tamil' },
  { code: 'te', label: 'Telugu' },
  { code: 'kn', label: 'Kannada' },
  { code: 'mr', label: 'Marathi' },
  { code: 'ms', label: 'Malay' },
  { code: 'tl', label: 'Tagalog' },
  { code: 'sw', label: 'Swahili' },
  { code: 'af', label: 'Afrikaans' },
  { code: 'bg', label: 'Bulgarian' },
  { code: 'hr', label: 'Croatian' },
  { code: 'sr', label: 'Serbian' },
  { code: 'sk', label: 'Slovak' },
  { code: 'sl', label: 'Slovenian' },
  { code: 'lt', label: 'Lithuanian' },
  { code: 'lv', label: 'Latvian' },
  { code: 'et', label: 'Estonian' },
  { code: 'is', label: 'Icelandic' },
  { code: 'ca', label: 'Catalan' },
  { code: 'gl', label: 'Galician' },
  { code: 'cy', label: 'Welsh' },
  { code: 'hy', label: 'Armenian' },
  { code: 'az', label: 'Azerbaijani' },
  { code: 'be', label: 'Belarusian' },
  { code: 'bs', label: 'Bosnian' },
  { code: 'mk', label: 'Macedonian' },
  { code: 'kk', label: 'Kazakh' },
  { code: 'ne', label: 'Nepali' },
  { code: 'mi', label: 'Maori' },
];

/** English names for prompt / TTS instruction use. */
const LANGUAGE_NAMES: Record<Exclude<OutputLanguage, 'auto'>, string> = {
  af: 'Afrikaans',
  ar: 'Arabic',
  hy: 'Armenian',
  az: 'Azerbaijani',
  be: 'Belarusian',
  bn: 'Bengali',
  bs: 'Bosnian',
  bg: 'Bulgarian',
  ca: 'Catalan',
  zh: 'Chinese',
  hr: 'Croatian',
  cs: 'Czech',
  da: 'Danish',
  nl: 'Dutch',
  en: 'English',
  et: 'Estonian',
  fi: 'Finnish',
  fr: 'French',
  gl: 'Galician',
  de: 'German',
  el: 'Greek',
  he: 'Hebrew',
  hi: 'Hindi',
  hu: 'Hungarian',
  is: 'Icelandic',
  id: 'Indonesian',
  it: 'Italian',
  ja: 'Japanese',
  kn: 'Kannada',
  kk: 'Kazakh',
  ko: 'Korean',
  lv: 'Latvian',
  lt: 'Lithuanian',
  mk: 'Macedonian',
  ms: 'Malay',
  mr: 'Marathi',
  mi: 'Maori',
  ne: 'Nepali',
  no: 'Norwegian',
  fa: 'Persian',
  pl: 'Polish',
  pt: 'Portuguese',
  ro: 'Romanian',
  ru: 'Russian',
  sr: 'Serbian',
  sk: 'Slovak',
  sl: 'Slovenian',
  es: 'Spanish',
  sw: 'Swahili',
  sv: 'Swedish',
  te: 'Telugu',
  tl: 'Tagalog',
  ta: 'Tamil',
  th: 'Thai',
  tr: 'Turkish',
  uk: 'Ukrainian',
  ur: 'Urdu',
  vi: 'Vietnamese',
  cy: 'Welsh',
};

const LANGUAGE_CODES = new Set<string>(
  OUTPUT_LANGUAGES.map((l) => l.code),
);

export function coerceOutputLanguage(value: unknown): OutputLanguage {
  if (typeof value === 'string' && LANGUAGE_CODES.has(value)) {
    return value as OutputLanguage;
  }
  return DEFAULT_OUTPUT_LANGUAGE;
}

export function getLanguageName(code: OutputLanguage): string | null {
  if (code === 'auto') return null;
  return LANGUAGE_NAMES[code];
}

/** Comprehension prompt guidance for the chosen output language. */
export function comprehensionLanguageGuidance(code: OutputLanguage): string {
  if (code === 'auto') {
    return `Write the entire news report in the same language as the source article.
If the article mixes languages, use the dominant language.
Do not translate into English unless the article is primarily in English.`;
  }

  const name = LANGUAGE_NAMES[code];
  return `Write the entire news report in ${name}.
Translate all content from the source article into ${name} while preserving facts, names, numbers, and quotes.
Every string in the JSON output must be in ${name}.`;
}

/** TTS system-instruction fragment for the chosen output language. */
export function ttsLanguageInstruction(code: OutputLanguage): string {
  if (code === 'auto') {
    return 'Read the script aloud in the language the text is written in.';
  }
  return `Read the script aloud in ${LANGUAGE_NAMES[code]}.`;
}
