---
title: Learn reusable skills
description: Turn repeatable workflows into guides with clear scope and steps.
---

# Learn reusable skills

Some experience belongs in a fact record. Other experience makes a useful operating guide. Skill learning handles the latter.

## What makes a useful skill

A repeatable debugging approach, validation sequence, or operating workflow. It should have an applicable situation, inputs, steps, and a finish condition.

A preference to discuss plans belongs in your profile. A guide to debugging payment callbacks can be a skill.

## Start learning

```text
/learn
```

Use `/learn [source]` to specify source code, documents, or conversation material. The extension also periodically reviews incremental skill-feed content.

Periodic review checks after 20 interactive inputs by default, pauses its counter during review, and waits for a complete assistant reply as material. Current incremental review uses this session's feed; it does not automatically learn from every historical session. It runs separately from the L1–L3 queue.

## Inspect the result

In a callback investigation, the specific cause can become a fact and a transferable decision principle can become a method. A complete procedure with inputs, steps, branches, outputs, and validation can become a skill.

Review prioritizes updating or extending an existing related skill before creating another. Inspect the trigger, required inputs, failure branches, and validation steps. A submitted request does not guarantee a new skill. The quality checks are model instructions and can still be misjudged.

## Sources and limits

Skill-feed retains tool calls and results to help understand execution. It is separate from L0's ordinary conversation archive. Reuse and quality checks apply; not every conversation produces a skill.

Default cleaning is not general-purpose secret redaction. Credentials in tool arguments or results may enter skill-feed and be sent to the configured model during review. Read [Data, privacy, and backups](./data) before choosing material.
