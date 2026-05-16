# 05 — Magic number reintroduced (minor)

A named constant was inlined back into the call site as a magic number,
and the constant itself was renamed to `*_DEPRECATED`. No runtime
change — readability / maintainability regression only. Modal severity
`minor`; calibration drift above `major` indicates over-flagging.
