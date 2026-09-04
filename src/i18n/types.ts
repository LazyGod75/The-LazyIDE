export type Locale = 'fr' | 'en' | 'es' | 'zh' | 'de' | 'ja';

export interface LocaleMeta {
  code: Locale;
  label: string;
  flag: string;
}

export const LOCALES: LocaleMeta[] = [
  { code: 'fr', label: 'Français', flag: '🇫🇷' },
  { code: 'en', label: 'English', flag: '🇬🇧' },
  { code: 'es', label: 'Español', flag: '🇪🇸' },
  { code: 'zh', label: '中文', flag: '🇨🇳' },
  { code: 'de', label: 'Deutsch', flag: '🇩🇪' },
  { code: 'ja', label: '日本語', flag: '🇯🇵' },
];

export const DEFAULT_LOCALE: Locale = 'fr';

export type TranslationDict = Record<string, string>;
