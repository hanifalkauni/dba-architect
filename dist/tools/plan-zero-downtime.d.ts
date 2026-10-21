import { Dialect } from '../types/index.js';
export interface StatementAssessment {
    rule_id: string;
    original_ddl: string;
    lock_type_acquired: string;
    hazard_explanation: string;
}
export interface ZeroDowntimePhase {
    phase: string;
    description: string;
    sql_script: string;
}
export interface PlanZeroDowntimeOutput {
    overall_risk_level: 'LOW_SAFE' | 'MODERATE_BRIEF_LOCK' | 'HIGH_LOCKING_RISK' | 'CRITICAL_TABLE_REWRITE';
    statement_assessments: StatementAssessment[];
    zero_downtime_runbook: ZeroDowntimePhase[];
}
export declare function planZeroDowntimeMigration(input: {
    dialect: Dialect;
    engine_version?: string;
    ddl_statements: string;
    estimated_table_rows?: number;
}): PlanZeroDowntimeOutput;
