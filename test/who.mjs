process.env.T_WHO=3;
const {server}=await import('../server.mjs');const {io}=await import('socket.io-client');
const U='http://localhost:3993';const wait=ms=>new Promise(r=>setTimeout(r,ms));
server.listen(3993,async()=>{
 const h=io(U);let hs;h.on('state',s=>hs=s);
 const code=await new Promise(r=>h.emit('host:create',{origin:U},a=>r(a.code)));
 h.emit('host:bots',3);h.emit('host:mode','who');
 const mk=async n=>{const s=io(U);s.on('you',v=>s.v=v);await new Promise(r=>s.emit('p:join',{code,name:n,pid:n},r));return s};
 const A=await mk('Маша'),B=await mk('Петя');await wait(300);
 console.log('mode',hs.mode,'total',hs.total,'title',hs.title);
 for(let i=0;i<hs.total;i++){
  h.emit('host:next');await wait(300);
  if(hs.phase!=='whovote'){console.log('!! phase',hs.phase);break}
  const cand=A.v.cands.find(c=>c.name==='Петя');A.emit('p:who',cand.id);B.emit('p:who',cand.id);
  await wait(3500);
  if(i===0)console.log('reveal:',hs.phase,'leaders',hs.leaders,'tally',hs.tally.map(t=>t.name+':'+t.n).join(' '),'A delta',A.v.delta);
  h.emit('host:next');await wait(200);
 }
 console.log('final',hs.phase,'star',JSON.stringify(hs.star),'winner',hs.ranking[0].name,hs.ranking[0].score);
 h.emit('host:next');await wait(200);h.emit('host:mode','who');
 const c=await new Promise(r=>h.emit('host:pack',{custom:{title:'Юбилей',qs:['Кто скорее всего уснёт?','Кто первым споёт?']}},r));
 console.log('custom who',c,hs.title,hs.total);
 h.emit('host:mode','blef');await wait(200);console.log('back to blef',hs.mode,hs.total,hs.title);
 process.exit(0);
});
