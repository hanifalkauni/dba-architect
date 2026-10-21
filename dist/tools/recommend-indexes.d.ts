import { CardinalityLevel, Dialect, ExtractedTablePredicate, RecommendedIndex, RedundantExistingIndex, SargabilityWarning, WriteOverheadWarning } from '../types/index.js';
export interface QueryAnalysisItem {
    query_id: string;
    status: 'ANALYZED' | 'PARSE_ERROR';
    error_message?: string;
    normalized_sql: string;
    extracted_predicates: Array<{
        table: string;
        equality_columns: string[];
        join_columns: string[];
        sort_columns: Array<{
            column: string;
            direction: 'ASC' | 'DESC';
        }>;
        range_columns: string[];
        projected_columns: string[];
    }>;
    sargability_warnings: SargabilityWarning[];
    recommended_indexes: RecommendedIndex[];
}
export interface RecommendIndexesOutput {
    query_analyses: QueryAnalysisItem[];
    redundancy_and_overhead_report: {
        redundant_existing_indexes: RedundantExistingIndex[];
        write_overhead_warnings: WriteOverheadWarning[];
    };
}
export declare function buildEsrIndexForTablePredicate(options: {
    dialect: Dialect;
    pred: ExtractedTablePredicate;
    executionFrequency: 'low' | 'medium' | 'high' | 'critical_hot_path';
    cardinalityHints?: Record<string, CardinalityLevel>;
    primaryKeyColumns?: string[];
}): RecommendedIndex | null;
export declare function recommendIndexesForQueries(input: {
    dialect: Dialect;
    queries: Array<{
        id?: string;
        sql: string;
        execution_frequency?: 'low' | 'medium' | 'high' | 'critical_hot_path';
    }>;
    existing_schema_ddl?: string;
    migration_files_dir?: string;
    cardinality_hints?: Record<string, CardinalityLevel>;
}): RecommendIndexesOutput;
