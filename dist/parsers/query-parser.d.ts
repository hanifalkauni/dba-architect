import { Dialect, ExtractedTablePredicate, SargabilityWarning } from '../types/index.js';
export interface ParsedQueryAnalysisResult {
    status: 'ANALYZED' | 'PARSE_ERROR';
    error_message?: string;
    normalized_sql: string;
    tables: string[];
    extracted_predicates: ExtractedTablePredicate[];
    sargability_warnings: SargabilityWarning[];
    has_dynamic_sort: boolean;
}
export declare function maskSqlLiteralsAndNormalize(sql: string): {
    normalizedSql: string;
    preservedConstantLiterals: Record<string, string>;
    hasDynamicSort: boolean;
};
export declare function analyzeSqlQueryAst(sql: string, _dialect: Dialect): ParsedQueryAnalysisResult;
