# 04 — Pagination off-by-one (major)

The `slice` end-bound was changed from `start + size` to `start + size + 1`.
Every page now overlaps the next page by one element. Modal severity
`major` — a correctness regression visible to every caller of `pageOf`.
