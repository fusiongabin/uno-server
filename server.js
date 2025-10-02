// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 10000;
const COLORS = ['red', 'green', 'blue', 'yellow'];

function cryptoId(){ return Math.random().toString(36).substr(2,9); }
function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]] } return a; }

function makeDeck(){
  const deck=[];
  COLORS.forEach(color=>{
    for(let i=0;i<=9;i++){ deck.push({id:cryptoId(),type:'number',color,value:i}); if(i>0) deck.push({id:cryptoId(),type:'number',color,value:i}); }
    ['skip','reverse','draw2'].forEach(type=>{ deck.push({id:cryptoId(),type,color}); deck.push({id:cryptoId(),type,color}); });
  });
  for(let i=0;i<4;i++){ deck.push({id:cryptoId(),type:'wild',color:'wild'}); deck.push({id:cryptoId(),type:'draw4',color:'wild'}); }
  return shuffle(deck);
}

let game = null;
function createGame(){
  const deck = makeDeck();
  let top = deck.shift(); while(top.type!=='number'){ deck.push(top); top=deck.shift(); }
  return { deck, discard:[top], players:[], currentIndex:0, direction:1, pendingDraw:0, topCard:top };
}
if(!game) game=createGame();

function reshuffleIfNeeded(){
  if(game.deck.length===0){
    const keep=game.discard.splice(game.discard.length-1,1);
    game.deck.push(...shuffle(game.discard));
    game.discard=keep;
  }
}

function nextIndex(step=1){
  const n=game.players.length; if(n===0) return 0;
  return ((game.currentIndex+game.direction*step)%n+n)%n;
}

function emitStateToAll(){
  game.players.forEach(p=>{
    const payload={
      topCard:game.topCard,
      drawDeckCount:game.deck.length,
      deck:game.deck,
      currentPlayerId:game.players[game.currentIndex]?.id||null,
      players:game.players.map(pp=>({
        id:pp.id,nick:pp.nick,cardsCount:pp.hand.length,
        cards: pp.id===p.id ? pp.hand : undefined,
        hasCalledUno: pp.hasCalledUno||false
      })),
      pendingDraw:game.pendingDraw
    };
    io.to(p.id).emit('gameState',payload);
  });
}

function logAll(msg){ io.emit('log',msg); }

io.on('connection', socket=>{
  const nick = socket.handshake.auth?.nick || 'Player';
  const player = {id:socket.id,nick,hand:[]};
  for(let i=0;i<7;i++){ reshuffleIfNeeded(); player.hand.push(game.deck.shift()); }
  game.players.push(player);

  logAll(`${nick} rejoint la partie`);
  emitStateToAll();

  socket.on('playCard',payload=>{
    const meIdx=game.players.findIndex(p=>p.id===socket.id);
    if(meIdx!==game.currentIndex){ socket.emit('errorMsg','Ce n\'est pas ton tour'); return; }
    const me=game.players[meIdx];
    const card=me.hand[payload.cardIndex];
    const top=game.topCard;
    const sameColor=card.color===top.color;
    const sameNumber=card.type==='number' && top.type==='number' && card.value===top.value;
    const sameSpecial=card.type===top.type && card.type!=='number';
    const wildOrDraw4=card.type==='wild'||card.type==='draw4';
    if(!(sameColor||sameNumber||sameSpecial||wildOrDraw4)){ socket.emit('errorMsg','Coup invalide'); return; }
    if(me.hand.length===1 && card.type!=='number'){ socket.emit('youCannotPlaySpecialLast'); return; }

    me.hand.splice(payload.cardIndex,1);
    game.discard.push(card);
    game.topCard=card;

    if(card.type==='reverse') game.direction*=-1;
    else if(card.type==='skip') game.currentIndex=nextIndex(2)-1;
    else if(card.type==='draw2') game.pendingDraw+=2;
    else if(card.type==='draw4') game.pendingDraw+=4;

    if(me.hand.length===1) me.hasCalledUno=false;
    if(me.hand.length===0){ logAll(`${me.nick} a gagné !`); emitStateToAll(); return; }

    game.currentIndex=nextIndex(1);
    emitStateToAll();
  });

  socket.on('drawOne',()=>{
    const meIdx=game.players.findIndex(p=>p.id===socket.id);
    if(meIdx!==game.currentIndex){ socket.emit('errorMsg','Ce n\'est pas ton tour'); return; }
    const me=game.players[meIdx];
    const amt=game.pendingDraw>0?game.pendingDraw:1;
    for(let i=0;i<amt;i++){ reshuffleIfNeeded(); me.hand.push(game.deck.shift()); }
    game.pendingDraw=0;
    game.currentIndex=nextIndex(1);
    emitStateToAll();
  });

  socket.on('callUno',()=>{
    const me=game.players.find(p=>p.id===socket.id);
    if(me.hand.length===1){ me.hasCalledUno=true; logAll(`${me.nick} dit UNO !`); emitStateToAll(); }
  });

  socket.on('disconnect',()=>{
    const idx=game.players.findIndex(p=>p.id===socket.id);
    if(idx>=0){ const name=game.players[idx].nick; game.players.splice(idx,1); logAll(`${name} s'est déconnecté`); if(game.players.length===0) game=createGame(); emitStateToAll(); }
  });
});

server.listen(PORT,()=>console.log('UNO serveur écoute sur',PORT));
