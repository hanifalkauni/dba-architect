import fs from 'node:fs';
import path from 'node:path';
import { ConfidenceLevel, Dialect, ExtractedTablePredicate } from '../types/index.js';
import { estimateColumnCardinality } from '../constants/catalog.js';
import { parseDdlToSchemaState } from '../parsers/ddl-parser.js';
import { analyzeSqlQueryAst } from '../parsers/query-parser.js';
import { readMigrationSources, walkProjectFiles } from '../utils/file-walker.js';

export interface CodeAntipattern {
  rule_id: string;
  pattern_type: 'POTENTIAL_N_PLUS_ONE';
  severity: 'CRITICAL';
  file_path: string;
  line_number: number;
  code_snippet_masked: string;
  recommendation: string;
}

export interface CanonicalWorkloadItem {
  fingerprint_id: string;
  pattern_summary: string;
  occurrences_count: number;
  locations: string[];
  equality_columns: string[];
  sort_columns: Array<{ column: string; direction: 'ASC' | 'DESC' }>;
  range_columns: string[];
}

export interface ConsolidatedIndexPlanItem {
  index_name: string;
  confidence: ConfidenceLevel;
  ddl: string;
  covers_fingerprints: string[];
  consolidation_note: string;
}

export interface HolisticTableStrategy {
  table_name: string;
  total_query_occurrences: number;
  canonical_workload: CanonicalWorkloadItem[];
  consolidated_index_plan: ConsolidatedIndexPlanItem[];
  redundant_existing_indexes: Array<{
    rule_id: string;
    existing_index_name: string;
    columns: string[];
    superseded_by: string;
    drop_ddl: string;
  }>;
  write_overhead_warnings?: Array<{
    rule_id: string;
    total_indexes: number;
    warning: string;
    recommendation: string;
  }>;
}

export interface ScanProjectQueriesOutput {
  scan_metadata: {
    files_scanned: number;
    files_skipped_large_or_binary: number;
    queries_extracted: number;
    unique_canonical_patterns: number;
    tables_identified: string[];
  };
  code_antipatterns: CodeAntipattern[];
  holistic_table_strategies: HolisticTableStrategy[];
}

