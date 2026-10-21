export declare function isSensitiveFilePath(filePath: string): boolean;
export declare function validateSafePath(targetPath: string, allowedRoot?: string): string;
export interface WalkedFilesResult {
    files: string[];
    skippedLargeOrBinary: number;
}
export declare function walkProjectFiles(options: {
    rootPath: string;
    extensions: string[];
    excludeGlobs?: string[];
    maxFiles?: number;
    maxFileSizeBytes?: number;
}): Promise<WalkedFilesResult>;
export declare function readMigrationSources(migrationSource: {
    raw_sql?: string;
    file_paths?: string[];
    migration_dir?: string;
}): {
    combinedSql: string;
    warnings: string[];
};
