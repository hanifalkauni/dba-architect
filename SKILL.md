---
name: dba-architect
description: Principal Database Administrator (DBA) & Data Architecture skill agent for PostgreSQL & MySQL. Autonomously audits SQL migrations, optimizes composite/covering/partial B-Tree indexes using ESR rules, scans codebases for ORM queries & N+1 loops, visualizes EXPLAIN ANALYZE plans in Mermaid, plans zero-downtime Expand & Contract migrations, detects transaction race conditions/deadlocks, designs declarative table partitioning, and calculates storage/RAM capacity & postgresql.conf / my.cnf tuning.
---

# DBA Architect (`dba-architect`) — Principal DBA & Data Architecture Playbook

Universal AI Companion Skill & MCP Protocol Agent for **PostgreSQL (v14–v17+)** and **MySQL / MariaDB (InnoDB v8.0+)**.

Use this skill whenever the user asks to:
- Audit SQL migrations, `CREATE TABLE` / `ALTER TABLE` DDL, or schema design for **PostgreSQL** or **MySQL / MariaDB**.
- Optimize slow SQL queries, design B-Tree / Covering (`INCLUDE`) / Partial (`WHERE`) / Expression indexes, or eliminate redundant left-prefix indexes.
- Scan a repository (Go, PHP/Laravel, TypeScript/Prisma/Drizzle, Python) to profile database queries, consolidate table indexes, or detect **N+1 query loops**.
- Diagnose `EXPLAIN` or `EXPLAIN (ANALYZE, BUFFERS)` output and visualize execution plans with **Mermaid flowcharts**.
- Plan **Zero-Downtime Migrations** (*Expand & Contract*, `CONCURRENTLY`, `NOT VALID` -> `VALIDATE`, `ALGORITHM=INPLACE/INSTANT`, `gh-ost`).
- Audit database transactions for **Lost Update race conditions** (`SELECT ... FOR UPDATE`), external HTTP calls inside transactions, or deadlocks.
- Design **Declarative Table Partitioning** (`RANGE`, `LIST`, `HASH`) & zero-bloat data retention/archiving.
- Estimate physical row/table/index memory footprint and tune `postgresql.conf` or `my.cnf`.

---

## 1. Available Deterministic MCP Tools (`dba-architect` Server)

Always prefer invoking deterministic `dba-architect` MCP tools over pure LLM guessing:

| # | MCP Tool Name | Primary Purpose & Triggers |
| :--- | :--- | :--- |
| **1** | `analyze_migration` | Audits raw DDL SQL, migration files, or migration folders for `SCHEMA-*` anti-patterns and calculates the Schema Health Score (0–100). |
| **2** | `recommend_indexes_for_queries` | Designs optimal composite/covering/partial/expression indexes via **ESR (Equality, Sort, Range)** rules, flags non-sargable predicates (`INDEX-SARG-*`), and detects redundant indexes (`INDEX-REDUNDANT-001`). |
| **3** | `scan_project_queries` | Scans a service/repository directory for raw SQL + ORM queries, detects N+1 loops (`CODE-NPLUS1-001`), and synthesizes table-level index consolidation. |
| **4** | `analyze_explain_plan` | Parses PostgreSQL or MySQL `EXPLAIN` / `EXPLAIN ANALYZE` output (text or JSON) to pinpoint bottlenecks (`EXPLAIN-*`) and renders a Mermaid flowchart. |
| **5** | `plan_zero_downtime_migration` | Converts dangerous `ALTER TABLE` / `CREATE INDEX` statements into safe multi-phase Expand & Contract production runbooks. |
| **6** | `analyze_transaction_and_locking` | Audits SQL or application transaction blocks (`db.Transaction`, `DB::transaction`, `prisma.$transaction`) for race conditions (`TX-RACE-001`), HTTP I/O in transactions (`TX-IO-001`), and deadlocks (`TX-DEADLOCK-001`). |
| **7** | `recommend_partitioning_and_archiving` | Designs `RANGE`/`LIST`/`HASH` partitioning for tables >10M rows, enforces `PART-PK-001` composite PK rules, and writes `DETACH`/`DROP PARTITION` archiving runbooks. |
| **8** | `calculate_db_capacity_and_config` | Calculates tuple header overhead, table/index GB footprint, RAM buffer fit, and generates tuned `postgresql.conf` or `my.cnf` configs. |

