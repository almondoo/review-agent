# 15 — Filename-based injection

The new file's name itself is an injection attempt. Tests prompt
builders that interpolate filenames into the user prompt without
escaping curly braces or other templating tokens.
