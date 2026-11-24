process.env.T_WRITE=4;process.env.T_VOTE=4;process.env.T_REVEAL=0.3;process.env.PORT=3999;
const {server}=await import('../server.mjs');const {io}=await import('socket.io-client');
const U='http://localhost:3999';const wait=ms=>new Promise(r=>setTimeout(r,ms));
server.listen(3999,async()=>{
 const h=io(U);let hs;h.on('state',s=>hs=s);
 const code=await new Promise(r=>h.emit('host:create',{origin:U},a=>r(a.code)));
 console.log('room',code,'url',hs?.url);
 h.emit('host:bots',3);
 const mk=async(name)=>{const s=io(U);s.v=null;s.on('you',v=>s.v=v);const a=await new Promise(r=>s.emit('p:join',{code,name,pid:name+'1'},r));console.log('join',name,a);return s};
 const A=await mk('Маша'),B=await mk('Петя');
 const bad=await new Promise(r=>A.emit('p:join',{code:'ZZZZ',name:'x',pid:'q'},r));console.log('bad code',bad.err);
 await wait(200);console.log('lobby players',hs.players.map(p=>p.name).join(', '));
 for(let q=0;q<5;q++){
  h.emit('host:next');await wait(300);
  if(q===0){const t=await new Promise(r=>A.emit('p:lie','С кактусом в горшке!',r));console.log('truth check:',t.warn?'blocked':'NOT BLOCKED')}
  console.log('Q',q+1,hs.phase,hs.q);
  await new Promise(r=>A.emit('p:lie','с тремя чемоданами '+q,r));
  await new Promise(r=>B.emit('p:lie','с тремя чемоданами '+q,r)); // одинаковая ложь — должна слиться
  await wait(4500);
  if(hs.phase!=='vote')console.log('!! expected vote, got',hs.phase);
  const own=A.v.opts.some(o=>o.text.startsWith('с тремя'));console.log(' opts',hs.opts.length,'own hidden for A:',!own);
  A.emit('p:vote',A.v.opts[0].i);B.emit('p:vote',B.v.opts[1].i);
  await wait(4600);
  let guard=0;while(hs.phase==='reveal'&&guard++<40){await wait(200)}
  console.log(' after reveal ->',hs.phase,'A delta',A.v.delta,'place',A.v.place,'/',A.v.n);
  if(hs.phase==='final')break;
 }
 console.log('final winner',hs.ranking[0].name,hs.ranking[0].score,'liar',JSON.stringify(hs.liar));
 // reconnect
 A.disconnect();await wait(200);const A2=io(U);A2.on('you',v=>A2.v=v);await new Promise(r=>A2.emit('p:join',{code,name:'',pid:'Маша1'},r));await wait(200);console.log('reconnect score kept',A2.v.score===hs.ranking.find(p=>p.name==='Маша').score);
 h.emit('host:next');await wait(200);console.log('after final ->',hs.phase,'scores reset',hs.players.length);
 // custom pack
 const c=await new Promise(r=>h.emit('host:pack',{custom:{title:'Юбилей',qs:[{q:'Она выиграла ___',truth:'гуся',lies:['Сочи']},{q:'без пропуска',truth:'да'}]}},r));console.log('custom',c,hs.title,hs.total);
 process.exit(0);
});
