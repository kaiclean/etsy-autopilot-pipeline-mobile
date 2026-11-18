// Tables live in schema-core (shops, catalog, listings, orders), schema-ops (runs, events, costs, settings, push,
// dead letters) and schema-brain (brain vault, themes, quotas). This facade keeps `@/db/schema` imports unchanged.
export * from "./schema-core";
export * from "./schema-ops";
export * from "./schema-brain";