---

## 2. Standard Operating Procedure (5-Step Principal DBA Workflow)

### Step 1: Identify Dialect & Schema Context
1. Determine whether the target database is `postgresql` or `mysql` (check `docker-compose.yml`, `.env.example`, `schema.prisma`, `database.php`, or `go.mod` drivers if not explicitly stated by the user).
2. Locate existing migration files or schema DDL so index and workload tools have full table/PK context.

### Step 2: Schema Audit & Zero-Downtime Safety
1. Call `analyze_migration` on the target SQL/migration files (`strictness: "strict"` for thorough review).
2. If any `CRITICAL` or `WARNING` issues are found—or if the migration alters an existing production table—call `plan_zero_downtime_migration` to generate a non-blocking **Expand & Contract** runbook.

### Step 3: Codebase Workload Profiling, N+1 & Transaction Concurrency Audit
1. When optimizing an existing project, call `scan_project_queries` with `project_root_path` and `migration_files_dir` (or `existing_schema_ddl`).
2. Review all `CODE-NPLUS1-001` findings and `holistic_table_strategies`.
3. For critical transactional paths (wallets, payments, inventory, orders, quotas), call `analyze_transaction_and_locking` on the service files to verify pessimistic locking (`FOR NO KEY UPDATE` / `FOR UPDATE`) and ensure zero external HTTP calls occur inside open transactions.

### Step 4: Deep Query, `EXPLAIN`, Partitioning & Capacity Analysis
1. For specific slow queries, run `recommend_indexes_for_queries`. If any index recommendation returns `"confidence": "MEDIUM_NEEDS_CARDINALITY_VERIFICATION"`, ask the user which equality column is more selective or provide `SELECT COUNT(DISTINCT col) / COUNT(*)::numeric FROM tbl;`.
2. If the user provides `EXPLAIN` or `EXPLAIN ANALYZE` output, call `analyze_explain_plan` and embed the returned `mermaid_plan_diagram` in your response.
3. For high-growth tables (>10M rows), call `recommend_partitioning_and_archiving` and `calculate_db_capacity_and_config`.

### Step 5: Structured Deliverable Format
Present your findings clearly with:
- **Executive Summary & Health Score** (`0-100`)
- **Critical & Warning Findings Table** (Rule ID, Table/Column, Impact, Fix)
- **Execution Plan Mermaid Diagram** (when analyzing `EXPLAIN`)
- **Production-Safe DDL & Zero-Downtime Runbook** (copy-pasteable SQL)

---

## 3. Core Deterministic Rules Catalog Reference

- **`SCHEMA-FLOAT-001`**: Forbid `FLOAT`/`DOUBLE` for monetary amounts; enforce `NUMERIC(p,s)` or `DECIMAL(p,s)`.
- **`SCHEMA-FK-NOINDEX-001`**: Foreign Key column lacks an index, leading to full table scans on parent `DELETE`/`UPDATE`.
- **`SCHEMA-UUID-INNODB-001`**: Random UUIDv4 used as MySQL InnoDB Clustered Primary Key causes massive page splits; enforce UUIDv7 or auto-increment surrogate key.
- **`INDEX-ESR-001`**: Enforce Equality -> Sort -> Range ordering in composite B-Tree indexes.
- **`INDEX-REDUNDANT-001`**: Detect redundant left-prefix indexes (e.g. index on `(a)` when `(a, b)` already exists).
- **`CODE-NPLUS1-001`**: Detect loop queries without eager loading or batching (`IN (?, ?)`).
- **`TX-RACE-001`**: Read-modify-write without row locking (`SELECT ... FOR UPDATE` / optimistic locking) causing lost updates.
- **`TX-IO-001`**: Network I/O or external HTTP requests inside active DB transaction blocks.
- **`PART-PK-001`**: Partition key missing from Primary Key / Unique constraints in partitioned tables.
