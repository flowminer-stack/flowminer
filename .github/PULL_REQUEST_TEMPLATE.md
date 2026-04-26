# Summary

<!-- 1-3 sentences on what this PR does and why. -->

## Changes

<!-- Bullet list of key changes. Skip if the summary is enough. -->

## Test plan

<!-- How did you verify this works? Include the commands you ran. -->

- [ ] `docker compose build` succeeds
- [ ] `docker compose up -d` — all services become healthy
- [ ] Manual smoke test of the changed feature

## Screenshots (if UI)

<!-- Drop before/after images here. -->

## Checklist

- [ ] I read `CONTRIBUTING.md`
- [ ] New code has docstrings / JSDoc where public
- [ ] Type hints (Python) / strict types (TS) on new functions
- [ ] No new hardcoded secrets, keys, or credentials
- [ ] New dependencies pinned in `requirements.txt` / `package.json`
- [ ] New env vars documented in `.env.example`
- [ ] New endpoints gated by the correct `Depends(...)` authorization
