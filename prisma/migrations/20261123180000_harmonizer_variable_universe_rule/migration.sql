-- A universe that can be computed (`{ variable, min }`, e.g. EDAD >= 15) on a canonical variable.
ALTER TABLE "harmonizer_canonical_variables" ADD COLUMN "universeRule" JSONB;
