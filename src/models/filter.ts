export interface ModelQuotaItem {
  label: string;
  modelOrTier?: string;
  remainingFraction: number;
  resetTime: string;
  isExhausted: boolean;
}

export const PREFERRED_MODEL_ORDER: readonly string[] = [
  'Gemini 3.8 Flash (High)',
  'Gemini 3.1 Pro (High)',
  'Gemini 3.7 Flash (High)',
  'Gemini 3.6 Flash (High)',
  'Claude Sonnet 4.6 (Thinking)',
  'Claude Opus 4.6 (Thinking)'
];

/**
 * Filters and stabilizes model quota display list.
 * Rules:
 * 1. Only displays models containing "(High)" OR "(Thinking)".
 * 2. Hides "Low", "Medium", and other non-matching variants.
 * 3. Enforces permanent fixed order:
 *    1. Gemini 3.8 Flash (High)
 *    2. Gemini 3.1 Pro (High)
 *    3. Gemini 3.7 Flash (High)
 *    4. Gemini 3.6 Flash (High)
 *    5. Claude Sonnet 4.6 (Thinking)
 *    6. Claude Opus 4.6 (Thinking)
 * 4. Never reorders on percentage, reset time, or exhaustion status.
 * 5. Appends any future unknown High/Thinking models after the predefined list alphabetically.
 */
export function filterAndOrderModels(models: ModelQuotaItem[]): ModelQuotaItem[] {
  if (!models || !Array.isArray(models)) return [];

  // Filter only (High) or (Thinking) models; omit Low, Medium, etc.
  const filtered = models.filter(m => {
    if (!m || !m.label) return false;
    const label = m.label;
    return label.includes('(High)') || label.includes('(Thinking)');
  });

  // Sort strictly by predefined fixed sequence
  return filtered.sort((a, b) => {
    const idxA = PREFERRED_MODEL_ORDER.indexOf(a.label);
    const idxB = PREFERRED_MODEL_ORDER.indexOf(b.label);

    if (idxA !== -1 && idxB !== -1) {
      return idxA - idxB;
    }
    if (idxA !== -1) return -1;
    if (idxB !== -1) return 1;

    // Unknown High/Thinking models are placed after predefined models, sorted alphabetically
    return a.label.localeCompare(b.label);
  });
}
