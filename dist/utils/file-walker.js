import fs from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import ignoreModule from 'ignore';
const SENSITIVE_PATTERNS = [
    /(^|[\\/])\.env(\..+)?$/i,
    /\.(pem|key|p12|pfx|keystore|jks)$/i,
    /(^|[\\/])credentials\.json$/i,
    /(^|[\\/])secrets?\.(json|ya?ml|toml)$/i,
    /(^|[\\/])id_(rsa|ed25519|ecdsa)$/i
];
export function isSensitiveFilePath(filePath) {
    const normalized = filePath.replace(/\\/g, '/');
    return SENSITIVE_PATTERNS.some((rx) => rx.test(normalized));
}
export function validateSafePath(targetPath, allowedRoot) {
    const resolved = path.resolve(targetPath);
    if (isSensitiveFilePath(resolved)) {
        throw new Error(`Security Guardrail: Access to sensitive file '${path.basename(resolved)}' is blocked.`);
    }
    if (allowedRoot) {
        const resolvedRoot = path.resolve(allowedRoot);
        const relative = path.relative(resolvedRoot, resolved);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new Error(`Security Guardrail: Path traversal detected outside workspace root '${resolvedRoot}'.`);
        }
    }
    return resolved;
}
export async function walkProjectFiles(options) {
    const rootDir = validateSafePath(options.rootPath);
    const maxFiles = options.maxFiles ?? 5000;
    const maxFileSizeBytes = options.maxFileSizeBytes ?? 2 * 1024 * 1024; // 2 MB
    const defaultExcludes = [
        '**/node_modules/**',
        '**/vendor/**',
        '**/.git/**',
        '**/dist/**',
        '**/build/**',
        '**/.next/**',
        '**/coverage/**'
    ];
    const excludeGlobs = Array.from(new Set([...defaultExcludes, ...(options.excludeGlobs ?? [])]));
    // Load .gitignore if present
    const ig = ignoreModule();
    const gitignorePath = path.join(rootDir, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
        try {
            const content = fs.readFileSync(gitignorePath, 'utf-8');
            ig.add(content);
        }
        catch {
            // Ignore read errors on .gitignore
        }
    }
    const extPattern = options.extensions.length === 1
        ? `**/*.${options.extensions[0]}`
        : `**/*.{${options.extensions.join(',')}}`;
    const rawEntries = await fg(extPattern, {
        cwd: rootDir,
        ignore: excludeGlobs,
        dot: false,
        onlyFiles: true,
        absolute: false
    });
    const files = [];
    let skippedLargeOrBinary = 0;
    for (const relPath of rawEntries) {
        if (files.length >= maxFiles)
            break;
        const posixRel = relPath.replace(/\\/g, '/');
        if (ig.ignores(posixRel))
            continue;
        if (isSensitiveFilePath(posixRel))
            continue;
        const fullPath = path.join(rootDir, relPath);
        try {
            const stat = fs.statSync(fullPath);
            if (stat.size > maxFileSizeBytes) {
                skippedLargeOrBinary++;
                continue;
            }
            files.push(fullPath);
        }
        catch {
            skippedLargeOrBinary++;
        }
    }
    return { files, skippedLargeOrBinary };
}
export function readMigrationSources(migrationSource) {
    const warnings = [];
    if (migrationSource.raw_sql !== undefined) {
        return { combinedSql: migrationSource.raw_sql, warnings };
    }
    if (migrationSource.file_paths && migrationSource.file_paths.length > 0) {
        const chunks = [];
        for (const fp of migrationSource.file_paths) {
            try {
                const safePath = validateSafePath(fp);
                if (!fs.existsSync(safePath)) {
                    warnings.push(`Migration file not found: ${fp}`);
                    continue;
                }
                chunks.push(fs.readFileSync(safePath, 'utf-8'));
            }
            catch (err) {
                warnings.push(err.message);
            }
        }
        return { combinedSql: chunks.join('\n;\n'), warnings };
    }
    if (migrationSource.migration_dir) {
        try {
            const safeDir = validateSafePath(migrationSource.migration_dir);
            if (!fs.existsSync(safeDir)) {
                warnings.push(`Migration directory not found: ${migrationSource.migration_dir}`);
                return { combinedSql: '', warnings };
            }
            const entries = fs
                .readdirSync(safeDir)
                .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql') && !isSensitiveFilePath(f))
                .sort();
            const chunks = [];
            for (const entry of entries) {
                const full = path.join(safeDir, entry);
                chunks.push(fs.readFileSync(full, 'utf-8'));
            }
            return { combinedSql: chunks.join('\n;\n'), warnings };
        }
        catch (err) {
            warnings.push(err.message);
            return { combinedSql: '', warnings };
        }
    }
    return { combinedSql: '', warnings: ['No valid migration source provided.'] };
}
//# sourceMappingURL=file-walker.js.map