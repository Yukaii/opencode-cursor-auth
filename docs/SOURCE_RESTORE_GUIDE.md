# Cursor Agent Source Restoration Guide

This document explains how to locate and restore readable source code from Cursor's bundled CLI agent.

## Overview

Cursor ships a background agent (cursor-agent) that handles AI interactions. The agent is distributed as minified/bundled JavaScript using webpack. This guide explains how to:

1. Find the source files
2. Extract and format them for analysis
3. Understand the structure

## Source Locations

### macOS

```bash
~/.local/share/cursor-agent/versions/
```

### Linux

```bash
~/.local/share/cursor-agent/versions/
```

### Windows

```powershell
%APPDATA%\cursor-agent\versions\
```

## Directory Structure

Each version is stored in a dated folder with a commit hash:

```
~/.local/share/cursor-agent/versions/
├── 2025.08.08-562252e/
├── 2025.09.04-fc40cd1/
├── 2025.10.20-f1b214f/
├── 2025.11.06-8fe8a63/
└── 2025.11.25-d5b3271/   # Latest version
```

### Version Folder Contents

Each version contains webpack-bundled JavaScript chunks:

```
2025.11.25-d5b3271/
├── index.js           # Main entry point (~170KB)
├── 110.index.js       # Chunk files
├── 128.index.js
├── 1337.index.js      # Contains protobuf definitions
├── 1514.index.js      # Large chunk (~147KB)
├── ...                # ~329 total JS files
└── [other chunks]
```

Total size: ~170MB bundled

## Finding the Latest Version

```bash
# List all versions sorted by date
ls -lt ~/.local/share/cursor-agent/versions/

# Get the latest version
LATEST=$(ls -t ~/.local/share/cursor-agent/versions/ | head -1)
echo $LATEST
```

## Restoring Readable Source

### Method 1: Prettier Formatting

The quickest way to make the code readable:

```bash
# Install prettier if needed
npm install -g prettier

# Format a single file
prettier --write ~/.local/share/cursor-agent/versions/$LATEST/index.js

# Format all files (creates copies)
mkdir -p ./restored-source
for f in ~/.local/share/cursor-agent/versions/$LATEST/*.js; do
  prettier "$f" > "./restored-source/$(basename $f)"
done
```

### Method 2: Using scripts/restore.ts (Recommended)

This project includes a sophisticated restore script that extracts and reorganizes webpack modules:

```bash
# First, copy cursor-agent source to the expected input directory
mkdir -p cursor-agent-source
cp ~/.local/share/cursor-agent/versions/$(ls -t ~/.local/share/cursor-agent/versions/ | head -1)/*.js cursor-agent-source/

# Run the restore script
bun run scripts/restore.ts
```

The script (`scripts/restore.ts`):
1. Reads all `.js` files from `cursor-agent-source/` directory
2. Parses webpack bundle structure to find module boundaries
3. Extracts two types of modules:
   - **Webpack modules**: `/***/ "path":` format - individual module files
   - **Concatenated modules**: `;// CONCATENATED MODULE: path` format - inlined modules
4. Uses Babel to parse and regenerate clean code from function wrappers
5. Outputs organized files to `cursor-agent-restored-source-code/` preserving original paths

**Output structure:**
```
cursor-agent-restored-source-code/
├── node_modules/.pnpm/           # Third-party dependencies
├── proto/dist/generated/         # Protobuf definitions (most valuable)
│   └── aiserver/v1/
│       ├── agent_connect.js
│       ├── agent_pb.js
│       └── tools_pb.js
└── src/                          # Cursor's source code
```

### Method 3: Manual Extraction

For specific modules, you can extract them manually:

```bash
# Search for specific patterns
grep -l "AgentService" ~/.local/share/cursor-agent/versions/$LATEST/*.js

# Find protobuf definitions
grep -l "proto3" ~/.local/share/cursor-agent/versions/$LATEST/*.js
```

## Key Files to Examine

After restoration, these files contain the most useful code:

| File Pattern | Contents |
|-------------|----------|
| `index.js` | Main entry, webpack bootstrap |
| `1337.index.js` | Usually contains protobuf schemas |
| `1514.index.js` | Large module with core logic |
| `1542.index.js` | API client implementations |

## Understanding Webpack Chunks

The code uses webpack's chunk splitting. Key patterns:

```javascript
// Module exports
__webpack_require__.d(__webpack_exports__, {
  AgentService: () => AgentService,
  // ...
});

// Module imports
var _connect_es__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__("...");
```

### Finding Service Definitions

Search for gRPC service definitions:

```bash
# Find service definitions
grep -r "MethodKind" ./restored-source/

# Find protobuf message definitions
grep -r "proto3.util.newFieldList" ./restored-source/
```

## Protobuf Extraction

The agent uses `@bufbuild/protobuf` for protocol buffers. Key patterns:

```javascript
// Message definition
class SomeMessage extends Message {
  static fields = proto3.util.newFieldList(() => [
    { no: 1, name: "field_name", kind: "scalar", T: 9 /* STRING */ },
    { no: 2, name: "other_field", kind: "message", T: OtherMessage },
  ]);
}

// Service definition
const AgentService = {
  typeName: "aiserver.v1.AgentService",
  methods: {
    runAgent: {
      name: "RunAgent",
      I: RunAgentRequest,
      O: RunAgentResult,
      kind: MethodKind.ServerStreaming,
    },
  },
};
```

## Tips for Analysis

### 1. Search for API Endpoints

```bash
grep -r "api2.cursor.sh" ./restored-source/
grep -r "/aiserver.v1" ./restored-source/
```

### 2. Find Authentication Logic

```bash
grep -r "authorization" ./restored-source/
grep -r "accessToken" ./restored-source/
```

### 3. Locate Model Definitions

```bash
grep -r "claude\|gpt\|gemini" ./restored-source/
```

### 4. Find Tool Definitions

```bash
grep -r "ToolCall\|tool_use" ./restored-source/
```

## Security Notes

- The restored source is for **educational and interoperability purposes only**
- Do not redistribute Cursor's proprietary code
- Respect Cursor's terms of service
- This project only uses the learned API protocols, not the actual code

## Keeping Up to Date

Cursor auto-updates the agent. To track changes:

```bash
# Watch for new versions
ls -lt ~/.local/share/cursor-agent/versions/ | head -5

# Compare versions
diff -r ./restored-v1/ ./restored-v2/
```

## Troubleshooting

### "Directory not found"

Cursor agent may not be installed or hasn't run yet. Launch Cursor IDE to trigger installation.

### "Permission denied"

```bash
chmod -R u+r ~/.local/share/cursor-agent/
```

### "Prettier fails on large files"

Some chunks are very large. Use `--parser babel` explicitly:

```bash
prettier --parser babel --write large-file.js
```

## Related Documentation

- [CURSOR_API.md](./CURSOR_API.md) - API protocol documentation
- [ARCHITECTURE_COMPARISON.md](./ARCHITECTURE_COMPARISON.md) - Architecture analysis
- [AUTH.md](./AUTH.md) - Authentication flow

## Version History

| Date | Version | Notes |
|------|---------|-------|
| 2025-11-25 | d5b3271 | Latest analyzed version |
| 2025-11-06 | 8fe8a63 | Previous stable |
| 2025-10-28 | 0a91dc2 | Tool calling updates |
