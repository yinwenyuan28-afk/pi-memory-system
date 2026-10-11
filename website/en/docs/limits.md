---
title: Limits and data handling
description: Compatibility, recall prerequisites, data flow, and documented issues.
---

# Limits and data handling

This page reflects the repository documentation and feature analysis dated October 11, 2026. Use these conditions to decide whether the extension fits your workflow.

## Compatibility and effect conditions

| Topic | Current boundary |
| --- | --- |
| System | Windows only; Node ≥ 22.13 |
| Semantic recall | Configure Embedding; vectorization defaults off; the automatic threshold defaults to 500 valid records; backfill existing records |
| Recall quality | Bounded by relevance, record count, character budget, and timing; extraction and retrieval are not guaranteed |
| Multiple projects | Project ownership influences ranking; it is not strict isolation and may be unknown |
| Scenes | L2 is not automatically injected into each answer |
| Profile | Proposals in USER-temp.md require review and merge |

## Files and service calls

Memory files live in your Pi profile. Extraction and skill review use your configured model. Vectorization calls your configured Embedding service. Processing location depends on those choices.

Default cleaning does not guarantee removal of API keys, passwords, or bearer tokens. Skill-feed retains tool arguments and results, so take care with secrets in those sources.

## Documented issues

- **Chat extraction mode:** prompt types and commit enums differ, which can reject submissions. This prototype focuses its examples on development work records.
- **Viewer bridge:** no authentication and unrestricted CORS. Default loopback listening is not token-based access protection; LAN mode expands access.
- **Long operations:** synchronous CLI calls can block other bridge requests during backfill and rebuild.
- **Secrets:** skill-feed cleaning has no general credential-redaction guarantee.

These findings come from static repository analysis, not a live model reproduction. Check source code, the README, and issue records for the latest status.

## Get help

Read the [repository README](https://github.com/yinwenyuan28-afk/pi-memory-system#readme), or describe your version, steps, and error in [GitHub Issues](https://github.com/yinwenyuan28-afk/pi-memory-system/issues). Remove keys and private memory before sharing.
