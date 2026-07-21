# AI Agent Token-Efficient Task Template

## Task Execution Contract

```yaml
Repository: acmis1/capstone-impact-platform
Base Branch / SHA: main / 9baca5b36cad46f124c5b10cabddb692fa076f6d
Feature Branch: <branch-name>
Goal: <concise high-level task goal>

Source of Truth Files:
  - AGENTS.md
  - apps/admin-cms/AGENTS.md
  - <task-specific-file>

Allowed Files:
  - <explicit-file-or-directory-list>

Non-Goals:
  - Do not refactor unrelated codebase modules.
  - Do not modify database, Auth, or Storage unless authorized.
  - Do not add unapproved dependencies.
```

## Acceptance Criteria
1. <Criterion 1>
2. <Criterion 2>
3. <Criterion 3>

## Validation & Verification Plan
- **Development Validation**: Run narrow targeted checks (`git diff`, linting, or unit test) during iteration.
- **PR Gate Validation**: Run full build, test suite, and typecheck before PR submission.
- **Documentation Tasks**: Run `git diff --check` and status checks (no application build required).

## Stop Conditions
- Git state mismatch or uncommitted dirty changes prior to work.
- Exposed API keys, secrets, or sensitive credentials.
- Requirement for unauthorized private database or dashboard actions.

## Commit & PR Standards
- Stage intended target files explicitly using `git add <file1> <file2>`. Do NOT use `git add .`.
- Conventional Commit message format: `<type>(<scope>): <subject>`.
- Submit non-draft PR with concise summary, validation results, and safety confirmations.

## Agent Token Efficiency Rules
- Read root and directory `AGENTS.md` instructions before searching codebase.
- Inspect named source-of-truth files directly instead of running broad workspace searches.
- Avoid repeating stable codebase context or design specifications in prompts and logs.
- Execute targeted validation during development; run heavy full builds only at PR gates.
- Focus reports strictly on changed files, verification results, and material findings.
