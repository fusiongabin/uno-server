// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const srv = http.createServer(app);
const io = new Server(srv, { cors: { origin: "*", methods: ["GET","POST"] } });

const PORT = process.env.PORT || 10000;
const COLORS = ['red','yellow','green','blue'];

function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]] } return a; }

function makeDeck(){
  const deck = [];
  COLORS.forEach(color=>{
    deck.push({ id: cryptoId(), type:'number', color, value:0 });
    for(let v=1; v<=9; v++){ deck.push({ id: cryptoId(), type:'number', color, value:v }); deck.push({ id: cryptoId(), type:'number', color, value:v }); }
    for(let i=0;i<2;i++){ deck.push({ id: cryptoId(), type:'skip', color }); deck.push({ id: cryptoId(), type:'reverse', color }); deck.push({ id: cryptoId(), type:'draw1', color }); deck.push({ id: cryptoId(), type:'draw2', color }); }
  });
  for(let i=0;i<4;i++){ deck.push({ id: cryptoId(), type:'wild', color:'wild' }); deck.push({ id: cryptoId(), type:'draw4', color:'wild' }); }
  return shuffle(deck);
}
function cryptoId(){ return Math.random().toString(36).slice(2,10); }

const rooms = {};
function createRoom(name){
  const deck = makeDeck();
  const discard = [];
  let top = deck.shift();
  while(top && top.type !== 'number'){ deck.push(top); top = deck.shift(); if(deck.length===0) break; }
  if(!top) top = { id: cryptoId(), type: 'number', color:'red', value:0 };
  discard.push(top);
  rooms[name] = { deck, discard, players: [], currentIndex:0, direction:1, pendingDraw:0, topCard: top };
  return rooms[name];
}
function reshuffleIfNeeded(r){
  if(r.deck.length === 0){
    const keep = r.discard.splice(r.discard.length-1,1);
    r.deck.push(...shuffle(r.discard));
    r.discard = keep;
  }
}
function nextIndex(state, step=1){
  const n = state.players.length; if(n===0) return 0;
  return ((state.currentIndex + state.direction*step) % n + n) % n;
}
function logTo(room, txt){ io.to(room).emit('log', txt); }

