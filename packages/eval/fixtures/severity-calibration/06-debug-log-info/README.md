# 06 — Leftover debug log (info)

A `console.log('[debug] …', id)` line was added to a request handler.
The logged value is public URL data (no PII), so there is no security
component. Modal severity `info`; `minor` is the ceiling. Anything
above `minor` indicates the model is over-rating cosmetic logging
leftovers.
