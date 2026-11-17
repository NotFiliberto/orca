set -e
F=src/main/runtime/orchestration/db/maintenance/scratch-party-bench.test.ts
VARIANT=set pnpm exec vitest run --config config/vitest.config.ts $F
git apply scratch-includes.patch
VARIANT=includes pnpm exec vitest run --config config/vitest.config.ts $F
git apply -R scratch-includes.patch
