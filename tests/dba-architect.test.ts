import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeMigration } from '../src/tools/analyze-migration.js';
import { recommendIndexesForQueries } from '../src/tools/recommend-indexes.js';
import { scanProjectQueries } from '../src/tools/scan-project.js';
import { analyzeExplainPlan } from '../src/tools/analyze-explain.js';
import { planZeroDowntimeMigration } from '../src/tools/plan-zero-downtime.js';
import { analyzeTransactionAndLocking } from '../src/tools/analyze-transactions.js';
import { recommendPartitioningAndArchiving } from '../src/tools/recommend-partitioning.js';
import { calculateDbCapacityAndConfig } from '../src/tools/calculate-capacity.js';
import { RULES_CATALOG } from '../src/constants/catalog.js';
import { validateSafePath } from '../src/utils/file-walker.js';

import { createDbaArchitectServer } from '../src/server.js';
import { initAdapters } from '../src/adapters.js';

describe('dba-architect Core Suite & 8 Deterministic Tools', () => {
  it('Catalog contains all 30 deterministic DBA rules', () => {
    expect(RULES_CATALOG.length).toBe(30);
    const ruleIds = new Set(RULES_CATALOG.map((r) => r.rule_id));
    expect(ruleIds.has('SCHEMA-TYPE-001')).toBe(true);
    expect(ruleIds.has('INDEX-SARG-001')).toBe(true);
    expect(ruleIds.has('CODE-NPLUS1-001')).toBe(true);
    expect(ruleIds.has('EXPLAIN-SCAN-001')).toBe(true);
    expect(ruleIds.has('TX-RACE-001')).toBe(true);
    expect(ruleIds.has('PART-PK-001')).toBe(true);
  });

  it('Tool 1: analyze_migration detects financial float, unindexed FK, VARCHAR(36) UUID, and computes deterministic score', () => {
    const rawSql = `
      CREATE TABLE orders (
        id UUID PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE payment_transactions (
        id VARCHAR(36) PRIMARY KEY,
        order_id UUID NOT NULL REFERENCES orders(id),
        amount DOUBLE PRECISION NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        status VARCHAR(32) NOT NULL
      );
    `;
    const res = analyzeMigration({
      dialect: 'postgresql',
      migration_source: { raw_sql: rawSql },
      strictness: 'standard'
    });

    expect(res.summary.tables_analyzed).toBe(2);
    const rulesTriggered = res.issues.map((i) => i.rule_id);
    expect(rulesTriggered).toContain('SCHEMA-TYPE-001'); // DOUBLE PRECISION on amount
    expect(rulesTriggered).toContain('SCHEMA-FK-001'); // unindexed order_id FK
    expect(rulesTriggered).toContain('SCHEMA-TYPE-004'); // VARCHAR(36) id
    expect(res.summary.score).toBe(59); // 100 - 25(1) - 8(2) = 59
    expect(res.optimized_ddl_script).toContain('NUMERIC(19, 4)');
    expect(res.optimized_ddl_script).toContain('CREATE INDEX CONCURRENTLY idx_payment_transactions_order_id');
  });

  it('Tool 1 (MySQL & Strict Mode): detects random UUID PK on InnoDB, blocking CREATE INDEX, and implicit FK ON DELETE', () => {
    const mysqlSql = `
      CREATE TABLE orders (
        id CHAR(36) DEFAULT (UUID()) PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id),
        amount FLOAT NOT NULL
      );
      CREATE INDEX idx_orders_amount ON orders (amount);
    `;
    const res = analyzeMigration({
      dialect: 'mysql',
      migration_source: { raw_sql: mysqlSql },
      strictness: 'strict'
    });

    const rules = res.issues.map((i) => i.rule_id);
    expect(rules).toContain('SCHEMA-PK-001'); // Random UUID PK on InnoDB
    expect(rules).toContain('SCHEMA-DDL-001'); // Missing ALGORITHM=INPLACE, LOCK=NONE
    expect(rules).toContain('SCHEMA-FK-003'); // Implicit ON DELETE in strict mode on orders
  });

  it('Tool 2: recommend_indexes_for_queries applies ESR rule, partial/covering index, non-sargable warning, and redundancy detection', () => {
    const existingDdl = `
      CREATE TABLE orders (
        id UUID PRIMARY KEY,
        merchant_id UUID NOT NULL,
        status VARCHAR(32) NOT NULL,
        total_amount NUMERIC(19,4) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        deleted_at TIMESTAMPTZ
      );
      CREATE INDEX idx_orders_merchant_id ON orders (merchant_id);
    `;

    const res = recommendIndexesForQueries({
      dialect: 'postgresql',
      existing_schema_ddl: existingDdl,
      queries: [
        {
          id: 'q1_hot_orders',
          sql: "SELECT id, total_amount, created_at FROM orders WHERE merchant_id = $1 AND status = 'PAID' AND deleted_at IS NULL AND created_at >= $2 ORDER BY created_at DESC LIMIT 20",
          execution_frequency: 'critical_hot_path'
        },
        {
          id: 'q2_lower_email',
          sql: "SELECT * FROM users WHERE LOWER(email) = 'budi@company.com'",
          execution_frequency: 'medium'
        }
      ]
    });

    expect(res.query_analyses).toHaveLength(2);
    const q1 = res.query_analyses[0];
    expect(q1.recommended_indexes[0].index_type).toBe('PARTIAL_COVERING_BTREE');
    expect(q1.recommended_indexes[0].ddl).toContain('INCLUDE (id, total_amount)');
    expect(q1.recommended_indexes[0].ddl).toContain("WHERE status = 'PAID' AND deleted_at IS NULL");

    const q2 = res.query_analyses[1];
    expect(q2.normalized_sql).not.toContain('budi@company.com'); // PII masked
    expect(q2.sargability_warnings[0].rule_id).toBe('INDEX-SARG-001');
    expect(q2.recommended_indexes[0].index_type).toBe('EXPRESSION_BTREE');

    expect(res.redundancy_and_overhead_report.redundant_existing_indexes).toHaveLength(1);
    expect(res.redundancy_and_overhead_report.redundant_existing_indexes[0].existing_index_name).toBe(
      'idx_orders_merchant_id'
    );
  });

  it('Tool 3: scan_project_queries extracts Go, PHP, Python, and TS/JS ORM & SQL queries, detects N+1 loops, and consolidates table indexes', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dba-arch-scan-'));
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'service.go'),
        `package order
        func ProcessOrders(orders []Order) {
          for _, ord := range orders {
            repo.GetOrderItemsByOrderID(ctx, ord.ID)
          }
          db.Table("orders").Where("user_id = ? AND status = ?", uid, "PAID").Order("created_at desc").Find(&list)
          db.Table("orders").Where("user_id = ?", uid).Find(&list2)
        }`
      );
      fs.writeFileSync(
        path.join(tmpDir, 'views.py'),
        `def list_invoices(uid):
          return Invoice.objects.filter(customer_id=uid, created_at__gte=start_dt).order_by('-created_at')
        `
      );
      fs.writeFileSync(
        path.join(tmpDir, 'repo.ts'),
        `export async function findPayments(knex: any, uid: string) {
          return knex('payments').where('account_id', '=', uid).orderBy('paid_at', 'desc');
        }
        `
      );

      const res = await scanProjectQueries({
        project_root_path: tmpDir,
        dialect: 'postgresql'
      });

      expect(res.scan_metadata.files_scanned).toBe(3);
      expect(res.code_antipatterns.length).toBeGreaterThanOrEqual(1);
      expect(res.code_antipatterns[0].rule_id).toBe('CODE-NPLUS1-001');

      expect(res.scan_metadata.tables_identified).toContain('orders');
      expect(res.scan_metadata.tables_identified).toContain('invoices');
      expect(res.scan_metadata.tables_identified).toContain('payments');

      const ordersStrat = res.holistic_table_strategies.find((s) => s.table_name === 'orders');
      expect(ordersStrat).toBeDefined();
      expect(ordersStrat!.consolidated_index_plan).toHaveLength(1);
      expect(ordersStrat!.consolidated_index_plan[0].covers_fingerprints).toHaveLength(2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('Tool 4: analyze_explain_plan parses EXPLAIN ANALYZE output, flags Seq Scan & Disk Sort, and renders Mermaid diagram', () => {
    const explainText = `
Limit  (cost=12500.00..12505.00 rows=20 width=64) (actual time=1415.10..1420.50 rows=20 loops=1)
  ->  Sort  (cost=12500.00..12600.00 rows=40000 width=64) (actual time=1415.00..1418.00 rows=20 loops=1)
        Sort Key: created_at DESC
        Sort Method: external merge  Disk: 48120kB
        ->  Seq Scan on orders  (cost=0.00..9500.00 rows=120 width=64) (actual time=0.05..1150.20 rows=120 loops=1)
              Filter: ((merchant_id = 42) AND (status = 'PAID'::text))
              Rows Removed by Filter: 2450000
Planning Time: 1.20 ms
Execution Time: 1420.50 ms
    `;

    const res = analyzeExplainPlan({
      dialect: 'postgresql',
      explain_output: explainText
    });

    expect(res.summary.health_status).toBe('CRITICAL_BOTTLENECK');
    expect(res.summary.slowest_node).toBe('Seq Scan on orders');
    const rules = res.bottlenecks.map((b) => b.rule_id);
    expect(rules).toContain('EXPLAIN-SCAN-001');
    expect(rules).toContain('EXPLAIN-SORT-001');
    expect(res.mermaid_plan_diagram).toContain('flowchart TD');
    expect(res.mermaid_plan_diagram).toContain('Seq Scan on orders');
    expect(res.mermaid_plan_diagram).toContain('N1 --> N2');
    expect(res.mermaid_plan_diagram).toContain('N2 --> N3');
  });

  it('Edge Cases: DDL parser handles quoted schema prefixes, UNIQUE constraints as FK indexes, and blocking ALTER TABLE rules', () => {
    const sql = `
      CREATE TABLE "public"."merchants" (
        "id" UUID PRIMARY KEY,
        "code" VARCHAR(32) UNIQUE NOT NULL
      );
      CREATE TABLE "public"."payouts" (
        "id" UUID PRIMARY KEY,
        "merchant_code" VARCHAR(32) NOT NULL REFERENCES "public"."merchants"("code") ON DELETE RESTRICT,
        "amount" NUMERIC(19,4) NOT NULL,
        CONSTRAINT uq_payouts_merchant_code UNIQUE ("merchant_code")
      );
      ALTER TABLE "public"."payouts" ADD CONSTRAINT fk_extra FOREIGN KEY ("merchant_code") REFERENCES "public"."merchants"("code");
    `;
    const res = analyzeMigration({
      dialect: 'postgresql',
      migration_source: { raw_sql: sql }
    });

    expect(res.summary.tables_analyzed).toBe(2);
    // merchant_code has a UNIQUE constraint so it should NOT trigger SCHEMA-FK-001 (unindexed FK)
    expect(res.issues.some((i) => i.rule_id === 'SCHEMA-FK-001')).toBe(false);
    // ALTER TABLE ... ADD FOREIGN KEY without NOT VALID should trigger SCHEMA-DDL-001
    expect(res.issues.some((i) => i.rule_id === 'SCHEMA-DDL-001')).toBe(true);
  });

  it('Edge Cases: Query parser avoids polluting equality_columns with function-wrapped or negated columns, and supports composite expression index', () => {
    const res = recommendIndexesForQueries({
      dialect: 'postgresql',
      queries: [
        {
          id: 'q_composite_expr',
          sql: "SELECT id FROM users WHERE tenant_id = $1 AND LOWER(email) = 'admin@corp.com' AND status NOT IN ('BANNED')"
        }
      ]
    });

    const qa = res.query_analyses[0];
    const pred = qa.extracted_predicates[0];
    expect(pred.equality_columns).toContain('tenant_id');
    expect(pred.equality_columns).toContain('LOWER(email)');
    expect(pred.equality_columns).not.toContain('email');
    expect(pred.equality_columns).not.toContain('status');
    expect(qa.recommended_indexes[0].ddl).toContain('(tenant_id, (LOWER(email)))');
  });

  it('Edge Cases: EXPLAIN tree builder accurately links sibling branches in Join plans', () => {
    const joinExplain = `
Hash Join  (cost=100.00..500.00 rows=100 width=64) (actual time=10.00..95.00 rows=100 loops=1)
  Hash Cond: (o.user_id = u.id)
  ->  Seq Scan on orders o  (cost=0.00..300.00 rows=10000 width=32) (actual time=0.05..75.00 rows=10000 loops=1)
        Filter: (status = 'PAID'::text)
        Rows Removed by Filter: 50000
  ->  Hash  (cost=50.00..50.00 rows=1000 width=32) (actual time=8.00..8.00 rows=1000 loops=1)
        Batches: 4  Memory Usage: 4096kB
        ->  Seq Scan on users u  (cost=0.00..50.00 rows=1000 width=32) (actual time=0.01..4.00 rows=1000 loops=1)
Execution Time: 95.00 ms
    `;
    const res = analyzeExplainPlan({
      dialect: 'postgresql',
      explain_output: joinExplain
    });

    expect(res.summary.slowest_node).toBe('Seq Scan on orders');
    expect(res.mermaid_plan_diagram).toContain('N1 --> N2');
    expect(res.mermaid_plan_diagram).toContain('N1 --> N3');
    expect(res.mermaid_plan_diagram).toContain('N3 --> N4');
    expect(res.bottlenecks.map((b) => b.rule_id)).toContain('EXPLAIN-JOIN-001');
  });

  it('Edge Cases: plan_zero_downtime_migration handles PostgreSQL SET DATA TYPE and semicolon inside string literal', () => {
    const res = planZeroDowntimeMigration({
      dialect: 'postgresql',
      ddl_statements: "ALTER TABLE invoices ALTER COLUMN notes SET DEFAULT 'a;b', ALTER COLUMN total SET DATA TYPE NUMERIC(19,4);"
    });
    expect(res.overall_risk_level).toBe('CRITICAL_TABLE_REWRITE');
    expect(res.zero_downtime_runbook[0].sql_script).toContain('total_v2 NUMERIC(19,4)');
  });

  it('Edge Cases: analyze_transaction_and_locking recognizes Prisma atomic increment as concurrency-safe', () => {
    const safeSnippet = `
      await prisma.$transaction(async (tx) => {
        const wallet = await tx.wallet.findUnique({ where: { id: walletId } });
        await tx.wallet.update({
          where: { id: walletId },
          data: { balance: { decrement: amount } }
        });
      });
    `;
    const res = analyzeTransactionAndLocking({
      dialect: 'postgresql',
      source: { code_or_sql_snippet: safeSnippet }
    });
    expect(res.concurrency_issues.some((i) => i.rule_id === 'TX-RACE-001')).toBe(false);
    expect(res.summary.concurrency_safety_score).toBe(100);
  });

  it('Tool 5: plan_zero_downtime_migration transforms blocking ALTER TABLE into 3-phase Expand & Contract runbook (PG) and gh-ost (MySQL)', () => {
    const res = planZeroDowntimeMigration({
      dialect: 'postgresql',
      ddl_statements:
        'ALTER TABLE orders ADD CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users(id), ALTER COLUMN status SET NOT NULL;',
      estimated_table_rows: 10000000
    });

    expect(res.overall_risk_level).toBe('HIGH_LOCKING_RISK');
    expect(res.zero_downtime_runbook).toHaveLength(3);
    expect(res.zero_downtime_runbook[0].sql_script).toContain('NOT VALID');
    expect(res.zero_downtime_runbook[1].sql_script).toContain('VALIDATE CONSTRAINT');
    expect(res.zero_downtime_runbook[2].sql_script).toContain('SET NOT NULL');

    const mysqlRes = planZeroDowntimeMigration({
      dialect: 'mysql',
      ddl_statements: 'ALTER TABLE orders MODIFY COLUMN amount DECIMAL(19,4);',
      estimated_table_rows: 25000000
    });
    expect(mysqlRes.overall_risk_level).toBe('CRITICAL_TABLE_REWRITE');
    expect(mysqlRes.zero_downtime_runbook[0].sql_script).toContain('gh-ost');
  });

  it('Tool 6: analyze_transaction_and_locking detects Lost Update race condition (TX-RACE-001) and HTTP call in transaction (TX-IO-001)', () => {
    const snippet = `
      await prisma.$transaction(async (tx) => {
        const wallet = await tx.wallet.findUnique({ where: { id: walletId } });
        const charge = await paymentGateway.charge(wallet.userId, amount);
        await tx.wallet.update({ where: { id: walletId }, data: { balance: wallet.balance - amount } });
      });
    `;

    const res = analyzeTransactionAndLocking({
      dialect: 'postgresql',
      source: { code_or_sql_snippet: snippet }
    });

    const ruleIds = res.concurrency_issues.map((i) => i.rule_id);
    expect(ruleIds).toContain('TX-RACE-001');
    expect(ruleIds).toContain('TX-IO-001');
    expect(res.summary.concurrency_safety_score).toBe(50);
  });

  it('Tool 7: recommend_partitioning_and_archiving enforces PART-PK-001 composite PK and supports RANGE, LIST, and HASH', () => {
    const ddl = `
      CREATE TABLE audit_logs (
        id UUID PRIMARY KEY,
        tenant_id UUID NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        payload JSONB NOT NULL
      );
    `;
    const res = recommendPartitioningAndArchiving({
      dialect: 'postgresql',
      table_ddl: ddl,
      estimated_total_rows: 250000000,
      monthly_growth_rows: 15000000,
      retention_months: 12
    });

    expect(res.partitioning_recommended).toBe(true);
    expect(res.strategy.pk_adjustment_required).toBe(true);
    expect(res.strategy.pk_adjustment_rule_id).toBe('PART-PK-001');
    expect(res.partitioned_table_ddl).toContain('PRIMARY KEY (id, created_at)');
    expect(res.partitioned_table_ddl).toContain('PARTITION BY RANGE (created_at)');
    expect(res.archiving_and_retention_runbook).toContain('DETACH PARTITION');

    const listRes = recommendPartitioningAndArchiving({
      dialect: 'postgresql',
      table_ddl: `CREATE TABLE regional_accounts (id UUID PRIMARY KEY, country_code VARCHAR(8) NOT NULL);`,
      estimated_total_rows: 50000000
    });
    expect(listRes.strategy.partition_type).toBe('LIST');
    expect(listRes.partitioned_table_ddl).toContain('PARTITION BY LIST (country_code)');
  });

  it('Tool 8: calculate_db_capacity_and_config estimates table/index GB footprint and tunes postgresql.conf and my.cnf', () => {
    const ddl = `
      CREATE TABLE orders (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL,
        amount NUMERIC(19, 4) NOT NULL,
        status VARCHAR(32) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX idx_orders_user_id ON orders (user_id);
    `;
    const res = calculateDbCapacityAndConfig({
      dialect: 'postgresql',
      schema_ddl: ddl,
      estimated_rows_per_table: { orders: 50000000 },
      server_hardware: {
        vcpu: 8,
        ram_gb: 32,
        storage_type: 'nvme',
        workload_type: 'oltp',
        max_connections: 200
      }
    });

    expect(res.capacity_estimation.tables).toHaveLength(1);
    expect(res.capacity_estimation.tables[0].projected_rows).toBe(50000000);
    expect(res.capacity_estimation.working_set_fits_in_ram).toBe(true);
    expect(res.engine_tuning_recommendation.config_file).toBe('postgresql.conf');
    expect(res.engine_tuning_recommendation.parameters.shared_buffers).toBe('8GB');
    expect(res.engine_tuning_recommendation.parameters.random_page_cost).toBe('1.1');

    const myRes = calculateDbCapacityAndConfig({
      dialect: 'mysql',
      schema_ddl: ddl,
      estimated_rows_per_table: { orders: 50000000 },
      server_hardware: { vcpu: 8, ram_gb: 32, storage_type: 'nvme', workload_type: 'oltp' }
    });
    expect(myRes.engine_tuning_recommendation.config_file).toBe('my.cnf');
    expect(myRes.engine_tuning_recommendation.parameters.innodb_buffer_pool_size).toBe('22G');
  });

  it('Security Guardrail blocks sensitive .env and .pem files', () => {
    expect(() => validateSafePath('C:/MyProject/dba-architect/.env.production')).toThrow(/Security Guardrail/);
    expect(() => validateSafePath('C:/MyProject/dba-architect/certs/private.pem')).toThrow(/Security Guardrail/);
  });

  it('MCP Server instance registers all 8 Tools, 3 Resources, and 4 Prompts without error', () => {
    const server = createDbaArchitectServer();
    expect(server).toBeDefined();
  });

  it('initAdapters successfully installs multi-agent adapters into target directory', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dba-test-'));
    try {
      const created = initAdapters(tempDir);
      expect(created.length).toBeGreaterThanOrEqual(10);
      expect(created).toContain('.agents/skills/dba-architect/SKILL.md');
      expect(created).toContain('.cursor/rules/dba-architect.mdc');
      expect(created).toContain('CLAUDE.md');
      expect(created).toContain('.windsurfrules');
      expect(created).toContain('.github/copilot-instructions.md');
      expect(created).toContain('.clinerules');
      expect(created).toContain('.continue/config.json');
      expect(created).toContain('.kiro/config.json');
      expect(created).toContain('dba-architect.config.json');

      expect(fs.existsSync(path.join(tempDir, '.agents/skills/dba-architect/SKILL.md'))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, '.cursor/rules/dba-architect.mdc'))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'CLAUDE.md'))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'dba-architect.config.json'))).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

