import { z } from 'zod';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, GetPromptRequestSchema, ListPromptsRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { CARDINALITY_HEURISTICS, RULES_CATALOG, ZERO_DOWNTIME_TEMPLATES } from './constants/catalog.js';
import { analyzeMigration } from './tools/analyze-migration.js';
import { recommendIndexesForQueries } from './tools/recommend-indexes.js';
import { scanProjectQueries } from './tools/scan-project.js';
import { analyzeExplainPlan } from './tools/analyze-explain.js';
import { planZeroDowntimeMigration } from './tools/plan-zero-downtime.js';
import { analyzeTransactionAndLocking } from './tools/analyze-transactions.js';
import { recommendPartitioningAndArchiving } from './tools/recommend-partitioning.js';
import { calculateDbCapacityAndConfig } from './tools/calculate-capacity.js';
const DialectSchema = z.enum(['postgresql', 'mysql']);
const CardinalityLevelSchema = z.enum(['very_low', 'low', 'medium', 'high', 'unique']);
const AnalyzeMigrationArgsSchema = z.object({
    dialect: DialectSchema,
    engine_version: z.string().optional(),
    migration_source: z
        .object({
        raw_sql: z.string().optional(),
        file_paths: z.array(z.string()).optional(),
        migration_dir: z.string().optional()
    })
        .refine((s) => s.raw_sql !== undefined || (s.file_paths && s.file_paths.length > 0) || Boolean(s.migration_dir), { message: 'migration_source must provide raw_sql, file_paths, or migration_dir' }),
    strictness: z.enum(['standard', 'strict']).optional()
});
const RecommendIndexesArgsSchema = z.object({
    dialect: DialectSchema,
    queries: z
        .array(z.object({
        id: z.string().optional(),
        sql: z.string().min(1),
        execution_frequency: z.enum(['low', 'medium', 'high', 'critical_hot_path']).optional()
    }))
        .min(1),
    existing_schema_ddl: z.string().optional(),
    migration_files_dir: z.string().optional(),
    cardinality_hints: z.record(CardinalityLevelSchema).optional()
});
const ScanProjectArgsSchema = z.object({
    project_root_path: z.string().min(1),
    dialect: DialectSchema,
    target_languages: z
        .array(z.enum(['go', 'php', 'typescript', 'javascript', 'python', 'sql']))
        .optional(),
    exclude_globs: z.array(z.string()).optional(),
    focus_tables: z.array(z.string()).optional(),
    existing_schema_ddl: z.string().optional(),
    migration_files_dir: z.string().optional(),
    max_files_to_scan: z.number().int().positive().optional()
});
const AnalyzeExplainArgsSchema = z.object({
    dialect: DialectSchema,
    explain_output: z.string().min(1),
    sql_query: z.string().optional(),
    existing_schema_ddl: z.string().optional()
});
const PlanZeroDowntimeArgsSchema = z.object({
    dialect: DialectSchema,
    engine_version: z.string().optional(),
    ddl_statements: z.string().min(1),
    estimated_table_rows: z.number().int().nonnegative().optional()
});
const AnalyzeTransactionsArgsSchema = z.object({
    dialect: DialectSchema,
    source: z
        .object({
        code_or_sql_snippet: z.string().optional(),
        file_paths: z.array(z.string()).optional()
    })
        .refine((s) => s.code_or_sql_snippet !== undefined || (s.file_paths && s.file_paths.length > 0), {
        message: 'source must provide code_or_sql_snippet or file_paths'
    })
});
const RecommendPartitioningArgsSchema = z.object({
    dialect: DialectSchema,
    table_ddl: z.string().min(1),
    estimated_total_rows: z.number().int().nonnegative(),
    monthly_growth_rows: z.number().int().nonnegative().optional(),
    retention_months: z.number().int().positive().optional(),
    common_query_filters: z.array(z.string()).optional()
});
const CalculateCapacityArgsSchema = z.object({
    dialect: DialectSchema,
    schema_ddl: z.string().optional(),
    estimated_rows_per_table: z.record(z.number().int().nonnegative()).optional(),
    server_hardware: z
        .object({
        vcpu: z.number().int().positive().optional(),
        ram_gb: z.number().positive().optional(),
        storage_type: z.enum(['nvme', 'ssd', 'hdd']).optional(),
        workload_type: z.enum(['oltp', 'analytics', 'mixed']).optional(),
        max_connections: z.number().int().positive().optional()
    })
        .optional()
});
export function createDbaArchitectServer() {
    const server = new Server({
        name: 'dba-architect',
        version: '1.0.0'
    }, {
        capabilities: {
            tools: {},
            resources: {},
            prompts: {}
        }
    });
    // 1. Register 8 MCP Tools
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        return {
            tools: [
                {
                    name: 'analyze_migration',
                    description: 'Audit SQL DDL statements, migration files, or migration directory against DBA best-practice rules (data types, unindexed FKs, locking DDL hazards, 1NF, alignment padding) for PostgreSQL or MySQL.',
                    inputSchema: {
                        type: 'object',
                        required: ['dialect', 'migration_source'],
                        properties: {
                            dialect: {
                                type: 'string',
                                enum: ['postgresql', 'mysql'],
                                description: 'Target database engine dialect.'
                            },
                            engine_version: {
                                type: 'string',
                                default: 'latest',
                                description: 'Database version (e.g., 16 for PG, 8.0 for MySQL).'
                            },
                            migration_source: {
                                type: 'object',
                                description: 'Provide raw_sql, file_paths array, or migration_dir path.',
                                oneOf: [
                                    {
                                        required: ['raw_sql'],
                                        properties: { raw_sql: { type: 'string' } }
                                    },
                                    {
                                        required: ['file_paths'],
                                        properties: { file_paths: { type: 'array', items: { type: 'string' } } }
                                    },
                                    {
                                        required: ['migration_dir'],
                                        properties: { migration_dir: { type: 'string' } }
                                    }
                                ],
                                properties: {
                                    raw_sql: { type: 'string' },
                                    file_paths: { type: 'array', items: { type: 'string' } },
                                    migration_dir: { type: 'string' }
                                }
                            },
                            strictness: {
                                type: 'string',
                                enum: ['standard', 'strict'],
                                default: 'standard'
                            }
                        }
                    }
                },
                {
                    name: 'recommend_indexes_for_queries',
                    description: 'Analyze raw SQL queries (including JOINs, CTEs, subqueries) using the ESR (Equality, Sort, Range) rule to recommend composite, covering, partial, and expression indexes, detect non-sargable predicates, and find redundant left-prefix indexes.',
                    inputSchema: {
                        type: 'object',
                        required: ['dialect', 'queries'],
                        properties: {
                            dialect: { type: 'string', enum: ['postgresql', 'mysql'] },
                            queries: {
                                type: 'array',
                                minItems: 1,
                                items: {
                                    type: 'object',
                                    required: ['sql'],
                                    properties: {
                                        id: { type: 'string' },
                                        sql: { type: 'string' },
                                        execution_frequency: {
                                            type: 'string',
                                            enum: ['low', 'medium', 'high', 'critical_hot_path'],
                                            default: 'medium'
                                        }
                                    }
                                }
                            },
                            existing_schema_ddl: { type: 'string' },
                            migration_files_dir: { type: 'string' },
                            cardinality_hints: {
                                type: 'object',
                                additionalProperties: {
                                    type: 'string',
                                    enum: ['very_low', 'low', 'medium', 'high', 'unique']
                                }
                            }
                        }
                    }
                },
                {
                    name: 'scan_project_queries',
                    description: 'Statically scan a codebase directory to extract raw SQL and ORM/Query Builder patterns (Go, PHP/Laravel, TS/Prisma, Python), detect N+1 query loops, mask PII literals, and synthesize a holistic consolidated index plan per table.',
                    inputSchema: {
                        type: 'object',
                        required: ['project_root_path', 'dialect'],
                        properties: {
                            project_root_path: { type: 'string' },
                            dialect: { type: 'string', enum: ['postgresql', 'mysql'] },
                            target_languages: {
                                type: 'array',
                                items: {
                                    type: 'string',
                                    enum: ['go', 'php', 'typescript', 'javascript', 'python', 'sql']
                                }
                            },
                            exclude_globs: {
                                type: 'array',
                                items: { type: 'string' },
                                default: ['**/node_modules/**', '**/vendor/**', '**/.git/**', '**/dist/**', '**/tests/**']
                            },
                            focus_tables: { type: 'array', items: { type: 'string' } },
                            existing_schema_ddl: { type: 'string' },
                            migration_files_dir: { type: 'string' },
                            max_files_to_scan: { type: 'integer', default: 5000 }
                        }
                    }
                },
                {
                    name: 'analyze_explain_plan',
                    description: 'Parse PostgreSQL or MySQL EXPLAIN / EXPLAIN (ANALYZE, BUFFERS) output (Text or JSON) to identify execution bottlenecks (Seq Scan, External Disk Sort, Heap Fetches, Row Misestimations) and generate a Mermaid plan flowchart.',
                    inputSchema: {
                        type: 'object',
                        required: ['dialect', 'explain_output'],
                        properties: {
                            dialect: { type: 'string', enum: ['postgresql', 'mysql'] },
                            explain_output: { type: 'string' },
                            sql_query: { type: 'string' },
                            existing_schema_ddl: { type: 'string' }
                        }
                    }
                },
                {
                    name: 'plan_zero_downtime_migration',
                    description: 'Transform blocking or hazardous DDL statements into a safe Multi-Phase Expand & Contract zero-downtime migration runbook for large production tables.',
                    inputSchema: {
                        type: 'object',
                        required: ['dialect', 'ddl_statements'],
                        properties: {
                            dialect: { type: 'string', enum: ['postgresql', 'mysql'] },
                            engine_version: { type: 'string', default: 'latest' },
                            ddl_statements: { type: 'string' },
                            estimated_table_rows: { type: 'integer', default: 10000000 }
                        }
                    }
                },
                {
                    name: 'analyze_transaction_and_locking',
                    description: 'Audit SQL or application transaction blocks to detect Lost Update race conditions (missing FOR UPDATE), external HTTP/network calls inside open transactions, and deadlock risks.',
                    inputSchema: {
                        type: 'object',
                        required: ['dialect', 'source'],
                        properties: {
                            dialect: { type: 'string', enum: ['postgresql', 'mysql'] },
                            source: {
                                type: 'object',
                                oneOf: [
                                    {
                                        required: ['code_or_sql_snippet'],
                                        properties: { code_or_sql_snippet: { type: 'string' } }
                                    },
                                    {
                                        required: ['file_paths'],
                                        properties: { file_paths: { type: 'array', items: { type: 'string' } } }
                                    }
                                ],
                                properties: {
                                    code_or_sql_snippet: { type: 'string' },
                                    file_paths: { type: 'array', items: { type: 'string' } }
                                }
                            }
                        }
                    }
                },
                {
                    name: 'recommend_partitioning_and_archiving',
                    description: 'Design declarative table partitioning (RANGE, LIST, HASH), validate composite Primary Key constraints (PART-PK-001), and generate zero-bloat partition detach/drop retention runbooks.',
                    inputSchema: {
                        type: 'object',
                        required: ['dialect', 'table_ddl', 'estimated_total_rows'],
                        properties: {
                            dialect: { type: 'string', enum: ['postgresql', 'mysql'] },
                            table_ddl: { type: 'string' },
                            estimated_total_rows: { type: 'integer' },
                            monthly_growth_rows: { type: 'integer' },
                            retention_months: { type: 'integer', default: 12 },
                            common_query_filters: { type: 'array', items: { type: 'string' } }
                        }
                    }
                },
                {
                    name: 'calculate_db_capacity_and_config',
                    description: 'Estimate physical row size, heap/clustered table footprint, and B-Tree index memory requirements for N million rows, and generate tuned postgresql.conf or my.cnf parameters.',
                    inputSchema: {
                        type: 'object',
                        required: ['dialect'],
                        properties: {
                            dialect: { type: 'string', enum: ['postgresql', 'mysql'] },
                            schema_ddl: { type: 'string' },
                            estimated_rows_per_table: {
                                type: 'object',
                                additionalProperties: { type: 'integer' }
                            },
                            server_hardware: {
                                type: 'object',
                                properties: {
                                    vcpu: { type: 'integer', default: 4 },
                                    ram_gb: { type: 'number', default: 16 },
                                    storage_type: { type: 'string', enum: ['nvme', 'ssd', 'hdd'], default: 'nvme' },
                                    workload_type: {
                                        type: 'string',
                                        enum: ['oltp', 'analytics', 'mixed'],
                                        default: 'oltp'
                                    },
                                    max_connections: { type: 'integer', default: 200 }
                                }
                            }
                        }
                    }
                }
            ]
        };
    });
    // Handle Tool Calls
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args = {} } = request.params;
        try {
            switch (name) {
                case 'analyze_migration': {
                    const parsed = AnalyzeMigrationArgsSchema.parse(args);
                    const result = analyzeMigration(parsed);
                    return {
                        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
                    };
                }
                case 'recommend_indexes_for_queries': {
                    const parsed = RecommendIndexesArgsSchema.parse(args);
                    const result = recommendIndexesForQueries(parsed);
                    return {
                        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
                    };
                }
                case 'scan_project_queries': {
                    const parsed = ScanProjectArgsSchema.parse(args);
                    const result = await scanProjectQueries(parsed);
                    return {
                        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
                    };
                }
                case 'analyze_explain_plan': {
                    const parsed = AnalyzeExplainArgsSchema.parse(args);
                    const result = analyzeExplainPlan(parsed);
                    return {
                        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
                    };
                }
                case 'plan_zero_downtime_migration': {
                    const parsed = PlanZeroDowntimeArgsSchema.parse(args);
                    const result = planZeroDowntimeMigration(parsed);
                    return {
                        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
                    };
                }
                case 'analyze_transaction_and_locking': {
                    const parsed = AnalyzeTransactionsArgsSchema.parse(args);
                    const result = analyzeTransactionAndLocking(parsed);
                    return {
                        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
                    };
                }
                case 'recommend_partitioning_and_archiving': {
                    const parsed = RecommendPartitioningArgsSchema.parse(args);
                    const result = recommendPartitioningAndArchiving(parsed);
                    return {
                        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
                    };
                }
                case 'calculate_db_capacity_and_config': {
                    const parsed = CalculateCapacityArgsSchema.parse(args);
                    const result = calculateDbCapacityAndConfig(parsed);
                    return {
                        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
                    };
                }
                default:
                    return {
                        isError: true,
                        content: [{ type: 'text', text: `Unknown tool: ${name}` }]
                    };
            }
        }
        catch (err) {
            return {
                isError: true,
                content: [{ type: 'text', text: `Error executing ${name}: ${err.message}` }]
            };
        }
    });
    // 2. Register 3 MCP Resources
    server.setRequestHandler(ListResourcesRequestSchema, async () => {
        return {
            resources: [
                {
                    uri: 'dba://rules/catalog',
                    name: 'DBA Architect Master Rule Catalog (30 Rules)',
                    mimeType: 'application/json',
                    description: 'Complete catalog of all 30 deterministic DBA rules (SCHEMA-*, INDEX-*, CODE-*, EXPLAIN-*, TX-*, PART-*) with severity and remediation for PostgreSQL and MySQL.'
                },
                {
                    uri: 'dba://heuristics/cardinality',
                    name: 'ESR Column Cardinality Heuristics Dictionary',
                    mimeType: 'application/json',
                    description: 'Heuristic column naming patterns and selectivity weights used for static ESR composite index ordering.'
                },
                {
                    uri: 'dba://templates/zero-downtime',
                    name: 'Zero-Downtime Migration Expand & Contract Templates',
                    mimeType: 'application/json',
                    description: 'Production-safe online DDL templates for PostgreSQL (CONCURRENTLY, NOT VALID) and MySQL (ALGORITHM=INPLACE/INSTANT, gh-ost).'
                }
            ]
        };
    });
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
        const { uri } = request.params;
        if (uri === 'dba://rules/catalog') {
            return {
                contents: [
                    {
                        uri,
                        mimeType: 'application/json',
                        text: JSON.stringify(RULES_CATALOG, null, 2)
                    }
                ]
            };
        }
        if (uri === 'dba://heuristics/cardinality') {
            return {
                contents: [
                    {
                        uri,
                        mimeType: 'application/json',
                        text: JSON.stringify({
                            description: CARDINALITY_HEURISTICS.description,
                            weights: CARDINALITY_HEURISTICS.weights,
                            pattern_examples: {
                                unique: ['id', 'uuid', 'email', 'nik', 'npwp', 'invoice_no'],
                                high: ['*_id', 'user_id', 'merchant_id', 'tenant_id', '*_code', 'token', 'phone'],
                                medium: ['category', 'country', 'city', 'channel', 'payment_method'],
                                low: ['status', 'state', 'type', 'role', 'tier', 'currency'],
                                very_low: ['is_*', 'has_*', '*_flag', 'active', 'deleted', 'gender']
                            }
                        }, null, 2)
                    }
                ]
            };
        }
        if (uri === 'dba://templates/zero-downtime') {
            return {
                contents: [
                    {
                        uri,
                        mimeType: 'application/json',
                        text: JSON.stringify(ZERO_DOWNTIME_TEMPLATES, null, 2)
                    }
                ]
            };
        }
        throw new Error(`Resource not found: ${uri}`);
    });
    // 3. Register 4 MCP Prompts
    server.setRequestHandler(ListPromptsRequestSchema, async () => {
        return {
            prompts: [
                {
                    name: 'audit-migration',
                    description: 'Audit SQL migration files for schema anti-patterns and generate a zero-downtime production rollout plan.',
                    arguments: [
                        { name: 'migration_path', description: 'Path to migration file or directory', required: true },
                        { name: 'dialect', description: 'postgresql or mysql', required: true }
                    ]
                },
                {
                    name: 'optimize-table-workload',
                    description: 'Scan a project repository for all queries and transactions touching a specific table and build a consolidated index plan.',
                    arguments: [
                        { name: 'project_root_path', description: 'Root path of the repository', required: true },
                        { name: 'table_name', description: 'Target table name to optimize', required: true },
                        { name: 'dialect', description: 'postgresql or mysql', required: true }
                    ]
                },
                {
                    name: 'diagnose-slow-query-explain',
                    description: 'Analyze an EXPLAIN ANALYZE output and SQL query to visualize bottlenecks in Mermaid and produce exact index fixes.',
                    arguments: [
                        { name: 'explain_output', description: 'Raw EXPLAIN ANALYZE output', required: true },
                        { name: 'sql_query', description: 'Original SQL query', required: true },
                        { name: 'dialect', description: 'postgresql or mysql', required: true }
                    ]
                },
                {
                    name: 'plan-production-rollout',
                    description: 'Evaluate partitioning requirements, physical storage/RAM footprint, and database engine tuning for high-scale production rollout.',
                    arguments: [
                        { name: 'schema_ddl', description: 'CREATE TABLE DDL', required: true },
                        { name: 'estimated_rows', description: 'Projected row count (e.g., 100000000)', required: true },
                        { name: 'ram_gb', description: 'Server RAM in GB (e.g., 32)', required: true },
                        { name: 'dialect', description: 'postgresql or mysql', required: true }
                    ]
                }
            ]
        };
    });
    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
        const { name, arguments: args = {} } = request.params;
        switch (name) {
            case 'audit-migration':
                return {
                    messages: [
                        {
                            role: 'user',
                            content: {
                                type: 'text',
                                text: `Please audit the database migration at '${args.migration_path}' for dialect '${args.dialect}'.
1. Call 'analyze_migration' with strictness='strict' to identify all CRITICAL, WARNING, and INFO schema issues.
2. Call 'plan_zero_downtime_migration' on any risky DDL changes to produce a multi-phase Expand & Contract rollout script.
3. Present the Health Score, summarized findings table, and the production-safe migration DDL.`
                            }
                        }
                    ]
                };
            case 'optimize-table-workload':
                return {
                    messages: [
                        {
                            role: 'user',
                            content: {
                                type: 'text',
                                text: `Please perform a holistic workload and concurrency optimization for table '${args.table_name}' in project '${args.project_root_path}' (${args.dialect}):
1. Call 'scan_project_queries' with focus_tables=['${args.table_name}'] to extract all raw SQL and ORM patterns, detect N+1 loops, and generate a consolidated composite index plan.
2. Call 'analyze_transaction_and_locking' on service/repository files modifying '${args.table_name}' to check for race conditions or external I/O inside transactions.
3. Present the canonical workload summary, N+1/concurrency fixes, and the consolidated CREATE INDEX statements.`
                            }
                        }
                    ]
                };
            case 'diagnose-slow-query-explain':
                return {
                    messages: [
                        {
                            role: 'user',
                            content: {
                                type: 'text',
                                text: `Please diagnose this slow query for '${args.dialect}':
SQL Query:
${args.sql_query}

EXPLAIN Output:
${args.explain_output}

1. Call 'analyze_explain_plan' to detect scan/sort/join/heap bottlenecks and render the Mermaid execution plan diagram.
2. Call 'recommend_indexes_for_queries' on the SQL query with execution_frequency='critical_hot_path'.
3. Provide the Mermaid diagram, root-cause bottleneck analysis, query rewrite suggestions (if non-sargable), and exact index DDL.`
                            }
                        }
                    ]
                };
            case 'plan-production-rollout':
                return {
                    messages: [
                        {
                            role: 'user',
                            content: {
                                type: 'text',
                                text: `Please prepare a production capacity and partitioning architecture plan for '${args.dialect}' with ${args.estimated_rows} projected rows on a ${args.ram_gb}GB RAM server:
Schema DDL:
${args.schema_ddl}

1. Call 'recommend_partitioning_and_archiving' with estimated_total_rows=${args.estimated_rows}.
2. Call 'calculate_db_capacity_and_config' with schema_ddl and server_hardware={ ram_gb: ${args.ram_gb} }.
3. Present the storage/RAM fit analysis, partitioning DDL + retention runbook, and tuned database configuration.`
                            }
                        }
                    ]
                };
            default:
                throw new Error(`Unknown prompt: ${name}`);
        }
    });
    return server;
}
//# sourceMappingURL=server.js.map