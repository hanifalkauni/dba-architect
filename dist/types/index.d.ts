export type Dialect = 'postgresql' | 'mysql';
export type Severity = 'CRITICAL' | 'WARNING' | 'INFO';
export type ConfidenceLevel = 'HIGH' | 'MEDIUM_NEEDS_CARDINALITY_VERIFICATION';
export type CardinalityLevel = 'very_low' | 'low' | 'medium' | 'high' | 'unique';
export interface ParsedColumn {
    name: string;
    rawDataType: string;
    baseType: string;
    length?: number;
    precision?: number;
    scale?: number;
    unsigned?: boolean;
    nullable: boolean;
    isPrimaryKey: boolean;
    isUnique: boolean;
    hasDefault: boolean;
    defaultValue?: string;
    references?: {
        table: string;
        column: string;
        onDelete?: string;
        onUpdate?: string;
    };
}
export interface ParsedForeignKey {
    constraintName?: string;
    columns: string[];
    referencedTable: string;
    referencedColumns: string[];
    onDelete?: string;
    onUpdate?: string;
}
export interface ParsedIndex {
    name: string;
    table: string;
    columns: Array<{
        name: string;
        direction?: 'ASC' | 'DESC';
        expression?: string;
    }>;
    includeColumns: string[];
    whereClause?: string;
    unique: boolean;
    concurrently: boolean;
    algorithm?: string;
    lock?: string;
}
export interface ParsedTable {
    name: string;
    columns: ParsedColumn[];
    primaryKeyColumns: string[];
    foreignKeys: ParsedForeignKey[];
    indexes: ParsedIndex[];
    partitionBy?: {
        type: 'RANGE' | 'LIST' | 'HASH';
        columns: string[];
    };
}
export interface SchemaState {
    dialect: Dialect;
    tables: Map<string, ParsedTable>;
    indexes: ParsedIndex[];
    rawStatements: string[];
    parseWarnings: string[];
}
export interface SchemaIssue {
    rule_id: string;
    severity: Severity;
    table: string;
    column?: string;
    category: string;
    finding: string;
    impact: string;
    recommendation: string;
    suggested_ddl_fix: string;
}
export interface AnalyzeMigrationOutput {
    summary: {
        dialect: Dialect;
        tables_analyzed: number;
        score: number;
        issue_counts: {
            critical: number;
            warning: number;
            info: number;
        };
    };
    issues: SchemaIssue[];
    parse_warnings: string[];
    optimized_ddl_script: string;
}
export interface ExtractedTablePredicate {
    table: string;
    equality_columns: string[];
    equality_literals: Record<string, string>;
    join_columns: string[];
    sort_columns: Array<{
        column: string;
        direction: 'ASC' | 'DESC';
    }>;
    range_columns: string[];
    projected_columns: string[];
}
export interface SargabilityWarning {
    rule_id: string;
    table: string;
    column: string;
    expression: string;
    issue: string;
    query_rewrite_suggestion: string;
}
export interface RecommendedIndex {
    table: string;
    index_name: string;
    index_type: 'COMPOSITE_BTREE' | 'COVERING_BTREE' | 'PARTIAL_BTREE' | 'PARTIAL_COVERING_BTREE' | 'EXPRESSION_BTREE' | 'SINGLE_COLUMN_BTREE';
    confidence: ConfidenceLevel;
    columns: string[];
    include_columns?: string[];
    where_clause?: string;
    esr_rationale: string;
    small_table_note: string;
    ddl: string;
}
export interface RedundantExistingIndex {
    rule_id: string;
    table: string;
    existing_index_name: string;
    columns: string[];
    superseded_by: string;
    drop_ddl: string;
}
export interface WriteOverheadWarning {
    rule_id: string;
    table: string;
    total_indexes: number;
    warning: string;
    recommendation: string;
}
