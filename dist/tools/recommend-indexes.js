import { estimateColumnCardinality } from '../constants/catalog.js';
import { parseDdlToSchemaState } from '../parsers/ddl-parser.js';
import { analyzeSqlQueryAst } from '../parsers/query-parser.js';
import { readMigrationSources } from '../utils/file-walker.js';
export function buildEsrIndexForTablePredicate(options) {
    const { dialect, pred, executionFrequency, cardinalityHints, primaryKeyColumns = ['id'] } = options;
    // Combine equality_columns + join_columns
    const rawEqCols = Array.from(new Set([...pred.equality_columns, ...pred.join_columns]));
    if (rawEqCols.length === 0 && pred.sort_columns.length === 0 && pred.range_columns.length === 0) {
        return null;
    }
    // Check if single expression index (e.g., LOWER(email))
    if (rawEqCols.length === 1 && /[()]/.test(rawEqCols[0])) {
        const expr = rawEqCols[0];
        const cleanSlug = expr.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
        const idxName = `idx_${pred.table}_${cleanSlug}`;
        const ddl = dialect === 'postgresql'
            ? `CREATE INDEX CONCURRENTLY ${idxName} ON ${pred.table} (${expr});`
            : `CREATE INDEX ${idxName} ON ${pred.table} ((${expr})) ALGORITHM=INPLACE, LOCK=NONE;`;
        return {
            table: pred.table,
            index_name: idxName,
            index_type: 'EXPRESSION_BTREE',
            confidence: 'HIGH',
            columns: [expr],
            esr_rationale: `Functional expression index matching the exact expression '${expr}' in the WHERE predicate.`,
            small_table_note: 'Applicable when table grows beyond ~10,000 rows.',
            ddl
        };
    }
    // Separate constant low-selectivity equality columns for Partial Index in PostgreSQL
    const partialWhereParts = [];
    const keyEqualityCols = [];
    for (const col of rawEqCols) {
        const literalVal = pred.equality_literals[col];
        if (dialect === 'postgresql' && literalVal && rawEqCols.length > 1) {
            if (literalVal.startsWith('IS ')) {
                partialWhereParts.push(`${col} ${literalVal}`);
            }
            else {
                partialWhereParts.push(`${col} = ${literalVal}`);
            }
        }
        else {
            keyEqualityCols.push(col);
        }
    }
    // If all equality columns were moved to partial index, keep at least the highest cardinality one in key
    if (keyEqualityCols.length === 0 && rawEqCols.length > 0) {
        keyEqualityCols.push(rawEqCols[0]);
        partialWhereParts.shift();
    }
    // Sort keyEqualityCols by estimated cardinality descending
    const scoredEq = keyEqualityCols.map((col) => ({
        col,
        ...estimateColumnCardinality(pred.table, col, cardinalityHints)
    }));
    scoredEq.sort((a, b) => b.score - a.score);
    let confidence = 'HIGH';
    if (scoredEq.length >= 2 &&
        scoredEq[0].score === scoredEq[1].score &&
        !scoredEq[0].fromHint &&
        !scoredEq[1].fromHint) {
        confidence = 'MEDIUM_NEEDS_CARDINALITY_VERIFICATION';
    }
    const orderedKeyCols = scoredEq.map((s) => s.col);
    const sortDirections = new Map();
    // Add Sort columns (S in ESR)
    for (const sc of pred.sort_columns) {
        if (sc.column === '__DYNAMIC_IDENT__')
            continue;
        if (!orderedKeyCols.includes(sc.column)) {
            orderedKeyCols.push(sc.column);
        }
        sortDirections.set(sc.column, sc.direction);
    }
    // Add Range columns (R in ESR) if not already added by Sort
    for (const rc of pred.range_columns) {
        if (!orderedKeyCols.includes(rc)) {
            orderedKeyCols.push(rc);
        }
    }
    if (orderedKeyCols.length === 0) {
        return null;
    }
    // Determine Covering Index columns (INCLUDE for PG, suffix for MySQL)
    const isHotQuery = executionFrequency === 'high' || executionFrequency === 'critical_hot_path';
    const includeCols = [];
    if (isHotQuery &&
        pred.projected_columns.length > 0 &&
        !pred.projected_columns.includes('*') &&
        pred.projected_columns.length <= 4) {
        for (const projCol of pred.projected_columns) {
            const bareInputs = orderedKeyCols.map((c) => c.toLowerCase());
            if (!bareInputs.includes(projCol.toLowerCase())) {
                // In MySQL InnoDB, Primary Key is implicitly appended to every Secondary Index leaf node
                if (dialect === 'mysql' &&
                    primaryKeyColumns.some((pk) => pk.toLowerCase() === projCol.toLowerCase())) {
                    continue;
                }
                includeCols.push(projCol);
            }
        }
    }
    // Format index type
    const hasPartial = dialect === 'postgresql' && partialWhereParts.length > 0;
    const hasCovering = includeCols.length > 0;
    let indexType = orderedKeyCols.length === 1 ? 'SINGLE_COLUMN_BTREE' : 'COMPOSITE_BTREE';
    if (hasPartial && hasCovering)
        indexType = 'PARTIAL_COVERING_BTREE';
    else if (hasPartial)
        indexType = 'PARTIAL_BTREE';
    else if (hasCovering)
        indexType = 'COVERING_BTREE';
    const formattedKeyCols = orderedKeyCols.map((c) => {
        const dir = sortDirections.get(c);
        const exprFormatted = /[()]/.test(c) ? (dialect === 'postgresql' ? `(${c})` : `((${c}))`) : c;
        return dir === 'DESC' ? `${exprFormatted} DESC` : exprFormatted;
    });
    const colNameSlug = orderedKeyCols
        .map((c) => c.replace(/[^a-zA-Z0-9]/g, '').slice(0, 10))
        .join('_')
        .toLowerCase();
    const idxName = `idx_${pred.table}_${colNameSlug}`;
    let ddl = '';
    if (dialect === 'postgresql') {
        const includeClause = hasCovering ? ` INCLUDE (${includeCols.join(', ')})` : '';
        const whereClause = hasPartial ? ` WHERE ${partialWhereParts.join(' AND ')}` : '';
        ddl = `CREATE INDEX CONCURRENTLY ${idxName} ON ${pred.table} (${formattedKeyCols.join(', ')})${includeClause}${whereClause};`;
    }
    else {
        const mysqlAllCols = [...formattedKeyCols, ...includeCols];
        ddl = `CREATE INDEX ${idxName} ON ${pred.table} (${mysqlAllCols.join(', ')}) ALGORITHM=INPLACE, LOCK=NONE;`;
    }
    const rationaleParts = [];
    if (scoredEq.length > 0) {
        rationaleParts.push(`Equality on (${scoredEq.map((s) => `'${s.col}' [${s.level}]`).join(', ')}) placed first.`);
    }
    if (hasPartial) {
        rationaleParts.push(`Constant low-selectivity filter (${partialWhereParts.join(' AND ')}) moved to Partial Index WHERE clause.`);
    }
    if (pred.sort_columns.length > 0) {
        rationaleParts.push(`Sort column (${pred.sort_columns.map((s) => `${s.column} ${s.direction}`).join(', ')}) placed next to prevent external filesort.`);
    }
    if (pred.range_columns.length > 0) {
        rationaleParts.push(`Range predicate on (${pred.range_columns.join(', ')}) satisfied without breaking B-Tree order.`);
    }
    if (hasCovering) {
        rationaleParts.push(dialect === 'postgresql'
            ? `Projected columns (${includeCols.join(', ')}) added to INCLUDE for Index-Only Scan.`
            : `Projected columns (${includeCols.join(', ')}) appended as covering index suffix.`);
    }
    return {
        table: pred.table,
        index_name: idxName,
        index_type: indexType,
        confidence,
        columns: orderedKeyCols,
        include_columns: hasCovering ? includeCols : undefined,
        where_clause: hasPartial ? partialWhereParts.join(' AND ') : undefined,
        esr_rationale: rationaleParts.join(' '),
        small_table_note: 'Index recommendation applies when table is projected to exceed ~10,000 rows.',
        ddl
    };
}
export function recommendIndexesForQueries(input) {
    const dialect = input.dialect;
    // Parse existing schema if provided
    let combinedExistingDdl = input.existing_schema_ddl ?? '';
    if (input.migration_files_dir) {
        const loaded = readMigrationSources({ migration_dir: input.migration_files_dir });
        combinedExistingDdl += '\n' + loaded.combinedSql;
    }
    const existingSchema = parseDdlToSchemaState(combinedExistingDdl, dialect);
    const queryAnalyses = [];
    const allRecommendedIndexes = [];
    input.queries.forEach((q, idx) => {
        const queryId = q.id || `query_${idx + 1}`;
        const freq = q.execution_frequency ?? 'medium';
        const parsed = analyzeSqlQueryAst(q.sql, dialect);
        if (parsed.status === 'PARSE_ERROR') {
            queryAnalyses.push({
                query_id: queryId,
                status: 'PARSE_ERROR',
                error_message: parsed.error_message,
                normalized_sql: parsed.normalized_sql,
                extracted_predicates: [],
                sargability_warnings: [],
                recommended_indexes: []
            });
            return;
        }
        const recommendedForQuery = [];
        for (const pred of parsed.extracted_predicates) {
            const existingTbl = existingSchema.tables.get(pred.table);
            const pkCols = existingTbl?.primaryKeyColumns ?? ['id'];
            const rec = buildEsrIndexForTablePredicate({
                dialect,
                pred,
                executionFrequency: freq,
                cardinalityHints: input.cardinality_hints,
                primaryKeyColumns: pkCols
            });
            if (rec) {
                recommendedForQuery.push(rec);
                allRecommendedIndexes.push(rec);
            }
        }
        queryAnalyses.push({
            query_id: queryId,
            status: 'ANALYZED',
            normalized_sql: parsed.normalized_sql,
            extracted_predicates: parsed.extracted_predicates.map((p) => ({
                table: p.table,
                equality_columns: p.equality_columns,
                join_columns: p.join_columns,
                sort_columns: p.sort_columns,
                range_columns: p.range_columns,
                projected_columns: p.projected_columns
            })),
            sargability_warnings: parsed.sargability_warnings,
            recommended_indexes: recommendedForQuery
        });
    });
    // Detect Left-Prefix Redundancy against existing indexes
    const redundantExistingIndexes = [];
    for (const existingIdx of existingSchema.indexes) {
        if (existingIdx.unique)
            continue;
        const existingColNames = existingIdx.columns.map((c) => c.name.toLowerCase());
        // Check against newly recommended indexes or other wider existing indexes
        const widerCandidate = allRecommendedIndexes.find((rec) => {
            if (rec.table.toLowerCase() !== existingIdx.table.toLowerCase())
                return false;
            if (rec.columns.length <= existingColNames.length)
                return false;
            return existingColNames.every((col, i) => rec.columns[i]?.toLowerCase() === col);
        });
        if (widerCandidate) {
            redundantExistingIndexes.push({
                rule_id: 'INDEX-REDUNDANT-001',
                table: existingIdx.table,
                existing_index_name: existingIdx.name,
                columns: existingIdx.columns.map((c) => c.name),
                superseded_by: `${widerCandidate.index_name} (${widerCandidate.columns.join(', ')})`,
                drop_ddl: dialect === 'postgresql'
                    ? `DROP INDEX CONCURRENTLY IF EXISTS ${existingIdx.name};`
                    : `DROP INDEX ${existingIdx.name} ON ${existingIdx.table} ALGORITHM=INPLACE, LOCK=NONE;`
            });
        }
    }
    // Check Write Amplification Overhead (> 5 indexes on a single table)
    const writeOverheadWarnings = [];
    const tableIndexCounts = new Map();
    for (const idx of existingSchema.indexes) {
        tableIndexCounts.set(idx.table, (tableIndexCounts.get(idx.table) ?? 0) + 1);
    }
    for (const rec of allRecommendedIndexes) {
        tableIndexCounts.set(rec.table, (tableIndexCounts.get(rec.table) ?? 0) + 1);
    }
    for (const [tbl, total] of tableIndexCounts.entries()) {
        if (total > 5) {
            writeOverheadWarnings.push({
                rule_id: 'INDEX-OVERHEAD-001',
                table: tbl,
                total_indexes: total,
                warning: `Table '${tbl}' has ${total} combined existing and recommended indexes (exceeds safe OLTP threshold of 5).`,
                recommendation: 'Consolidate overlapping composite indexes and drop unused/left-prefix redundant indexes to prevent write amplification and PostgreSQL HOT update degradation.'
            });
        }
    }
    return {
        query_analyses: queryAnalyses,
        redundancy_and_overhead_report: {
            redundant_existing_indexes: redundantExistingIndexes,
            write_overhead_warnings: writeOverheadWarnings
        }
    };
}
//# sourceMappingURL=recommend-indexes.js.map