# Future Work & Roadmap

This document outlines planned improvements and potential future directions for the OpenCode Cursor Auth project.

## Status Legend
- **Planned** - Documented and prioritized
- **In Progress** - Actively being worked on
- **Blocked** - Waiting on external dependency or more research
- **Completed** - Done and merged

---

## High Priority

### 1. Error Handling & Resilience
**Status**: Planned  
**Priority**: High

- [ ] Implement retry logic with exponential backoff for transient failures
- [ ] Better error messages for common auth issues
- [ ] Graceful degradation when Cursor API is unavailable
- [ ] Connection pooling for better performance

### 2. Streaming Reliability
**Status**: Planned  
**Priority**: High

- [ ] Detect and recover from dropped SSE connections
- [ ] Implement heartbeat monitoring to detect stale streams
- [ ] Add timeout handling for long-running requests
- [ ] Better handling of network interruptions

### 3. Token Management
**Status**: Planned  
**Priority**: High

- [ ] Proactive token refresh before expiration
- [ ] Automatic re-authentication when tokens become invalid
- [ ] Better handling of concurrent requests during token refresh
- [ ] Support for token rotation

---

## Medium Priority

### 4. Session Reuse (Experimental)
**Status**: Blocked  
**Priority**: Medium

Session reuse via BidiAppend would significantly reduce latency by avoiding the ~3-6s bootstrap per request. Currently blocked due to KV blob storage issue.

**Research needed**:
- [ ] Investigate Cursor CLI headers that enable streaming after BidiAppend
- [ ] Explore KV blob extraction as alternative approach
- [ ] Test with different Cursor client versions
- [ ] Monitor if Cursor API behavior changes

**Potential solutions**:
1. **KV Blob Extraction**: Poll blob store after heartbeat timeout, extract and emit text
2. **Header Matching**: Find correct headers that trigger streaming mode
3. **Hybrid Approach**: Fresh sessions for tool calls, session reuse for simple chat

### 5. MCP (Model Context Protocol) Support
**Status**: Planned  
**Priority**: Medium

- [ ] Full MCP tool passthrough
- [ ] MCP tool result formatting
- [ ] Custom MCP server integration
- [ ] MCP tool discovery

### 6. Multi-Model Support
**Status**: Planned  
**Priority**: Medium

- [ ] Model capability detection (streaming, tools, vision)
- [ ] Model-specific parameter normalization
- [ ] Better model alias resolution
- [ ] Model availability monitoring

---

## Low Priority

### 7. Performance Optimization
**Status**: Planned  
**Priority**: Low

- [ ] Request batching for multiple concurrent calls
- [ ] Response caching for identical requests
- [ ] Connection keep-alive optimization
- [ ] Memory usage profiling and optimization

### 8. Observability
**Status**: Planned  
**Priority**: Low

- [ ] Structured logging with configurable levels
- [ ] Request/response metrics (latency, error rates)
- [ ] OpenTelemetry integration for tracing
- [ ] Dashboard for monitoring proxy health

### 9. Configuration Management
**Status**: Planned  
**Priority**: Low

- [ ] Configuration file support (opencode.json / .cursorrc)
- [ ] Environment-specific configurations
- [ ] Runtime configuration reload
- [ ] Configuration validation

### 10. Additional API Endpoints
**Status**: Planned  
**Priority**: Low

- [ ] `/v1/embeddings` - Text embeddings (if supported by Cursor)
- [ ] `/v1/audio/transcriptions` - Speech-to-text (if available)
- [ ] `/v1/images/generations` - Image generation (if available)
- [ ] Custom endpoints for Cursor-specific features

---

## Research & Exploration

### Understanding Cursor's Architecture
**Status**: Ongoing

Areas to investigate:
- [ ] Why does BidiAppend cause KV blob storage instead of streaming?
- [ ] What headers/flags trigger different response modes?
- [ ] How does Cursor CLI handle multi-turn conversations?
- [ ] What's the role of checkpoints in conversation state?

### Alternative Approaches
**Status**: Exploratory

- [ ] Direct WebSocket connection to Cursor (bypass gRPC-Web)
- [ ] Custom Cursor CLI wrapper instead of API reverse-engineering
- [ ] Integration with Cursor's VS Code extension protocol
- [ ] Browser-based proxy using Cursor web interface

---

## Technical Debt

### Code Quality
- [ ] Remove unused variables (linting warnings)
- [ ] Fix test mock types (session-reuse.test.ts)
- [ ] Document all public APIs
- [ ] Add JSDoc comments to core functions

### Testing
- [ ] Increase test coverage for edge cases
- [ ] Add integration tests with mock Cursor API
- [ ] End-to-end tests with real Cursor API (CI/CD)
- [ ] Performance benchmarks

### Documentation
- [x] Comprehensive README
- [x] Architecture documentation
- [x] API reference
- [ ] Contribution guidelines
- [ ] Deployment guides

---

## Breaking Changes Consideration

Future versions may include breaking changes. Potential areas:

1. **API Surface**: Tool call ID format may change
2. **Configuration**: Environment variable names may be standardized
3. **Authentication**: May move to a more secure credential storage
4. **Protocol**: May adopt different protobuf versions

---

## How to Contribute

Interested in helping? Here's how:

1. **Pick an issue**: Check the GitHub issues for `good first issue` or `help wanted` labels
2. **Research**: For blocked items, research and document findings
3. **Test**: Help improve test coverage
4. **Document**: Improve documentation and examples

---

## Version History

### v0.1.0 (Current)
- Initial release
- OpenAI-compatible proxy server
- Full tool calling support
- Model listing and resolution
- Basic authentication

### v0.2.0 (Planned)
- Improved error handling
- Better token management
- Performance optimizations

### v1.0.0 (Future)
- Stable API
- Production-ready reliability
- Comprehensive documentation
