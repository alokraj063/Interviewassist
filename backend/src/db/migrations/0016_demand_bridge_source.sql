-- Track origin of demand_skills / demand_locations rows so the OL sync
-- worker can refresh just its own rows without clobbering anything a
-- recruiter has added by hand.
--
-- Default 'manual' so existing rows survive untouched. New sync-driven
-- rows are written with source='offer_letter'; on the next sync the
-- worker DELETEs source='offer_letter' for the demand and re-inserts.

ALTER TABLE demand_skills
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';

ALTER TABLE demand_locations
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';
