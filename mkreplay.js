const fs=require('fs'); const r=JSON.parse(fs.readFileSync(process.argv[2]));
const slim={seed:r.seed,model:r.model,T:r.T,recordedAt:r.recordedAt,summary:r.summary||null,ticks:r.ticks.map(t=>({latency:t.latency,repaired:t.repaired,actions:t.actions}))};
fs.writeFileSync('app/replay.js','/* Recorded closed-loop LLM run (real API responses). Replayed deterministically. */\nwindow.REPLAY='+JSON.stringify(slim)+';\n');
console.log('ticks',slim.ticks.length);
