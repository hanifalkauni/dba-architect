import { AnalyzeMigrationOutput, Dialect } from '../types/index.js';
export declare function analyzeMigration(input: {
    dialect: Dialect;
    engine_version?: string;
    migration_source: {
        raw_sql?: string;
        file_paths?: string[];
        migration_dir?: string;
    };
    strictness?: 'standard' | 'strict';
}): AnalyzeMigrationOutput;
