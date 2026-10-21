import { Dialect, SchemaState } from '../types/index.js';
export declare function splitSqlStatements(sql: string): string[];
export declare function parseDdlToSchemaState(sql: string, dialect: Dialect, initialWarnings?: string[]): SchemaState;
