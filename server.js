// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 10000;

const COLORS = ['red', 'green', 'blue', 'yellow'];

function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]] } return a; }
function cryptoId(){ return Math.random().toString(36).slice(2,10); }

function makeDeck(){
  const deck = [];
  COLORS.forEach(color=>{
    deck.push({ id: cryptoId(), type:'number', color, value:0 });
    for(let v=1;v<=9;v++){ deck.push({ id: cryptoId(), type:'number', color, value:v }); deck.push({ id: cryptoId(), type:'number', color, value:v }); }
    for(let i=0;i<2;i++){ deck.push({ id: cryptoId(), type:'skip', color }); deck.push({ id: cryptoId(), type:'reverse', color }); deck.push({ id: cryptoId(), type:'draw1', color }); deck.push({ id: cryptoId(), type:'draw2', color }); }
  });
  for(let i=0;i<4;i++){ deck.push({ id: cryptoId(), type:'wild', color:'wild' }); deck.push({ id: cryptoId(), type:'draw4', color:'wild' }); }
  return shuffle(deck);
}

let game = null;

function createGame(){
  const deck = makeDeck();
  let top = deck.shift();
  while(top && top.type !== 'number'){ deck.push(top); top = deck.shift(); if(deck.length===0) break; }
  if(!top) top = { id: cryptoId(), type:'number', color:'red', value:0 };
  return {
    deck,
    discard: [top],
    players: [],
    currentIndex:0,
    direction:1,
    pendingDraw:0,
    topCard: top
  };
}

function reshuffleIfNeeded(){
  if(game.deck.length === 0){
    const keep = game.discard.splice(game.discard.length-1,1);
    game.deck.push(...shuffle(game.discard));
    game.discard = keep;
  }
}

function nextIndex(step=1){
  const n = game.players.length; if(n===0) return 0;
  return ((game.currentIndex + game.direction*step) % n + n) % n;
}

function emitStateToAll(){
  game.players.forEach(p=>{
    const payload = {
      topCard: game.topCard,
      drawDeckCount: game.deck.length,
      currentPlayerId: game.players[game.currentIndex]?.id || null,
      players: game.players.map(pp=>({
        id:pp.id, nick:pp.nick, cardsCount:pp.hand.length,
        cards: pp.id===p.id ? pp.hand : undefined,
        hasCalledUno: pp.hasCalledUno||false
      })),
      pendingDraw: game.pendingDraw
    };
    io.to(p.id).emit('gameState', payload);
  });
}

function logToAll(msg){ io.emit('log', msg); }

