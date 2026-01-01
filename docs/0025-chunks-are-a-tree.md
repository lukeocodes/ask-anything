# 0025. Chunks are a tree; structure lives in columns

Date: 2026-01-01

## Status

Accepted

## Context

A chunk with its heading breadcrumb pasted into the body retrieves well and
tells you nothing about its neighbours. Answering "what comes before this",
"show the whole section", or "which files talk about X at the top level"
means re-parsing the document. Fixed-size windows cut sentences and headings
in half.

## Decision

Chunking is progressive by heading depth. A document is parsed into a
heading tree. A section (a heading and everything under it) is emitted whole
if it fits `size` (1,800 characters). If it does not, its own text (the
heading line plus the preamble before its first child heading) becomes the
section's chunk, and each child heading is chunked the same way, one level
deeper. Any text that still does not fit, a leaf section or an oversized
preamble, is packed by paragraph into children of that section, code fences
kept intact as `code` chunks, with `overlap` (200 characters) carried
between consecutive paragraph chunks and reset at a code fence or a hard
split. Files without headings get a `file` root; if the text fits it is the
root's body, otherwise the root body is empty and the text lives in its
paragraph children. A file whose only top-level content is one heading uses
that section as its root.

Every emitted chunk is a row in `knowledge_chunks` with its structure in
columns, not in the body:

| Column | Meaning |
|---|---|
| `parent_id` | The enclosing chunk. `NULL` at the root. A self foreign key. |
| `depth` | 0 for a `file` root; heading level for sections; for packed children, the parent's depth plus one. |
| `heading` | This chunk's own heading text, if any. |
| `heading_path` | Ancestor headings root to self, as `text[]`. |
| `path` | Materialised position, `"0.2.1"`, for subtree and sibling queries. |
| `ord` | Document order across the whole file. |
| `kind` | `section`, `paragraph`, `code`, or `file`. |
| `start_line`, `end_line` | Position in the source file. |

A section whose children are emitted is always emitted itself, even if its
preamble is empty, so every `parent_id` points at a real row and ancestors are
never missing.

The body is the text alone. The embedding is computed over
`heading_path.join(" > ") + "\n\n" + body` (the body alone at the root), so
recall keeps the context the columns now hold. A chunk with an empty body
gets no embedding and is never a retrieval hit; it exists for structure.

`GET /v1/chunks/:id/context` returns a chunk with its parent, siblings, and
children. `GET /v1/knowledge/:id/chunks` returns a record's tree.

## Consequences

- Relatives are a join, not a parse. Siblings share `parent_id`; a subtree is
  a `path` prefix; the enclosing section is one hop up.
- Retrieval returns `heading_path` and `path` with every hit, so an answer
  can cite "README > Installation > Docker" and a consumer can expand it.
- Chunks are a little larger than fixed windows and vary in size. That is the
  trade for never splitting a heading from its first paragraph.
- Non-Markdown files get a flat tree: one root, paragraph children. Language
  aware splitting for code is a later decision.
