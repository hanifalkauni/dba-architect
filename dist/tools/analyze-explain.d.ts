import { Dialect, Severity } from '../types/index.js';
export interface ExplainBottleneck {
    rule_id: string;
    severity: Severity;
    node_type: string;
    target_relation?: string;
    execution_time_ms?: number;
    rows_emitted?: number;
    rows_removed_by_filter?: number;
    finding: string;
    recommendation: string;
    suggested_ddl_fix?: string;
}
export interface AnalyzeExplainOutput {
    summary: {
        dialect: Dialect;
        total_execution_time_ms: number;
        planning_time_ms: number;
        slowest_node: string;
        health_status: 'HEALTHY' | 'NEEDS_TUNING' | 'CRITICAL_BOTTLENECK';
    };
    bottlenecks: ExplainBottleneck[];
    mermaid_plan_diagram: string;
}
export declare function analyzeExplainPlan(input: {
    dialect: Dialect;
    explain_output: string;
    sql_query?: string;
    existing_schema_ddl?: string;
}): AnalyzeExplainOutput;
