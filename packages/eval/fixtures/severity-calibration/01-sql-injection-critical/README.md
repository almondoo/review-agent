# 01 — SQL injection (critical)

A parameterised query is rewritten as template-string interpolation of a
user-controlled `email` parameter. Classic SQL injection — severity must
land at `critical` modally, never below `major`.

This fixture exists to catch silent calibration drift: when a future
prompt edit makes the model rate clear injection regressions as
`minor` or `info`, this fixture flips and the consistency score drops.
