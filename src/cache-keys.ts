// Redis key layout used by the Schematic replicator, and read by every SDK
// running in replicator mode. Keep in sync with schematic-replicator/cache.go.
//
//   {prefix}flags:{version}:{flagKey}              -> flag JSON
//   {prefix}company:{version}:{companyId}          -> company JSON
//   {prefix}company:{version}:{key}:{value}        -> company ID (JSON string)
//   {prefix}user:{version}:{userId}                -> user JSON
//   {prefix}user:{version}:{key}:{value}           -> user ID (JSON string)
//
// Flag keys and lookup key/value pairs are lowercased. IDs are not.

export const DEFAULT_PREFIX = "schematic:";

export function flagKey(prefix: string, version: string, key: string): string {
  return `${prefix}flags:${version}:${key.toLowerCase()}`;
}

export function idKey(prefix: string, type: "company" | "user", version: string, id: string): string {
  return `${prefix}${type}:${version}:${id}`;
}

export function lookupKey(prefix: string, type: "company" | "user", version: string, key: string, value: string): string {
  return `${prefix}${type}:${version}:${key.toLowerCase()}:${value.toLowerCase()}`;
}
