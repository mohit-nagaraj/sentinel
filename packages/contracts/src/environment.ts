export type EnvironmentSource = Readonly<Record<string, string | undefined>>

export type SentinelEnvironment = Readonly<Record<string, never>>

export function loadEnvironment(
  _source: EnvironmentSource
): SentinelEnvironment {
  void _source
  return Object.freeze({})
}
