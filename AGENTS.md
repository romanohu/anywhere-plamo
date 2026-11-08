# Development workflow

- Develop application features on `dev`. Merge into `main` only when requested.
- GitHub Actions are paused to conserve the monthly allowance. Keep workflows manual-only; do not enable, dispatch, or rerun them unless the user explicitly asks to resume Actions.
- Include `[skip ci]` in commits while Actions are paused, and verify that pushes do not start workflow runs.
- Run appropriate checks locally.
