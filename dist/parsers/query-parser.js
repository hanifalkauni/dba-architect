const LOW_SELECTIVITY_COLUMNS = /^(status|state|type|role|is_active|is_deleted|deleted_at|archived|flag|gender)$/i;
export function maskSqlLiteralsAndNormalize(sql) {
    let cleaned = sql.replace(/--[^\r\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
    let hasDynamicSort = false;
    // Detect dynamic identifiers like $sortCol, ${sort}, {{col}}
    if (/ORDER\s+BY\s+(\$[a-zA-Z0-9_]+|\$\{[^}]+\}|\{\{[^}]+\}\})/i.test(cleaned)) {
        hasDynamicSort = true;
        cleaned = cleaned.replace(/ORDER\s+BY\s+(\$[a-zA-Z0-9_]+|\$\{[^}]+\}|\{\{[^}]+\}\})/gi, 'ORDER BY __DYNAMIC_IDENT__');
    }
    // Capture low-selectivity literal filters before masking (for Partial Index WHERE generation)
    const preservedConstantLiterals = {};
    const constEqMatches = [
        ...cleaned.matchAll(/\b([a-zA-Z0-9_.]+)\s*=\s*('([A-Z0-9_-]{1,24})'|\btrue\b|\bfalse\b)/gi)
    ];
    for (const m of constEqMatches) {
        const rawCol = m[1].split('.').pop() || m[1];
        const rawVal = m[2];
        if (LOW_SELECTIVITY_COLUMNS.test(rawCol) && !/@/.test(rawVal) && !/sk-|secret|token|key/i.test(rawCol)) {
            preservedConstantLiterals[rawCol] = rawVal;
        }
    }
    const isNullMatches = [...cleaned.matchAll(/\b([a-zA-Z0-9_.]+)\s+IS\s+(NOT\s+)?NULL\b/gi)];
    for (const m of isNullMatches) {
        const rawCol = m[1].split('.').pop() || m[1];
        const isNot = m[2] ? 'NOT NULL' : 'NULL';
        preservedConstantLiterals[rawCol] = `IS ${isNot}`;
    }
    // Mask string literals, positional parameters ($1, :param), and numbers
    let masked = cleaned
        .replace(/'(?:''|[^'])*'/g, (match) => {
        // Preserve simple uppercase enum-like status literals in normalized output if safe, else '?'
        if (/^'[A-Z_]{2,16}'$/.test(match)) {
            return match;
        }
        return '?';
    })
        .replace(/\$\d+/g, '?')
        .replace(/:[a-zA-Z_][a-zA-Z0-9_]*/g, '?')
        .replace(/\b\d+(?:\.\d+)?\b/g, '?')
        .replace(/\s+/g, ' ')
        .replace(/;\s*$/, '')
        .trim();
    return { normalizedSql: masked, preservedConstantLiterals, hasDynamicSort };
}
function cleanColName(col) {
    return col.trim().replace(/^["`]|["`]$/g, '');
}
export function analyzeSqlQueryAst(sql, _dialect) {
    const trimmed = sql.trim();
    if (!trimmed || !/\b(SELECT|UPDATE|DELETE)\b/i.test(trimmed)) {
        return {
            status: 'PARSE_ERROR',
            error_message: 'Query does not contain a valid SELECT, UPDATE, or DELETE statement.',
            normalized_sql: trimmed,
            tables: [],
            extracted_predicates: [],
            sargability_warnings: [],
            has_dynamic_sort: false
        };
    }
    const { normalizedSql, preservedConstantLiterals, hasDynamicSort } = maskSqlLiteralsAndNormalize(trimmed);
    // Extract CTE names so we don't treat CTE virtual names as physical tables
    const cteNames = new Set();
    for (const cteMatch of trimmed.matchAll(/\bWITH\s+(?:RECURSIVE\s+)?([a-zA-Z0-9_]+)\s+AS\s*\(/gi)) {
        cteNames.add(cteMatch[1].toLowerCase());
    }
    for (const multiCte of trimmed.matchAll(/,\s*([a-zA-Z0-9_]+)\s+AS\s*\(/gi)) {
        cteNames.add(multiCte[1].toLowerCase());
    }
    // Map alias -> real table name, and list of tables
    const aliasToTable = new Map();
    const tablesOrdered = [];
    const registerTable = (rawTbl, rawAlias) => {
        const tbl = cleanColName(rawTbl).replace(/^[a-zA-Z0-9_]+\./, '');
        if (!tbl || /^(SELECT|WHERE|SET|VALUES|ON|AND|OR|LEFT|INNER|RIGHT|JOIN|LATERAL|\()$/i.test(tbl))
            return;
        if (cteNames.has(tbl.toLowerCase()))
            return;
        if (!tablesOrdered.includes(tbl)) {
            tablesOrdered.push(tbl);
        }
        aliasToTable.set(tbl.toLowerCase(), tbl);
        if (rawAlias) {
            const cleanAlias = cleanColName(rawAlias);
            if (cleanAlias &&
                !/^(WHERE|JOIN|LEFT|INNER|RIGHT|ON|ORDER|GROUP|LIMIT|SET|VALUES|HAVING|UNION)$/i.test(cleanAlias)) {
                aliasToTable.set(cleanAlias.toLowerCase(), tbl);
            }
        }
    };
    for (const m of trimmed.matchAll(/\b(?:FROM|UPDATE|INTO)\s+([a-zA-Z0-9_."`]+)(?:\s+(?:AS\s+)?([a-zA-Z0-9_]+))?/gi)) {
        registerTable(m[1], m[2]);
    }
    for (const m of trimmed.matchAll(/\bJOIN\s+([a-zA-Z0-9_."`]+)(?:\s+(?:AS\s+)?([a-zA-Z0-9_]+))?/gi)) {
        registerTable(m[1], m[2]);
    }
    if (tablesOrdered.length === 0) {
        return {
            status: 'PARSE_ERROR',
            error_message: 'Could not resolve any target table from SQL statement.',
            normalized_sql: normalizedSql,
            tables: [],
            extracted_predicates: [],
            sargability_warnings: [],
            has_dynamic_sort: hasDynamicSort
        };
    }
    const primaryTable = tablesOrdered[0];
    const tablePredicates = new Map();
    for (const t of tablesOrdered) {
        tablePredicates.set(t, {
            table: t,
            equality_columns: [],
            equality_literals: {},
            join_columns: [],
            sort_columns: [],
            range_columns: [],
            projected_columns: []
        });
    }
    const resolveQualifiedColumn = (rawRef) => {
        const cleaned = cleanColName(rawRef);
        if (cleaned.includes('.')) {
            const [prefix, col] = cleaned.split('.');
            const resolvedTable = aliasToTable.get(prefix.toLowerCase()) || prefix;
            if (!tablePredicates.has(resolvedTable)) {
                tablePredicates.set(resolvedTable, {
                    table: resolvedTable,
                    equality_columns: [],
                    equality_literals: {},
                    join_columns: [],
                    sort_columns: [],
                    range_columns: [],
                    projected_columns: []
                });
            }
            return { table: resolvedTable, column: cleanColName(col) };
        }
        return { table: primaryTable, column: cleaned };
    };
    // 1. Extract SELECT projected columns
    const selectMatch = trimmed.match(/SELECT\s+(?:DISTINCT\s+)?([\s\S]+?)\s+FROM\b/i);
    if (selectMatch) {
        const rawSelectList = selectMatch[1].split(',').map((s) => s.trim());
        for (const item of rawSelectList) {
            if (item === '*' || item.endsWith('.*')) {
                const p = tablePredicates.get(primaryTable);
                if (p && !p.projected_columns.includes('*'))
                    p.projected_columns.push('*');
                continue;
            }
            // Strip AS alias
            const withoutAlias = item.replace(/\s+AS\s+[a-zA-Z0-9_"`]+$/i, '').trim();
            if (/^[a-zA-Z0-9_."`]+$/.test(withoutAlias)) {
                const { table, column } = resolveQualifiedColumn(withoutAlias);
                const p = tablePredicates.get(table);
                if (p && !p.projected_columns.includes(column)) {
                    p.projected_columns.push(column);
                }
            }
        }
    }
    // 2. Extract JOIN ... ON predicates
    for (const joinMatch of trimmed.matchAll(/\bJOIN\s+[a-zA-Z0-9_."`]+(?:\s+(?:AS\s+)?[a-zA-Z0-9_]+)?\s+ON\s+([a-zA-Z0-9_.]+)\s*=\s*([a-zA-Z0-9_.]+)/gi)) {
        const left = resolveQualifiedColumn(joinMatch[1]);
        const right = resolveQualifiedColumn(joinMatch[2]);
        const lp = tablePredicates.get(left.table);
        if (lp && !lp.join_columns.includes(left.column)) {
            lp.join_columns.push(left.column);
        }
        const rp = tablePredicates.get(right.table);
        if (rp && !rp.join_columns.includes(right.column)) {
            rp.join_columns.push(right.column);
        }
    }
    const sargabilityWarnings = [];
    // 3. Extract WHERE clause segment
    const whereMatch = trimmed.match(/\bWHERE\s+([\s\S]+?)(?:\bGROUP\s+BY\b|\bORDER\s+BY\b|\bLIMIT\b|\bOFFSET\b|\bHAVING\b|$)/i);
    if (whereMatch) {
        const whereClause = whereMatch[1].trim();
        const sargableExprCols = new Set();
        // 3a. Detect Non-Sargable Function Calls: FUNC(col) = ...
        for (const fnMatch of whereClause.matchAll(/\b(LOWER|UPPER|YEAR|MONTH|DAY|DATE|CAST|COALESCE|TRIM|SUBSTRING|DATE_TRUNC)\s*\(\s*([a-zA-Z0-9_.]+)(?:\s*,[^)]*)?\)\s*(=|>|<|>=|<=|LIKE)/gi)) {
            const fnName = fnMatch[1].toUpperCase();
            const { table, column } = resolveQualifiedColumn(fnMatch[2]);
            const expr = `${fnName}(${column})`;
            const fullExpr = `${expr} ${fnMatch[3]} ?`;
            sargableExprCols.add(`${table}.${column}`.toLowerCase());
            const p = tablePredicates.get(table);
            if (p && !p.equality_columns.includes(expr)) {
                p.equality_columns.push(expr);
            }
            let rewriteSuggestion = `Create a functional expression index on ${expr} or rewrite the predicate so '${column}' is not wrapped in ${fnName}().`;
            if (fnName === 'YEAR' || fnName === 'DATE' || fnName === 'DATE_TRUNC') {
                rewriteSuggestion = `Rewrite as a sargable date range: WHERE ${column} >= '2026-01-01' AND ${column} < '2027-01-01'.`;
            }
            else if (fnName === 'LOWER' || fnName === 'UPPER') {
                rewriteSuggestion = `Either use CITEXT data type (PostgreSQL), or create a functional expression index on ${expr}.`;
            }
            sargabilityWarnings.push({
                rule_id: 'INDEX-SARG-001',
                table,
                column,
                expression: fullExpr,
                issue: `Wrapping column '${column}' in function ${fnName}() prevents standard B-Tree index usage on (${column}), forcing a Full Table Scan.`,
                query_rewrite_suggestion: rewriteSuggestion
            });
        }
        // 3b. Detect Non-Sargable Leading Wildcard LIKE '%abc%'
        for (const likeMatch of whereClause.matchAll(/\b([a-zA-Z0-9_.]+)\s+(I?LIKE)\s+'(%[^']*)'/gi)) {
            const { table, column } = resolveQualifiedColumn(likeMatch[1]);
            const op = likeMatch[2].toUpperCase();
            const pattern = likeMatch[3];
            sargabilityWarnings.push({
                rule_id: 'INDEX-SARG-002',
                table,
                column,
                expression: `${column} ${op} '${pattern}'`,
                issue: `Leading wildcard '${pattern}' on column '${column}' prevents B-Tree index left-prefix seek.`,
                query_rewrite_suggestion: "Use PostgreSQL pg_trgm GIN index (USING gin (col gin_trgm_ops)), Full-Text Search (tsvector), or MySQL FULLTEXT index."
            });
        }
        // 3c. Detect Non-Sargable Column Arithmetic: col * 2 > 1000
        for (const arithMatch of whereClause.matchAll(/\b([a-zA-Z0-9_.]+)\s*([*+/]|-(?!>))\s*(\d+(?:\.\d+)?)\s*(=|>|<|>=|<=)\s*(\d+(?:\.\d+)?)/g)) {
            const { table, column } = resolveQualifiedColumn(arithMatch[1]);
            const mathOp = arithMatch[2];
            const rhs = arithMatch[3];
            const cmp = arithMatch[4];
            const target = arithMatch[5];
            sargableExprCols.add(`${table}.${column}`.toLowerCase());
            sargabilityWarnings.push({
                rule_id: 'INDEX-SARG-003',
                table,
                column,
                expression: `${column} ${mathOp} ${rhs} ${cmp} ${target}`,
                issue: `Arithmetic operation on column '${column}' disables B-Tree index lookup and evaluates every row.`,
                query_rewrite_suggestion: `Move arithmetic to the constant side of the comparison (e.g., WHERE ${column} ${cmp} ${target} / ${rhs}).`
            });
        }
        // 3d. Detect Negation (!=, <>, NOT IN)
        for (const negMatch of whereClause.matchAll(/\b([a-zA-Z0-9_.]+)\s*(!=|<>|\bNOT\s+IN\b)/gi)) {
            const { table, column } = resolveQualifiedColumn(negMatch[1]);
            const op = negMatch[2].toUpperCase().replace(/\s+/g, ' ');
            sargabilityWarnings.push({
                rule_id: 'INDEX-SARG-004',
                table,
                column,
                expression: `${column} ${op} ?`,
                issue: `Negation operator '${op}' on '${column}' has low selectivity and typically forces a sequential scan.`,
                query_rewrite_suggestion: `Rewrite using positive equality/IN predicates or a PostgreSQL Partial Index if filtering a rare state.`
            });
        }
        // 3e. Extract Equality Predicates: col = ?, col IN (...), col IS NULL
        for (const eqMatch of whereClause.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_.]*)\s*(?:=\s*(?:'[^']*'|\?|\$\d+|:[a-zA-Z0-9_]+|\d+|true|false|ANY\s*\([^)]+\))|(?<!\bNOT\s)\bIN\s*\([^)]+\)|\bIS\s+(?:NOT\s+)?NULL)/gi)) {
            const rawIdentifier = eqMatch[1];
            if (/^(AND|OR|WHERE|NOT|NULL|TRUE|FALSE)$/i.test(rawIdentifier))
                continue;
            const { table, column } = resolveQualifiedColumn(rawIdentifier);
            if (sargableExprCols.has(`${table}.${column}`.toLowerCase()))
                continue;
            const p = tablePredicates.get(table);
            if (p && !p.equality_columns.includes(column)) {
                p.equality_columns.push(column);
                if (preservedConstantLiterals[column]) {
                    p.equality_literals[column] = preservedConstantLiterals[column];
                }
            }
        }
        // 3f. Extract Range Predicates: col > ?, col < ?, col >= ?, col <= ?, col BETWEEN, col LIKE 'prefix%'
        for (const rangeMatch of whereClause.matchAll(/\b([a-zA-Z0-9_.]+)\s*(?:>=|<=|(?<!<)>|<(?!>)|\bBETWEEN\b|\bI?LIKE\s+'[^%][^']*')/gi)) {
            const rawIdentifier = rangeMatch[1];
            if (/^(AND|OR|WHERE|NOT)$/i.test(rawIdentifier))
                continue;
            const { table, column } = resolveQualifiedColumn(rawIdentifier);
            if (sargableExprCols.has(`${table}.${column}`.toLowerCase()))
                continue;
            const p = tablePredicates.get(table);
            if (p && !p.range_columns.includes(column)) {
                p.range_columns.push(column);
            }
        }
    }
    // 4. Extract ORDER BY columns
    const orderByMatch = trimmed.match(/\bORDER\s+BY\s+([\s\S]+?)(?:\bLIMIT\b|\bOFFSET\b|$)/i);
    if (orderByMatch) {
        const orderItems = orderByMatch[1].split(',').map((s) => s.trim());
        for (const item of orderItems) {
            const m = item.match(/^([a-zA-Z0-9_."`]+)(?:\s+(ASC|DESC))?/i);
            if (m) {
                const { table, column } = resolveQualifiedColumn(m[1]);
                const direction = m[2]?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
                const p = tablePredicates.get(table);
                if (p && !p.sort_columns.some((sc) => sc.column === column)) {
                    p.sort_columns.push({ column, direction });
                }
            }
        }
    }
    // 5. Extract GROUP BY columns into sort_columns if not already present
    const groupByMatch = trimmed.match(/\bGROUP\s+BY\s+([\s\S]+?)(?:\bHAVING\b|\bORDER\s+BY\b|\bLIMIT\b|$)/i);
    if (groupByMatch) {
        const groupItems = groupByMatch[1].split(',').map((s) => s.trim());
        for (const item of groupItems) {
            if (/^[a-zA-Z0-9_."`]+$/.test(item)) {
                const { table, column } = resolveQualifiedColumn(item);
                const p = tablePredicates.get(table);
                if (p &&
                    !p.equality_columns.includes(column) &&
                    !p.sort_columns.some((sc) => sc.column === column)) {
                    p.sort_columns.push({ column, direction: 'ASC' });
                }
            }
        }
    }
    return {
        status: 'ANALYZED',
        normalized_sql: normalizedSql,
        tables: Array.from(tablePredicates.keys()),
        extracted_predicates: Array.from(tablePredicates.values()),
        sargability_warnings: sargabilityWarnings,
        has_dynamic_sort: hasDynamicSort
    };
}
//# sourceMappingURL=query-parser.js.map