# API Key Scraper - Enhanced Edition

A comprehensive GitHub secret scanner pi extension that monitors public activity for leaked credentials.

## Features

### 20+ Secret Patterns Detected

| Category | Patterns | Severity |
|----------|----------|----------|
| Cloud | AWS (IAM keys, secrets), Azure, GCP (API keys, service accounts) | Critical |
| AI/ML | OpenAI, Anthropic, Cohere | High |
| Payments | Stripe (live/test), PayPal | Critical |
| Communication | Slack (tokens, webhooks), Discord, Telegram | High |
| Infrastructure | GitHub (tokens, OAuth), DockerHub, NPM | Medium |
| Databases | MongoDB, PostgreSQL, Redis URIs | Critical |
| Generic | API keys, private keys | Variable |
| Testing | Honeytokens/Canary tokens | Low |

### Data Sources

1. **Events API** - Real-time commits & gists
2. **Gist Events** - Public gists (major leak vector)
3. **Code Search API** - Active search across GitHub
4. **Deep History** - Full repo history scanning

### Smart Features

- **Live Verification** - Tests found keys against actual APIs
- **Verification Caching** - 24hr TTL to avoid re-testing
- **Smart Rate Limiting** - Respects X-RateLimit headers and X-Poll-Interval
- **Severity Scoring** - Critical/High/Medium/Low classifications
- **Notifications** - Slack webhook alerts for valid finds
- **Honeytoken Detection** - Test if scanner is working

## Commands

| Command | Description |
|---------|-------------|
| `/scan-secrets` | Run comprehensive scan |
| `/scan-secrets --history` | Include deep history scan |
| `/monitor-secrets` | Continuous monitoring loop |
| `/config-scanner webhook=<url>` | Set Slack webhook |
| `/config-scanner maxPages=10` | Adjust scan depth |
| `/show-secrets` | View all discovered secrets |
| `/clear-secret-cache` | Reset cache |

## Tool

```
scan_github_secrets
  maxPages?: number      # Event pages to scan
  enableHistory?: boolean # Scan full history
  enableSearch?: boolean # Use Code Search API
```

## Configuration

```bash
# Set notification webhook
/config-scanner webhook=https://hooks.slack.com/services/...

# Adjust rate limits
/config-scanner maxPages=10 cacheHours=48

# Change sampling
/config-scanner sampleRate=0.1  # 10% of non-suspicious commits
```

## How It Works

1. **Events API polling** fetches recent commits & gists
2. **Suspicious detection** flags commits with leak keywords
3. **Random sampling** catches accidental leaks in innocent commits
4. **Content fetching** retrieves diffs/gist contents
5. **Pattern matching** against 20+ secret regexes
6. **Live verification** tests credentials against real APIs
7. **Caching** prevents duplicate verification
8. **Notifications** alert on valid findings

## Architecture

Inspired by:
- **TruffleHog** - Verification approach & pattern breadth
- **Shhgit** - Events API streaming strategy
- **GitHound** - Code Search API integration
- **GitGuardian** - Honeytoken concept
