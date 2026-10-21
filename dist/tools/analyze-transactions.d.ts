import { Dialect, Severity } from '../types/index.js';
export interface ConcurrencyIssue {
    rule_id: string;
    severity: Severity;
    category: string;
    finding: string;
    impact: string;
    recommendation: string;
}
export interface AnalyzeTransactionOutput {
    summary: {
        transactions_analyzed: number;
        concurrency_safety_score: number;
        issues_detected: number;
    };
    concurrency_issues: ConcurrencyIssue[];
}
export declare function analyzeTransactionAndLocking(input: {
    dialect: Dialect;
    source: {
        code_or_sql_snippet?: string;
        file_paths?: string[];
    };
}): AnalyzeTransactionOutput;
