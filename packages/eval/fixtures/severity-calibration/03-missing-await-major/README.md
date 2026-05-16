# 03 — Missing await on audit log (major)

The `await` was removed from an `audit.log(...)` call inside an async
handler. Failures from the audit sink are now silently lost. Modal
severity should be `major`. Calibration drift below `minor` or above
`major` indicates the rubric is mis-tuned for fire-and-forget
async regressions.
