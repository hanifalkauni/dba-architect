export const RULES_CATALOG = [
    {
        rule_id: 'SCHEMA-TYPE-001',
        domain: 'SCHEMA',
        tool: 'analyze_migration',
        severity: 'CRITICAL',
        category: 'DATA_TYPE_ANTIPATTERN',
        title: 'Floating-Point Type Used for Monetary/Financial Column',
        description: 'Using FLOAT, REAL, or DOUBLE PRECISION on financial columns causes IEEE-754 base-2 rounding errors.',
        postgresql_remediation: 'Use NUMERIC(19, 4) or BIGINT (minor currency units).',
        mysql_remediation: 'Use DECIMAL(19, 4) or BIGINT.'
    },
    {
        rule_id: 'SCHEMA-TYPE-002',
        domain: 'SCHEMA',
        tool: 'analyze_migration',
        severity: 'INFO',
        category: 'OVERSIZED_VARCHAR',
        title: 'Arbitrary VARCHAR(255) on Bounded/Short Column',
        description: 'Defaulting to VARCHAR(255) on status, currency, country_code, or phone columns wastes sort/memory buffers in MySQL and lacks semantic bounds.',
        postgresql_remediation: 'Use bounded VARCHAR(32) or CHECK constraint / native ENUM.',
        mysql_remediation: 'Use tight VARCHAR(16..32) or CHAR(2..3) for ISO codes to reduce temporary table memory allocation.'
    },
    {
        rule_id: 'SCHEMA-TYPE-003',
        domain: 'SCHEMA',
        tool: 'analyze_migration',
        severity: 'WARNING',
        category: 'PK_FK_INT_OVERFLOW_RISK',
        title: '32-Bit INTEGER Primary/Foreign Key Overflow Risk',
        description: 'Using 32-bit INT/SERIAL on high-growth transactional tables risks signed integer exhaustion at 2,147,483,647 rows.',
        postgresql_remediation: 'Use BIGINT / BIGSERIAL or UUID (v7).',
        mysql_remediation: 'Use BIGINT UNSIGNED AUTO_INCREMENT.'
    },
    {
        rule_id: 'SCHEMA-TYPE-004',
        domain: 'SCHEMA',
        tool: 'analyze_migration',
        severity: 'WARNING',
        category: 'SUBOPTIMAL_UUID_STORAGE',
        title: 'UUID Stored as VARCHAR(36) or TEXT',
        description: 'Storing UUID strings consumes 36-40 bytes instead of 16 bytes, bloating B-Tree indexes by more than 2x.',
        postgresql_remediation: 'Use native UUID data type (16 bytes).',
        mysql_remediation: 'Use BINARY(16) with UUID_TO_BIN(uuid, 1) and BIN_TO_UUID().'
    },
    {
        rule_id: 'SCHEMA-TYPE-005',
        domain: 'SCHEMA',
        tool: 'analyze_migration',
        severity: 'WARNING',
        category: 'TIMESTAMP_WITHOUT_TZ',
        title: 'Timestamp Timezone or Y2K38 Anti-Pattern',
        description: 'PostgreSQL TIMESTAMP without time zone strips UTC context; MySQL 32-bit TIMESTAMP overflows in 2038.',
        postgresql_remediation: 'Always use TIMESTAMPTZ (timestamp with time zone).',
        mysql_remediation: 'Use DATETIME(6) for range beyond 2038 or ensure MySQL 8.0.28+ 64-bit timestamp support.'
    },
    {
        rule_id: 'SCHEMA-PK-001',
        domain: 'SCHEMA',
        tool: 'analyze_migration',
        severity: 'WARNING',
        category: 'MYSQL_RANDOM_UUID_PK',
        title: 'Random UUIDv4 Used as Clustered Primary Key in MySQL InnoDB',
        description: 'InnoDB physically orders rows by the Primary Key. Random UUIDv4 inserts cause severe B-Tree page splitting, random Disk I/O, and 50% page fill fragmentation.',
        postgresql_remediation: 'Prefer time-ordered UUIDv7 to improve B-Tree leaf page locality.',
        mysql_remediation: 'Use BIGINT UNSIGNED AUTO_INCREMENT as Clustered PK, or use time-ordered UUIDv7 stored in BINARY(16).'
    },
    {
        rule_id: 'SCHEMA-CONST-001',
        domain: 'SCHEMA',
        tool: 'analyze_migration',
        severity: 'WARNING',
        category: 'MISSING_NOT_NULL',
        title: 'Missing NOT NULL Constraint on Core Column',
        description: 'Allowing NULLs on status, audit timestamps (created_at), or required foreign keys introduces three-valued logic bugs and prevents certain planner optimizations.',
        postgresql_remediation: 'Add NOT NULL constraint with an appropriate DEFAULT.',
        mysql_remediation: 'Define column as NOT NULL.'
    },
    {
        rule_id: 'SCHEMA-FK-001',
        domain: 'SCHEMA',
        tool: 'analyze_migration',
        severity: 'WARNING',
        category: 'UNINDEXED_FOREIGN_KEY',
        title: 'Foreign Key Column Lacks Supporting B-Tree Index',
        description: 'PostgreSQL does not automatically index Foreign Keys. Updating or deleting parent rows triggers a Full Sequential Scan on the child table and causes lock contention.',
        postgresql_remediation: 'CREATE INDEX CONCURRENTLY idx_child_fk ON child_table (fk_column);',
        mysql_remediation: 'Ensure the FK column is the left-most prefix of an appropriate index.'
    },
    {
        rule_id: 'SCHEMA-FK-002',
        domain: 'SCHEMA',
        tool: 'analyze_migration',
        severity: 'CRITICAL',
        category: 'FOREIGN_KEY_TYPE_MISMATCH',
        title: 'Data Type or Signedness Mismatch Between FK and Referenced PK',
        description: 'Mismatched types (e.g., INT vs BIGINT, or INT UNSIGNED vs INT) cause DDL failure in MySQL or implicit cast overhead removing index usage during JOINs.',
        postgresql_remediation: 'Match exact data type (e.g., both BIGINT or both UUID) between FK and parent PK.',
        mysql_remediation: 'Match exact type and UNSIGNED attribute between FK and parent PK.'
    },
    {
        rule_id: 'SCHEMA-FK-003',
        domain: 'SCHEMA',
        tool: 'analyze_migration',
        severity: 'WARNING',
        category: 'DANGEROUS_CASCADE',
        title: 'Unsafe ON DELETE CASCADE on Financial/Transactional Table or Implicit Default',
        description: 'ON DELETE CASCADE on orders/payments/audit tables can silently wipe historical financial records if a parent record is deleted.',
        postgresql_remediation: 'Explicitly specify ON DELETE RESTRICT on transactional/financial tables.',
        mysql_remediation: 'Explicitly specify ON DELETE RESTRICT.'
    },
    {
        rule_id: 'SCHEMA-NORM-001',
        domain: 'SCHEMA',
        tool: 'analyze_migration',
        severity: 'WARNING',
        category: 'FIRST_NORMAL_FORM_VIOLATION',
        title: 'Repeating Column Groups (1NF Violation)',
        description: 'Numbered columns like tag_1, tag_2, tag_3 or phone1, phone2 violate First Normal Form and prevent clean indexing.',
        postgresql_remediation: 'Normalize into a 1-to-N child table or use a typed array / JSONB with GIN index if strictly denormalized.',
        mysql_remediation: 'Extract repeating columns into a dedicated junction/child table.'
    },
    {
        rule_id: 'SCHEMA-NORM-002',
        domain: 'SCHEMA',
        tool: 'analyze_migration',
        severity: 'INFO',
        category: 'JSONB_DOCUMENT_ABUSE',
        title: 'Single-Column JSON/JSONB Document Table Without Relational Columns or GIN Index',
        description: 'Storing entire entity payloads in a single JSON/JSONB column bypasses column statistics, foreign keys, and type safety.',
        postgresql_remediation: 'Extract frequently queried attributes into typed relational columns or create a GIN / expression index.',
        mysql_remediation: 'Extract core columns or use Generated Virtual/Stored Columns with secondary B-Tree indexes.'
    },
    {
        rule_id: 'SCHEMA-LAYOUT-001',
        domain: 'SCHEMA',
        tool: 'analyze_migration',
        severity: 'INFO',
        category: 'COLUMN_ALIGNMENT_PADDING',
        title: 'Suboptimal PostgreSQL 8-Byte Column Alignment Order (Column Tetris)',
        description: 'Alternating 1/2/4-byte and 8-byte columns in PostgreSQL introduces CPU alignment padding bytes in every row tuple.',
        postgresql_remediation: 'Order fixed-width columns descending by alignment size: 8-byte (BIGINT, TIMESTAMPTZ, UUID) -> 4-byte (INT) -> 2-byte (SMALLINT) -> 1-byte (BOOLEAN) -> variable-length (VARCHAR, TEXT, NUMERIC).',
        mysql_remediation: 'N/A (InnoDB compacts variable-length fields separately in the record header).'
    },
    {
        rule_id: 'SCHEMA-DDL-001',
        domain: 'SCHEMA',
        tool: 'analyze_migration',
        severity: 'CRITICAL',
        category: 'UNSAFE_LOCKING_DDL',
        title: 'Blocking DDL Operation Risking Production Table Lock',
        description: 'Creating indexes without CONCURRENTLY or adding validated constraints / rewriting columns acquires exclusive locks that block reads/writes.',
        postgresql_remediation: 'Use CREATE INDEX CONCURRENTLY, set lock_timeout, and use NOT VALID -> VALIDATE CONSTRAINT.',
        mysql_remediation: 'Specify ALGORITHM=INPLACE, LOCK=NONE (or ALGORITHM=INSTANT) or use gh-ost / pt-online-schema-change.'
    },
    {
        rule_id: 'INDEX-SARG-001',
        domain: 'INDEX',
        tool: 'recommend_indexes_for_queries',
        severity: 'WARNING',
        category: 'NON_SARGABLE_FUNCTION',
        title: 'Function Wrapping Indexed Column in Predicate',
        description: 'Applying functions like LOWER(col), YEAR(col), or DATE(col) prevents standard B-Tree traversal.',
        postgresql_remediation: 'Rewrite predicate as range (e.g., created_at >= ... AND created_at < ...) or create an Expression Index.',
        mysql_remediation: 'Rewrite predicate as range or create a Functional Index in MySQL 8.0.13+.'
    },
    {
        rule_id: 'INDEX-SARG-002',
        domain: 'INDEX',
        tool: 'recommend_indexes_for_queries',
        severity: 'WARNING',
        category: 'NON_SARGABLE_LEADING_WILDCARD',
        title: 'Leading Wildcard in LIKE/ILIKE Predicate',
        description: 'Predicates like LIKE "%term%" cannot use standard left-anchored B-Tree ordering.',
        postgresql_remediation: 'Use pg_trgm extension with a GIN index (gin_trgm_ops) or Full-Text Search (tsvector).',
        mysql_remediation: 'Use a FULLTEXT index with MATCH(...) AGAINST(...) or N-gram parser.'
    },
    {
        rule_id: 'INDEX-SARG-003',
        domain: 'INDEX',
        tool: 'recommend_indexes_for_queries',
        severity: 'WARNING',
        category: 'NON_SARGABLE_ARITHMETIC',
        title: 'Arithmetic Expression Applied to Column in Predicate',
        description: 'Expressions such as amount * 2 > 1000 force per-row evaluation across the entire table.',
        postgresql_remediation: 'Isolate the column on one side of the operator: amount > 1000 / 2.',
        mysql_remediation: 'Isolate the column on one side of the operator: amount > 1000 / 2.'
    },
    {
        rule_id: 'INDEX-SARG-004',
        domain: 'INDEX',
        tool: 'recommend_indexes_for_queries',
        severity: 'INFO',
        category: 'NON_SARGABLE_NEGATION',
        title: 'Negation Operator (!=, <>, NOT IN) Inhibiting Index Seek',
        description: 'Negation operators typically have low selectivity, forcing the query planner to fall back to a Full Table Scan.',
        postgresql_remediation: 'Rewrite as positive IN (...) if bounded, or use a Partial Index WHERE status != ...',
        mysql_remediation: 'Rewrite using positive equality/range predicates or combine with a high-selectivity equality column.'
    },
    {
        rule_id: 'INDEX-REDUNDANT-001',
        domain: 'INDEX',
        tool: 'recommend_indexes_for_queries',
        severity: 'WARNING',
        category: 'REDUNDANT_LEFT_PREFIX_INDEX',
        title: 'Redundant Left-Prefix B-Tree Index',
        description: 'An index on (A) or (A, B) is duplicated by a wider index on (A, B, C), wasting RAM buffer pool and slowing down writes.',
        postgresql_remediation: 'DROP INDEX CONCURRENTLY IF EXISTS idx_redundant;',
        mysql_remediation: 'DROP INDEX idx_redundant ON tbl ALGORITHM=INPLACE, LOCK=NONE;'
    },
    {
        rule_id: 'INDEX-OVERHEAD-001',
        domain: 'INDEX',
        tool: 'recommend_indexes_for_queries',
        severity: 'WARNING',
        category: 'EXCESSIVE_INDEX_WRITE_OVERHEAD',
        title: 'Write Amplification Risk (>5 Indexes on Single Table)',
        description: 'Maintaining more than 5 secondary indexes on an OLTP table degrades INSERT/UPDATE/DELETE throughput and blocks PostgreSQL HOT updates.',
        postgresql_remediation: 'Consolidate overlapping indexes and avoid indexing frequently updated columns.',
        mysql_remediation: 'Consolidate secondary indexes to reduce InnoDB change buffer and page split overhead.'
    },
    {
        rule_id: 'CODE-NPLUS1-001',
        domain: 'CODE',
        tool: 'scan_project_queries',
        severity: 'CRITICAL',
        category: 'POTENTIAL_N_PLUS_ONE',
        title: 'Database Query Executed Inside Iterative Loop (N+1 Query Anti-Pattern)',
        description: 'Executing SQL/ORM queries inside a for/foreach/map loop multiplies network round-trips linearly with result size.',
        postgresql_remediation: 'Batch IDs before the loop and execute a single WHERE id = ANY($1) / WHERE id IN (?) query or ORM eager load.',
        mysql_remediation: 'Batch IDs before the loop and execute a single WHERE id IN (?) query or ORM eager load (with/Preload/include).'
    },
    {
        rule_id: 'EXPLAIN-SCAN-001',
        domain: 'EXPLAIN',
        tool: 'analyze_explain_plan',
        severity: 'CRITICAL',
        category: 'FULL_TABLE_SCAN_BOTTLENECK',
        title: 'High-Cost Sequential Scan / Full Table Scan Filtering Majority of Rows',
        description: 'Scanning an entire table and discarding most rows via post-scan Filter wastes I/O bandwidth and CPU.',
        postgresql_remediation: 'Create a composite B-Tree index matching the Filter predicate.',
        mysql_remediation: 'Add a composite index to eliminate type: ALL full table scan.'
    },
    {
        rule_id: 'EXPLAIN-SORT-001',
        domain: 'EXPLAIN',
        tool: 'analyze_explain_plan',
        severity: 'WARNING',
        category: 'EXTERNAL_DISK_FILESORT',
        title: 'External Merge Disk Sort / Filesort Spill',
        description: 'Sorting spilled to temporary disk files because no index provided pre-sorted tuples and sort memory was exceeded.',
        postgresql_remediation: 'Add ORDER BY columns to the index (ESR rule) or increase work_mem.',
        mysql_remediation: 'Add ORDER BY columns to the composite index or increase sort_buffer_size.'
    },
    {
        rule_id: 'EXPLAIN-JOIN-001',
        domain: 'EXPLAIN',
        tool: 'analyze_explain_plan',
        severity: 'WARNING',
        category: 'SUBOPTIMAL_JOIN_EXECUTION',
        title: 'High-Loop Nested Loop Join or Multi-Batch Disk Hash Join',
        description: 'Nested Loop executed thousands of inner lookups, or Hash Join spilled to disk across multiple batches.',
        postgresql_remediation: 'Ensure inner join column is indexed and increase work_mem for large Hash Joins.',
        mysql_remediation: 'Index the joined foreign key column and tune join_buffer_size.'
    },
    {
        rule_id: 'EXPLAIN-HEAP-001',
        domain: 'EXPLAIN',
        tool: 'analyze_explain_plan',
        severity: 'WARNING',
        category: 'HIGH_HEAP_FETCHES_ON_IOS',
        title: 'Index-Only Scan Degraded by High Heap Fetches',
        description: 'PostgreSQL Index-Only Scan had to visit the heap table thousands of times because visibility map pages are not all-visible.',
        postgresql_remediation: 'Run VACUUM ANALYZE on the table and tune autovacuum_vacuum_scale_factor (e.g., 0.02).',
        mysql_remediation: 'N/A (InnoDB secondary index leaf nodes read MVCC version via Clustered PK if needed).'
    },
    {
        rule_id: 'EXPLAIN-EST-001',
        domain: 'EXPLAIN',
        tool: 'analyze_explain_plan',
        severity: 'WARNING',
        category: 'ROW_ESTIMATION_MISMATCH',
        title: 'Severe Planner Row Estimation Mismatch (>=10x Off)',
        description: 'Estimated rows differ from actual rows by more than an order of magnitude, causing the optimizer to pick wrong join/scan strategies.',
        postgresql_remediation: 'Run ANALYZE tbl; if columns are correlated, run CREATE STATISTICS on the correlated columns.',
        mysql_remediation: 'Run ANALYZE TABLE tbl UPDATE HISTOGRAM ON col1, col2;'
    },
    {
        rule_id: 'TX-RACE-001',
        domain: 'TRANSACTION',
        tool: 'analyze_transaction_and_locking',
        severity: 'CRITICAL',
        category: 'LOST_UPDATE_RACE_CONDITION',
        title: 'Unprotected Read-Modify-Write Inside Transaction (Lost Update Risk)',
        description: 'Reading a row via plain SELECT and updating it inside a transaction without FOR UPDATE or atomic increment allows concurrent overwrites.',
        postgresql_remediation: 'Use SELECT ... FOR NO KEY UPDATE (or FOR UPDATE) or atomic UPDATE tbl SET balance = balance - $1 WHERE id = $2 AND balance >= $1.',
        mysql_remediation: 'Use SELECT ... FOR UPDATE or atomic conditional UPDATE.'
    },
    {
        rule_id: 'TX-IO-001',
        domain: 'TRANSACTION',
        tool: 'analyze_transaction_and_locking',
        severity: 'CRITICAL',
        category: 'EXTERNAL_IO_IN_TRANSACTION',
        title: 'External Network/HTTP Call Inside Open Database Transaction',
        description: 'Calling external APIs, sending emails, or sleeping while a DB transaction is open holds row locks and exhausts the connection pool.',
        postgresql_remediation: 'Split into a two-step state machine / Outbox pattern so network calls happen outside BEGIN...COMMIT.',
        mysql_remediation: 'Move HTTP/RPC calls outside the database transaction block.'
    },
    {
        rule_id: 'TX-DEADLOCK-001',
        domain: 'TRANSACTION',
        tool: 'analyze_transaction_and_locking',
        severity: 'WARNING',
        category: 'INCONSISTENT_LOCK_ORDERING',
        title: 'Potential Deadlock Due to Unordered Bulk Lock or Lock Order Inversion',
        description: 'Locking rows or tables in inconsistent order across concurrent transactions causes cyclic wait deadlocks.',
        postgresql_remediation: 'Always acquire table and row locks in a deterministic ascending ID/key order.',
        mysql_remediation: 'Sort primary keys ascending before executing batch UPDATE or SELECT ... FOR UPDATE.'
    },
    {
        rule_id: 'PART-PK-001',
        domain: 'PARTITION',
        tool: 'recommend_partitioning_and_archiving',
        severity: 'CRITICAL',
        category: 'PARTITION_KEY_MISSING_IN_PK',
        title: 'Partition Key Column Missing from Primary Key / Unique Constraint',
        description: 'Both PostgreSQL and MySQL require every Unique/Primary Key constraint on a partitioned table to include all partition key columns.',
        postgresql_remediation: 'Define composite PRIMARY KEY (id, partition_col).',
        mysql_remediation: 'Define composite PRIMARY KEY (id, partition_col).'
    }
];
export const CARDINALITY_HEURISTICS = {
    description: 'Heuristic column naming dictionary for static ESR (Equality, Sort, Range) composite index ordering when live DB statistics are unavailable.',
    weights: {
        unique: 100,
        high: 80,
        medium: 50,
        low: 20,
        very_low: 10
    },
    patterns: {
        unique: [/^id$/i, /^uuid$/i, /^ulid$/i, /_uuid$/i, /^email$/i, /^nik$/i, /^npwp$/i, /^invoice_no$/i, /^trx_id$/i],
        high: [/_id$/i, /^user_id$/i, /^merchant_id$/i, /^tenant_id$/i, /^account_id$/i, /^order_id$/i, /^customer_id$/i, /_code$/i, /^code$/i, /^token$/i, /^phone$/i, /^slug$/i],
        medium: [/^category/i, /^country/i, /^city/i, /^region/i, /^channel/i, /^provider/i, /^payment_method/i],
        low: [/^status$/i, /^state$/i, /^type$/i, /^role$/i, /^tier$/i, /^level$/i, /^stage$/i, /^currency$/i, /^priority$/i],
        very_low: [/^is_/i, /^has_/i, /^can_/i, /_flag$/i, /^active$/i, /^enabled$/i, /^deleted$/i, /^gender$/i, /^archived$/i]
    }
};
export function estimateColumnCardinality(table, column, hints) {
    const cleanCol = column.replace(/^["`]|["`]$/g, '').split('.').pop() || column;
    const qualifiedKey = `${table}.${cleanCol}`;
    if (hints) {
        const hinted = hints[qualifiedKey] || hints[cleanCol];
        if (hinted) {
            return {
                level: hinted,
                score: CARDINALITY_HEURISTICS.weights[hinted],
                fromHint: true
            };
        }
    }
    for (const rx of CARDINALITY_HEURISTICS.patterns.unique) {
        if (rx.test(cleanCol))
            return { level: 'unique', score: 100, fromHint: false };
    }
    for (const rx of CARDINALITY_HEURISTICS.patterns.high) {
        if (rx.test(cleanCol))
            return { level: 'high', score: 80, fromHint: false };
    }
    for (const rx of CARDINALITY_HEURISTICS.patterns.very_low) {
        if (rx.test(cleanCol))
            return { level: 'very_low', score: 10, fromHint: false };
    }
    for (const rx of CARDINALITY_HEURISTICS.patterns.low) {
        if (rx.test(cleanCol))
            return { level: 'low', score: 20, fromHint: false };
    }
    for (const rx of CARDINALITY_HEURISTICS.patterns.medium) {
        if (rx.test(cleanCol))
            return { level: 'medium', score: 50, fromHint: false };
    }
    return { level: 'medium', score: 50, fromHint: false };
}
export const ZERO_DOWNTIME_TEMPLATES = {
    postgresql: {
        add_index: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_{table}_{cols} ON {table} ({cols});',
        drop_index: 'DROP INDEX CONCURRENTLY IF EXISTS {index_name};',
        add_foreign_key: [
            "SET lock_timeout = '2s';",
            'ALTER TABLE {table} ADD CONSTRAINT {fk_name} FOREIGN KEY ({col}) REFERENCES {ref_table}({ref_col}) NOT VALID;',
            'ALTER TABLE {table} VALIDATE CONSTRAINT {fk_name};'
        ],
        set_not_null: [
            "SET lock_timeout = '2s';",
            'ALTER TABLE {table} ADD CONSTRAINT chk_{table}_{col}_nn CHECK ({col} IS NOT NULL) NOT VALID;',
            'ALTER TABLE {table} VALIDATE CONSTRAINT chk_{table}_{col}_nn;',
            'ALTER TABLE {table} ALTER COLUMN {col} SET NOT NULL;',
            'ALTER TABLE {table} DROP CONSTRAINT chk_{table}_{col}_nn;'
        ]
    },
    mysql: {
        add_index: 'CREATE INDEX idx_{table}_{cols} ON {table} ({cols}) ALGORITHM=INPLACE, LOCK=NONE;',
        drop_index: 'DROP INDEX {index_name} ON {table} ALGORITHM=INPLACE, LOCK=NONE;',
        add_column_instant: 'ALTER TABLE {table} ADD COLUMN {col_def}, ALGORITHM=INSTANT;',
        external_online_schema_change: 'gh-ost --user="dba" --host="primary-db" --database="{db}" --table="{table}" --alter="{alter_clause}" --execute'
    }
};
//# sourceMappingURL=catalog.js.map