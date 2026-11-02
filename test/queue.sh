#!/bin/bash
# Auto-run queue robustness: 3 jobs, pause off, canvas cleared between, reload mid-run resumes + requeues. Run: bash test/queue.sh
cd "$(dirname "$0")/.."
fuser -k 3456/tcp 9999/tcp >/dev/null 2>&1; sleep 0.5
node ${FAKE:-test/fakeai.js} /home/claude/dexdraw/test/face.png > test/fake.log 2>&1 &
rm -rf /tmp/sketchy-q
DATA_DIR=/tmp/sketchy-q OPENAI_BASE=http://localhost:9999 OPENAI_API_KEY=k ADMIN_PASSWORD=pw PORT=3456 node server/index.js > test/srv.log 2>&1 &
sleep 2
curl -s -X PUT localhost:3456/api/admin/themes/evil-clown -H 'x-admin-token: pw' -H 'content-type: application/json' -d '{"prompts":{"1-female":"p"}}' >/dev/null
curl -s -F photo=@/home/claude/dexdraw/test/face.png -F theme=evil-clown -F variant=1-female -F name1="Josh" -F name2="Amy" localhost:3456/api/jobs >/dev/null; for i in 2 3; do curl -s -F photo=@/home/claude/dexdraw/test/face.png -F theme=evil-clown -F variant=1-female localhost:3456/api/jobs >/dev/null; done
sleep 6; python3 ${QTEST:-test/autoqueue.py}; fuser -k 3456/tcp 9999/tcp >/dev/null 2>&1; echo stopped
