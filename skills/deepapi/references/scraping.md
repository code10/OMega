# DeepAPI Scraping Reference

## Overview
Guidelines and protocols for resilient web scraping and content extraction.

### Core Principles
- Respect target rate limits (minimum 250ms delay between consecutive requests).
- Use proper user-agent headers to identify the OMega agent.
- Extract structured semantics (CSS selectors, text bodies, tables).
- Handle common HTTP errors (429 Too Many Requests, 403 Forbidden) gracefully.

### Example Selector Strategy
1. Primary content container: `main`, `article`, `#content`
2. Title extraction: `h1`, `title`
3. Paragraph collation: `p`

