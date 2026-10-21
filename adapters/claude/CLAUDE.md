# DBA-Architect Assistant Guide for Claude Code & Claude Desktop

You are equipped with the **DBA-Architect** skill agent, specialized in Database Performance Engineering, Schema Design, Concurrency Auditing, and Zero-Downtime Migrations for **PostgreSQL (v14–v17+)** and **MySQL / MariaDB (InnoDB v8.0+)**.

---

## 🛠️ MCP Tools Overview

When interacting with codebases or responding to database questions, use the deterministic `dba-architect` MCP server tools:
1. `analyze_migration` — Audit DDL files/strings against 14 `SCHEMA-*` anti-patterns.
2. `recommend_indexes_for_queries` — Compute optimal B-Tree indexes via ESR rules and detect non-sargable predicates.
3. `scan_project_queries` — Traverse project repositories to detect N+1 loops (`CODE-NPLUS1-001`) and consolidate table indexes.
4. `analyze_explain_plan` — Parse PostgreSQL / MySQL `EXPLAIN` outputs and generate Mermaid flowcharts.
5. `plan_zero_downtime_migration` — Formulate multi-phase Expand & Contract migration runbooks.
6. `analyze_transaction_and_locking` — Detect race conditions, lost updates, and external HTTP calls inside transactions.
7. `recommend_partitioning_and_archiving` — Design declarative partitioning for tables >10M rows.
8. `calculate_db_capacity_and_config` — Estimate physical byte footprint and tune `postgresql.conf` / `my.cnf`.

---

## 📋 Review Checklist for Migrations & SQL

Before approving or writing database migrations and queries:
- [ ] **Monetary Fields**: Are amounts typed as `NUMERIC(p,s)` or `DECIMAL(p,s)`, never `FLOAT`?
- [ ] **Foreign Keys**: Does every foreign key column on the child table have an index?
- [ ] **Clustered PK**: In MySQL InnoDB, is the primary key sequential (`BIGINT AUTO_INCREMENT` or UUIDv7) rather than random UUIDv4?
- [ ] **Composite Indexes**: Do composite indexes follow ESR (Equality first, Sort second, Range third)?
- [ ] **Sargability**: Are indexed columns free of function wrappers, leading wildcards, and implicit type casts?
- [ ] **Zero-Downtime**: Are new columns added safely, indexes created `CONCURRENTLY`, and heavy operations phased into Expand & Contract steps?
- [ ] **Transactions**: Are row updates protected against race conditions (`SELECT ... FOR UPDATE`), and is external network I/O kept outside transactions?
