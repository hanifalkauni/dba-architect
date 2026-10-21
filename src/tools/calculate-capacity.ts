import { Dialect, ParsedColumn } from '../types/index.js';
import { parseDdlToSchemaState } from '../parsers/ddl-parser.js';

export interface TableCapacityEstimate {
  table_name: string;
  projected_rows: number;
  avg_row_bytes_including_header: number;
  estimated_table_size_gb: number;
  estimated_indexes_size_gb: number;
  total_footprint_gb: number;
}

export interface CalculateCapacityOutput {
  capacity_estimation: {
    tables: TableCapacityEstimate[];
    total_database_footprint_gb: number;
    working_set_fits_in_ram: boolean;
    memory_fit_analysis: string;
  };
  engine_tuning_recommendation: {
    config_file: 'postgresql.conf' | 'my.cnf';
    parameters: Record<string, string>;
    config_snippet: string;
  };
}

function estimateColumnBytes(col: ParsedColumn): number {
  const b = col.baseType.toUpperCase();
  if (/^(BIGINT|INT8|BIGSERIAL|DOUBLE PRECISION|FLOAT8|TIMESTAMPTZ|TIMESTAMP|DATETIME)$/.test(b)) return 8;
  if (/^(UUID)$/.test(b)) return 16;
  if (b === 'BINARY') return col.length ?? 16;
  if (/^(INT|INTEGER|INT4|SERIAL|DATE|REAL|FLOAT4|FLOAT)$/.test(b)) return 4;
  if (/^(SMALLINT|INT2|SMALLSERIAL)$/.test(b)) return 2;
  if (/^(BOOLEAN|BOOL|TINYINT)$/.test(b)) return 1;
  if (/^(NUMERIC|DECIMAL)$/.test(b)) return 12;
  if (/^(JSON|JSONB|TEXT)$/.test(b)) return 128;
  if (/^(VARCHAR|CHAR|CHARACTER VARYING)$/.test(b)) {
    const len = col.length ?? 64;
    return Math.min(len, Math.max(8, Math.round(len * 0.45)));
  }
  return 16;
}

