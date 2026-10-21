---
name: dba-architect
description: Principal Database Administrator (DBA) & Data Architecture skill agent for Google Antigravity. Autonomously audits SQL migrations, optimizes composite B-Tree indexes via ESR rules, scans codebases for ORM queries & N+1 loops, visualizes EXPLAIN ANALYZE plans in Mermaid, plans zero-downtime Expand & Contract migrations, audits transaction locking/deadlocks, designs table partitioning, and tunes postgresql.conf / my.cnf.
---

# DBA Architect (`dba-architect`) — Google Antigravity Playbook

Universal AI Companion Skill & MCP Protocol Agent for **PostgreSQL (v14–v17+)** and **MySQL / MariaDB (InnoDB v8.0+)**.

Use this skill whenever:
- Auditing SQL migrations, `CREATE TABLE` / `ALTER TABLE` DDL, or database schema design.
- Optimizing slow queries, index design (B-Tree, Covering, Partial, Expression), and removing redundant left-prefix indexes.
- Scanning backend repositories (Go, PHP/Laravel, TypeScript/Prisma/Drizzle, Python) for N+1 query loops and workload consolidation.
- Diagnosing PostgreSQL / MySQL `EXPLAIN` or `EXPLAIN (ANALYZE, BUFFERS)` execution plans with Mermaid diagrams.
- Generating zero-downtime migration plans (*Expand & Contract*, `CONCURRENTLY`, `VALIDATE CONSTRAINT`, `ALGORITHM=INPLACE`).
- Auditing database transactions for Lost Update race conditions (`SELECT ... FOR UPDATE`), HTTP I/O in transactions, or deadlocks.
- Designing declarative table partitioning (`RANGE`, `LIST`, `HASH`) and calculating RAM/disk capacity tuning.

---

## 1. Antigravity MCP Tools Integration

When connected to the `dba-architect` MCP server, call deterministic tools directly:
- `mcp_dba-architect_analyze_migration`
- `mcp_dba-architect_recommend_indexes_for_queries`
- `mcp_dba-architect_scan_project_queries`
- `mcp_dba-architect_analyze_explain_plan`
- `mcp_dba-architect_plan_zero_downtime_migration`
- `mcp_dba-architect_analyze_transaction_and_locking`
- `mcp_dba-architect_recommend_partitioning_and_archiving`
- `mcp_dba-architect_calculate_db_capacity_and_config`

---

## 2. Standard Operating Procedure (5-Step Principal DBA Workflow)

1. **Step 1: Identify Dialect & Schema Context**: Inspect `docker-compose.yml`, `.env`, ORM config, or `go.mod` to determine if engine is PostgreSQL or MySQL.
2. **Step 2: Schema Audit & Zero-Downtime Safety**: Run `analyze_migration`. If altering production tables, generate an Expand & Contract runbook with `plan_zero_downtime_migration`.
3. **Step 3: Codebase Workload Profiling & Concurrency**: Scan for N+1 queries using `scan_project_queries`, then audit critical payment/order paths with `analyze_transaction_and_locking`.
4. **Step 4: Deep Query, EXPLAIN & Capacity Analysis**: Optimize composite indexes via ESR rules (`recommend_indexes_for_queries`), parse query execution plans (`analyze_explain_plan`), and calculate buffer capacity.
5. **Step 5: Structured Deliverable**: Output Health Score (0–100), Critical/Warning Table, Mermaid Diagram, and copy-pasteable safe SQL.
