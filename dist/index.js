#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createDbaArchitectServer } from './server.js';
import { initAdapters } from './adapters.js';
const args = process.argv.slice(2);
function printHelp() {
    console.log(`
🚀 DBA-Architect (v1.0.0)
Universal Database Optimization, Architecture & DBA MCP Server + Multi-Agent Skill

Usage:
  npx dba-architect [command] [options]
  npx dba-architect init

Commands:
  init, --sync-agents   Install multi-agent IDE adapters (Antigravity, Cursor, Claude, Windsurf, Copilot, Cline, Kiro, Continue)
  --mcp                 Run Model Context Protocol (MCP) server via stdio (default if no command given)
  --help, -h            Show this help manual
  --version, -v         Show version

Examples:
  npx dba-architect init
  npx skills add hanifalkauni/dba-architect
  npx -y github:hanifalkauni/dba-architect init
  npx -y github:hanifalkauni/dba-architect
`);
}
async function main() {
    if (args.includes('--help') || args.includes('-h')) {
        printHelp();
        process.exit(0);
    }
    if (args.includes('--version') || args.includes('-v')) {
        console.log('dba-architect v1.0.0');
        process.exit(0);
    }
    if (args[0] === 'init' || args.includes('--sync-agents')) {
        console.log('\n🚀 Initializing DBA-Architect multi-agent adapters...');
        const created = initAdapters();
        for (const file of created) {
            console.log(`  ✓ Installed: ${file}`);
        }
        console.log('\n✨ Done! DBA-Architect rules and adapters are now ready in your workspace.\n');
        process.exit(0);
    }
    // Default mode: Run as MCP server over stdio
    const server = createDbaArchitectServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
main().catch((err) => {
    console.error('Fatal error running dba-architect:', err);
    process.exit(1);
});
//# sourceMappingURL=index.js.map