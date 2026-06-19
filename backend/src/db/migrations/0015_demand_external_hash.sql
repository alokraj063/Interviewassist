-- Hash-gated change detection for demand sync.
--
-- Background: the demand-sync worker runs every few minutes and previously
-- bumped demands.updated_at on every UPDATE pass regardless of whether any
-- column actually changed. The Demands list UI shows updated_at as a
-- relative "x minutes ago" label, so every row read "1 minute ago" — the
-- column carried no information. MySQL job_postings has no native
-- updated_at, so we can't pass that signal through.
--
-- Instead, the worker computes a sha1 over the payload it's about to write
-- and stores it here. On the next sync, if the new hash matches, the
-- UPDATE skips the updated_at bump (the row's mtime stays anchored to the
-- last real change).
--
-- Skills/locations bridge content is folded into the hash so changes there
-- propagate to updated_at as well.

ALTER TABLE demands
  ADD COLUMN IF NOT EXISTS external_data_hash text;
