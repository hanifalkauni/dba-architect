import { readMigrationSources } from '../utils/file-walker.js';
import { parseDdlToSchemaState } from '../parsers/ddl-parser.js';
const FINANCIAL_COLUMN_PATTERNS = /(^|_)(amount|price|balance|total|fee|cost|rate|salary|discount|tax|subtotal|credit|debit)($|_)/i;
const FLOAT_TYPES = /^(FLOAT|FLOAT4|FLOAT8|REAL|DOUBLE|DOUBLE PRECISION)$/i;
const SHORT_BOUNDED_COLUMNS = /(^|_)(status|state|country_code|currency|currency_code|phone|mobile|type|role|gender|lang|locale)($|_)/i;
const TRANSACTIONAL_TABLE_PATTERNS = /(order|payment|transaction|ledger|invoice|journal|wallet|audit|settlement|payout|transfer|event|log)/i;
function getPgAlignmentBytes(baseType) {
    const upper = baseType.toUpperCase();
    if (/^(BIGINT|INT8|BIGSERIAL|SERIAL8|DOUBLE PRECISION|FLOAT8|TIMESTAMPTZ|TIMESTAMP|TIMESTAMP WITH TIME ZONE|TIMESTAMP WITHOUT TIME ZONE|UUID)$/.test(upper)) {
        return 8;
    }
    if (/^(INT|INTEGER|INT4|SERIAL|SERIAL4|DATE|REAL|FLOAT4)$/.test(upper)) {
        return 4;
    }
    if (/^(SMALLINT|INT2|SMALLSERIAL|SERIAL2)$/.test(upper)) {
        return 2;
    }
    if (/^(BOOLEAN|BOOL|CHAR)$/.test(upper)) {
        return 1;
    }
    // Variable-length (varlena) placed last
    return 0;
}
function isColumnIndexedLeftPrefix(table, columnName) {
    if (table.primaryKeyColumns[0]?.toLowerCase() === columnName.toLowerCase()) {
        return true;
    }
    for (const idx of table.indexes) {
        if (idx.columns[0]?.name.toLowerCase() === columnName.toLowerCase()) {
            return true;
        }
    }
    return false;
}
function normalizeCanonicalTypeFamily(col) {
    const b = col.baseType.toUpperCase();
    if (/^(INT|INTEGER|INT4|SERIAL|SERIAL4)$/.test(b))
        return 'INT32';
    if (/^(BIGINT|INT8|BIGSERIAL|SERIAL8)$/.test(b))
        return 'INT64';
    if (/^(SMALLINT|INT2|SMALLSERIAL)$/.test(b))
        return 'INT16';
    if (b === 'UUID')
        return 'UUID';
    if (b === 'BINARY' && col.length === 16)
        return 'BINARY16';
    if (/^(VARCHAR|CHAR|TEXT|CHARACTER VARYING)$/.test(b))
        return `STRING_${col.length ?? 'UNBOUNDED'}`;
    return b;
}
export function analyzeMigration(input) {
    const dialect = input.dialect;
    const strictness = input.strictness ?? 'standard';
    const { combinedSql, warnings } = readMigrationSources(input.migration_source);
    const schema = parseDdlToSchemaState(combinedSql, dialect, warnings);
    const issues = [];
    for (const [, table] of schema.tables) {
        const isTransactionalTable = TRANSACTIONAL_TABLE_PATTERNS.test(table.name);
        // Check columns
        for (const col of table.columns) {
            const upperType = col.baseType.toUpperCase();
            // 1. SCHEMA-TYPE-001: Floating point on financial columns
            if (FINANCIAL_COLUMN_PATTERNS.test(col.name) && FLOAT_TYPES.test(upperType)) {
                const targetType = dialect === 'postgresql' ? 'NUMERIC(19, 4)' : 'DECIMAL(19, 4)';
                const fixDdl = dialect === 'postgresql'
                    ? `ALTER TABLE ${table.name} ALTER COLUMN ${col.name} TYPE ${targetType};`
                    : `ALTER TABLE ${table.name} MODIFY COLUMN ${col.name} ${targetType} NOT NULL;`;
                issues.push({
                    rule_id: 'SCHEMA-TYPE-001',
                    severity: 'CRITICAL',
                    table: table.name,
                    column: col.name,
                    category: 'DATA_TYPE_ANTIPATTERN',
                    finding: `Column '${col.name}' uses floating-point type '${col.rawDataType}'.`,
                    impact: 'Floating-point types cannot represent base-10 decimals accurately, causing rounding errors in financial calculations.',
                    recommendation: `Use '${targetType}' or 'BIGINT' storing minor currency units (e.g., cents/rupiah).`,
                    suggested_ddl_fix: fixDdl
                });
            }
            // 2. SCHEMA-TYPE-002: Oversized VARCHAR(255) on bounded columns
            if ((upperType === 'VARCHAR' || upperType === 'CHARACTER VARYING') &&
                (col.length === undefined || col.length >= 255) &&
                SHORT_BOUNDED_COLUMNS.test(col.name)) {
                issues.push({
                    rule_id: 'SCHEMA-TYPE-002',
                    severity: 'INFO',
                    table: table.name,
                    column: col.name,
                    category: 'OVERSIZED_VARCHAR',
                    finding: `Column '${col.name}' uses oversized '${col.rawDataType}' for a short bounded domain.`,
                    impact: 'Over-allocates memory during in-memory sorting/temporary tables (especially in MySQL) and lacks tight length validation.',
                    recommendation: `Use 'VARCHAR(32)' (or 'CHAR(2)'/'CHAR(3)' for ISO country/currency codes).`,
                    suggested_ddl_fix: dialect === 'postgresql'
                        ? `ALTER TABLE ${table.name} ALTER COLUMN ${col.name} TYPE VARCHAR(32);`
                        : `ALTER TABLE ${table.name} MODIFY COLUMN ${col.name} VARCHAR(32) NOT NULL;`
                });
            }
            // 3. SCHEMA-TYPE-003: 32-bit INT on PK or FK of transactional tables
            if (/^(INT|INTEGER|INT4|SERIAL)$/.test(upperType) &&
                (col.isPrimaryKey || col.name.endsWith('_id')) &&
                isTransactionalTable) {
                issues.push({
                    rule_id: 'SCHEMA-TYPE-003',
                    severity: 'WARNING',
                    table: table.name,
                    column: col.name,
                    category: 'PK_FK_INT_OVERFLOW_RISK',
                    finding: `Identifier column '${col.name}' on transactional table '${table.name}' uses 32-bit '${col.rawDataType}'.`,
                    impact: '32-bit signed integers overflow at ~2.14 billion rows, requiring an expensive table rewrite later.',
                    recommendation: "Use 64-bit 'BIGINT' (or 'UUID' with UUIDv7).",
                    suggested_ddl_fix: dialect === 'postgresql'
                        ? `ALTER TABLE ${table.name} ALTER COLUMN ${col.name} TYPE BIGINT;`
                        : `ALTER TABLE ${table.name} MODIFY COLUMN ${col.name} BIGINT UNSIGNED NOT NULL;`
                });
            }
            // 4. SCHEMA-TYPE-004: UUID stored as VARCHAR(36) / CHAR(36) / TEXT
            const looksLikeUuidCol = col.name === 'id' || col.name === 'uuid' || col.name.endsWith('_id') || col.name.endsWith('_uuid');
            if (looksLikeUuidCol &&
                ((upperType === 'VARCHAR' && col.length === 36) ||
                    (upperType === 'CHAR' && col.length === 36) ||
                    (col.name.includes('uuid') && (upperType === 'VARCHAR' || upperType === 'TEXT')))) {
                issues.push({
                    rule_id: 'SCHEMA-TYPE-004',
                    severity: 'WARNING',
                    table: table.name,
                    column: col.name,
                    category: 'SUBOPTIMAL_UUID_STORAGE',
                    finding: `Column '${col.name}' is defined as '${col.rawDataType}' to store UUIDs.`,
                    impact: 'Consumes 37-40 bytes per row instead of 16 bytes for native UUID/BINARY(16), increasing B-Tree index size by ~2.2x and reducing buffer pool hit ratio.',
                    recommendation: dialect === 'postgresql'
                        ? "Use the native 'UUID' data type (preferably generated with UUIDv7 for sequential locality)."
                        : "Use 'BINARY(16)' with UUID_TO_BIN(uuid, 1) or UUIDv7.",
                    suggested_ddl_fix: dialect === 'postgresql'
                        ? `ALTER TABLE ${table.name} ALTER COLUMN ${col.name} TYPE UUID USING ${col.name}::uuid;`
                        : `ALTER TABLE ${table.name} MODIFY COLUMN ${col.name} BINARY(16) NOT NULL;`
                });
            }
            // 5. SCHEMA-PK-001: MySQL Random UUID PK on Clustered Index
            if (dialect === 'mysql' &&
                col.isPrimaryKey &&
                (upperType === 'UUID' ||
                    ((upperType === 'VARCHAR' || upperType === 'CHAR') && col.length === 36) ||
                    col.defaultValue?.toUpperCase().includes('UUID()'))) {
                issues.push({
                    rule_id: 'SCHEMA-PK-001',
                    severity: 'WARNING',
                    table: table.name,
                    column: col.name,
                    category: 'MYSQL_RANDOM_UUID_PK',
                    finding: `Primary key '${col.name}' on MySQL InnoDB table '${table.name}' uses UUID strings or random UUIDv4.`,
                    impact: 'InnoDB clusters table data by Primary Key. Random UUIDs cause random page insertions, page splitting, and bloated secondary indexes.',
                    recommendation: 'Use BIGINT UNSIGNED AUTO_INCREMENT as the Clustered PK, or use time-ordered UUIDv7 stored in BINARY(16).',
                    suggested_ddl_fix: `ALTER TABLE ${table.name} MODIFY COLUMN ${col.name} BINARY(16) NOT NULL;`
                });
            }
            // 6. SCHEMA-TYPE-005: Timestamp without time zone (PG) or 32-bit TIMESTAMP (MySQL)
            if (dialect === 'postgresql' && (upperType === 'TIMESTAMP' || upperType === 'TIMESTAMP WITHOUT TIME ZONE')) {
                issues.push({
                    rule_id: 'SCHEMA-TYPE-005',
                    severity: 'WARNING',
                    table: table.name,
                    column: col.name,
                    category: 'TIMESTAMP_WITHOUT_TZ',
                    finding: `Column '${col.name}' uses '${col.rawDataType}' without time zone in PostgreSQL.`,
                    impact: 'Strips timezone offset context and causes ambiguity across distributed services and DST transitions.',
                    recommendation: "Use 'TIMESTAMPTZ' (TIMESTAMP WITH TIME ZONE).",
                    suggested_ddl_fix: `ALTER TABLE ${table.name} ALTER COLUMN ${col.name} TYPE TIMESTAMPTZ USING ${col.name} AT TIME ZONE 'UTC';`
                });
            }
            else if (dialect === 'mysql' && upperType === 'TIMESTAMP') {
                issues.push({
                    rule_id: 'SCHEMA-TYPE-005',
                    severity: 'WARNING',
                    table: table.name,
                    column: col.name,
                    category: 'TIMESTAMP_WITHOUT_TZ',
                    finding: `Column '${col.name}' uses 32-bit 'TIMESTAMP' in MySQL.`,
                    impact: 'MySQL 32-bit TIMESTAMP is susceptible to the Year 2038 (Y2K38) overflow limit (2038-01-19).',
                    recommendation: "Use 'DATETIME' (or 'DATETIME(6)') storing UTC timestamps.",
                    suggested_ddl_fix: `ALTER TABLE ${table.name} MODIFY COLUMN ${col.name} DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP;`
                });
            }
            // 7. SCHEMA-CONST-001: Missing NOT NULL on status, created_at, or FK columns
            const isCoreNonNullCol = /^(status|state|created_at|updated_at|tenant_id|merchant_id|user_id|order_id)$/i.test(col.name);
            if (col.nullable && !col.isPrimaryKey && isCoreNonNullCol) {
                issues.push({
                    rule_id: 'SCHEMA-CONST-001',
                    severity: 'WARNING',
                    table: table.name,
                    column: col.name,
                    category: 'MISSING_NOT_NULL',
                    finding: `Core column '${col.name}' is defined as NULLABLE without an explicit NOT NULL constraint.`,
                    impact: 'Allows unexpected NULL states, complicates query predicates with IS NULL checks, and degrades index predictability.',
                    recommendation: `Add 'NOT NULL' constraint to '${col.name}'.`,
                    suggested_ddl_fix: dialect === 'postgresql'
                        ? `ALTER TABLE ${table.name} ALTER COLUMN ${col.name} SET NOT NULL;`
                        : `ALTER TABLE ${table.name} MODIFY COLUMN ${col.name} ${col.rawDataType} NOT NULL;`
                });
            }
        }
        // 8. Foreign Key Checks (SCHEMA-FK-001, SCHEMA-FK-002, SCHEMA-FK-003)
        for (const fk of table.foreignKeys) {
            const fkColName = fk.columns[0];
            const refColName = fk.referencedColumns[0] || 'id';
            // SCHEMA-FK-001: Unindexed Foreign Key
            if (!isColumnIndexedLeftPrefix(table, fkColName)) {
                const idxName = `idx_${table.name}_${fkColName}`;
                const createIdxDdl = dialect === 'postgresql'
                    ? `CREATE INDEX CONCURRENTLY ${idxName} ON ${table.name} (${fkColName});`
                    : `CREATE INDEX ${idxName} ON ${table.name} (${fkColName}) ALGORITHM=INPLACE, LOCK=NONE;`;
                issues.push({
                    rule_id: 'SCHEMA-FK-001',
                    severity: 'WARNING',
                    table: table.name,
                    column: fkColName,
                    category: 'UNINDEXED_FOREIGN_KEY',
                    finding: `Foreign key column '${fkColName}' referencing '${fk.referencedTable}(${refColName})' does not have a supporting index.`,
                    impact: 'PostgreSQL does not automatically index foreign keys. Updates or deletes on the parent table will trigger a Sequential Scan on the child table, causing lock contention.',
                    recommendation: 'Create a B-Tree index on the foreign key column.',
                    suggested_ddl_fix: createIdxDdl
                });
            }
            // SCHEMA-FK-002: Foreign Key Type Mismatch
            const parentTable = schema.tables.get(fk.referencedTable);
            const childCol = table.columns.find((c) => c.name.toLowerCase() === fkColName.toLowerCase());
            const parentCol = parentTable?.columns.find((c) => c.name.toLowerCase() === refColName.toLowerCase());
            if (childCol && parentCol) {
                const childFamily = normalizeCanonicalTypeFamily(childCol);
                const parentFamily = normalizeCanonicalTypeFamily(parentCol);
                const unsignedMismatch = Boolean(childCol.unsigned) !== Boolean(parentCol.unsigned);
                if (childFamily !== parentFamily || unsignedMismatch) {
                    issues.push({
                        rule_id: 'SCHEMA-FK-002',
                        severity: 'CRITICAL',
                        table: table.name,
                        column: fkColName,
                        category: 'FOREIGN_KEY_TYPE_MISMATCH',
                        finding: `Foreign key '${table.name}.${fkColName}' (${childCol.rawDataType}) does not match referenced primary key '${fk.referencedTable}.${refColName}' (${parentCol.rawDataType}).`,
                        impact: 'Causes Foreign Key creation failure in MySQL InnoDB or implicit type conversion during JOINs that disables B-Tree index usage.',
                        recommendation: `Change '${table.name}.${fkColName}' to match '${parentCol.rawDataType}'.`,
                        suggested_ddl_fix: dialect === 'postgresql'
                            ? `ALTER TABLE ${table.name} ALTER COLUMN ${fkColName} TYPE ${parentCol.rawDataType};`
                            : `ALTER TABLE ${table.name} MODIFY COLUMN ${fkColName} ${parentCol.rawDataType} NOT NULL;`
                    });
                }
            }
            // SCHEMA-FK-003: Dangerous ON DELETE CASCADE or Missing ON DELETE on transactional tables
            if (fk.onDelete === 'CASCADE' && isTransactionalTable) {
                issues.push({
                    rule_id: 'SCHEMA-FK-003',
                    severity: 'WARNING',
                    table: table.name,
                    column: fkColName,
                    category: 'DANGEROUS_CASCADE',
                    finding: `Transactional table '${table.name}' uses 'ON DELETE CASCADE' on foreign key '${fkColName}'.`,
                    impact: 'Deleting a parent record will silently cascade and permanently destroy historical financial/transactional records.',
                    recommendation: "Use 'ON DELETE RESTRICT' and implement soft-deletion or archiving instead.",
                    suggested_ddl_fix: `-- Replace ON DELETE CASCADE with ON DELETE RESTRICT on ${table.name}(${fkColName})`
                });
            }
            else if (!fk.onDelete && isTransactionalTable && strictness === 'strict') {
                issues.push({
                    rule_id: 'SCHEMA-FK-003',
                    severity: 'WARNING',
                    table: table.name,
                    column: fkColName,
                    category: 'IMPLICIT_FK_ON_DELETE',
                    finding: `Transactional table '${table.name}' foreign key '${fkColName}' omits an explicit 'ON DELETE' action.`,
                    impact: 'Relying on implicit engine defaults makes referential integrity behavior ambiguous during parent record deletion.',
                    recommendation: "Explicitly specify 'ON DELETE RESTRICT' (or 'ON DELETE SET NULL' where appropriate).",
                    suggested_ddl_fix: `-- Add explicit ON DELETE RESTRICT on ${table.name}(${fkColName})`
                });
            }
        }
        // 9. SCHEMA-NORM-001: Repeating Groups (1NF Violation)
        const numberedGroups = new Map();
        for (const col of table.columns) {
            const m = col.name.match(/^([a-zA-Z_]+?)_?([1-9])$/);
            if (m) {
                const prefix = m[1];
                const list = numberedGroups.get(prefix) ?? [];
                list.push(col.name);
                numberedGroups.set(prefix, list);
            }
        }
        for (const [prefix, cols] of numberedGroups.entries()) {
            if (cols.length >= 2) {
                issues.push({
                    rule_id: 'SCHEMA-NORM-001',
                    severity: 'WARNING',
                    table: table.name,
                    column: cols.join(', '),
                    category: 'FIRST_NORMAL_FORM_VIOLATION',
                    finding: `Detected repeating column group (${cols.join(', ')}) on table '${table.name}'.`,
                    impact: 'Violates First Normal Form (1NF), forces OR predicates across multiple columns, and prevents clean indexing.',
                    recommendation: `Extract '${prefix}' into a separate 1-to-N child table '${table.name}_${prefix}s'.`,
                    suggested_ddl_fix: `CREATE TABLE ${table.name}_${prefix}s (\n    id UUID PRIMARY KEY,\n    ${table.name}_id UUID NOT NULL REFERENCES ${table.name}(id) ON DELETE CASCADE,\n    ${prefix}_value VARCHAR(255) NOT NULL\n);`
                });
            }
        }
        // 10. SCHEMA-NORM-002: JSON/JSONB Document Abuse
        const jsonCols = table.columns.filter((c) => /^(JSON|JSONB)$/i.test(c.baseType));
        if (jsonCols.length > 0 && table.columns.length <= 3) {
            const jsonCol = jsonCols[0];
            issues.push({
                rule_id: 'SCHEMA-NORM-002',
                severity: 'INFO',
                table: table.name,
                column: jsonCol.name,
                category: 'JSONB_DOCUMENT_ABUSE',
                finding: `Table '${table.name}' consists almost entirely of a single '${jsonCol.baseType}' document column ('${jsonCol.name}').`,
                impact: 'Loses relational column statistics, foreign key integrity, and causes TOAST table bloat on frequent updates.',
                recommendation: dialect === 'postgresql'
                    ? 'Extract frequently filtered fields into typed relational columns and add a GIN index if querying JSON paths.'
                    : 'Extract core fields into relational columns or create Generated Virtual Columns with B-Tree indexes.',
                suggested_ddl_fix: dialect === 'postgresql'
                    ? `CREATE INDEX CONCURRENTLY idx_${table.name}_${jsonCol.name}_gin ON ${table.name} USING GIN (${jsonCol.name});`
                    : `-- Add generated column for hot JSON attribute on ${table.name}.${jsonCol.name}`
            });
        }
        // 11. SCHEMA-LAYOUT-001: PostgreSQL Column Alignment Padding (Column Tetris) in strict mode
        if (dialect === 'postgresql' && strictness === 'strict' && table.columns.length >= 4) {
            let alignmentTransitions = 0;
            let sawSmallOrVarlena = false;
            for (const col of table.columns) {
                const align = getPgAlignmentBytes(col.baseType);
                if (align < 8) {
                    sawSmallOrVarlena = true;
                }
                else if (align === 8 && sawSmallOrVarlena) {
                    alignmentTransitions++;
                }
            }
            if (alignmentTransitions > 0) {
                const sortedCols = [...table.columns].sort((a, b) => getPgAlignmentBytes(b.baseType) - getPgAlignmentBytes(a.baseType));
                issues.push({
                    rule_id: 'SCHEMA-LAYOUT-001',
                    severity: 'INFO',
                    table: table.name,
                    category: 'COLUMN_ALIGNMENT_PADDING',
                    finding: `Column declaration order in '${table.name}' interleaves 8-byte columns after smaller/variable-length columns.`,
                    impact: 'Introduces CPU struct alignment padding bytes per tuple in PostgreSQL heap pages.',
                    recommendation: `Order columns from 8-byte fixed-width down to variable-length: (${sortedCols.map((c) => c.name).join(', ')}).`,
                    suggested_ddl_fix: `-- Reorder columns in CREATE TABLE ${table.name}: ${sortedCols.map((c) => c.name).join(', ')}`
                });
            }
        }
    }
    // 12. SCHEMA-DDL-001: Check standalone CREATE INDEX statements without CONCURRENTLY / ALGORITHM=INPLACE
    for (const idx of schema.indexes) {
        const rawStmt = schema.rawStatements.find((s) => /CREATE\s+(?:UNIQUE\s+)?INDEX/i.test(s) && s.includes(idx.name));
        if (rawStmt) {
            if (dialect === 'postgresql' && !idx.concurrently) {
                issues.push({
                    rule_id: 'SCHEMA-DDL-001',
                    severity: 'CRITICAL',
                    table: idx.table,
                    category: 'UNSAFE_LOCKING_DDL',
                    finding: `Index '${idx.name}' on '${idx.table}' is created without 'CONCURRENTLY'.`,
                    impact: 'Standard CREATE INDEX acquires a SHARE lock that blocks all INSERT, UPDATE, and DELETE operations on the table until index build finishes.',
                    recommendation: "Use 'CREATE INDEX CONCURRENTLY' in migration scripts targeting live tables.",
                    suggested_ddl_fix: `CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX CONCURRENTLY ${idx.name} ON ${idx.table} (${idx.columns.map((c) => c.name).join(', ')});`
                });
            }
            else if (dialect === 'mysql' && !/ALGORITHM\s*=\s*INPLACE/i.test(rawStmt)) {
                issues.push({
                    rule_id: 'SCHEMA-DDL-001',
                    severity: 'CRITICAL',
                    table: idx.table,
                    category: 'UNSAFE_LOCKING_DDL',
                    finding: `Index '${idx.name}' on '${idx.table}' is created without explicit 'ALGORITHM=INPLACE, LOCK=NONE'.`,
                    impact: 'May fall back to table copy or metadata lock that stalls concurrent DML on large MySQL InnoDB tables.',
                    recommendation: "Append 'ALGORITHM=INPLACE, LOCK=NONE' to CREATE INDEX statements.",
                    suggested_ddl_fix: `CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX ${idx.name} ON ${idx.table} (${idx.columns.map((c) => c.name).join(', ')}) ALGORITHM=INPLACE, LOCK=NONE;`
                });
            }
        }
    }
    // 13. SCHEMA-DDL-001: Check blocking ALTER TABLE statements (validated FK without NOT VALID, SET NOT NULL, column type rewrite)
    for (const rawStmt of schema.rawStatements) {
        const alterMatch = rawStmt.match(/^ALTER\s+TABLE\s+(?:ONLY\s+)?([^\s]+)\s+([\s\S]+)$/i);
        if (!alterMatch)
            continue;
        const tblName = alterMatch[1].replace(/^["`[]|["`\]]$/g, '').replace(/^[a-zA-Z0-9_]+\./, '');
        const body = alterMatch[2];
        if (dialect === 'postgresql') {
            if (/ADD\s+(?:CONSTRAINT\s+[^\s]+\s+)?FOREIGN\s+KEY/i.test(body) && !/\bNOT\s+VALID\b/i.test(body)) {
                issues.push({
                    rule_id: 'SCHEMA-DDL-001',
                    severity: 'CRITICAL',
                    table: tblName,
                    category: 'UNSAFE_LOCKING_DDL',
                    finding: `ALTER TABLE on '${tblName}' adds a FOREIGN KEY constraint without 'NOT VALID'.`,
                    impact: 'Acquires an AccessExclusiveLock on both child and parent tables while scanning all existing rows to validate the constraint.',
                    recommendation: "Add the foreign key with 'NOT VALID' under a short lock_timeout, then run 'ALTER TABLE ... VALIDATE CONSTRAINT ...' in a separate transaction.",
                    suggested_ddl_fix: `${rawStmt.replace(/;?\s*$/, '')} NOT VALID;`
                });
            }
            if (/ALTER\s+COLUMN\s+[^\s]+\s+SET\s+NOT\s+NULL/i.test(body)) {
                issues.push({
                    rule_id: 'SCHEMA-DDL-001',
                    severity: 'CRITICAL',
                    table: tblName,
                    category: 'UNSAFE_LOCKING_DDL',
                    finding: `ALTER TABLE on '${tblName}' runs 'SET NOT NULL' directly on an existing column.`,
                    impact: 'Scans the entire table under an AccessExclusiveLock unless a validated CHECK (col IS NOT NULL) constraint already exists.',
                    recommendation: "Create a 'CHECK (col IS NOT NULL) NOT VALID' constraint, 'VALIDATE CONSTRAINT', then promote to 'SET NOT NULL' using 'plan_zero_downtime_migration'.",
                    suggested_ddl_fix: `SET lock_timeout = '2s'; ${rawStmt}`
                });
            }
            if (/ALTER\s+COLUMN\s+[^\s]+\s+(?:SET\s+DATA\s+)?TYPE\b/i.test(body)) {
                issues.push({
                    rule_id: 'SCHEMA-DDL-001',
                    severity: 'CRITICAL',
                    table: tblName,
                    category: 'UNSAFE_LOCKING_DDL',
                    finding: `ALTER TABLE on '${tblName}' changes a column data type in-place.`,
                    impact: 'Rewrites the entire table heap and all indexes while holding an AccessExclusiveLock.',
                    recommendation: 'Use a multi-phase Expand & Contract migration (shadow column + dual-write + backfill + rename).',
                    suggested_ddl_fix: `-- Use plan_zero_downtime_migration for expand-and-contract column type change on ${tblName}`
                });
            }
        }
        else if (dialect === 'mysql') {
            if (/\bMODIFY(?:\s+COLUMN)?\b|\bCHANGE(?:\s+COLUMN)?\b/i.test(body) && !/ALGORITHM\s*=\s*(?:INPLACE|INSTANT)/i.test(body)) {
                issues.push({
                    rule_id: 'SCHEMA-DDL-001',
                    severity: 'CRITICAL',
                    table: tblName,
                    category: 'UNSAFE_LOCKING_DDL',
                    finding: `ALTER TABLE on '${tblName}' modifies a column without online DDL clauses or external shadow-table migration.`,
                    impact: 'Changing column types in MySQL InnoDB typically triggers ALGORITHM=COPY, blocking concurrent writes.',
                    recommendation: "Use 'gh-ost' or 'pt-online-schema-change' for table-rebuilding column modifications, or specify 'ALGORITHM=INPLACE, LOCK=NONE' if supported.",
                    suggested_ddl_fix: `${rawStmt.replace(/;?\s*$/, '')}, ALGORITHM=INPLACE, LOCK=NONE;`
                });
            }
        }
    }
    // Calculate deterministic Health Score
    const criticalCount = issues.filter((i) => i.severity === 'CRITICAL').length;
    const warningCount = issues.filter((i) => i.severity === 'WARNING').length;
    const infoCount = issues.filter((i) => i.severity === 'INFO').length;
    const rawScore = 100 - 25 * criticalCount - 8 * warningCount - 2 * infoCount;
    const score = Math.max(0, rawScore);
    // Generate optimized DDL script
    const optimizedDdlParts = [];
    for (const [, table] of schema.tables) {
        const colLines = [];
        for (const col of table.columns) {
            let optType = col.rawDataType;
            const upper = col.baseType.toUpperCase();
            if (FINANCIAL_COLUMN_PATTERNS.test(col.name) && FLOAT_TYPES.test(upper)) {
                optType = dialect === 'postgresql' ? 'NUMERIC(19, 4)' : 'DECIMAL(19, 4)';
            }
            else if ((col.name === 'id' || col.name.endsWith('_id') || col.name.includes('uuid')) &&
                upper === 'VARCHAR' &&
                col.length === 36) {
                optType = dialect === 'postgresql' ? 'UUID' : 'BINARY(16)';
            }
            else if (dialect === 'postgresql' && (upper === 'TIMESTAMP' || upper === 'TIMESTAMP WITHOUT TIME ZONE')) {
                optType = 'TIMESTAMPTZ';
            }
            else if ((upper === 'VARCHAR' || upper === 'CHARACTER VARYING') &&
                (col.length === undefined || col.length >= 255) &&
                SHORT_BOUNDED_COLUMNS.test(col.name)) {
                optType = 'VARCHAR(32)';
            }
            const pkClause = col.isPrimaryKey && table.primaryKeyColumns.length === 1 ? ' PRIMARY KEY' : '';
            const notNullClause = !col.isPrimaryKey &&
                (!col.nullable || /^(status|state|created_at|updated_at|tenant_id|merchant_id|user_id|order_id)$/i.test(col.name))
                ? ' NOT NULL'
                : '';
            const defaultClause = col.defaultValue ? ` DEFAULT ${col.defaultValue}` : '';
            const refClause = col.references
                ? ` REFERENCES ${col.references.table}(${col.references.column}) ON DELETE ${col.references.onDelete === 'CASCADE' && TRANSACTIONAL_TABLE_PATTERNS.test(table.name)
                    ? 'RESTRICT'
                    : col.references.onDelete || 'RESTRICT'}`
                : '';
            colLines.push(`    ${col.name} ${optType}${pkClause}${notNullClause}${defaultClause}${refClause}`);
        }
        if (table.primaryKeyColumns.length > 1) {
            colLines.push(`    PRIMARY KEY (${table.primaryKeyColumns.join(', ')})`);
        }
        let createTableDdl = `CREATE TABLE ${table.name} (\n${colLines.join(',\n')}\n);`;
        optimizedDdlParts.push(createTableDdl);
        // Add missing FK indexes
        for (const fk of table.foreignKeys) {
            const fkCol = fk.columns[0];
            if (!isColumnIndexedLeftPrefix(table, fkCol)) {
                const idxName = `idx_${table.name}_${fkCol}`;
                optimizedDdlParts.push(dialect === 'postgresql'
                    ? `CREATE INDEX CONCURRENTLY ${idxName} ON ${table.name} (${fkCol});`
                    : `CREATE INDEX ${idxName} ON ${table.name} (${fkCol}) ALGORITHM=INPLACE, LOCK=NONE;`);
            }
        }
    }
    return {
        summary: {
            dialect,
            tables_analyzed: schema.tables.size,
            score,
            issue_counts: {
                critical: criticalCount,
                warning: warningCount,
                info: infoCount
            }
        },
        issues,
        parse_warnings: schema.parseWarnings,
        optimized_ddl_script: optimizedDdlParts.join('\n')
    };
}
//# sourceMappingURL=analyze-migration.js.map