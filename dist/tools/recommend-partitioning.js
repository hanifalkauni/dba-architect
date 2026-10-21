import { parseDdlToSchemaState } from '../parsers/ddl-parser.js';
export function recommendPartitioningAndArchiving(input) {
    const dialect = input.dialect;
    const retentionMonths = input.retention_months ?? 12;
    const schema = parseDdlToSchemaState(input.table_ddl, dialect);
    const firstTable = Array.from(schema.tables.values())[0];
    const tableName = firstTable?.name ?? 'target_table';
    const columns = firstTable?.columns ?? [];
    const pkCols = firstTable?.primaryKeyColumns ?? ['id'];
    // Small/medium table threshold (< 10M rows)
    if (input.estimated_total_rows < 10000000) {
        return {
            partitioning_recommended: false,
            rationale: `Table '${tableName}' has an estimated ${input.estimated_total_rows.toLocaleString()} rows (< 10,000,000 threshold). Standard B-Tree indexing without declarative partitioning provides lower planning overhead and simpler maintenance.`,
            strategy: {
                partition_type: 'NONE',
                partition_key: '',
                granularity: 'NONE',
                pk_adjustment_required: false,
                pk_adjustment_note: 'No Primary Key change needed.'
            },
            partitioned_table_ddl: input.table_ddl.trim(),
            archiving_and_retention_runbook: 'Use batched DELETE statements with an index on the timestamp column (e.g., DELETE FROM tbl WHERE id IN (SELECT id FROM tbl WHERE created_at < ... LIMIT 5000)).'
        };
    }
    // Identify candidate partition key from time columns or tenant_id
    const filterText = (input.common_query_filters ?? []).join(' ');
    const timeCol = columns.find((c) => /^(created_at|event_time|occurred_at|log_date|transaction_date|timestamp)$/i.test(c.name)) ||
        columns.find((c) => /TIMESTAMP|DATE|DATETIME/i.test(c.baseType));
    const tenantCol = columns.find((c) => /^(tenant_id|merchant_id|organization_id)$/i.test(c.name));
    const regionCol = columns.find((c) => /^(region_code|country_code|jurisdiction|domain_type)$/i.test(c.name));
    let partitionType = 'RANGE';
    let partitionKey = timeCol?.name ?? 'created_at';
    let granularity = (input.monthly_growth_rows ?? 5000000) >= 2000000 ? 'MONTHLY' : 'YEARLY';
    if (!timeCol && regionCol) {
        partitionType = 'LIST';
        partitionKey = regionCol.name;
        granularity = 'LIST_VALUE';
    }
    else if (!timeCol && tenantCol && filterText.includes(tenantCol.name)) {
        partitionType = 'HASH';
        partitionKey = tenantCol.name;
        granularity = 'HASH_MODULO_16';
    }
    // Check PART-PK-001: Does Primary Key include partitionKey?
    const pkIncludesPartKey = pkCols.some((pk) => pk.toLowerCase() === partitionKey.toLowerCase());
    const pkAdjustmentRequired = !pkIncludesPartKey;
    const newPkCols = pkIncludesPartKey ? pkCols : [...pkCols, partitionKey];
    const colDefs = columns.map((c) => {
        const nn = !c.nullable || c.isPrimaryKey || c.name === partitionKey ? ' NOT NULL' : '';
        const def = c.defaultValue ? ` DEFAULT ${c.defaultValue}` : '';
        return `    ${c.name} ${c.rawDataType}${nn}${def}`;
    });
    colDefs.push(`    PRIMARY KEY (${newPkCols.join(', ')})`);
    let partitionedDdl = '';
    let archivingRunbook = '';
    if (dialect === 'postgresql') {
        if (partitionType === 'RANGE') {
            partitionedDdl = [
                `CREATE TABLE ${tableName} (`,
                colDefs.join(',\n'),
                `) PARTITION BY RANGE (${partitionKey});`,
                '',
                `CREATE TABLE ${tableName}_y2026m10 PARTITION OF ${tableName}`,
                `    FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00');`,
                `CREATE TABLE ${tableName}_y2026m11 PARTITION OF ${tableName}`,
                `    FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');`
            ].join('\n');
            archivingRunbook = [
                `-- Retention Policy: ${retentionMonths} months.`,
                `-- Instead of 'DELETE FROM ${tableName} WHERE ${partitionKey} < ...' which causes massive MVCC dead-tuple bloat, detach and archive old partitions instantaneously:`,
                `ALTER TABLE ${tableName} DETACH PARTITION ${tableName}_y2025m09 CONCURRENTLY;`,
                `-- Optional: Export detached table to S3/Parquet cold storage, then drop with zero table lock:`,
                `DROP TABLE ${tableName}_y2025m09;`
            ].join('\n');
        }
        else if (partitionType === 'LIST') {
            partitionedDdl = [
                `CREATE TABLE ${tableName} (`,
                colDefs.join(',\n'),
                `) PARTITION BY LIST (${partitionKey});`,
                '',
                `CREATE TABLE ${tableName}_id PARTITION OF ${tableName} FOR VALUES IN ('ID');`,
                `CREATE TABLE ${tableName}_sg PARTITION OF ${tableName} FOR VALUES IN ('SG');`
            ].join('\n');
            archivingRunbook = `-- List partitioned by discrete '${partitionKey}' values for regional data isolation and partition pruning.`;
        }
        else {
            partitionedDdl = [
                `CREATE TABLE ${tableName} (`,
                colDefs.join(',\n'),
                `) PARTITION BY HASH (${partitionKey});`,
                '',
                `CREATE TABLE ${tableName}_p0 PARTITION OF ${tableName} FOR VALUES WITH (MODULUS 16, REMAINDER 0);`,
                `CREATE TABLE ${tableName}_p1 PARTITION OF ${tableName} FOR VALUES WITH (MODULUS 16, REMAINDER 1);`
            ].join('\n');
            archivingRunbook = `-- Hash partitioned across 16 buckets by '${partitionKey}' to keep B-Tree indexes fit in shared_buffers.`;
        }
    }
    else {
        // MySQL InnoDB Declarative Partitioning
        if (partitionType === 'RANGE') {
            partitionedDdl = [
                `CREATE TABLE ${tableName} (`,
                colDefs.join(',\n'),
                `) ENGINE=InnoDB`,
                `PARTITION BY RANGE COLUMNS(${partitionKey}) (`,
                `    PARTITION p2026_10 VALUES LESS THAN ('2026-11-01 00:00:00'),`,
                `    PARTITION p2026_11 VALUES LESS THAN ('2026-12-01 00:00:00'),`,
                `    PARTITION p_max VALUES LESS THAN (MAXVALUE)`,
                `);`
            ].join('\n');
            archivingRunbook = [
                `-- Retention Policy: ${retentionMonths} months.`,
                `-- Drop expired monthly partition instantaneously without InnoDB undo log overhead:`,
                `ALTER TABLE ${tableName} DROP PARTITION p2025_09;`
            ].join('\n');
        }
        else if (partitionType === 'LIST') {
            partitionedDdl = [
                `CREATE TABLE ${tableName} (`,
                colDefs.join(',\n'),
                `) ENGINE=InnoDB`,
                `PARTITION BY LIST COLUMNS(${partitionKey}) (`,
                `    PARTITION p_id VALUES IN ('ID'),`,
                `    PARTITION p_sg VALUES IN ('SG')`,
                `);`
            ].join('\n');
            archivingRunbook = `-- List partitioned across discrete '${partitionKey}' values in MySQL InnoDB.`;
        }
        else {
            partitionedDdl = [
                `CREATE TABLE ${tableName} (`,
                colDefs.join(',\n'),
                `) ENGINE=InnoDB`,
                `PARTITION BY HASH (${partitionKey}) PARTITIONS 16;`
            ].join('\n');
            archivingRunbook = `-- Hash partitioned across 16 InnoDB partitions by '${partitionKey}'.`;
        }
    }
    return {
        partitioning_recommended: true,
        rationale: `Table '${tableName}' is projected to reach ${input.estimated_total_rows.toLocaleString()} rows. ${partitionType} partitioning on '${partitionKey}' (${granularity}) enables Partition Pruning on hot queries and zero-bloat retention management (${retentionMonths} months).`,
        strategy: {
            partition_type: partitionType,
            partition_key: partitionKey,
            granularity,
            pk_adjustment_required: pkAdjustmentRequired,
            pk_adjustment_rule_id: pkAdjustmentRequired ? 'PART-PK-001' : undefined,
            pk_adjustment_note: pkAdjustmentRequired
                ? `Rule PART-PK-001: Primary Key (${pkCols.join(', ')}) must be changed to composite PRIMARY KEY (${newPkCols.join(', ')}) to satisfy declarative partitioning constraints.`
                : `Primary Key (${pkCols.join(', ')}) already includes the partition key.`
        },
        partitioned_table_ddl: partitionedDdl,
        archiving_and_retention_runbook: archivingRunbook
    };
}
//# sourceMappingURL=recommend-partitioning.js.map