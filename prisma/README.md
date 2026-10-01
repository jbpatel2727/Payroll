# Database setup

The running application uses two separate data stores:

- **Employees, attendance, payroll, branches, departments, settings** — `src/data.json` / `src/payroll.sqlite` via `src/database.js` (a JSON blob per collection). Not modeled in Prisma.
- **Users, Roles, Permissions** (RBAC, added in Phase 1) — a MongoDB database via Prisma (`schema.prisma`), accessed through `src/prisma.js`. Requires a `DATABASE_URL` env var (a `mongodb+srv://...` connection string) — see `.env` locally, or the project's Vercel environment variables in production.

MongoDB doesn't use SQL-style migrations — after changing `schema.prisma`, run `npx prisma db push` to sync the schema to the database, then `npx prisma generate` to regenerate the client.

Prisma 7 does not yet support MongoDB, so this project is pinned to `prisma@6.19.3` / `@prisma/client@6.19.3` until that changes.

The JSON datastore is normalized on server startup/load: missing employee IDs are generated, legacy `salary` values are copied to `baseSalary`, and attendance/payroll employee references are repaired by employee name.
