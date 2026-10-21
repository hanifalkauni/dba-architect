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

interface ParsedPlanNode {
  id: string;
  nodeType: string;
  relation?: string;
  planRows: number;
  actualRows?: number;
  actualTotalTimeMs?: number;
  loops: number;
  filter?: string;
  rowsRemovedByFilter?: number;
  sortMethod?: string;
  sortSpaceUsedKb?: number;
  sortKey?: string;
  heapFetches?: number;
  hashBatches?: number;
  children: ParsedPlanNode[];
}

function extractColumnsFromFilterText(filter: string): string[] {
  const cols: string[] = [];
  for (const m of filter.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:=|>|<|>=|<=|~~|LIKE|IN)\b/gi)) {
    const c = m[1];
    if (!/^(AND|OR|NOT|NULL|TRUE|FALSE|TEXT|VARCHAR|INT|INTEGER)$/i.test(c) && !cols.includes(c)) {
      cols.push(c);
    }
  }
  return cols;
}

function parsePgJsonPlanNode(raw: Record<string, unknown>, counter: { val: number }): ParsedPlanNode {
  const id = `N${++counter.val}`;
  const nodeType = String(raw['Node Type'] || 'PlanNode');
  const relation = raw['Relation Name'] ? String(raw['Relation Name']) : undefined;
  const planRows = Number(raw['Plan Rows'] ?? 0);
  const actualRows = raw['Actual Rows'] !== undefined ? Number(raw['Actual Rows']) : undefined;
  const actualTotalTimeMs =
    raw['Actual Total Time'] !== undefined ? Number(raw['Actual Total Time']) : Number(raw['Total Cost'] ?? 0);
  const loops = Number(raw['Actual Loops'] ?? 1);
  const filter = raw['Filter'] ? String(raw['Filter']) : undefined;
  const rowsRemovedByFilter =
    raw['Rows Removed by Filter'] !== undefined ? Number(raw['Rows Removed by Filter']) : undefined;
  const sortMethod = raw['Sort Method'] ? String(raw['Sort Method']) : undefined;
  const sortSpaceUsedKb = raw['Sort Space Used'] !== undefined ? Number(raw['Sort Space Used']) : undefined;
  const sortKey = Array.isArray(raw['Sort Key']) ? (raw['Sort Key'] as string[]).join(', ') : undefined;
  const heapFetches = raw['Heap Fetches'] !== undefined ? Number(raw['Heap Fetches']) : undefined;
  const hashBatches = raw['Hash Batches'] !== undefined ? Number(raw['Hash Batches']) : undefined;

  const rawPlans = Array.isArray(raw['Plans']) ? (raw['Plans'] as Record<string, unknown>[]) : [];
  const children = rawPlans.map((child) => parsePgJsonPlanNode(child, counter));

  return {
    id,
    nodeType,
    relation,
    planRows,
    actualRows,
    actualTotalTimeMs,
    loops,
    filter,
    rowsRemovedByFilter,
    sortMethod,
    sortSpaceUsedKb,
    sortKey,
    heapFetches,
    hashBatches,
    children
  };
}

