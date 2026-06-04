Backend tasks performed

- Added author_id and soft-delete handling on create (server sets author_id from req.user.id).
- Created DELETE /api/remedies/:id to perform soft-delete with permission checks (owner when draft or admin).
- Prepared database migration SQL (database/04_rls_and_columns.sql) to add columns and RLS policies.

Open items

- Run database/04_rls_and_columns.sql in Supabase SQL Editor (requires service role or project DB access).
- Ensure profiles table exists and on_auth_user_created trigger creates profile rows.
- Update supabase seed and migration flow to include this migration.
- Consider adding a restore/purge admin endpoint for soft-deleted items.
