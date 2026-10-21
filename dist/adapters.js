import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export function initAdapters(targetDir = process.cwd()) {
    const dest = path.resolve(targetDir);
    // Adapters dir can be found relative to dist/ or src/
    let adaptersSrc = path.resolve(__dirname, '..', 'adapters');
    if (!fs.existsSync(adaptersSrc)) {
        adaptersSrc = path.resolve(__dirname, 'adapters');
    }
    const createdFiles = [];
    const copyMapping = [
        { src: 'antigravity/SKILL.md', dest: '.agents/skills/dba-architect/SKILL.md' },
        { src: 'cursor/dba-architect.mdc', dest: '.cursor/rules/dba-architect.mdc' },
        { src: 'claude/CLAUDE.md', dest: 'CLAUDE.md' },
        { src: 'windsurf/.windsurfrules', dest: '.windsurfrules' },
        { src: 'copilot/copilot-instructions.md', dest: '.github/copilot-instructions.md' },
        { src: 'cline/.clinerules', dest: '.clinerules' },
        { src: 'continue/config.json', dest: '.continue/config.json' },
        { src: 'continue/dba-architect.md', dest: '.continue/rules/dba-architect.md' },
        { src: 'kiro/dba-architect.md', dest: '.kiro/steering/dba-architect.md' },
        { src: 'kiro/config.json', dest: '.kiro/config.json' }
    ];
    for (const item of copyMapping) {
        const srcFile = path.join(adaptersSrc, item.src);
        const destFile = path.join(dest, item.dest);
        if (fs.existsSync(srcFile)) {
            fs.mkdirSync(path.dirname(destFile), { recursive: true });
            fs.copyFileSync(srcFile, destFile);
            createdFiles.push(item.dest);
        }
    }
    // Create default config file if not existing
    const cfgPath = path.join(dest, 'dba-architect.config.json');
    if (!fs.existsSync(cfgPath)) {
        let defaultCfg = path.resolve(__dirname, '..', 'dba-architect.config.json');
        if (!fs.existsSync(defaultCfg)) {
            defaultCfg = path.resolve(__dirname, 'dba-architect.config.json');
        }
        if (fs.existsSync(defaultCfg)) {
            fs.copyFileSync(defaultCfg, cfgPath);
            createdFiles.push('dba-architect.config.json');
        }
    }
    return createdFiles;
}
//# sourceMappingURL=adapters.js.map