function toSnakeCasePlural(modelName: string, knownTables: Set<string>): string {
  const clean = modelName.trim().replace(/^["`']|["`']$/g, '');
  if (knownTables.has(clean.toLowerCase())) return clean.toLowerCase();

  const snake = clean
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();

  if (knownTables.has(snake)) return snake;
  const pluralS = snake.endsWith('y')
    ? `${snake.slice(0, -1)}ies`
    : snake.endsWith('s')
      ? snake
      : `${snake}s`;

  if (knownTables.has(pluralS)) return pluralS;
  return pluralS;
}

function maskCodeSnippetLiterals(snippet: string): string {
  return snippet
    .replace(/'(?:''|[^'])*'/g, "'?'")
    .replace(/"(?:\\"|[^"])*"/g, '"?"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function getLineNumberFromIndex(content: string, charIndex: number): number {
  let line = 1;
  for (let i = 0; i < charIndex && i < content.length; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

export async function scanProjectQueries(input: {
  project_root_path: string;
  dialect: Dialect;
  target_languages?: Array<'go' | 'php' | 'typescript' | 'javascript' | 'python' | 'sql'>;
  exclude_globs?: string[];
  focus_tables?: string[];
  existing_schema_ddl?: string;
  migration_files_dir?: string;
  max_files_to_scan?: number;
}): Promise<ScanProjectQueriesOutput> {
  const dialect = input.dialect;
  const langToExts: Record<string, string[]> = {
    go: ['go'],
    php: ['php'],
    typescript: ['ts', 'tsx'],
    javascript: ['js', 'jsx', 'mjs'],
    python: ['py'],
    sql: ['sql']
  };

  const selectedLangs = input.target_languages ?? ['go', 'php', 'typescript', 'javascript', 'python', 'sql'];
  const extensions = Array.from(new Set(selectedLangs.flatMap((l) => langToExts[l] ?? [])));

  // Reconstruct existing schema if provided
  let combinedDdl = input.existing_schema_ddl ?? '';
  if (input.migration_files_dir) {
    const loaded = readMigrationSources({ migration_dir: input.migration_files_dir });
    combinedDdl += '\n' + loaded.combinedSql;
  }
  const existingSchema = parseDdlToSchemaState(combinedDdl, dialect);
  const knownTables = new Set<string>(Array.from(existingSchema.tables.keys()).map((t) => t.toLowerCase()));

  const walked = await walkProjectFiles({
    rootPath: input.project_root_path,
    extensions,
    excludeGlobs: input.exclude_globs,
    maxFiles: input.max_files_to_scan ?? 5000
  });

  // First pass: collect explicit ORM model -> table mappings across files
  const explicitModelMap = new Map<string, string>();
  const fileContents = new Map<string, string>();

  for (const filePath of walked.files) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      fileContents.set(filePath, content);

      // Laravel: class Order extends Model { protected $table = 'ms_orders'; }
      const phpClassMatch = content.match(/class\s+([A-Za-z0-9_]+)\s+extends\s+Model[\s\S]*?\$table\s*=\s*['"]([^'"]+)['"]/);
      if (phpClassMatch) {
        explicitModelMap.set(phpClassMatch[1].toLowerCase(), phpClassMatch[2]);
      }

      // GORM: func (Order) TableName() string { return "ms_orders" }
      for (const gormMap of content.matchAll(
        /func\s*\(\s*(?:[a-zA-Z0-9_]+\s+)?\*?([A-Za-z0-9_]+)\s*\)\s*TableName\s*\(\s*\)\s*string\s*\{\s*return\s*["`']([^"`']+)["`']/g
      )) {
        explicitModelMap.set(gormMap[1].toLowerCase(), gormMap[2]);
      }

      // SQLAlchemy: class User(Base): __tablename__ = 'users'
      for (const pyMap of content.matchAll(/class\s+([A-Za-z0-9_]+)\s*\([^)]*\)[\s\S]{0,200}?__tablename__\s*=\s*['"]([^'"]+)['"]/g)) {
        explicitModelMap.set(pyMap[1].toLowerCase(), pyMap[2]);
      }
    } catch {
      // Ignore unreadable files
    }
  }

  const resolveModelToTable = (modelOrTable: string): string => {
    const clean = modelOrTable.trim().replace(/^["`']|["`']$/g, '');
    const explicit = explicitModelMap.get(clean.toLowerCase());
    if (explicit) return explicit;
    return toSnakeCasePlural(clean, knownTables);
  };

  interface ExtractedWorkloadRecord {
    table: string;
    equality_columns: string[];
    sort_columns: Array<{ column: string; direction: 'ASC' | 'DESC' }>;
    range_columns: string[];
    location: string;
  }

  const extractedWorkloads: ExtractedWorkloadRecord[] = [];
  const codeAntipatterns: CodeAntipattern[] = [];

  for (const [filePath, content] of fileContents.entries()) {
    const relPath = path.relative(input.project_root_path, filePath).replace(/\\/g, '/');

    // A. Detect N+1 Queries inside Loops (for, foreach, while, .map)
    const loopRegex =
      /\b(for\s*\([^)]*\)\s*\{|for\s+[^{]+\{|foreach\s*\([^)]*\)\s*\{|while\s*\([^)]*\)\s*\{|\.[a-zA-Z0-9_]*map\s*\([^)]*=>\s*\{)/g;
    for (const loopMatch of content.matchAll(loopRegex)) {
      const startIdx = loopMatch.index ?? 0;
      const bodyWindow = content.slice(startIdx, startIdx + 450);
      const dbCallInLoop =
        /\b(repo\.[A-Za-z0-9_]+|db\.(?:Query|Exec|Get|Select|Where|First|Find)|DB::(?:table|select)|[A-Z][a-zA-Z0-9_]*::(?:where|find|first)|prisma\.[a-zA-Z0-9_]+\.(?:findUnique|findFirst|findMany|update)|session\.query|\.objects\.(?:filter|get))\b/.test(
          bodyWindow
        );
      if (dbCallInLoop && !/\b(whereIn|WHERE\s+[a-zA-Z0-9_.]+\s+IN|Preload|with\(|include\s*:)\b/i.test(bodyWindow)) {
        const lineNo = getLineNumberFromIndex(content, startIdx);
        const firstLines = bodyWindow.split(/\r?\n/).slice(0, 3).join(' ');
        codeAntipatterns.push({
          rule_id: 'CODE-NPLUS1-001',
          pattern_type: 'POTENTIAL_N_PLUS_ONE',
          severity: 'CRITICAL',
          file_path: relPath,
          line_number: lineNo,
          code_snippet_masked: maskCodeSnippetLiterals(firstLines),
          recommendation:
            "Extract target IDs into a collection/slice before the loop and execute a single batched query using 'WHERE id IN (?)' or ORM eager loading ('with()', 'Preload()', 'include')."
        });
      }
    }

    // B. Extract Raw SQL strings containing SELECT / UPDATE / DELETE
    for (const rawSqlMatch of content.matchAll(
      /(["'`])((?:SELECT|UPDATE|DELETE)\s+[\s\S]{12,500}?\b(?:FROM|SET|WHERE)\b[\s\S]{0,400}?)\1/gi
    )) {
      const sqlCandidate = rawSqlMatch[2];
      const lineNo = getLineNumberFromIndex(content, rawSqlMatch.index ?? 0);
      const parsed = analyzeSqlQueryAst(sqlCandidate, dialect);
      if (parsed.status === 'ANALYZED') {
        for (const pred of parsed.extracted_predicates) {
          extractedWorkloads.push({
            table: pred.table,
            equality_columns: Array.from(new Set([...pred.equality_columns, ...pred.join_columns])),
            sort_columns: pred.sort_columns,
            range_columns: pred.range_columns,
            location: `${relPath}:${lineNo}`
          });
        }
      }
    }

    // C. Extract Laravel / PHP Query Builder & Eloquent chains
    for (const phpMatch of content.matchAll(
      /(?:DB::table\(\s*['"]([^'"]+)['"]\s*\)|([A-Z][a-zA-Z0-9_]+)::(?:query\(\)\s*->\s*)?(?=where|orderBy))([\s\S]{1,350}?);/g
    )) {
      const rawTableOrModel = phpMatch[1] || phpMatch[2];
      const chain = phpMatch[0];
      const lineNo = getLineNumberFromIndex(content, phpMatch.index ?? 0);
      const table = phpMatch[1] ? phpMatch[1] : resolveModelToTable(rawTableOrModel);

      const eqCols: string[] = [];
      const rangeCols: string[] = [];
      const sortCols: Array<{ column: string; direction: 'ASC' | 'DESC' }> = [];

      for (const w of chain.matchAll(/->where\(\s*['"]([a-zA-Z0-9_.]+)['"]\s*(?:,\s*['"]([=<>!]+)['"])?/g)) {
        const col = w[1].split('.').pop() || w[1];
        const op = w[2] || '=';
        if (op === '=') {
          if (!eqCols.includes(col)) eqCols.push(col);
        } else if (['>', '<', '>=', '<='].includes(op)) {
          if (!rangeCols.includes(col)) rangeCols.push(col);
        }
      }
      for (const win of chain.matchAll(/->(?:whereIn|whereNull)\(\s*['"]([a-zA-Z0-9_.]+)['"]/g)) {
        const col = win[1].split('.').pop() || win[1];
        if (!eqCols.includes(col)) eqCols.push(col);
      }
      for (const wb of chain.matchAll(/->whereBetween\(\s*['"]([a-zA-Z0-9_.]+)['"]/g)) {
        const col = wb[1].split('.').pop() || wb[1];
        if (!rangeCols.includes(col)) rangeCols.push(col);
      }
      for (const ob of chain.matchAll(/->orderBy\(\s*['"]([a-zA-Z0-9_.]+)['"](?:\s*,\s*['"](asc|desc)['"])?/gi)) {
        const col = ob[1].split('.').pop() || ob[1];
        const dir = ob[2]?.toUpperCase() === 'DESC' ? ('DESC' as const) : ('ASC' as const);
        sortCols.push({ column: col, direction: dir });
      }

      if (eqCols.length > 0 || rangeCols.length > 0 || sortCols.length > 0) {
        extractedWorkloads.push({
          table,
          equality_columns: eqCols,
          sort_columns: sortCols,
          range_columns: rangeCols,
          location: `${relPath}:${lineNo}`
        });
      }
    }

    // D. Extract Go GORM chains (.Table("orders") / .Model(&Order{}).Where(...).Order(...))
    for (const gormMatch of content.matchAll(
      /\.(?:Table\(\s*["`']([^"`']+)["`']\s*\)|Model\(\s*&?([A-Za-z0-9_]+)\{\}\s*\))([\s\S]{1,350}?)\.(?:Find|First|Take|Scan|Count|Pluck)\b/g
    )) {
      const table = gormMatch[1] ? gormMatch[1] : resolveModelToTable(gormMatch[2]);
      const chain = gormMatch[3];
      const lineNo = getLineNumberFromIndex(content, gormMatch.index ?? 0);

      const eqCols: string[] = [];
      const rangeCols: string[] = [];
      const sortCols: Array<{ column: string; direction: 'ASC' | 'DESC' }> = [];

      for (const w of chain.matchAll(/\.Where\(\s*["`']([^"`']+)["`']/g)) {
        const cond = w[1];
        for (const eq of cond.matchAll(/\b([a-zA-Z0-9_]+)\s*(?:=|\bIN\b)/gi)) {
          if (!/^(AND|OR)$/i.test(eq[1]) && !eqCols.includes(eq[1])) eqCols.push(eq[1]);
        }
        for (const rng of cond.matchAll(/\b([a-zA-Z0-9_]+)\s*(?:>=|<=|>|<)/g)) {
          if (!rangeCols.includes(rng[1])) rangeCols.push(rng[1]);
        }
      }
      for (const o of chain.matchAll(/\.Order\(\s*["`']([a-zA-Z0-9_]+)(?:\s+(asc|desc))?["`']/gi)) {
        sortCols.push({
          column: o[1],
          direction: o[2]?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC'
        });
      }

      if (eqCols.length > 0 || rangeCols.length > 0 || sortCols.length > 0) {
        extractedWorkloads.push({
          table,
          equality_columns: eqCols,
          sort_columns: sortCols,
          range_columns: rangeCols,
          location: `${relPath}:${lineNo}`
        });
      }
    }

    // E. Extract Prisma queries: prisma.order.findMany({ where: { ... }, orderBy: { ... } })
    for (const prismaMatch of content.matchAll(
      /\bprisma\.([a-zA-Z0-9_]+)\.(?:findMany|findFirst|findUnique|count|updateMany|deleteMany)\(\s*\{([\s\S]{1,400}?)\}\s*\)/g
    )) {
      const model = prismaMatch[1];
      const body = prismaMatch[2];
      const table = resolveModelToTable(model);
      const lineNo = getLineNumberFromIndex(content, prismaMatch.index ?? 0);

      const eqCols: string[] = [];
      const rangeCols: string[] = [];
      const sortCols: Array<{ column: string; direction: 'ASC' | 'DESC' }> = [];

      const whereBlock = body.match(/where\s*:\s*\{([\s\S]+?)\}/);
      if (whereBlock) {
        const wb = whereBlock[1];
        for (const fieldMatch of wb.matchAll(/\b([a-zA-Z0-9_]+)\s*:\s*(\{[^}]*\}|[^{,\n]+)/g)) {
          const col = fieldMatch[1];
          const val = fieldMatch[2];
          if (/^(AND|OR|NOT)$/i.test(col)) continue;
          if (/\b(gt|gte|lt|lte)\s*:/.test(val)) {
            if (!rangeCols.includes(col)) rangeCols.push(col);
          } else {
            if (!eqCols.includes(col)) eqCols.push(col);
          }
        }
      }

      const orderBlock = body.match(/orderBy\s*:\s*\{([^}]+)\}/);
      if (orderBlock) {
        for (const om of orderBlock[1].matchAll(/\b([a-zA-Z0-9_]+)\s*:\s*['"](asc|desc)['"]/gi)) {
          sortCols.push({
            column: om[1],
            direction: om[2].toUpperCase() === 'DESC' ? 'DESC' : 'ASC'
          });
        }
      }

      if (eqCols.length > 0 || rangeCols.length > 0 || sortCols.length > 0) {
        extractedWorkloads.push({
          table,
          equality_columns: eqCols,
          sort_columns: sortCols,
          range_columns: rangeCols,
          location: `${relPath}:${lineNo}`
        });
      }
    }

    // F. Extract Python Django ORM & SQLAlchemy queries: Order.objects.filter(...).order_by(...) or session.query(Order).filter(...)
    for (const pyMatch of content.matchAll(
      /(?:([A-Z][a-zA-Z0-9_]*)\.objects|session\.query\(\s*([A-Z][a-zA-Z0-9_]*)\s*\))([\s\S]{1,350}?)(?:\n|;|$)/g
    )) {
      const model = pyMatch[1] || pyMatch[2];
      const chain = pyMatch[3];
      if (!/\.(?:filter|filter_by|order_by)\s*\(/.test(chain)) continue;
      const table = resolveModelToTable(model);
      const lineNo = getLineNumberFromIndex(content, pyMatch.index ?? 0);

      const eqCols: string[] = [];
      const rangeCols: string[] = [];
      const sortCols: Array<{ column: string; direction: 'ASC' | 'DESC' }> = [];

      for (const fm of chain.matchAll(/\.(?:filter|filter_by)\(([^)]+)\)/g)) {
        const args = fm[1];
        // Django kwargs: user_id=uid, created_at__gte=dt OR SQLAlchemy Model.user_id == uid
        for (const kw of args.matchAll(/(?:[A-Za-z0-9_]+\.)?([a-zA-Z0-9_]+)\s*(==|=|>=|<=|>|<)/g)) {
          const rawCol = kw[1];
          const op = kw[2];
          if (/__(?:gt|gte|lt|lte)$/i.test(rawCol)) {
            const baseCol = rawCol.replace(/__(?:gt|gte|lt|lte)$/i, '');
            if (!rangeCols.includes(baseCol)) rangeCols.push(baseCol);
          } else if (['>=', '<=', '>', '<'].includes(op)) {
            if (!rangeCols.includes(rawCol)) rangeCols.push(rawCol);
          } else {
            const baseCol = rawCol.replace(/__(?:in|exact|isnull)$/i, '');
            if (!eqCols.includes(baseCol)) eqCols.push(baseCol);
          }
        }
      }

      for (const ob of chain.matchAll(/\.order_by\(\s*['"](-?[a-zA-Z0-9_]+)['"]\s*\)/g)) {
        const rawOrder = ob[1];
        const isDesc = rawOrder.startsWith('-');
        sortCols.push({
          column: isDesc ? rawOrder.slice(1) : rawOrder,
          direction: isDesc ? 'DESC' : 'ASC'
        });
      }

      if (eqCols.length > 0 || rangeCols.length > 0 || sortCols.length > 0) {
        extractedWorkloads.push({
          table,
          equality_columns: eqCols,
          sort_columns: sortCols,
          range_columns: rangeCols,
          location: `${relPath}:${lineNo}`
        });
      }
    }

    // G. Extract Knex / Drizzle queries: knex('orders').where(...) or db.select().from(orders).where(...)
    for (const knexMatch of content.matchAll(
      /(?:\bknex\(\s*['"]([^'"]+)['"]\s*\)|\.from\(\s*['"]?([a-zA-Z0-9_]+)['"]?\s*\))([\s\S]{1,300}?)(?:;|\n\n)/g
    )) {
      const rawTarget = knexMatch[1] || knexMatch[2];
      const chain = knexMatch[3];
      if (!/\.(?:where|orderBy)\s*\(/.test(chain)) continue;
      const table = resolveModelToTable(rawTarget);
      const lineNo = getLineNumberFromIndex(content, knexMatch.index ?? 0);

      const eqCols: string[] = [];
      const rangeCols: string[] = [];
      const sortCols: Array<{ column: string; direction: 'ASC' | 'DESC' }> = [];

      for (const w of chain.matchAll(/\.where\(\s*['"]([a-zA-Z0-9_.]+)['"](?:\s*,\s*['"]([=<>!]+)['"])?/g)) {
        const col = w[1].split('.').pop() || w[1];
        const op = w[2] || '=';
        if (['>', '<', '>=', '<='].includes(op)) {
          if (!rangeCols.includes(col)) rangeCols.push(col);
        } else if (!eqCols.includes(col)) {
          eqCols.push(col);
        }
      }
      for (const ob of chain.matchAll(/\.orderBy\(\s*['"]([a-zA-Z0-9_.]+)['"](?:\s*,\s*['"](asc|desc)['"])?/gi)) {
        const col = ob[1].split('.').pop() || ob[1];
        sortCols.push({
          column: col,
          direction: ob[2]?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC'
        });
      }

      if (eqCols.length > 0 || rangeCols.length > 0 || sortCols.length > 0) {
        extractedWorkloads.push({
          table,
          equality_columns: eqCols,
          sort_columns: sortCols,
          range_columns: rangeCols,
          location: `${relPath}:${lineNo}`
        });
      }
    }
  }

  // Filter by focus_tables if requested
  const focusSet =
    input.focus_tables && input.focus_tables.length > 0
      ? new Set(input.focus_tables.map((t) => t.toLowerCase()))
      : null;

  const filteredWorkloads = focusSet
    ? extractedWorkloads.filter((w) => focusSet.has(w.table.toLowerCase()))
    : extractedWorkloads;

  // Group workloads by table and fingerprint
  const byTable = new Map<string, ExtractedWorkloadRecord[]>();
  for (const w of filteredWorkloads) {
    const list = byTable.get(w.table) ?? [];
    list.push(w);
    byTable.set(w.table, list);
  }

  let totalUniqueFingerprints = 0;
  const holisticStrategies: HolisticTableStrategy[] = [];

  for (const [tableName, records] of byTable.entries()) {
    const fingerprintMap = new Map<string, CanonicalWorkloadItem>();

    for (const rec of records) {
      // Sort equality columns by cardinality heuristic for canonical fingerprinting
      const sortedEq = [...rec.equality_columns].sort(
        (a, b) =>
          estimateColumnCardinality(tableName, b).score - estimateColumnCardinality(tableName, a).score
      );
      const sortedRange = [...rec.range_columns];
      const sortParts = rec.sort_columns.map((s) => `${s.column} ${s.direction}`);

      const filterTokens = [
        ...sortedEq.map((c) => `${c} = ?`),
        ...sortedRange.map((c) => `${c} < ?`)
      ];
      const filterStr = filterTokens.length > 0 ? `FILTER(${filterTokens.join(', ')})` : '';
      const sortStr = sortParts.length > 0 ? `SORT(${sortParts.join(', ')})` : '';
      const patternSummary = [filterStr, sortStr].filter(Boolean).join(' ');
      if (!patternSummary) continue;

      const existingFp = fingerprintMap.get(patternSummary);
      if (existingFp) {
        existingFp.occurrences_count++;
        if (!existingFp.locations.includes(rec.location)) {
          existingFp.locations.push(rec.location);
        }
      } else {
        const fpId = `fp_${tableName}_${String(fingerprintMap.size + 1).padStart(2, '0')}`;
        fingerprintMap.set(patternSummary, {
          fingerprint_id: fpId,
          pattern_summary: patternSummary,
          occurrences_count: 1,
          locations: [rec.location],
          equality_columns: sortedEq,
          sort_columns: rec.sort_columns,
          range_columns: sortedRange
        });
      }
    }

    const canonicalWorkload = Array.from(fingerprintMap.values()).sort(
      (a, b) => b.occurrences_count - a.occurrences_count
    );
    totalUniqueFingerprints += canonicalWorkload.length;

    // Build candidate ESR index key sequence for each fingerprint
    interface IndexCandidate {
      fpId: string;
      cols: Array<{ name: string; dir: 'ASC' | 'DESC' }>;
    }
    const candidates: IndexCandidate[] = canonicalWorkload.map((fp) => {
      const cols: Array<{ name: string; dir: 'ASC' | 'DESC' }> = [];
      for (const eq of fp.equality_columns) {
        cols.push({ name: eq, dir: 'ASC' });
      }
      for (const sc of fp.sort_columns) {
        if (!cols.some((c) => c.name === sc.column)) {
          cols.push({ name: sc.column, dir: sc.direction });
        }
      }
      for (const rc of fp.range_columns) {
        if (!cols.some((c) => c.name === rc)) {
          cols.push({ name: rc, dir: 'ASC' });
        }
      }
      return { fpId: fp.fingerprint_id, cols };
    });

    // Consolidate indexes via Left-Prefix Merging (wider index covers shorter prefix candidates)
    const sortedCandidates = [...candidates].sort((a, b) => b.cols.length - a.cols.length);
    const mergedGroups: Array<{
      cols: Array<{ name: string; dir: 'ASC' | 'DESC' }>;
      coveredFpIds: string[];
    }> = [];

    for (const cand of sortedCandidates) {
      if (cand.cols.length === 0) continue;
      const matchingGroup = mergedGroups.find((grp) => {
        if (grp.cols.length < cand.cols.length) return false;
        return cand.cols.every((c, idx) => grp.cols[idx].name.toLowerCase() === c.name.toLowerCase());
      });

      if (matchingGroup) {
        matchingGroup.coveredFpIds.push(cand.fpId);
      } else {
        mergedGroups.push({
          cols: cand.cols,
          coveredFpIds: [cand.fpId]
        });
      }
    }

    const consolidatedPlan: ConsolidatedIndexPlanItem[] = mergedGroups.map((grp) => {
      const colSlug = grp.cols
        .map((c) => c.name.replace(/[^a-zA-Z0-9]/g, '').slice(0, 10))
        .join('_')
        .toLowerCase();
      const idxName = `idx_${tableName}_${colSlug}`;
      const colExprs = grp.cols.map((c) => (c.dir === 'DESC' ? `${c.name} DESC` : c.name));
      const ddl =
        dialect === 'postgresql'
          ? `CREATE INDEX CONCURRENTLY ${idxName} ON ${tableName} (${colExprs.join(', ')});`
          : `CREATE INDEX ${idxName} ON ${tableName} (${colExprs.join(', ')}) ALGORITHM=INPLACE, LOCK=NONE;`;

      const note =
        grp.coveredFpIds.length > 1
          ? `Serves '${grp.coveredFpIds[0]}' directly via ESR rule, and serves (${grp.coveredFpIds.slice(1).join(', ')}) via left-most B-Tree prefix (${grp.cols[0].name}), eliminating redundant single-column indexes.`
          : `Dedicated composite B-Tree index serving workload pattern '${grp.coveredFpIds[0]}'.`;

      return {
        index_name: idxName,
        confidence: 'HIGH',
        ddl,
        covers_fingerprints: grp.coveredFpIds,
        consolidation_note: note
      };
    });

    // Check existing indexes on this table for left-prefix redundancy against consolidatedPlan
    const redundantExisting: HolisticTableStrategy['redundant_existing_indexes'] = [];
  const writeOverheadWarnings: HolisticTableStrategy['write_overhead_warnings'] = [];
    for (const exIdx of existingSchema.indexes.filter(
      (i) => i.table.toLowerCase() === tableName.toLowerCase() && !i.unique
    )) {
      const exCols = exIdx.columns.map((c) => c.name.toLowerCase());
      const coveringNew = mergedGroups.find(
        (grp) =>
          grp.cols.length > exCols.length &&
          exCols.every((ec, idx) => grp.cols[idx].name.toLowerCase() === ec)
      );
      if (coveringNew) {
        const supName = `idx_${tableName}_${coveringNew.cols
          .map((c) => c.name.replace(/[^a-zA-Z0-9]/g, '').slice(0, 10))
          .join('_')
          .toLowerCase()}`;
        redundantExisting.push({
          rule_id: 'INDEX-REDUNDANT-001',
          existing_index_name: exIdx.name,
          columns: exIdx.columns.map((c) => c.name),
          superseded_by: supName,
          drop_ddl:
            dialect === 'postgresql'
              ? `DROP INDEX CONCURRENTLY IF EXISTS ${exIdx.name};`
              : `DROP INDEX ${exIdx.name} ON ${tableName} ALGORITHM=INPLACE, LOCK=NONE;`
        });
      }
    }

    const totalActiveIndexes =
      existingSchema.indexes.filter((i) => i.table.toLowerCase() === tableName.toLowerCase()).length -
      redundantExisting.length +
      consolidatedPlan.length;
    if (totalActiveIndexes > 5) {
      writeOverheadWarnings.push({
        rule_id: 'INDEX-OVERHEAD-001',
        total_indexes: totalActiveIndexes,
        warning: `Table '${tableName}' has ${totalActiveIndexes} active indexes after consolidation (exceeds safe OLTP threshold of 5).`,
        recommendation:
          'Review low-frequency workload fingerprints and drop rarely used secondary indexes to reduce write amplification.'
      });
    }

    holisticStrategies.push({
      table_name: tableName,
      total_query_occurrences: records.length,
      canonical_workload: canonicalWorkload,
      consolidated_index_plan: consolidatedPlan,
      redundant_existing_indexes: redundantExisting,
      ...(writeOverheadWarnings.length > 0 ? { write_overhead_warnings: writeOverheadWarnings } : {})
    });
  }

  return {
    scan_metadata: {
      files_scanned: walked.files.length,
      files_skipped_large_or_binary: walked.skippedLargeOrBinary,
      queries_extracted: filteredWorkloads.length,
      unique_canonical_patterns: totalUniqueFingerprints,
      tables_identified: Array.from(byTable.keys())
    },
    code_antipatterns: codeAntipatterns,
    holistic_table_strategies: holisticStrategies
  };
}
