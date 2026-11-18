F=src/main/native-chat/agent-session-journal/zz-cadence.test.ts
echo "== head"; pnpm exec vitest run --config config/vitest.config.ts --silent=false $F 2>&1 | grep -a "CAD\|Tests "
git fetch -q origin brennanb2025/qa/streaming-text-tail-on 2>/dev/null
git checkout f5f8630d2a31aec928cc2f6f0fa73af2003c3ffe -- src/main/native-chat/agent-session-journal src/main/native-chat/agent-session-timeline
echo "== f5f8630"; pnpm exec vitest run --config config/vitest.config.ts --silent=false $F 2>&1 | grep -a "CAD\|Tests "
git checkout HEAD -- src/main/native-chat/agent-session-journal src/main/native-chat/agent-session-timeline