io.on('connection', socket => {
  const nick = socket.handshake.auth?.nick || 'J'+Math.floor(Math.random()*999);
  const roomName = socket.handshake.auth?.room || 'default';
  socket.data.nick = nick; socket.data.room = roomName;
  socket.join(roomName);

  if(!rooms[roomName]) createRoom(roomName);
  const room = rooms[roomName];

  const player = { id: socket.id, nick, hand: [], hasCalledUno:false };
  for(let i=0;i<7;i++){ reshuffleIfNeeded(room); const c = room.deck.shift(); player.hand.push(c); }
  room.players.push(player);

  logTo(roomName, `${nick} rejoint la partie (${room.players.length})`);
  emitState(roomName);

  socket.on('playCard', payload => {
    const r = rooms[roomName]; if(!r) return;
    const meIdx = r.players.findIndex(p=>p.id===socket.id);
    if(meIdx !== r.currentIndex){ socket.emit('errorMsg','Ce n\'est pas ton tour.'); return; }
    const me = r.players[meIdx];
    const idx = payload.cardIndex;
    if(typeof idx !== 'number' || idx<0 || idx>=me.hand.length){ socket.emit('errorMsg','Carte invalide'); return; }
    const card = me.hand[idx];
    const top = r.topCard;

    const sameColor = (card.color === top.color);
    const sameNumber = (card.type==='number' && top.type==='number' && card.value === top.value);
    const sameTypeSpecial = (card.type === top.type && card.type !== 'number');
    const isWildOrDraw4 = (card.type === 'wild' || card.type === 'draw4');

    if(!(sameColor || sameNumber || sameTypeSpecial || isWildOrDraw4)){
      socket.emit('errorMsg','Coup invalide.'); return;
    }

    // cannot finish on special
    if(me.hand.length === 1 && card.type !== 'number'){
      socket.emit('youCannotPlaySpecialLast'); return;
    }

    // remove card, push discard
    me.hand.splice(idx,1);
    r.discard.push(card);

    // emit cardPlayed so clients animate the card moving from player's hand -> discard
    io.to(roomName).emit('cardPlayed', { playerId: me.id, card });

    // If wild/draw4: chosenColor required
    if(card.type === 'wild' || card.type === 'draw4'){
      const chosen = payload.chosenColor;
      if(!['red','green','blue','yellow'].includes(chosen)){
        // rollback
        me.hand.push(card); r.discard.pop();
        socket.emit('errorMsg','Choisis une couleur valide.');
        return;
      }
      r.topCard = { ...card, color: chosen };
      logTo(roomName, `${me.nick} joue ${card.type === 'draw4' ? '+4' : 'WILD'} et choisit ${chosen}`);
    } else {
      r.topCard = card;
      logTo(roomName, `${me.nick} joue ${card.type === 'number' ? card.value : card.type} ${card.color}`);
    }

    // UNO reset
    if(me.hand.length === 1) me.hasCalledUno = false;

    // Effects: stacking
    let advance = 1;
    if(card.type === 'reverse'){ r.direction *= -1; }
    else if(card.type === 'skip'){ advance = 2; }
    else if(card.type === 'draw1'){ r.pendingDraw += 1; }
    else if(card.type === 'draw2'){ r.pendingDraw += 2; }
    else if(card.type === 'draw4'){ r.pendingDraw += 4; }

    if(me.hand.length === 0){
      logTo(roomName, `${me.nick} a gagné !`);
      emitState(roomName);
      return;
    }

    r.currentIndex = nextIndex(r, advance);
    emitState(roomName);
  });

  socket.on('drawOne', () => {
    const r = rooms[roomName]; if(!r) return;
    const meIdx = r.players.findIndex(p=>p.id===socket.id);
    if(meIdx !== r.currentIndex){ socket.emit('errorMsg','Ce n\'est pas ton tour.'); return; }
    const me = r.players[meIdx];

    if(r.pendingDraw > 0){
      const amt = r.pendingDraw;
      for(let i=0;i<amt;i++){ reshuffleIfNeeded(r); const c = r.deck.shift(); me.hand.push(c); io.to(roomName).emit('cardDrawn', { playerId: me.id, card: c }); }
      logTo(roomName, `${me.nick} pioche ${amt} (pénalité).`);
      r.pendingDraw = 0;
      r.currentIndex = nextIndex(r,1);
      emitState(roomName);
      return;
    }

    reshuffleIfNeeded(r); const card = r.deck.shift(); me.hand.push(card);
    io.to(roomName).emit('cardDrawn', { playerId: me.id, card });
    logTo(roomName, `${me.nick} pioche 1 carte.`);
    r.currentIndex = nextIndex(r,1);
    emitState(roomName);
  });

  socket.on('callUno', () => {
    const r = rooms[roomName]; if(!r) return; const me = r.players.find(p=>p.id===socket.id); if(!me) return;
    if(me.hand.length === 1){ me.hasCalledUno = true; logTo(roomName, `${me.nick} dit UNO !`); emitState(roomName); } else socket.emit('errorMsg','Tu ne peux pas dire UNO maintenant.');
  });

  socket.on('counterUno', ({ targetId }) => {
    const r = rooms[roomName]; if(!r) return; const target = r.players.find(p=>p.id===targetId);
    if(!target){ socket.emit('errorMsg','Cible invalide'); return; }
    if(target.hand.length === 1 && !target.hasCalledUno){
      for(let i=0;i<2;i++){ reshuffleIfNeeded(r); const c = r.deck.shift(); target.hand.push(c); io.to(roomName).emit('cardDrawn', { playerId: target.id, card: c }); }
      logTo(roomName, `${socket.data.nick} fait contre-UNO sur ${target.nick} → ${target.nick} pioche 2.`);
      emitState(roomName);
    } else socket.emit('errorMsg','Contre-UNO invalide.');
  });

  socket.on('disconnect', () => {
    const r = rooms[roomName]; if(!r) return;
    const idx = r.players.findIndex(p=>p.id===socket.id);
    if(idx>=0){ const name = r.players[idx].nick; r.players.splice(idx,1); logTo(roomName, `${name} s'est déconnecté.`); if(r.players.length===0) delete rooms[roomName]; else { if(r.currentIndex >= r.players.length) r.currentIndex = 0; emitState(roomName); } }
  });

  function emitState(roomName){
    const r = rooms[roomName]; if(!r) return;
    r.players.forEach(p=>{
      const state = {
        topCard: r.topCard,
        drawDeckCount: r.deck.length,
        currentPlayerId: r.players[r.currentIndex]?.id || null,
        players: r.players.map(pp=>({ id:pp.id, nick:pp.nick, cardsCount: pp.hand.length, cards: (pp.id === p.id ? pp.hand : undefined), hasCalledUno: pp.hasCalledUno })),
        pendingDraw: r.pendingDraw
      };
      io.to(p.id).emit('gameState', state);
    });
  }
});

srv.listen(PORT, ()=> console.log('UNO server listening on', PORT));
