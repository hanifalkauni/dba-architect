import { ConfidenceLevel, Dialect } from '../types/index.js';
export interface CodeAntipattern {
    rule_id: string;
    pattern_type: 'POTENTIAL_N_PLUS_ONE';
    severity: 'CRITICAL';
    file_path: string;
    line_number: number;
    code_snippet_masked: string;
    recommendation: string;
}
export interface CanonicalWorkloadItem {
    fingerprint_id: string;
    pattern_summary: string;
    occurrences_count: number;
    locations: string[];
    equality_columns: string[];
    sort_columns: Array<{
        column: string;
        direction: 'ASC' | 'DESC';
    }>;
    range_columns: string[];
}
export interface ConsolidatedIndexPlanItem {
    index_name: string;
    confidence: ConfidenceLevel;
    ddl: string;
    covers_fingerprints: string[];
    consolidation_note: string;
}
export interface HolisticTableStrategy {
    table_name: string;
    total_query_occurrences: number;
    canonical_workload: CanonicalWorkloadItem[];
    consolidated_index_plan: ConsolidatedIndexPlanItem[];
    redundant_existing_indexes: Array<{
        rule_id: string;
        existing_index_name: string;
        columns: string[];
        superseded_by: string;
        drop_ddl: string;
    }>;
    write_overhead_warnings?: Array<{
        rule_id: string;
        total_indexes: number;
        warning: string;
        recommendation: string;
    }>;
}
export interface ScanProjectQueriesOutput {
    scan_metadata: {
        files_scanned: number;
        files_skipped_large_or_binary: number;
        queries_extracted: number;
        unique_canonical_patterns: number;
        tables_identified: string[];
    };
    code_antipatterns: CodeAntipattern[];
    holistic_table_strategies: HolisticTableStrategy[];
}
export declare function scanProjectQueries(input: {
    project_root_path: string;
    dialect: Dialect;
    target_languages?: Array<'go' | 'php' | 'typescript' | 'javascript' | 'python' | 'sql'>;
    exclude_globs?: string[];
    focus_tables?: string[];
    existing_schema_ddl?: string;
    migration_files_dir?: string;
    max_files_to_scan?: number;
}): Promise<ScanProjectQueriesOutput>;
