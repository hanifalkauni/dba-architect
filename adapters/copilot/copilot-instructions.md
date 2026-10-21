# GitHub Copilot Custom Instructions: DBA-Architect

When assisting with database schemas, ORM models (Prisma, TypeORM, Drizzle, GORM, Eloquent, SQLAlchemy), SQL queries, and migrations:

1. **Precision Data Types**:
   - Never generate `FLOAT` or `DOUBLE` for currency/financial fields. Use `DECIMAL(18, 4)` or `NUMERIC(18, 4)`.
   - On MySQL InnoDB, prefer auto-increment integers or sequential UUIDv7 over random UUIDv4 as primary keys.

2. **Index Design**:
   - Automatically suggest composite indexes ordered by ESR: Equality columns first, followed by Sort columns, followed by Range columns.
   - Ensure child foreign key columns have indexes.
   - Do not create single-column indexes that are already left-prefixes of existing composite indexes.

3. **Query Sargability & N+1 Prevention**:
   - Write queries so predicates are sargable (avoid `WHERE DATE(col) = ...`, use range checks `WHERE col >= ... AND col < ...`).
   - Identify loops that execute individual database queries inside them and rewrite them using batch loading (`IN (?)`) or ORM eager loading (`with`, `include`, `Preload`).

4. **Transaction Safety**:
   - If balance or inventory checks occur before an update, suggest `SELECT ... FOR UPDATE` within the transaction block.
   - Keep network requests, email sending, and payment API calls completely outside of transaction blocks.