io.on('connection', socket=>{
  if(!game) game = createGame();

  const nick = socket.handshake.auth?.nick || 'J'+Math.floor(Math.random()*999);
  socket.data.nick = nick;
  const player = { id: socket.id, nick, hand:[], hasCalledUno:false };
  for(let i=0;i<7;i++){ reshuffleIfNeeded(); player.hand.push(game.deck.shift()); }
  game.players.push(player);

  logToAll(`${nick} rejoint la partie`);
  emitStateToAll();

  socket.on('playCard', payload=>{
    const meIdx = game.players.findIndex(p=>p.id===socket.id);
    if(meIdx!==game.currentIndex){ socket.emit('errorMsg','Ce n\'est pas ton tour'); return; }
    const me = game.players[meIdx];
    const idx = payload.cardIndex;
    if(typeof idx!=='number'||idx<0||idx>=me.hand.length){ socket.emit('errorMsg','Carte invalide'); return; }
    const card = me.hand[idx];
    const top = game.topCard;
    const sameColor = card.color===top.color;
    const sameNumber = card.type==='number' && top.type==='number' && card.value===top.value;
    const sameTypeSpecial = card.type===top.type && card.type!=='number';
    const isWildOrDraw4 = (card.type==='wild'||card.type==='draw4');
    if(!(sameColor||sameNumber||sameTypeSpecial||isWildOrDraw4)){ socket.emit('errorMsg','Coup invalide'); return; }
    if(me.hand.length===1 && card.type!=='number'){ socket.emit('youCannotPlaySpecialLast'); return; }

    me.hand.splice(idx,1);
    game.discard.push(card);
    io.emit('cardPlayed',{ playerId: me.id, card });

    if(card.type==='wild'||card.type==='draw4'){
      const chosen = payload.chosenColor;
      if(!['red','green','blue','yellow'].includes(chosen)){ me.hand.push(card); game.discard.pop(); socket.emit('errorMsg','Choisir une couleur valide'); return; }
      game.topCard = {...card, color:chosen};
      logToAll(`${me.nick} joue ${card.type==='draw4'?'+4':'WILD'} et choisit ${chosen}`);
    } else {
      game.topCard = card;
      logToAll(`${me.nick} joue ${card.type==='number'?card.value:card.type} ${card.color}`);
    }

    if(me.hand.length===1) me.hasCalledUno=false;

    let advance = 1;
    if(card.type==='reverse') game.direction*=-1;
    else if(card.type==='skip') advance=2;
    else if(card.type==='draw1') game.pendingDraw+=1;
    else if(card.type==='draw2') game.pendingDraw+=2;
    else if(card.type==='draw4') game.pendingDraw+=4;

    if(me.hand.length===0){
      logToAll(`${me.nick} a gagné !`);
      emitStateToAll();
      return;
    }

    game.currentIndex = nextIndex(advance);
    emitStateToAll();
  });

  socket.on('drawOne', ()=>{
    const meIdx = game.players.findIndex(p=>p.id===socket.id);
    if(meIdx!==game.currentIndex){ socket.emit('errorMsg','Ce n\'est pas ton tour'); return; }
    const me = game.players[meIdx];
    if(game.pendingDraw>0){
      const amt = game.pendingDraw;
      for(let i=0;i<amt;i++){ reshuffleIfNeeded(); const c=game.deck.shift(); me.hand.push(c); io.emit('cardDrawn',{playerId:me.id, card:c}); }
      logToAll(`${me.nick} pioche ${amt} cartes (pénalité)`);
      game.pendingDraw=0;
      game.currentIndex = nextIndex(1);
      emitStateToAll();
      return;
    }
    reshuffleIfNeeded(); const card=game.deck.shift(); me.hand.push(card);
    io.emit('cardDrawn',{playerId:me.id, card});
    logToAll(`${me.nick} pioche 1 carte`);
    game.currentIndex = nextIndex(1);
    emitStateToAll();
  });

  socket.on('callUno', ()=>{
    const me = game.players.find(p=>p.id===socket.id); if(!me) return;
    if(me.hand.length===1){ me.hasCalledUno=true; logToAll(`${me.nick} dit UNO !`); emitStateToAll(); } else socket.emit('errorMsg','Impossible de dire UNO maintenant');
  });

  socket.on('counterUno', ({targetId})=>{
    const target = game.players.find(p=>p.id===targetId); if(!target){ socket.emit('errorMsg','Cible invalide'); return; }
    if(target.hand.length===1 && !target.hasCalledUno){
      for(let i=0;i<2;i++){ reshuffleIfNeeded(); const c=game.deck.shift(); target.hand.push(c); io.emit('cardDrawn',{playerId:target.id, card:c}); }
      logToAll(`${socket.data.nick} fait contre-UNO sur ${target.nick} → ${target.nick} pioche 2`);
      emitStateToAll();
    } else socket.emit('errorMsg','Contre-UNO invalide');
  });

  socket.on('disconnect', ()=>{
    const idx = game.players.findIndex(p=>p.id===socket.id);
    if(idx>=0){ const name = game.players[idx].nick; game.players.splice(idx,1); logToAll(`${name} s'est déconnecté`); if(game.players.length===0) game=null; else if(game.currentIndex>=game.players.length) game.currentIndex=0; emitStateToAll(); }
  });
});

server.listen(PORT, ()=>console.log('UNO serveur écoute sur', PORT));
