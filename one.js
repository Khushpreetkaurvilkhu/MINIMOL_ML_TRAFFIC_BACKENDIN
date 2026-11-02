const Sim = require('../app/sim.js'), LLM = require('../app/llm.js');
const model = process.argv[2];
(async()=>{
  const w = Sim.create(1); for (let i=0;i<40;i++) Sim.step(w, Sim.baselinePolicy(w));
  const pk = Sim.telemetryAll(w);
  const base = Sim.baselinePolicy(w);
  try {
    const r = await LLM.decide({base:'http://localhost:8787', model, jsonMode:false}, w.tick, pk);
    let agree=0; r.actions.forEach((a,i)=>{ if(a.action===base[i].action) agree++; });
    console.log(model, Math.round(r.latency)+'ms', 'agree', agree+'/20', 'repaired', r.repaired, 'promptChars', r.prompt.length);
  } catch(e){ console.log(model, 'ERR', e.message.slice(0,200)); }
})();
