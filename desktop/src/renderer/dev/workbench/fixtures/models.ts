// Re-export for symmetry with the other fixture modules — the model catalog
// and the providers that own it are defined together in providers.ts because
// a CatalogRow's providerId has to reference a real ProviderRow.
export { catalog, providers } from './providers';
export type { CatalogRow, ProviderRow } from './providers';
