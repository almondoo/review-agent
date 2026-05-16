# 02 — Path traversal (critical)

The diff removes a post-`path.join` containment check from a public
HTTP handler. A request with `?name=../../etc/passwd` now escapes the
upload directory and reads arbitrary files. Severity must land
`critical` modally; `major` is acceptable but anything below indicates
the model has lost calibration on unauthenticated file-read.
