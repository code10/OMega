# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-11-23

### Added
- Initial release of OMega framework.
- Support for local and cloud LLM providers.
- Integrated browser automation with Playwright.
- Persistent memory system.
- Recursive self-improvement protocol.
- Multi-platform CI/CD workflows.

### Changed
- Refined UI theme to "Arena".
- Optimized token usage in long conversations with model-scaled compaction and 48KB JSON-preserving tool truncation.
- Added provider prompt caching (static/dynamic prompt split, Anthropic `cache_control`, Gemini/OpenAI cache-hot prefixes).
- Accelerated `search_files` with native `rg` / `git grep` and eliminated double checkpoint serialization per step.
- Hardened `patch_file` with ambiguity rejection (`replaceAll` opt-in), line-numbered `read_file`, non-blocking `OMSystemOne` warmup, and core coding tool pinning.

### Fixed
- Corrected TypeScript and Node type versions in `package.json`.
- Improved path normalization for Windows environments.
