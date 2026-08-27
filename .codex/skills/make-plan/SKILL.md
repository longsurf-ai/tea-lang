---
name: make_plan
description: |
  Create concise, code-grounded implementation plans as markdown files in the plans/ folder.
  Use this skill whenever the user asks to write, create, draft, or make a plan; says
  "/plan <topic>"; or asks to plan the implementation of a feature, refactor, bug fix,
  migration, or architecture change. The output is a short, scannable execution document,
  not an exhaustive design transcript.
---

# Make Plan

Create a concise implementation plan and save it in `plans/`.

## Understand the change

Investigate thoroughly, then compress what you learned. Before writing:

1. Read the code that owns the current behavior and the main call paths the
   change will touch.
2. Read the nearest `AGENTS.md` files and relevant authority docs in `docs/`.
3. Identify the source of truth, the invariant being changed or preserved, and
   how the implementation will enforce it.
4. If the plan touches a database schema, persisted JSON/JSONB shape, migration,
   migration runner, or deploy DB gate, read `.skills/migration/SKILL.md` and
   follow its confirmation rules before describing the change.
5. Resolve important unknowns from the repository when possible. Include an
   assumption only when it remains unresolved and would materially change the
   plan.

Do not turn the investigation into a file inventory or narrate everything you
read. The plan should contain conclusions.

## Save the plan

Write one file at:

```text
plans/YYYYMMDD-<short-kebab-case-slug>.md
```

Use today's date with no dashes. Keep the slug descriptive and under about 60
characters.

## Length and readability

Aim for 400-900 words. Do not exceed roughly 1,200 words unless the user asks
for a deep plan or the change has genuine migration, rollout, or safety
complexity. If a plan cannot stay actionable within that budget, split the work
into separately executable plans instead of appending more detail.

Optimize for a reviewer who needs to understand the change in two minutes:

- Lead with one compact ASCII diagram as the primary explanation of the system
  change. Use prose to annotate what the diagram cannot communicate.
- State each fact or decision once.
- Prefer short bullets and numbered steps over long prose.
- Name only the primary owner files or directories, not every likely edit.
- Include exact schemas or signatures only when the contract itself changes.
- Treat database schema changes as mandatory contract detail, not optional
  verbosity.
- Use tables when repeated fields need exact comparison. Database schema
  changes always use an ASCII before/after table diagram as described below.
- Keep verification proportional to risk. Browser steps belong only in plans
  with user-visible behavior.

## Document structure

Use these four sections.

### 1. System map

Start the plan with an ASCII diagram in a fenced `text` block. This is the
primary communication surface, not a decorative overview added after the
prose. Show the ownership boundary, data flow, state transition, sequence, or
before/after relationship that explains the change.

Use plain ASCII such as `+---+`, `|`, and `-->`; do not use Mermaid or Unicode
box-drawing characters. Keep the diagram focused, normally 6-20 lines. Prefer
one diagram; use two only when current and proposed states cannot remain clear
in one view. Even a small bug-fix plan should show its important write path,
async sequence, or state transition.

After the diagram, add 2-5 bullets for decisions the picture cannot express:

- the source of truth;
- the invariant and its enforcement level;
- a consequential tradeoff or scope boundary;
- an unresolved question, only if it blocks a safe choice.

Do not restate the diagram in prose.

### 2. Problem

In at most two short paragraphs, explain:

- the current behavior and its owner;
- the concrete failure, limitation, or requirement;
- the desired outcome and scope boundary.

Lead with the root problem, not a generic statement that code needs cleanup.

### 3. Implementation

Write 3-7 numbered steps in dependency order. Each step should fit this compact
pattern:

```markdown
1. **Outcome** — `primary/path`, `other/owner`
   - What changes at the owner or boundary.
   - Which invariant or contract is enforced, and at what level.
```

Combine closely related edits. Mention migrations, generated surfaces, docs, or
rollout gates only when the change actually requires them. Leave tactical code
organization to the implementer unless it is part of the contract.

#### Database schema changes

When any relational or application-owned JSON/JSONB schema changes, describe it
with DDL-equivalent precision. Never write only "update the schema," "add the
ownership fields," or similar shorthand.

Lead with a fenced `text` ASCII table diagram showing the persisted before and
after shapes. Database changes are easiest to review when table ownership,
columns, keys, and relationships are visible before the migration prose. Use
plain ASCII, not Mermaid or Unicode box drawing. For example:

```text
BEFORE                         AFTER
widgets                        widgets
+--------------------+         +------------------------+
| id text PK         |         | id text PK             |
| owner text         | rename  | owner_id uuid NOT NULL |
+--------------------+  ---->  +------------------------+
                                      |
                                      +-- FK -> users(id)

widget_cache                    DROPPED
```

Show every changed table in the diagram. Include added, removed, renamed, or
altered columns; nullability and defaults; primary/unique/foreign keys; and
important indexes or checks. For large unchanged tables, show only identity
columns plus changed fields and label the omitted fields as unchanged. After
the diagram, use short prose for details that do not render cleanly in a table:
migration order, existing-row transformation, validation/failure gates,
expand/contract sequencing, and generated/application projections.

Include every applicable detail:

- exact schema and table names;
- every added, removed, renamed, or altered column, including SQL type,
  nullability, default, generated or identity behavior, and existing-row
  treatment;
- primary keys, unique constraints, checks, foreign-key targets, and `ON
DELETE` / `ON UPDATE` actions;
- indexes, including column order, uniqueness, expressions, and predicates;
- enum, domain, sequence, trigger, or policy changes;
- exact persisted JSON/JSONB shape changes and the boundary schema that owns
  them;
- forward migration order, backfill or data-migration steps, rollout gates,
  and when constraints become enforceable;
- ORM/schema definitions, generated types, and other projections that must be
  updated from the database owner.

State explicitly how existing rows reach the new valid shape; if no historical
transformation is required, explain why. SQL-shaped blocks may supplement the
diagram when exact expressions or predicates matter, but do not replace it.

### 4. Verification

Provide 3-8 checkbox items, ordered from focused checks to end-to-end proof.
Each item should name the command or interaction and the expected observable
result. Include failure, concurrency, migration, or rollback cases only when
they are relevant to the risk of this change.

## Final pass

Before saving, remove repetition, background that does not affect an
implementation choice, speculative file lists, and generic verification such as
"test thoroughly." Confirm that a reader can answer:

1. Does the ASCII diagram communicate the change before the prose is read?
2. What source of truth changes?
3. What invariant must remain true, and how is it enforced?
4. What are the few implementation steps?
5. What proves the work is complete?
6. If the database changes, is the schema exact enough to implement without
   guessing any persisted shape, constraint, index, or existing-row treatment?
7. If the database changes, does an ASCII before/after table diagram make the
   structural change understandable before the migration prose is read?
