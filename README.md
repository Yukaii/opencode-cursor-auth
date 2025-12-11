# OpenCode Cursor Auth

> **⚠️ Experimental Project - Use at Your Own Risk**
>
> This is a highly experimental project with limited support. It was built by reverse-engineering Cursor's internal API, which means:
>
> - **It may break at any time** without notice if Cursor changes their API
> - **No guarantees** of stability, compatibility, or continued functionality
> - **"It Works On My Machine™"** - your mileage may vary
> - **Not affiliated with or endorsed by Cursor** - this is an unofficial community project
>
> If it stops working, feel free to open an issue, but fixes depend on community contributions and reverse-engineering efforts.

An OpenCode plugin and OpenAI-compatible proxy server that routes requests through Cursor's AI backend, enabling OpenCode (and any OpenAI-compatible client) to use Cursor's API with full tool calling support.

## Features

- **OpenCode Plugin**: Native integration with OpenCode via OAuth authentication
- **OpenAI API Compatible**: Drop-in replacement for OpenAI API endpoints
- **Full Tool Calling Support**: Complete support for function calling with bash, read, write, list, glob/grep
- **Dynamic Model Discovery**: Automatically fetches available models from Cursor's API
- **Streaming Support**: Real-time streaming responses via SSE

## Quick Start with OpenCode (Recommended)

### 1. Install the Plugin

```bash
# In your project directory
bun add opencode-cursor-auth
```

Or for local development, create `.opencode/plugin/cursor-auth.ts`:

```typescript
export { CursorOAuthPlugin } from "opencode-cursor-auth";
```

### 2. Configure OpenCode

Add to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "cursor": {
      "name": "Cursor"
    }
  }
}
```

That's it! The plugin will:
- Handle OAuth authentication with Cursor
- Automatically discover and register all available models
- Provide a custom fetch handler (no proxy server needed)

### 3. Authenticate

Run OpenCode and authenticate:

```
opencode auth login
```

Then:
1. Select **"other"** from the provider list
2. Type **"cursor"** as the provider name
3. Select **"OAuth with Cursor"**
4. Complete the browser-based OAuth flow

## Standalone Server Usage

If you prefer to run a standalone proxy server (for non-OpenCode clients):

### Prerequisites

- [Bun](https://bun.sh) v1.3.2+
- A Cursor account with valid credentials

### Installation

```bash
git clone https://github.com/Yukaii/opencode-cursor-auth.git
cd opencode-cursor-auth
bun install
```

### Authentication

```bash
# Interactive login
bun run demo:login

# Or set environment variable
export CURSOR_ACCESS_TOKEN="your_cursor_access_token"
```

### Running the Server

```bash
bun run server

# Or with custom port
PORT=8080 bun run server
```

The server starts on `http://localhost:18741` by default.

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/chat/completions` | POST | Chat completions (streaming/non-streaming) |
| `/v1/models` | GET | List available models |
| `/v1/tool_results` | POST | Submit tool execution results |
| `/health` | GET | Health check |

## Usage Examples

### With curl

```bash
# Simple chat completion
curl http://localhost:18741/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-4-sonnet",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'

# List available models
curl http://localhost:18741/v1/models
```

### With OpenAI SDK

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:18741/v1",
  apiKey: "not-needed", // Auth is handled by the server
});

const response = await client.chat.completions.create({
  model: "claude-4-sonnet",
  messages: [{ role: "user", content: "Explain quantum computing" }],
  stream: true,
});

for await (const chunk of response) {
  process.stdout.write(chunk.choices[0]?.delta?.content || "");
}
```

## Tool Calling

The proxy supports full OpenAI-compatible tool calling. When tools are provided, Cursor's built-in tools are mapped to OpenAI function calls:

| Cursor Tool | OpenAI Function | Description |
|-------------|-----------------|-------------|
| `shell` | `bash` | Execute shell commands |
| `read` | `read` | Read file contents |
| `write` | `write` | Write/create files |
| `ls` | `list` | List directory contents |
| `grep` | `grep` / `glob` | Search file contents / patterns |
| `mcp` | Original name | MCP tool passthrough |

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `18741` |
| `CURSOR_ACCESS_TOKEN` | Direct access token | - |
| `CURSOR_DEBUG` | Enable debug logging | `0` |

### Available Models

Models are fetched dynamically from Cursor's API. Common models include:

- `auto` - Auto-select best model
- `claude-4-sonnet` - Claude 4 Sonnet
- `claude-4-sonnet-thinking` - Claude 4 Sonnet (Thinking)
- `gpt-4o` - GPT-4o
- `gemini-2.5-pro` - Gemini 2.5 Pro
- `composer-1` - Cursor Composer

Use `/v1/models` or check the OpenCode model picker for the full list.

## Architecture

```
┌─────────────┐     ┌─────────────────┐     ┌─────────────┐
│   OpenAI    │────▶│  Proxy Server   │────▶│   Cursor    │
│   Client    │◀────│  (this project) │◀────│   API       │
└─────────────┘     └─────────────────┘     └─────────────┘

For OpenCode Plugin:
┌─────────────┐     ┌─────────────────┐     ┌─────────────┐
│   OpenCode  │────▶│  Custom Fetch   │────▶│   Cursor    │
│             │◀────│  (no server)    │◀────│   API       │
└─────────────┘     └─────────────────┘     └─────────────┘
```

## Project Structure

```
opencode-cursor-auth/
├── src/
│   ├── server.ts              # Standalone proxy server
│   ├── index.ts               # Plugin exports
│   ├── lib/
│   │   ├── api/
│   │   │   ├── agent-service.ts   # Cursor Agent API client
│   │   │   └── cursor-models.ts   # Model discovery
│   │   ├── auth/                  # Authentication helpers
│   │   ├── openai-compat/         # OpenAI compatibility layer
│   │   └── storage.ts             # Credential storage
│   └── plugin/
│       └── plugin.ts              # OpenCode plugin implementation
├── docs/                          # Documentation
└── scripts/                       # Utility scripts
```

## Documentation

- [Authentication Flow](docs/AUTH.md) - Detailed auth documentation
- [Cursor API Reference](docs/CURSOR_API.md) - Cursor's API protocol
- [Architecture Comparison](docs/ARCHITECTURE_COMPARISON.md) - OpenAI vs Cursor differences
- [OpenCode Plugin](docs/OPENCODE_PLUGIN.md) - Plugin implementation details

## Known Limitations

1. **Session Reuse**: Each request creates a fresh session (session reuse is experimental).
2. **Non-streaming Tool Results**: Tool results must be sent in a new request.
3. **Usage Metrics**: Token usage is estimated, not exact.

## Development

```bash
# Run tests
bun test

# Run with debug logging
CURSOR_DEBUG=1 bun run server

# Run demo scripts
bun run demo:status    # Check auth status
bun run demo:login     # Interactive login
bun run demo:logout    # Clear credentials
```

## Troubleshooting

### "No access token found"
Run `bun run demo:login` to authenticate, or set `CURSOR_ACCESS_TOKEN` environment variable.

### Tool calls not working
Ensure you're including the `tools` array in your request. The proxy only emits tool calls when tools are provided.

### Debug logging
Set `CURSOR_DEBUG=1` to enable verbose logging for troubleshooting.

## License

MIT

## Acknowledgments

- Built by reverse-engineering Cursor CLI's communication protocol
- Uses [Bun](https://bun.sh) for fast TypeScript execution
- Protocol buffers handled via [@bufbuild/protobuf](https://github.com/bufbuild/protobuf-es)
