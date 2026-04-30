export const SUPPORTED_LANGUAGES = [
  'en-US',
  'ja-JP',
  'zh-CN',
  'zh-TW',
  'ko-KR',
  'de-DE',
  'fr-FR',
  'es-ES',
  'pt-BR',
  'it-IT',
  'ru-RU',
  'pl-PL',
  'tr-TR',
] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export function isSupportedLanguage(value: string): value is SupportedLanguage {
  return (SUPPORTED_LANGUAGES as ReadonlyArray<string>).includes(value);
}
