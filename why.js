const fs=require('fs'); const Sim=require('../app/sim.js');
const rec=JSON.parse(fs.readFileSync(process.argv[2])); const w=Sim.create(rec.seed);
const hist={};
for (let i=0;i<rec.ticks.length;i++){
  const pk=Sim.telemetryAll(w); const acts=rec.ticks[i].actions;
  pk.forEach(p=>{(hist[p.id]=hist[p.id]||[]).push({tick:i,p,a:acts.find(a=>a.id===p.id)}); if(hist[p.id].length>8) hist[p.id].shift();});
  const red0=w.redViolations; const before=w.cars.map(c=>c.passedLine);
  Sim.step(w, acts);
  if (w.redViolations>red0){ w.cars.forEach((c,k)=>{ if(!before[k]&&c.passedLine&&c.enteredOn==='RED'){ console.log('RED RUN car',c.id,'tick',i,'light',JSON.stringify(w.light)); hist[c.id].slice(-6).forEach(h=>console.log(' ',h.tick, JSON.stringify(h.p.sig), 'v',h.p.v, 'stop',JSON.stringify(h.p.stop),'->',JSON.stringify(h.a))); }}); }
}
console.log('replay summary cleared',w.cleared,'coll',w.collisions,'red',w.redViolations,'ticks',w.tick);
