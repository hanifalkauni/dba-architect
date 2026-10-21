import {
  Dialect,
  ParsedColumn,
  ParsedForeignKey,
  ParsedIndex,
  ParsedTable,
  SchemaState
} from '../types/index.js';

function stripIdentifierQuotes(ident: string): string {
  return ident
    .trim()
    .replace(/^(?:["`[]?[a-zA-Z0-9_]+["`\]]?\.)+/, '')
    .replace(/^["`[]|["`\]]$/g, '');
}

export function splitSqlStatements(sql: string): string[] {
  const cleaned = sql
    .replace(/--[^\r\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const statements: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let parenDepth = 0;

  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    const prev = i > 0 ? cleaned[i - 1] : '';
    if (ch === "'" && !inDouble && prev !== '\\') {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle && prev !== '\\') {
      inDouble = !inDouble;
    } else if (!inSingle && !inDouble) {
      if (ch === '(') parenDepth++;
      else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
      else if (ch === ';' && parenDepth === 0) {
        if (current.trim()) statements.push(current.trim());
        current = '';
        continue;
      }
    }
    current += ch;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

function splitTopLevelCommas(body: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let inSingle = false;

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "'" && body[i - 1] !== '\\') {
      inSingle = !inSingle;
    } else if (!inSingle) {
      if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      else if (ch === ',' && depth === 0) {
        if (current.trim()) parts.push(current.trim());
        current = '';
        continue;
      }
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseDataTypeDetails(rawType: string): {
  baseType: string;
  length?: number;
  precision?: number;
  scale?: number;
  unsigned?: boolean;
} {
  const upper = rawType.trim().toUpperCase();
  const unsigned = /\bUNSIGNED\b/.test(upper);
  const withoutUnsigned = upper.replace(/\bUNSIGNED\b/g, '').trim();

  const match = withoutUnsigned.match(/^([A-Z0-9_ ]+?)\s*(?:\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\))?$/);
  if (!match) {
    return { baseType: withoutUnsigned, unsigned };
  }
  const baseType = match[1].replace(/\s+/g, ' ').trim();
  const firstNum = match[2] !== undefined ? parseInt(match[2], 10) : undefined;
  const secondNum = match[3] !== undefined ? parseInt(match[3], 10) : undefined;

  if (secondNum !== undefined) {
    return { baseType, precision: firstNum, scale: secondNum, unsigned };
  }
  return { baseType, length: firstNum, precision: firstNum, unsigned };
}

export function parseDdlToSchemaState(sql: string, dialect: Dialect, initialWarnings: string[] = []): SchemaState {
  const tables = new Map<string, ParsedTable>();
  const indexes: ParsedIndex[] = [];
  const parseWarnings = [...initialWarnings];
  const statements = splitSqlStatements(sql);

  for (const stmt of statements) {
    const normalizedStmt = stmt.replace(/\s+/g, ' ').trim();

    // 1. CREATE TABLE
    const createTableMatch = stmt.match(
      /CREATE\s+(?:UNLOGGED\s+|TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)\s*\(([\s\S]+)\)\s*([\s\S]*)$/i
    );
    if (createTableMatch && !/\bPARTITION\s+OF\b/i.test(stmt)) {
      const tableName = stripIdentifierQuotes(createTableMatch[1]);
      const body = createTableMatch[2];
      const tail = createTableMatch[3] || '';

      const columns: ParsedColumn[] = [];
      const primaryKeyColumns: string[] = [];
      const foreignKeys: ParsedForeignKey[] = [];
      const tableIndexes: ParsedIndex[] = [];

      const items = splitTopLevelCommas(body);
      for (const item of items) {
        const trimmed = item.trim();
        if (!trimmed) continue;

        // Table-level PRIMARY KEY
        const pkConstraintMatch = trimmed.match(
          /^(?:CONSTRAINT\s+[^\s]+\s+)?PRIMARY\s+KEY\s*\(([^)]+)\)/i
        );
        if (pkConstraintMatch) {
          const pkCols = pkConstraintMatch[1].split(',').map((c) => stripIdentifierQuotes(c));
          for (const pkc of pkCols) {
            if (!primaryKeyColumns.includes(pkc)) primaryKeyColumns.push(pkc);
          }
          continue;
        }

        // Table-level FOREIGN KEY
        const fkConstraintMatch = trimmed.match(
          /^(?:CONSTRAINT\s+([^\s]+)\s+)?FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+([^\s(]+)\s*\(([^)]+)\)(.*)$/i
        );
        if (fkConstraintMatch) {
          const constraintName = fkConstraintMatch[1] ? stripIdentifierQuotes(fkConstraintMatch[1]) : undefined;
          const cols = fkConstraintMatch[2].split(',').map((c) => stripIdentifierQuotes(c));
          const refTable = stripIdentifierQuotes(fkConstraintMatch[3]);
          const refCols = fkConstraintMatch[4].split(',').map((c) => stripIdentifierQuotes(c));
          const actions = fkConstraintMatch[5] || '';
          const onDeleteMatch = actions.match(/ON\s+DELETE\s+(CASCADE|RESTRICT|SET\s+NULL|SET\s+DEFAULT|NO\s+ACTION)/i);
          const onUpdateMatch = actions.match(/ON\s+UPDATE\s+(CASCADE|RESTRICT|SET\s+NULL|SET\s+DEFAULT|NO\s+ACTION)/i);

          foreignKeys.push({
            constraintName,
            columns: cols,
            referencedTable: refTable,
            referencedColumns: refCols,
            onDelete: onDeleteMatch ? onDeleteMatch[1].toUpperCase().replace(/\s+/g, ' ') : undefined,
            onUpdate: onUpdateMatch ? onUpdateMatch[1].toUpperCase().replace(/\s+/g, ' ') : undefined
          });
          continue;
        }

        // MySQL inline INDEX / KEY inside CREATE TABLE
        const inlineIdxMatch = trimmed.match(
          /^(?:(UNIQUE)\s+)?(?:INDEX|KEY)\s+([^\s(]+)?\s*\(([^)]+)\)/i
        );
        if (inlineIdxMatch) {
          const isUnique = Boolean(inlineIdxMatch[1]);
          const idxName = inlineIdxMatch[2]
            ? stripIdentifierQuotes(inlineIdxMatch[2])
            : `idx_${tableName}_${inlineIdxMatch[3].replace(/[^a-zA-Z0-9_]/g, '_')}`;
          const idxCols = inlineIdxMatch[3].split(',').map((c) => {
            const parts = c.trim().split(/\s+/);
            const direction = parts[1]?.toUpperCase() === 'DESC' ? ('DESC' as const) : ('ASC' as const);
            return { name: stripIdentifierQuotes(parts[0]), direction };
          });
          const parsedIdx: ParsedIndex = {
            name: idxName,
            table: tableName,
            columns: idxCols,
            includeColumns: [],
            unique: isUnique,
            concurrently: false
          };
          tableIndexes.push(parsedIdx);
          indexes.push(parsedIdx);
          continue;
        }

        // Skip CHECK constraint lines; parse table-level UNIQUE constraints as unique indexes
        const uniqueConstraintMatch = trimmed.match(
          /^(?:CONSTRAINT\s+([^\s]+)\s+)?UNIQUE\s*(?:INDEX|KEY)?\s*(?:[^\s(]+\s*)?\(([^)]+)\)/i
        );
        if (uniqueConstraintMatch) {
          const uqName = uniqueConstraintMatch[1]
            ? stripIdentifierQuotes(uniqueConstraintMatch[1])
            : `uq_${tableName}_${uniqueConstraintMatch[2].replace(/[^a-zA-Z0-9_]/g, '_')}`;
          const uqCols = uniqueConstraintMatch[2].split(',').map((c) => {
            const parts = c.trim().split(/\s+/);
            const direction = parts[1]?.toUpperCase() === 'DESC' ? ('DESC' as const) : ('ASC' as const);
            return { name: stripIdentifierQuotes(parts[0]), direction };
          });
          const parsedUqIdx: ParsedIndex = {
            name: uqName,
            table: tableName,
            columns: uqCols,
            includeColumns: [],
            unique: true,
            concurrently: false
          };
          tableIndexes.push(parsedUqIdx);
          indexes.push(parsedUqIdx);
          continue;
        }

        if (/^(?:CONSTRAINT\s+[^\s]+\s+)?(?:CHECK|EXCLUDE)\b/i.test(trimmed)) {
          continue;
        }

        // Parse Column Definition
        const colMatch = trimmed.match(/^([^\s]+)\s+([\s\S]+)$/);
        if (!colMatch) continue;
        const colName = stripIdentifierQuotes(colMatch[1]);
        const rest = colMatch[2];

        // Extract data type up to first constraint keyword
        const constraintKeywords =
          /\b(NOT\s+NULL|NULL|PRIMARY\s+KEY|UNIQUE|DEFAULT|REFERENCES|CHECK|AUTO_INCREMENT|GENERATED|COMMENT|COLLATE|CONSTRAINT)\b/i;
        const kwIdx = rest.search(constraintKeywords);
        const rawTypePart = (kwIdx >= 0 ? rest.slice(0, kwIdx) : rest).trim();
        const modifiersPart = kwIdx >= 0 ? rest.slice(kwIdx) : '';

        const typeInfo = parseDataTypeDetails(rawTypePart);
        const isPk = /\bPRIMARY\s+KEY\b/i.test(modifiersPart);
        const isNotNull = /\bNOT\s+NULL\b/i.test(modifiersPart) || isPk;
        const isUnique = /\bUNIQUE\b/i.test(modifiersPart);
        const hasDefault = /\bDEFAULT\b/i.test(modifiersPart);
        const defaultMatch = modifiersPart.match(/\bDEFAULT\s+([^\s,]+|\([^)]+\)|'[^']*')/i);

        if (isPk && !primaryKeyColumns.includes(colName)) {
          primaryKeyColumns.push(colName);
        }

        if (isUnique && !isPk) {
          const uqIdx: ParsedIndex = {
            name: `uq_${tableName}_${colName}`,
            table: tableName,
            columns: [{ name: colName, direction: 'ASC' }],
            includeColumns: [],
            unique: true,
            concurrently: false
          };
          tableIndexes.push(uqIdx);
          indexes.push(uqIdx);
        }

        let inlineRef: ParsedColumn['references'] | undefined;
        const refMatch = modifiersPart.match(
          /\bREFERENCES\s+([^\s(]+)\s*(?:\(([^)]+)\))?(?:\s+ON\s+DELETE\s+(CASCADE|RESTRICT|SET\s+NULL|SET\s+DEFAULT|NO\s+ACTION))?(?:\s+ON\s+UPDATE\s+(CASCADE|RESTRICT|SET\s+NULL|SET\s+DEFAULT|NO\s+ACTION))?/i
        );
        if (refMatch) {
          const refTable = stripIdentifierQuotes(refMatch[1]);
          const refCol = refMatch[2] ? stripIdentifierQuotes(refMatch[2]) : 'id';
          const onDelete = refMatch[3] ? refMatch[3].toUpperCase().replace(/\s+/g, ' ') : undefined;
          const onUpdate = refMatch[4] ? refMatch[4].toUpperCase().replace(/\s+/g, ' ') : undefined;
          inlineRef = {
            table: refTable,
            column: refCol,
            onDelete,
            onUpdate
          };
          foreignKeys.push({
            columns: [colName],
            referencedTable: refTable,
            referencedColumns: [refCol],
            onDelete,
            onUpdate
          });
        }

        columns.push({
          name: colName,
          rawDataType: rawTypePart,
          baseType: typeInfo.baseType,
          length: typeInfo.length,
          precision: typeInfo.precision,
          scale: typeInfo.scale,
          unsigned: typeInfo.unsigned,
          nullable: !isNotNull,
          isPrimaryKey: isPk,
          isUnique,
          hasDefault,
          defaultValue: defaultMatch ? defaultMatch[1] : undefined,
          references: inlineRef
        });
      }

      // Sync column isPrimaryKey flags with table-level PRIMARY KEY
      for (const col of columns) {
        if (primaryKeyColumns.includes(col.name)) {
          col.isPrimaryKey = true;
          col.nullable = false;
        }
      }

      // Check PARTITION BY in tail
      let partitionBy: ParsedTable['partitionBy'];
      const partMatch = tail.match(/PARTITION\s+BY\s+(RANGE|LIST|HASH)\s*\(([^)]+)\)/i);
      if (partMatch) {
        partitionBy = {
          type: partMatch[1].toUpperCase() as 'RANGE' | 'LIST' | 'HASH',
          columns: partMatch[2].split(',').map((c) => stripIdentifierQuotes(c))
        };
      }

      tables.set(tableName, {
        name: tableName,
        columns,
        primaryKeyColumns,
        foreignKeys,
        indexes: tableIndexes,
        partitionBy
      });
      continue;
    }

    // 2. CREATE INDEX
    const createIdxMatch = stmt.match(
      /CREATE\s+(UNIQUE\s+)?INDEX\s+(CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([^\s]+)\s+ON\s+(?:ONLY\s+)?([^\s(]+)(?:\s+USING\s+[a-zA-Z0-9_]+)?\s*\(([\s\S]+?)\)(?:\s+INCLUDE\s*\(([^)]+)\))?(?:\s+WHERE\s+([\s\S]+?))?(?:\s+ALGORITHM\s*=\s*([A-Z]+))?(?:\s*,?\s*LOCK\s*=\s*([A-Z]+))?$/i
    );
    if (createIdxMatch) {
      const unique = Boolean(createIdxMatch[1]);
      const concurrently = Boolean(createIdxMatch[2]);
      const idxName = stripIdentifierQuotes(createIdxMatch[3]);
      const tblName = stripIdentifierQuotes(createIdxMatch[4]);
      const rawCols = splitTopLevelCommas(createIdxMatch[5]);
      const includeCols = createIdxMatch[6]
        ? createIdxMatch[6].split(',').map((c) => stripIdentifierQuotes(c))
        : [];
      const whereClause = createIdxMatch[7]?.trim();
      const algorithm = createIdxMatch[8]?.toUpperCase();
      const lock = createIdxMatch[9]?.toUpperCase();

      const parsedCols = rawCols.map((rc) => {
        const cleanedCol = rc.trim();
        const dirMatch = cleanedCol.match(/^(.*?)(?:\s+(ASC|DESC))?(?:\s+NULLS\s+(?:FIRST|LAST))?$/i);
        const exprOrCol = dirMatch ? dirMatch[1].trim() : cleanedCol;
        const direction = dirMatch?.[2]?.toUpperCase() === 'DESC' ? ('DESC' as const) : ('ASC' as const);
        const isExpr = /[()]/.test(exprOrCol);
        return {
          name: isExpr ? exprOrCol : stripIdentifierQuotes(exprOrCol),
          direction,
          expression: isExpr ? exprOrCol : undefined
        };
      });

      const parsedIdx: ParsedIndex = {
        name: idxName,
        table: tblName,
        columns: parsedCols,
        includeColumns: includeCols,
        whereClause,
        unique,
        concurrently,
        algorithm,
        lock
      };
      indexes.push(parsedIdx);
      const tbl = tables.get(tblName);
      if (tbl) {
        tbl.indexes.push(parsedIdx);
      }
      continue;
    }

    // 3. ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY / ADD COLUMN / ADD INDEX
    const alterMatch = stmt.match(/^ALTER\s+TABLE\s+(?:ONLY\s+)?([^\s]+)\s+([\s\S]+)$/i);
    if (alterMatch) {
      const tblName = stripIdentifierQuotes(alterMatch[1]);
      const actionsText = alterMatch[2];
      let tbl = tables.get(tblName);
      if (!tbl) {
        tbl = {
          name: tblName,
          columns: [],
          primaryKeyColumns: [],
          foreignKeys: [],
          indexes: []
        };
        tables.set(tblName, tbl);
      }

      const addFkMatches = actionsText.matchAll(
        /ADD\s+(?:CONSTRAINT\s+([^\s]+)\s+)?FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+([^\s(]+)\s*\(([^)]+)\)(.*?)(?=\s*,\s*ADD\b|\s*,\s*ALTER\b|\s*,\s*DROP\b|\s*,\s*MODIFY\b|$)/gi
      );
      for (const addFkMatch of addFkMatches) {
        const constraintName = addFkMatch[1] ? stripIdentifierQuotes(addFkMatch[1]) : undefined;
        const cols = addFkMatch[2].split(',').map((c) => stripIdentifierQuotes(c));
        const refTable = stripIdentifierQuotes(addFkMatch[3]);
        const refCols = addFkMatch[4].split(',').map((c) => stripIdentifierQuotes(c));
        const tail = addFkMatch[5] || '';
        const onDeleteMatch = tail.match(/ON\s+DELETE\s+(CASCADE|RESTRICT|SET\s+NULL|SET\s+DEFAULT|NO\s+ACTION)/i);
        const onUpdateMatch = tail.match(/ON\s+UPDATE\s+(CASCADE|RESTRICT|SET\s+NULL|SET\s+DEFAULT|NO\s+ACTION)/i);
        tbl.foreignKeys.push({
          constraintName,
          columns: cols,
          referencedTable: refTable,
          referencedColumns: refCols,
          onDelete: onDeleteMatch ? onDeleteMatch[1].toUpperCase().replace(/\s+/g, ' ') : undefined,
          onUpdate: onUpdateMatch ? onUpdateMatch[1].toUpperCase().replace(/\s+/g, ' ') : undefined
        });
      }

      const addColMatches = actionsText.matchAll(
        /ADD\s+(?:COLUMN\s+)?([^\s(]+)\s+([a-zA-Z0-9_ ]+(?:\([^)]+\))?)(.*?)(?=\s*,\s*ADD\b|\s*,\s*ALTER\b|\s*,\s*DROP\b|\s*,\s*MODIFY\b|$)/gi
      );
      for (const addColMatch of addColMatches) {
        if (!/^CONSTRAINT|FOREIGN|PRIMARY|INDEX|KEY|UNIQUE$/i.test(addColMatch[1])) {
          const colName = stripIdentifierQuotes(addColMatch[1]);
          const rawDataType = addColMatch[2];
          const restMod = addColMatch[3] || '';
          const typeDetails = parseDataTypeDetails(rawDataType);
          const defaultMatch = restMod.match(/\bDEFAULT\s+([^\s,]+|\([^)]+\)|'[^']*')/i);
          const refMatch = restMod.match(
            /\bREFERENCES\s+([^\s(]+)\s*(?:\(([^)]+)\))?(?:\s+ON\s+DELETE\s+(CASCADE|RESTRICT|SET\s+NULL|SET\s+DEFAULT|NO\s+ACTION))?(?:\s+ON\s+UPDATE\s+(CASCADE|RESTRICT|SET\s+NULL|SET\s+DEFAULT|NO\s+ACTION))?/i
          );
          let inlineRef: ParsedColumn['references'] | undefined;
          if (refMatch) {
            const refTable = stripIdentifierQuotes(refMatch[1]);
            const refCol = refMatch[2] ? stripIdentifierQuotes(refMatch[2]) : 'id';
            const onDelete = refMatch[3] ? refMatch[3].toUpperCase().replace(/\s+/g, ' ') : undefined;
            const onUpdate = refMatch[4] ? refMatch[4].toUpperCase().replace(/\s+/g, ' ') : undefined;
            inlineRef = { table: refTable, column: refCol, onDelete, onUpdate };
            tbl.foreignKeys.push({
              columns: [colName],
              referencedTable: refTable,
              referencedColumns: [refCol],
              onDelete,
              onUpdate
            });
          }
          tbl.columns.push({
            name: colName,
            rawDataType,
            baseType: typeDetails.baseType,
            length: typeDetails.length,
            precision: typeDetails.precision,
            scale: typeDetails.scale,
            unsigned: typeDetails.unsigned,
            nullable: !/\bNOT\s+NULL\b/i.test(restMod),
            isPrimaryKey: /\bPRIMARY\s+KEY\b/i.test(restMod),
            isUnique: /\bUNIQUE\b/i.test(restMod),
            hasDefault: /\bDEFAULT\b/i.test(restMod),
            defaultValue: defaultMatch ? defaultMatch[1] : undefined,
            references: inlineRef
          });
        }
      }
      continue;
    }

    if (!/^(DROP|SET|BEGIN|COMMIT|COMMENT|INSERT|SELECT|PRAGMA|USE)\b/i.test(normalizedStmt)) {
      parseWarnings.push(`Unrecognized or complex DDL statement skipped: ${normalizedStmt.slice(0, 80)}`);
    }
  }

  return {
    dialect,
    tables,
    indexes,
    rawStatements: statements,
    parseWarnings
  };
}
