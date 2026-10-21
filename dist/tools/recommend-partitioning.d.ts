import { Dialect } from '../types/index.js';
export interface RecommendPartitioningOutput {
    partitioning_recommended: boolean;
    rationale: string;
    strategy: {
        partition_type: 'RANGE' | 'LIST' | 'HASH' | 'NONE';
        partition_key: string;
        granularity: 'MONTHLY' | 'YEARLY' | 'HASH_MODULO_16' | 'LIST_VALUE' | 'NONE';
        pk_adjustment_required: boolean;
        pk_adjustment_rule_id?: string;
        pk_adjustment_note: string;
    };
    partitioned_table_ddl: string;
    archiving_and_retention_runbook: string;
}
export declare function recommendPartitioningAndArchiving(input: {
    dialect: Dialect;
    table_ddl: string;
    estimated_total_rows: number;
    monthly_growth_rows?: number;
    retention_months?: number;
    common_query_filters?: string[];
}): RecommendPartitioningOutput;
