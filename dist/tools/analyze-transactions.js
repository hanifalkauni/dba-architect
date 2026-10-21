import fs from 'node:fs';
import { validateSafePath } from '../utils/file-walker.js';
export function analyzeTransactionAndLocking(input) {
    const dialect = input.dialect;
    let combinedSource = input.source.code_or_sql_snippet ?? '';
    if (input.source.file_paths && input.source.file_paths.length > 0) {
        const chunks = [];
        for (const fp of input.source.file_paths) {
            const safe = validateSafePath(fp);
            if (fs.existsSync(safe)) {
                chunks.push(fs.readFileSync(safe, 'utf-8'));
            }
        }
        combinedSource = chunks.join('\n\n');
    }
    const issues = [];
    // Extract transaction blocks or treat whole snippet as transaction if BEGIN / Transaction() is present
    const txBlocks = [];
    for (const sqlTx of combinedSource.matchAll(/\bBEGIN\b[\s\S]+?\b(?:COMMIT|ROLLBACK)\b/gi)) {
        txBlocks.push(sqlTx[0]);
    }
    for (const codeTx of combinedSource.matchAll(/\b(?:db\.Transaction|DB::transaction|\$transaction|transaction\.atomic|BeginTx)\s*\([\s\S]{10,2000}?\}\s*\)/g)) {
        txBlocks.push(codeTx[0]);
    }
    if (txBlocks.length === 0 && combinedSource.trim().length > 0) {
        txBlocks.push(combinedSource);
    }
    const lockOrderByTx = [];
    for (const block of txBlocks) {
        // 1. TX-RACE-001: Read-Modify-Write without FOR UPDATE / FOR NO KEY UPDATE / lockForUpdate()
        const selectMatch = block.match(/\bSELECT\s+([\s\S]+?)\s+FROM\s+([a-zA-Z0-9_."`]+)[\s\S]*?(?:;|\n|"|`)/i);
        const ormReadMatch = block.match(/\b([A-Za-z0-9_]+)::(?:find|where)|\b(?:prisma|tx|db)\.([a-zA-Z0-9_]+)\.(?:findUnique|findFirst)|\.First\(\s*&([A-Za-z0-9_]+)/i);
        const updateMatch = block.match(/\bUPDATE\s+([a-zA-Z0-9_."`]+)\s+SET\s+([a-zA-Z0-9_]+)\s*=|\.save\(\)|\.update\(/i);
        const hasPessimisticLock = /\bFOR\s+(?:NO\s+KEY\s+)?UPDATE\b|\bFOR\s+SHARE\b|\blockForUpdate\s*\(|\bsharedLock\s*\(|\bClauses\(clause\.Locking|\bwith_for_update\s*\(|\bselect_for_update\s*\(/i.test(block);
        const hasAtomicIncrementOrDecrement = /\b(?:increment|decrement)\s*:/i.test(block);
        const hasOptimisticVersionCheck = /\bWHERE\b[\s\S]*?\bversion\s*=|\bversion\s*:\s*[a-zA-Z0-9_.]+/i.test(block);
        if ((selectMatch || ormReadMatch) &&
            updateMatch &&
            !hasPessimisticLock &&
            !hasAtomicIncrementOrDecrement &&
            !hasOptimisticVersionCheck) {
            const targetTable = updateMatch[1] || selectMatch?.[2] || ormReadMatch?.[1] || ormReadMatch?.[2] || 'target_table';
            const targetCol = updateMatch[2] || 'balance/state';
            issues.push({
                rule_id: 'TX-RACE-001',
                severity: 'CRITICAL',
                category: 'LOST_UPDATE_RACE_CONDITION',
                finding: `Transaction reads '${targetTable}' via standard SELECT/ORM lookup and subsequently executes UPDATE on '${targetCol}' without row-level locking.`,
                impact: 'Concurrent requests can read the same initial state simultaneously, resulting in double-spend, negative balance/stock, or lost update anomalies under READ COMMITTED isolation.',
                recommendation: dialect === 'postgresql'
                    ? `Use pessimistic row locking 'SELECT ... FOR NO KEY UPDATE' (or 'FOR UPDATE') or an atomic conditional update 'UPDATE ${targetTable} SET ${targetCol} = ${targetCol} - $1 WHERE id = $2 AND ${targetCol} >= $1'.`
                    : `Use pessimistic row locking 'SELECT ... FOR UPDATE' or an atomic conditional update 'UPDATE ${targetTable} SET ${targetCol} = ${targetCol} - ? WHERE id = ? AND ${targetCol} >= ?'.`
            });
        }
        // 2. TX-IO-001: External HTTP / RPC / Sleep / Mail call inside open DB transaction
        const ioMatch = block.match(/\b(fetch\s*\(|axios\.[a-z]+\s*\(|http\.(?:Get|Post|Do)\s*\(|Http::(?:get|post|put)\s*\(|requests\.(?:get|post)\s*\(|paymentGateway\.[a-zA-Z0-9_]+\s*\(|grpcClient\.[a-zA-Z0-9_]+\s*\(|Mail::send\s*\(|sleep\s*\(|time\.Sleep\s*\()/i);
        if (ioMatch) {
            issues.push({
                rule_id: 'TX-IO-001',
                severity: 'CRITICAL',
                category: 'EXTERNAL_IO_IN_TRANSACTION',
                finding: `Detected external I/O or network call ('${ioMatch[1].replace(/\($/, '()')}') inside an open database transaction block.`,
                impact: 'Holds row-level locks and occupies a database connection for the duration of network latency (hundreds of milliseconds to seconds), causing lock contention and connection pool exhaustion.',
                recommendation: 'Move external HTTP/API calls outside the DB transaction using an Idempotency Key / Outbox State Machine pattern (PENDING -> Commit -> HTTP Call -> COMPLETED).'
            });
        }
        // 3. TX-DEADLOCK-001: Unordered WHERE id IN (...) or multi-table lock ordering
        if (/\b(?:UPDATE\s+[a-zA-Z0-9_."`]+[\s\S]*?WHERE\s+id\s+IN|SELECT[\s\S]*?WHERE\s+id\s+IN[\s\S]*?FOR\s+UPDATE)\b/i.test(block)) {
            if (!/\bORDER\s+BY\s+id\b|\.sort\(|sort\.Slice/i.test(block)) {
                issues.push({
                    rule_id: 'TX-DEADLOCK-001',
                    severity: 'WARNING',
                    category: 'INCONSISTENT_LOCK_ORDERING',
                    finding: 'Bulk row locking (UPDATE ... WHERE id IN / SELECT ... WHERE id IN ... FOR UPDATE) without deterministic ascending ID ordering.',
                    impact: 'If two concurrent transactions lock overlapping ID sets in different orders (e.g., [10, 20] vs [20, 10]), a cyclic deadlock occurs.',
                    recommendation: 'Sort target IDs in ascending order in application code or use ORDER BY id ASC before acquiring locks.'
                });
            }
        }
        // Track order of tables modified/locked in this transaction
        const tablesLocked = [];
        for (const m of block.matchAll(/\b(?:UPDATE\s+([a-zA-Z0-9_]+)|FROM\s+([a-zA-Z0-9_]+)[\s\S]{1,120}?FOR\s+(?:NO\s+KEY\s+)?UPDATE|(?:prisma|tx|db)\.([a-zA-Z0-9_]+)\.(?:update|updateMany|delete))\b/gi)) {
            const tbl = (m[1] || m[2] || m[3]).toLowerCase();
            if (!tablesLocked.includes(tbl))
                tablesLocked.push(tbl);
        }
        if (tablesLocked.length >= 2) {
            lockOrderByTx.push(tablesLocked);
        }
    }
    // Check cross-transaction lock order inversion (Deadlock between Tx A and Tx B)
    for (let i = 0; i < lockOrderByTx.length; i++) {
        for (let j = i + 1; j < lockOrderByTx.length; j++) {
            const orderA = lockOrderByTx[i];
            const orderB = lockOrderByTx[j];
            if (orderA[0] === orderB[1] && orderA[1] === orderB[0]) {
                issues.push({
                    rule_id: 'TX-DEADLOCK-001',
                    severity: 'WARNING',
                    category: 'INCONSISTENT_LOCK_ORDERING',
                    finding: `Lock order inversion detected across transactions: Transaction #${i + 1} locks (${orderA.join(' -> ')}) whereas Transaction #${j + 1} locks (${orderB.join(' -> ')}).`,
                    impact: 'Guaranteed AB-BA deadlock under concurrent load.',
                    recommendation: `Enforce a strict canonical lock acquisition hierarchy: always lock '${orderA[0]}' before '${orderA[1]}'.`
                });
            }
        }
    }
    const criticalCount = issues.filter((i) => i.severity === 'CRITICAL').length;
    const warningCount = issues.filter((i) => i.severity === 'WARNING').length;
    const score = Math.max(0, 100 - criticalCount * 25 - warningCount * 10);
    return {
        summary: {
            transactions_analyzed: txBlocks.length,
            concurrency_safety_score: score,
            issues_detected: issues.length
        },
        concurrency_issues: issues
    };
}
//# sourceMappingURL=analyze-transactions.js.map