import { splitSqlStatements } from '../parsers/ddl-parser.js';
export function planZeroDowntimeMigration(input) {
    const dialect = input.dialect;
    const rows = input.estimated_table_rows ?? 10000000;
    const rawStatements = splitSqlStatements(input.ddl_statements);
    const assessments = [];
    const runbook = [];
    let maxRiskScore = 0; // 0=LOW, 1=MODERATE, 2=HIGH, 3=CRITICAL
    for (const stmt of rawStatements) {
        const normalized = stmt.replace(/\s+/g, ' ').trim();
        // Case 1: CREATE INDEX without CONCURRENTLY / ALGORITHM=INPLACE
        const createIdxMatch = normalized.match(/^CREATE\s+(UNIQUE\s+)?INDEX\s+(?!CONCURRENTLY)([^\s]+)\s+ON\s+([^\s(]+)\s*\(([^)]+)\)(.*)$/i);
        if (createIdxMatch) {
            const unique = createIdxMatch[1] ? 'UNIQUE ' : '';
            const idxName = createIdxMatch[2];
            const table = createIdxMatch[3];
            const cols = createIdxMatch[4];
            const tail = createIdxMatch[5] || '';
            if (dialect === 'postgresql') {
                maxRiskScore = Math.max(maxRiskScore, 2);
                assessments.push({
                    rule_id: 'SCHEMA-DDL-001',
                    original_ddl: `${stmt};`,
                    lock_type_acquired: 'ShareLock (blocks all INSERT, UPDATE, DELETE during index build)',
                    hazard_explanation: `Building index '${idxName}' without CONCURRENTLY blocks all writes across ${rows.toLocaleString()} rows.`
                });
                runbook.push({
                    phase: `Phase ${runbook.length + 1}: Online Index Creation (PostgreSQL CONCURRENTLY)`,
                    description: 'Build the B-Tree index in two background table scans using ShareUpdateExclusiveLock without blocking concurrent reads or writes.',
                    sql_script: `CREATE ${unique}INDEX CONCURRENTLY IF NOT EXISTS ${idxName} ON ${table} (${cols});`
                });
            }
            else if (!/ALGORITHM\s*=\s*INPLACE/i.test(tail)) {
                maxRiskScore = Math.max(maxRiskScore, 2);
                assessments.push({
                    rule_id: 'SCHEMA-DDL-001',
                    original_ddl: `${stmt};`,
                    lock_type_acquired: 'Shared Metadata Lock (potential DML stall if LOCK=NONE is omitted)',
                    hazard_explanation: `Ensure explicit Online DDL clauses are set when indexing ${rows.toLocaleString()} rows in MySQL InnoDB.`
                });
                runbook.push({
                    phase: `Phase ${runbook.length + 1}: Online Index Creation (MySQL InnoDB In-Place)`,
                    description: 'Enforce ALGORITHM=INPLACE and LOCK=NONE so MySQL fails fast rather than blocking DML if online build is unsupported.',
                    sql_script: `CREATE ${unique}INDEX ${idxName} ON ${table} (${cols}) ALGORITHM=INPLACE, LOCK=NONE;`
                });
            }
            continue;
        }
        // Case 2: ALTER TABLE ... ADD CONSTRAINT FOREIGN KEY or SET NOT NULL
        const alterTableMatch = normalized.match(/^ALTER\s+TABLE\s+(?:ONLY\s+)?([^\s]+)\s+([\s\S]+)$/i);
        if (alterTableMatch) {
            const table = alterTableMatch[1];
            const body = alterTableMatch[2];
            const fkMatch = body.match(/ADD\s+(?:CONSTRAINT\s+([^\s]+)\s+)?FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+([^\s(]+)\s*\(([^)]+)\)/i);
            const notNullMatches = [...body.matchAll(/ALTER\s+COLUMN\s+([^\s]+)\s+SET\s+NOT\s+NULL/gi)];
            const changeTypeMatch = body.match(/(?:ALTER\s+COLUMN\s+([^\s]+)\s+(?:SET\s+DATA\s+)?TYPE\s+([a-zA-Z0-9_ ]+(?:\([^)]+\))?)|MODIFY(?:\s+COLUMN)?\s+([^\s]+)\s+([a-zA-Z0-9_ ]+(?:\([^)]+\))?))/i);
            if (dialect === 'postgresql' && (fkMatch || notNullMatches.length > 0)) {
                maxRiskScore = Math.max(maxRiskScore, 2);
                assessments.push({
                    rule_id: 'SCHEMA-DDL-001',
                    original_ddl: `${stmt};`,
                    lock_type_acquired: 'AccessExclusiveLock (blocks all SELECT, INSERT, UPDATE, DELETE during full table validation scan)',
                    hazard_explanation: `Adding a validated Foreign Key or setting NOT NULL directly scans all ${rows.toLocaleString()} rows while holding an exclusive lock.`
                });
                const phase1Lines = [];
                const phase2Lines = [];
                const phase3Lines = [];
                if (fkMatch) {
                    const fkName = fkMatch[1] || `fk_${table}_${fkMatch[2].trim()}`;
                    const fkCol = fkMatch[2].trim();
                    const refTable = fkMatch[3].trim();
                    const refCol = fkMatch[4].trim();
                    phase1Lines.push(`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_${table}_${fkCol} ON ${table} (${fkCol});`);
                    phase1Lines.push(`SET lock_timeout = '2s';`);
                    phase1Lines.push(`ALTER TABLE ${table} ADD CONSTRAINT ${fkName} FOREIGN KEY (${fkCol}) REFERENCES ${refTable}(${refCol}) NOT VALID;`);
                    phase2Lines.push(`ALTER TABLE ${table} VALIDATE CONSTRAINT ${fkName};`);
                }
                for (const nn of notNullMatches) {
                    const col = nn[1];
                    const chkName = `chk_${table}_${col}_not_null`;
                    if (!phase1Lines.includes(`SET lock_timeout = '2s';`)) {
                        phase1Lines.push(`SET lock_timeout = '2s';`);
                    }
                    phase1Lines.push(`ALTER TABLE ${table} ADD CONSTRAINT ${chkName} CHECK (${col} IS NOT NULL) NOT VALID;`);
                    phase2Lines.push(`ALTER TABLE ${table} VALIDATE CONSTRAINT ${chkName};`);
                    if (!phase3Lines.includes(`SET lock_timeout = '2s';`)) {
                        phase3Lines.push(`SET lock_timeout = '2s';`);
                    }
                    phase3Lines.push(`ALTER TABLE ${table} ALTER COLUMN ${col} SET NOT NULL;`);
                    phase3Lines.push(`ALTER TABLE ${table} DROP CONSTRAINT ${chkName};`);
                }
                if (phase1Lines.length > 0) {
                    runbook.push({
                        phase: 'Phase 1: Create Supporting Index & Unvalidated Constraints (Expand)',
                        description: 'Create index concurrently and add constraints with NOT VALID so existing rows are not scanned under an exclusive lock.',
                        sql_script: phase1Lines.join('\n')
                    });
                }
                if (phase2Lines.length > 0) {
                    runbook.push({
                        phase: 'Phase 2: Background Constraint Validation',
                        description: 'Validate constraints using ShareUpdateExclusiveLock, which allows concurrent reads and writes.',
                        sql_script: phase2Lines.join('\n')
                    });
                }
                if (phase3Lines.length > 0) {
                    runbook.push({
                        phase: 'Phase 3: Instant Metadata Promotion (Contract)',
                        description: 'Promote validated CHECK constraint to native NOT NULL without scanning the table (PostgreSQL 12+).',
                        sql_script: phase3Lines.join('\n')
                    });
                }
                continue;
            }
            // Column Type Change (Table Rewrite Hazard)
            if (changeTypeMatch) {
                const col = (changeTypeMatch[1] || changeTypeMatch[3]).trim();
                const newType = (changeTypeMatch[2] || changeTypeMatch[4]).trim();
                maxRiskScore = Math.max(maxRiskScore, 3);
                assessments.push({
                    rule_id: 'SCHEMA-DDL-001',
                    original_ddl: `${stmt};`,
                    lock_type_acquired: dialect === 'postgresql'
                        ? 'AccessExclusiveLock with Full Heap & Index Rewrite'
                        : 'InnoDB Table Copy Rebuild (ALGORITHM=COPY, blocks concurrent DML)',
                    hazard_explanation: `Changing column '${col}' to '${newType}' rewrites all ${rows.toLocaleString()} rows on disk and holds an exclusive lock.`
                });
                if (dialect === 'postgresql') {
                    runbook.push({
                        phase: 'Phase 1: Add Shadow Column & Dual-Write Trigger (Expand)',
                        description: `Add new column '${col}_v2' with target type '${newType}' (metadata-only operation) and sync writes.`,
                        sql_script: `SET lock_timeout = '2s';\nALTER TABLE ${table} ADD COLUMN ${col}_v2 ${newType};\n-- Deploy application dual-write or synchronization trigger to populate ${col}_v2 on INSERT/UPDATE.`
                    }, {
                        phase: 'Phase 2: Batched Background Backfill',
                        description: `Backfill '${col}_v2' in small batches of 5,000 rows to avoid long locks and WAL spikes.`,
                        sql_script: `-- Run in batches from application worker:\nUPDATE ${table} SET ${col}_v2 = ${col}::${newType} WHERE id IN (SELECT id FROM ${table} WHERE ${col}_v2 IS NULL LIMIT 5000);`
                    }, {
                        phase: 'Phase 3: Swap Columns & Drop Old Column (Contract)',
                        description: 'Verify zero NULLs, swap column names under brief lock_timeout, and drop legacy column.',
                        sql_script: `SET lock_timeout = '2s';\nALTER TABLE ${table} RENAME COLUMN ${col} TO ${col}_legacy;\nALTER TABLE ${table} RENAME COLUMN ${col}_v2 TO ${col};\nALTER TABLE ${table} DROP COLUMN ${col}_legacy;`
                    });
                }
                else {
                    runbook.push({
                        phase: 'Phase 1: Online Shadow Table Migration via gh-ost / pt-online-schema-change',
                        description: 'MySQL column data type changes require a table copy. Use gh-ost to perform lock-free shadow table migration via binlog streaming.',
                        sql_script: `gh-ost \\\n  --user="dba" \\\n  --host="primary-db.internal" \\\n  --database="app_db" \\\n  --table="${table}" \\\n  --alter="MODIFY COLUMN ${col} ${newType}" \\\n  --chunk-size=2000 \\\n  --max-load="Threads_running=25" \\\n  --execute`
                    });
                }
                continue;
            }
            // Default ALTER TABLE fallback
            maxRiskScore = Math.max(maxRiskScore, 1);
            assessments.push({
                rule_id: 'SCHEMA-DDL-001',
                original_ddl: `${stmt};`,
                lock_type_acquired: dialect === 'postgresql' ? 'AccessExclusiveLock (brief metadata lock)' : 'InnoDB Metadata Lock',
                hazard_explanation: 'Standard DDL operation; guard with explicit lock_timeout / online algorithm clauses.'
            });
            runbook.push({
                phase: `Phase ${runbook.length + 1}: Guarded DDL Execution`,
                description: 'Execute with strict lock timeout to prevent lock queue pileup if a long query is running.',
                sql_script: dialect === 'postgresql'
                    ? `SET lock_timeout = '2s';\n${stmt};`
                    : `${stmt}, ALGORITHM=INPLACE, LOCK=NONE;`
            });
        }
    }
    const riskLevels = [
        'LOW_SAFE',
        'MODERATE_BRIEF_LOCK',
        'HIGH_LOCKING_RISK',
        'CRITICAL_TABLE_REWRITE'
    ];
    return {
        overall_risk_level: riskLevels[maxRiskScore] || 'LOW_SAFE',
        statement_assessments: assessments,
        zero_downtime_runbook: runbook
    };
}
//# sourceMappingURL=plan-zero-downtime.js.map