export function calculateDbCapacityAndConfig(input: {
  dialect: Dialect;
  schema_ddl?: string;
  estimated_rows_per_table?: Record<string, number>;
  server_hardware?: {
    vcpu?: number;
    ram_gb?: number;
    storage_type?: 'nvme' | 'ssd' | 'hdd';
    workload_type?: 'oltp' | 'analytics' | 'mixed';
    max_connections?: number;
  };
}): CalculateCapacityOutput {
  const dialect = input.dialect;
  const hw = {
    vcpu: input.server_hardware?.vcpu ?? 4,
    ram_gb: input.server_hardware?.ram_gb ?? 16,
    storage_type: input.server_hardware?.storage_type ?? 'nvme',
    workload_type: input.server_hardware?.workload_type ?? 'oltp',
    max_connections: input.server_hardware?.max_connections ?? 200
  };

  const schema = parseDdlToSchemaState(input.schema_ddl ?? '', dialect);
  const rowsMap = input.estimated_rows_per_table ?? {};

  // If no DDL was supplied but estimated_rows_per_table has keys, synthesize baseline tables
  if (schema.tables.size === 0 && Object.keys(rowsMap).length > 0) {
    for (const tblName of Object.keys(rowsMap)) {
      schema.tables.set(tblName, {
        name: tblName,
        columns: [
          {
            name: 'id',
            rawDataType: 'UUID',
            baseType: 'UUID',
            nullable: false,
            isPrimaryKey: true,
            isUnique: true,
            hasDefault: false
          },
          {
            name: 'created_at',
            rawDataType: 'TIMESTAMPTZ',
            baseType: 'TIMESTAMPTZ',
            nullable: false,
            isPrimaryKey: false,
            isUnique: false,
            hasDefault: true
          },
          {
            name: 'payload',
            rawDataType: 'VARCHAR(120)',
            baseType: 'VARCHAR',
            length: 120,
            nullable: false,
            isPrimaryKey: false,
            isUnique: false,
            hasDefault: false
          }
        ],
        primaryKeyColumns: ['id'],
        foreignKeys: [],
        indexes: []
      });
    }
  }

  const tableEstimates: TableCapacityEstimate[] = [];
  let totalIndexGb = 0;
  let totalFootprintGb = 0;

  for (const [tblName, tbl] of schema.tables.entries()) {
    const projectedRows = rowsMap[tblName] ?? 10000000;
    const rawDataBytes = tbl.columns.reduce((sum, c) => sum + estimateColumnBytes(c), 0) || 64;

    // Tuple header overhead: PostgreSQL = 24B + alignment (~4B); MySQL InnoDB = 19B (6B TRX_ID + 7B ROLL_PTR + 6B header)
    const headerBytes = dialect === 'postgresql' ? 28 : 22;
    const avgRowBytes = rawDataBytes + headerBytes;

    // Page fillfactor overhead (~1.20x for PG 8KB heap pages, ~1.15x for InnoDB 16KB clustered pages)
    const pageOverheadFactor = dialect === 'postgresql' ? 1.2 : 1.15;
    const tableSizeBytes = projectedRows * avgRowBytes * pageOverheadFactor;
    const tableSizeGb = Number((tableSizeBytes / 1024 ** 3).toFixed(2));

    // Estimate PK + secondary indexes footprint
    const secondaryCount = Math.max(1, tbl.indexes.length + tbl.foreignKeys.length);
    const pkBytes = dialect === 'mysql' ? 16 : 8;
    const avgEntryBytesPerIndex = dialect === 'postgresql' ? 28 : 24 + pkBytes;
    const indexesSizeBytes = projectedRows * (1 + secondaryCount) * avgEntryBytesPerIndex * 1.25; // 25% B-Tree bloat allowance
    const indexesSizeGb = Number((indexesSizeBytes / 1024 ** 3).toFixed(2));

    const totalTblGb = Number((tableSizeGb + indexesSizeGb).toFixed(2));
    totalIndexGb += indexesSizeGb;
    totalFootprintGb += totalTblGb;

    tableEstimates.push({
      table_name: tblName,
      projected_rows: projectedRows,
      avg_row_bytes_including_header: avgRowBytes,
      estimated_table_size_gb: tableSizeGb,
      estimated_indexes_size_gb: indexesSizeGb,
      total_footprint_gb: totalTblGb
    });
  }

  totalFootprintGb = Number(totalFootprintGb.toFixed(2));
  totalIndexGb = Number(totalIndexGb.toFixed(2));

  const availableCacheGb = dialect === 'postgresql' ? hw.ram_gb * 0.75 : hw.ram_gb * 0.7;
  const fitsInRam = totalIndexGb <= availableCacheGb;

  // Generate Engine Configuration
  if (dialect === 'postgresql') {
    const sharedBuffersGb = Math.max(1, Math.round(hw.ram_gb * 0.25));
    const effectiveCacheGb = Math.max(2, Math.round(hw.ram_gb * 0.75));
    const maintWorkMemMb = Math.min(2048, Math.max(256, Math.round((hw.ram_gb * 1024) / 16)));
    const workMemMb = Math.max(
      4,
      Math.min(
        128,
        Math.floor(((hw.ram_gb * 1024 * 0.25) / Math.max(20, hw.max_connections)) * (hw.workload_type === 'analytics' ? 2 : 1))
      )
    );
    const randomPageCost = hw.storage_type === 'nvme' || hw.storage_type === 'ssd' ? '1.1' : '4.0';
    const ioConcurrency = hw.storage_type === 'nvme' || hw.storage_type === 'ssd' ? '200' : '2';
    const maxWalGb = hw.workload_type === 'oltp' ? '8GB' : '16GB';
    const minWalGb = '2GB';

    const params: Record<string, string> = {
      shared_buffers: `${sharedBuffersGb}GB`,
      effective_cache_size: `${effectiveCacheGb}GB`,
      maintenance_work_mem: maintWorkMemMb >= 1024 ? `${Math.round(maintWorkMemMb / 1024)}GB` : `${maintWorkMemMb}MB`,
      work_mem: `${workMemMb}MB`,
      random_page_cost: randomPageCost,
      effective_io_concurrency: ioConcurrency,
      max_wal_size: maxWalGb,
      min_wal_size: minWalGb,
      checkpoint_completion_target: '0.9',
      autovacuum_vacuum_scale_factor: '0.02',
      autovacuum_analyze_scale_factor: '0.01'
    };

    const snippet = [
      `# Generated by dba-architect for ${hw.vcpu} vCPU, ${hw.ram_gb}GB RAM, ${hw.storage_type.toUpperCase()} ${hw.workload_type.toUpperCase()}`,
      ...Object.entries(params).map(([k, v]) => `${k} = ${v}`)
    ].join('\n');

    return {
      capacity_estimation: {
        tables: tableEstimates,
        total_database_footprint_gb: totalFootprintGb,
        working_set_fits_in_ram: fitsInRam,
        memory_fit_analysis: fitsInRam
          ? `Total B-Tree index footprint (${totalIndexGb} GB) comfortably fits within shared_buffers (${sharedBuffersGb} GB) + OS page cache (${effectiveCacheGb} GB) on a ${hw.ram_gb} GB RAM server.`
          : `Warning: Total B-Tree index footprint (${totalIndexGb} GB) exceeds available cache (${availableCacheGb.toFixed(1)} GB). Consider table partitioning, archiving old rows, or upgrading server RAM.`
      },
      engine_tuning_recommendation: {
        config_file: 'postgresql.conf',
        parameters: params,
        config_snippet: snippet
      }
    };
  } else {
    // MySQL InnoDB tuning
    const bufferPoolGb = Math.max(1, Math.round(hw.ram_gb * 0.7));
    const instances = Math.min(16, Math.max(1, Math.min(hw.vcpu, bufferPoolGb)));
    const redoCapacityGb = Math.min(16, Math.max(2, Math.round(bufferPoolGb * 0.25)));
    const ioCap = hw.storage_type === 'nvme' ? '2000' : hw.storage_type === 'ssd' ? '1000' : '200';
    const ioCapMax = hw.storage_type === 'nvme' ? '4000' : hw.storage_type === 'ssd' ? '2000' : '400';

    const params: Record<string, string> = {
      innodb_buffer_pool_size: `${bufferPoolGb}G`,
      innodb_buffer_pool_instances: `${instances}`,
      innodb_redo_log_capacity: `${redoCapacityGb}G`,
      innodb_flush_log_at_trx_commit: '1',
      innodb_flush_method: 'O_DIRECT',
      innodb_io_capacity: ioCap,
      innodb_io_capacity_max: ioCapMax,
      max_connections: `${hw.max_connections}`
    };

    const snippet = [
      `# Generated by dba-architect for ${hw.vcpu} vCPU, ${hw.ram_gb}GB RAM, ${hw.storage_type.toUpperCase()} ${hw.workload_type.toUpperCase()}`,
      '[mysqld]',
      ...Object.entries(params).map(([k, v]) => `${k} = ${v}`)
    ].join('\n');

    return {
      capacity_estimation: {
        tables: tableEstimates,
        total_database_footprint_gb: totalFootprintGb,
        working_set_fits_in_ram: fitsInRam,
        memory_fit_analysis: fitsInRam
          ? `Total index footprint (${totalIndexGb} GB) fits within innodb_buffer_pool_size (${bufferPoolGb} GB) on a ${hw.ram_gb} GB RAM server.`
          : `Warning: Total index footprint (${totalIndexGb} GB) exceeds innodb_buffer_pool_size (${bufferPoolGb} GB). Consider table partitioning or scaling RAM.`
      },
      engine_tuning_recommendation: {
        config_file: 'my.cnf',
        parameters: params,
        config_snippet: snippet
      }
    };
  }
}
