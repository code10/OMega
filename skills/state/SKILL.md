---
name: state
description: Workflow skill that recaps what the current thread is doing and how far along it is. Use when the user asks "state".
triggers: [user, model]
---

In plain English, remind me what we're doing in this thread, and what % we are done. Be concise and practical.

## Output Format

- **Current Objective**: 1 sentence stating the overall task or goal being worked on.
- **Progress**: Estimated percentage complete (e.g., `~70%`) with a brief tally (e.g., `Completed: X, Y | Remaining: Z`).
- **Immediate Next Step**: 1 sentence stating what is actively being done or waiting on input.

## Guidelines

- Answer in short, plain English. Be extremely concise (3–5 lines max).
- Base the completion percentage on concrete milestones (completed steps vs. remaining planned steps). If blocked or waiting on user input, state that clearly.
