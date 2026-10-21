import { CardinalityLevel } from '../types/index.js';
export interface RuleCatalogEntry {
    rule_id: string;
    domain: 'SCHEMA' | 'INDEX' | 'CODE' | 'EXPLAIN' | 'TRANSACTION' | 'PARTITION';
    tool: string;
    severity: 'CRITICAL' | 'WARNING' | 'INFO';
    category: string;
    title: string;
    description: string;
    postgresql_remediation: string;
    mysql_remediation: string;
}
export declare const RULES_CATALOG: RuleCatalogEntry[];
export declare const CARDINALITY_HEURISTICS: {
    description: string;
    weights: {
        unique: number;
        high: number;
        medium: number;
        low: number;
        very_low: number;
    };
    patterns: {
        unique: RegExp[];
        high: RegExp[];
        medium: RegExp[];
        low: RegExp[];
        very_low: RegExp[];
    };
};
export declare function estimateColumnCardinality(table: string, column: string, hints?: Record<string, CardinalityLevel>): {
    level: CardinalityLevel;
    score: number;
    fromHint: boolean;
};
export declare const ZERO_DOWNTIME_TEMPLATES: {
    postgresql: {
        add_index: string;
        drop_index: string;
        add_foreign_key: string[];
        set_not_null: string[];
    };
    mysql: {
        add_index: string;
        drop_index: string;
        add_column_instant: string;
        external_online_schema_change: string;
    };
};
