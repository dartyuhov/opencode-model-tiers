export function mergeRegistries(existing, additions, options = {}) {
  return {
    options: { ...existing.options, ...options },
    tiers: { ...existing.tiers, ...additions },
  };
}

export function serializeRegistry(registry) {
  return `${JSON.stringify(registry, null, 2)}\n`;
}
