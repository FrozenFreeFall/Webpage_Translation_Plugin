import { normalizeSettings } from './shared.js';
import { translateSegments as translateAiSegments } from './ai.js';
import { translateFreeSegments } from './free-translators.js';
import { translateLibreSegments } from './libretranslate.js';

export async function translateSegments(input, segments, options = {}) {
  // Only saved settings determine the destination; no automatic service fallback.
  const settings = normalizeSettings(input);
  if (settings.provider === 'ai') return translateAiSegments(settings, segments, options);
  if (settings.provider === 'libretranslate') return translateLibreSegments(settings, segments, options);
  return translateFreeSegments(settings, segments, options);
}
