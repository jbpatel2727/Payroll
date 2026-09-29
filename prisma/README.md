# Database setup

The running application currently uses `src/data.json` as its active JSON datastore. The Prisma schema in `schema.prisma` is the relational model for a future SQLite migration and is not instantiated by `src/server.js`.

The JSON datastore is normalized on server startup/load: missing employee IDs are generated, legacy `salary` values are copied to `baseSalary`, and attendance/payroll employee references are repaired by employee name.

For a future Prisma migration, use the repository's installed Prisma CLI through `npx.cmd` on Windows and review the current Prisma version's available commands before migrating.