function parseTextExplainToNodes(text: string): {
  nodes: ParsedPlanNode[];
  planningTimeMs: number;
  executionTimeMs: number;
} {
  const lines = text.split(/\r?\n/);
  const nodes: ParsedPlanNode[] = [];
  const stack: Array<{ indent: number; node: ParsedPlanNode }> = [];
  let planningTimeMs = 0;
  let executionTimeMs = 0;
  let current: ParsedPlanNode | null = null;
  let idx = 0;

  for (const line of lines) {
    const planTimeMatch = line.match(/Planning Time:\s*([\d.]+)\s*ms/i);
    if (planTimeMatch) {
      planningTimeMs = parseFloat(planTimeMatch[1]);
      continue;
    }
    const execTimeMatch = line.match(/Execution Time:\s*([\d.]+)\s*ms/i);
    if (execTimeMatch) {
      executionTimeMs = parseFloat(execTimeMatch[1]);
      continue;
    }

    // Match node header: [->] Seq Scan on orders  (cost=0.00..120.00 rows=100 width=32) (actual time=0.05..1150.20 rows=120 loops=1)
    const nodeMatch = line.match(
      /^(\s*(?:->\s*)?)([A-Z][a-zA-Z0-9 ]+?)(?:\s+using\s+([a-zA-Z0-9_."`]+))?(?:\s+on\s+([a-zA-Z0-9_."`]+))?(?:\s+[a-zA-Z0-9_]+)?\s*\(cost=[\d.]+\.\.([\d.]+)\s+rows=(\d+)\s+width=\d+\)(?:\s*\(actual\s+time=[\d.]+\.\.([\d.]+)\s+rows=(\d+)\s+loops=(\d+)\))?/i
    );
    if (nodeMatch) {
      const indent = nodeMatch[1].length;
      const nodeType = nodeMatch[2].trim();
      const relation = nodeMatch[4]?.replace(/^["`]|["`]$/g, '');
      const totalCost = parseFloat(nodeMatch[5]);
      const planRows = parseInt(nodeMatch[6], 10);
      const actualTime = nodeMatch[7] ? parseFloat(nodeMatch[7]) : totalCost;
      const actualRows = nodeMatch[8] ? parseInt(nodeMatch[8], 10) : undefined;
      const loops = nodeMatch[9] ? parseInt(nodeMatch[9], 10) : 1;

      current = {
        id: `N${++idx}`,
        nodeType,
        relation,
        planRows,
        actualRows,
        actualTotalTimeMs: actualTime * loops,
        loops,
        children: []
      };

      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
        stack.pop();
      }
      if (stack.length > 0) {
        stack[stack.length - 1].node.children.push(current);
      }
      stack.push({ indent, node: current });
      nodes.push(current);
      continue;
    }

    if (current) {
      const filterMatch = line.match(/^\s*Filter:\s*(.+)$/i);
      if (filterMatch) current.filter = filterMatch[1].trim();

      const removedMatch = line.match(/^\s*Rows Removed by Filter:\s*(\d+)/i);
      if (removedMatch) current.rowsRemovedByFilter = parseInt(removedMatch[1], 10);

      const sortMethodMatch = line.match(/^\s*Sort Method:\s*([^:]+?)\s+(?:Memory|Disk):\s*(\d+)kB/i);
      if (sortMethodMatch) {
        current.sortMethod = sortMethodMatch[1].trim();
        current.sortSpaceUsedKb = parseInt(sortMethodMatch[2], 10);
      }

      const sortKeyMatch = line.match(/^\s*Sort Key:\s*(.+)$/i);
      if (sortKeyMatch) current.sortKey = sortKeyMatch[1].trim();

      const heapFetchMatch = line.match(/^\s*Heap Fetches:\s*(\d+)/i);
      if (heapFetchMatch) current.heapFetches = parseInt(heapFetchMatch[1], 10);

      const batchesMatch = line.match(/^\s*Batches:\s*(\d+)/i);
      if (batchesMatch) current.hashBatches = parseInt(batchesMatch[1], 10);
    }
  }

  if (executionTimeMs === 0 && nodes.length > 0) {
    executionTimeMs = Math.max(...nodes.map((n) => n.actualTotalTimeMs ?? 0));
  }

  return { nodes, planningTimeMs, executionTimeMs };
}

function flattenNodes(root: ParsedPlanNode): ParsedPlanNode[] {
  const result: ParsedPlanNode[] = [root];
  for (const child of root.children) {
    result.push(...flattenNodes(child));
  }
  return result;
}

export function analyzeExplainPlan(input: {
  dialect: Dialect;
  explain_output: string;
  sql_query?: string;
  existing_schema_ddl?: string;
}): AnalyzeExplainOutput {
  const dialect = input.dialect;
  const raw = input.explain_output.trim();
  const bottlenecks: ExplainBottleneck[] = [];

  let allNodes: ParsedPlanNode[] = [];
  let totalExecutionTimeMs = 0;
  let planningTimeMs = 0;

  // Try JSON parse first
  let parsedJsonSuccessfully = false;
  if (raw.startsWith('[') || raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      const rootObj = Array.isArray(parsed) ? parsed[0] : parsed;
      if (rootObj && rootObj['Plan']) {
        parsedJsonSuccessfully = true;
        planningTimeMs = Number(rootObj['Planning Time'] ?? 0);
        totalExecutionTimeMs = Number(
          rootObj['Execution Time'] ?? rootObj['Plan']['Actual Total Time'] ?? rootObj['Plan']['Total Cost'] ?? 0
        );
        const rootNode = parsePgJsonPlanNode(rootObj['Plan'], { val: 0 });
        allNodes = flattenNodes(rootNode);
      } else if (rootObj && rootObj['query_block']) {
        // MySQL EXPLAIN FORMAT=JSON
        parsedJsonSuccessfully = true;
        const qb = rootObj['query_block'];
        const costInfo = qb['cost_info'] || {};
        totalExecutionTimeMs = Number(costInfo['query_cost'] ?? 100);
        const tableObj = qb['table'] || qb['ordering_operation']?.['table'] || {};
        const usingFilesort = Boolean(qb['ordering_operation']?.['using_filesort']);
        const accessType = String(tableObj['access_type'] || 'ALL');
        const tableName = String(tableObj['table_name'] || 'unknown_table');
        const rowsExamined = Number(tableObj['rows_examined_per_scan'] ?? 0);
        const attachedCondition = String(tableObj['attached_condition'] || '');

        const n1: ParsedPlanNode = {
          id: 'N1',
          nodeType: accessType === 'ALL' ? 'Full Table Scan (type: ALL)' : `Access (${accessType})`,
          relation: tableName,
          planRows: rowsExamined,
          actualRows: rowsExamined,
          actualTotalTimeMs: totalExecutionTimeMs,
          loops: 1,
          filter: attachedCondition,
          rowsRemovedByFilter: accessType === 'ALL' ? rowsExamined : 0,
          sortMethod: usingFilesort ? 'Using filesort' : undefined,
          children: []
        };
        allNodes = [n1];
      }
    } catch {
      parsedJsonSuccessfully = false;
    }
  }

  if (!parsedJsonSuccessfully) {
    const textParsed = parseTextExplainToNodes(raw);
    allNodes = textParsed.nodes;
    planningTimeMs = textParsed.planningTimeMs;
    totalExecutionTimeMs = textParsed.executionTimeMs;

    // Also support MySQL tabular/text "type: ALL" or "Using filesort"
    if (allNodes.length === 0 && /Using filesort|type:\s*ALL|\bALL\b/i.test(raw)) {
      const tblMatch = raw.match(/table:\s*([a-zA-Z0-9_]+)/i) || input.sql_query?.match(/FROM\s+([a-zA-Z0-9_]+)/i);
      const tbl = tblMatch ? tblMatch[1] : 'target_table';
      allNodes = [
        {
          id: 'N1',
          nodeType: /ALL/i.test(raw) ? 'Full Table Scan (ALL)' : 'Index Scan',
          relation: tbl,
          planRows: 50000,
          actualRows: 50000,
          actualTotalTimeMs: 500,
          loops: 1,
          rowsRemovedByFilter: /ALL/i.test(raw) ? 49000 : 0,
          sortMethod: /Using filesort/i.test(raw) ? 'external merge Disk (filesort)' : undefined,
          children: []
        }
      ];
      totalExecutionTimeMs = 500;
    }
  }

  // Evaluate DBA Explain Rules across all nodes
  let slowestNodeLabel = 'Query Root';
  let maxNodeTime = -1;

  for (const node of allNodes) {
    const nodeTime = node.actualTotalTimeMs ?? 0;
    const childSumTime = node.children.reduce((sum, ch) => sum + (ch.actualTotalTimeMs ?? 0), 0);
    const exclusiveTime = Math.max(0, nodeTime - childSumTime);
    const label = node.relation ? `${node.nodeType} on ${node.relation}` : node.nodeType;
    if (exclusiveTime > maxNodeTime) {
      maxNodeTime = exclusiveTime;
      slowestNodeLabel = label;
    }

    // 1. EXPLAIN-SCAN-001: Sequential Scan / Full Table Scan
    if (/Seq Scan|Full Table Scan/i.test(node.nodeType)) {
      const removed = node.rowsRemovedByFilter ?? 0;
      const emitted = node.actualRows ?? node.planRows;
      const totalRead = removed + emitted;
      if (removed > 1000 || totalRead > 5000 || nodeTime > 50) {
        const filterCols = node.filter ? extractColumnsFromFilterText(node.filter) : ['filter_col'];
        const tbl = node.relation || 'target_table';
        const idxCols = filterCols.length > 0 ? filterCols.join(', ') : 'id';
        const idxName = `idx_${tbl}_${filterCols.join('_') || 'opt'}`;
        const fixDdl =
          dialect === 'postgresql'
            ? `CREATE INDEX CONCURRENTLY ${idxName} ON ${tbl} (${idxCols});`
            : `CREATE INDEX ${idxName} ON ${tbl} (${idxCols}) ALGORITHM=INPLACE, LOCK=NONE;`;

        bottlenecks.push({
          rule_id: 'EXPLAIN-SCAN-001',
          severity: 'CRITICAL',
          node_type: node.nodeType,
          target_relation: tbl,
          execution_time_ms: nodeTime,
          rows_emitted: emitted,
          rows_removed_by_filter: removed,
          finding: `Sequential scan on '${tbl}' read ${totalRead.toLocaleString()} rows and discarded ${removed.toLocaleString()} rows via filter ${node.filter || ''}.`,
          recommendation: `Create a composite B-Tree index on ${tbl} (${idxCols}) matching the filter predicate.`,
          suggested_ddl_fix: fixDdl
        });
      }
    }

    // 2. EXPLAIN-SORT-001: External Merge Disk Sort / Using filesort
    if (
      /Sort/i.test(node.nodeType) ||
      (node.sortMethod && /external|disk|filesort/i.test(node.sortMethod))
    ) {
      const isDiskSort = node.sortMethod ? /external|disk|filesort/i.test(node.sortMethod) : nodeTime > 50;
      if (isDiskSort) {
        const spaceMb = node.sortSpaceUsedKb ? (node.sortSpaceUsedKb / 1024).toFixed(1) : 'N/A';
        bottlenecks.push({
          rule_id: 'EXPLAIN-SORT-001',
          severity: 'WARNING',
          node_type: node.nodeType,
          target_relation: node.relation,
          execution_time_ms: nodeTime,
          finding: `External Disk Sort (${node.sortMethod || 'Disk Sort'}, space=${spaceMb}MB) on key (${node.sortKey || 'ORDER BY'}).`,
          recommendation:
            dialect === 'postgresql'
              ? `Include the sort column (${node.sortKey || 'sort_col'}) in the composite B-Tree index following ESR rule, or increase session 'work_mem'.`
              : `Add the ORDER BY column to the composite index to eliminate 'Using filesort', or increase 'sort_buffer_size'.`
        });
      }
    }

    // 3. EXPLAIN-JOIN-001: High-loop Nested Loop or Multi-batch Hash Join
    if (/Nested Loop/i.test(node.nodeType) && node.loops >= 500) {
      bottlenecks.push({
        rule_id: 'EXPLAIN-JOIN-001',
        severity: 'WARNING',
        node_type: node.nodeType,
        target_relation: node.relation,
        execution_time_ms: nodeTime,
        finding: `Nested Loop Join executed ${node.loops.toLocaleString()} inner loop iterations.`,
        recommendation:
          'Ensure the inner join table has an index on the join key, or run ANALYZE so the planner can switch to a Hash Join / Merge Join.'
      });
    } else if (/Hash/i.test(node.nodeType) && (node.hashBatches ?? 1) > 1) {
      bottlenecks.push({
        rule_id: 'EXPLAIN-JOIN-001',
        severity: 'WARNING',
        node_type: node.nodeType,
        target_relation: node.relation,
        execution_time_ms: nodeTime,
        finding: `Hash Join spilled to disk across ${node.hashBatches} batches.`,
        recommendation: "Increase 'work_mem' so the in-memory hash table fits in a single batch (Batches: 1)."
      });
    }

    // 4. EXPLAIN-HEAP-001: High Heap Fetches on Index Only Scan
    if (/Index Only Scan/i.test(node.nodeType) && (node.heapFetches ?? 0) > 1000) {
      bottlenecks.push({
        rule_id: 'EXPLAIN-HEAP-001',
        severity: 'WARNING',
        node_type: node.nodeType,
        target_relation: node.relation,
        execution_time_ms: nodeTime,
        finding: `Index Only Scan on '${node.relation || 'table'}' performed ${node.heapFetches?.toLocaleString()} Heap Fetches.`,
        recommendation: `Run 'VACUUM ANALYZE ${node.relation || ''};' to refresh the PostgreSQL Visibility Map and lower 'autovacuum_vacuum_scale_factor'.`,
        suggested_ddl_fix: `VACUUM ANALYZE ${node.relation || 'target_table'};`
      });
    }

    // 5. EXPLAIN-EST-001: Severe Row Estimation Mismatch (>=10x off)
    if (node.actualRows !== undefined && node.planRows > 0) {
      const actual = Math.max(1, node.actualRows);
      const planned = Math.max(1, node.planRows);
      const ratio = Math.max(actual / planned, planned / actual);
      if (ratio >= 10 && Math.abs(actual - planned) >= 500) {
        bottlenecks.push({
          rule_id: 'EXPLAIN-EST-001',
          severity: 'WARNING',
          node_type: node.nodeType,
          target_relation: node.relation,
          execution_time_ms: nodeTime,
          rows_emitted: node.actualRows,
          finding: `Planner row estimate (${node.planRows.toLocaleString()}) differs from actual rows (${node.actualRows.toLocaleString()}) by ${ratio.toFixed(1)}x.`,
          recommendation:
            dialect === 'postgresql'
              ? `Run 'ANALYZE ${node.relation || ''};' or create multivariate extended statistics ('CREATE STATISTICS') if filter columns are correlated.`
              : `Run 'ANALYZE TABLE ${node.relation || 'tbl'};' to update InnoDB index cardinality histograms.`
        });
      }
    }
  }

  // Build Mermaid Flowchart
  const mermaidLines: string[] = ['flowchart TD'];
  if (allNodes.length === 0) {
    mermaidLines.push('  N1["Unparsed Plan Output"]');
  } else {
    for (const node of allNodes) {
      const relPart = node.relation ? ` on ${node.relation}` : '';
      const timePart = node.actualTotalTimeMs !== undefined ? ` (${node.actualTotalTimeMs.toFixed(1)}ms)` : '';
      const extraPart = node.rowsRemovedByFilter
        ? ` - ${node.rowsRemovedByFilter.toLocaleString()} rows filtered`
        : node.sortMethod
          ? ` - ${node.sortMethod}`
          : '';
      const safeLabel = `${node.nodeType}${relPart}${timePart}${extraPart}`.replace(/"/g, "'");
      mermaidLines.push(`  ${node.id}["${safeLabel}"]`);
      for (const child of node.children) {
        mermaidLines.push(`  ${node.id} --> ${child.id}`);
      }
    }
  }

  const hasCritical = bottlenecks.some((b) => b.severity === 'CRITICAL');
  const healthStatus = hasCritical
    ? 'CRITICAL_BOTTLENECK'
    : bottlenecks.length > 0
      ? 'NEEDS_TUNING'
      : 'HEALTHY';

  return {
    summary: {
      dialect,
      total_execution_time_ms: Number(totalExecutionTimeMs.toFixed(2)),
      planning_time_ms: Number(planningTimeMs.toFixed(2)),
      slowest_node: slowestNodeLabel,
      health_status: healthStatus
    },
    bottlenecks,
    mermaid_plan_diagram: mermaidLines.join('\n')
  };
}
