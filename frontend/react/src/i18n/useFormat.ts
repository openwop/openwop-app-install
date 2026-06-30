/**
 * React binding for the formatting layer. `useFormat()` subscribes the calling
 * component to the active language (via react-i18next) and returns the
 * {@link format} API, so it re-renders with re-localized numbers/dates the
 * moment the user switches locale. Non-component code imports `format.ts`
 * functions directly.
 */
import { useTranslation } from 'react-i18next';
import { format, type Formatter } from './format.js';

export function useFormat(): Formatter {
  useTranslation();
  return format;
}
