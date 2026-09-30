export const ANTIGRAVITY_MODEL_IDS: ReadonlySet<string> = new Set([
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.1-pro',
  'gemini-3.1-flash-image',
  'claude-sonnet-4-6-thinking',
  'claude-opus-4-6-thinking',
  'gpt-oss-120b-medium',
])

interface SelectedModel {
  providerID: string
  id: string
}

export function isAntigravityModel(
  model: SelectedModel | null | undefined,
): boolean {
  return model?.providerID === 'google' && ANTIGRAVITY_MODEL_IDS.has(model.id)
}

export function quotaGroupForAntigravityModel(
  model: SelectedModel | null | undefined,
): 'gemini' | 'non-gemini' | undefined {
  if (!isAntigravityModel(model) || !model) return undefined
  return model.id.startsWith('gemini-') ? 'gemini' : 'non-gemini'
}
