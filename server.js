// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 10000;
const COLORS = ['red','green','blue','yellow'];
const MAX_CARDS_LOSE = 35;

function cryptoId(){ return Math.random().toString(36).slice(2,10); }
function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]] } return a; }

function makeDeck(){
  const deck = [];
  COLORS.forEach(color=>{
    deck.push({ id: cryptoId(), type: 'number', color, value: 0 });
    for(let v=1; v<=9; v++){ deck.push({ id: cryptoId(), type: 'number', color, value: v }); deck.push({ id: cryptoId(), type: 'number', color, value: v }); }
    for(let i=0;i<2;i++){ deck.push({ id: cryptoId(), type: 'skip', color }); deck.push({ id: cryptoId(), type: 'reverse', color }); deck.push({ id: cryptoId(), type: 'draw1', color }); deck.push({ id: cryptoId(), type: 'draw2', color }); }
  });
  for(let i=0;i<4;i++) deck.push({ id: cryptoId(), type: 'wild', color:'wild' });
  for(let i=0;i<4;i++) deck.push({ id: cryptoId(), type: 'draw4', color:'wild' });
  return shuffle(deck);
}

let game = null;

function createGame(){
  const deck = makeDeck();
  let top = deck.shift();
  while(top && top.type !== 'number'){ deck.push(top); top = deck.shift(); if(deck.length === 0) break; }
  if(!top) top = { id: cryptoId(), type:'number', color:'red', value:0 };
  return { deck, discard:[top], players:[], currentIndex:0, direction:1, pendingDraw:0, topCard:top };
}
if(!game) game = createGame();

function reshuffleIfNeeded(){
  if(game.deck.length === 0){
    const keep = game.discard.splice(game.discard.length-1, 1);
    game.deck.push(...shuffle(game.discard));
    game.discard = keep;
  }
}

function nextIndex(step = 1){
  const n = game.players.filter(p=>!p.isSpectator).length;
  if(n === 0) return 0;
  let idx = game.currentIndex;
  let moved = 0;
  while(moved < step){
    idx = (idx + game.direction + game.players.length) % game.players.length;
    if(!game.players[idx].isSpectator) moved++;
  }
  return idx;
}

function logAll(msg){ io.emit('log', msg); }

function emitStateToAll(){
  game.players.forEach(p => {
    const payload = {
      topCard: game.topCard,
      drawDeckCount: game.deck.length,
      currentPlayerId: game.players[game.currentIndex] ? game.players[game.currentIndex].id : null,
      players: game.players.map(pp=>({
        id: pp.id, nick: pp.nick, cardsCount: pp.hand.length,
        cards: pp.id === p.id ? pp.hand : undefined,
        isSpectator: pp.isSpectator || false,
        hasCalledUno: pp.hasCalledUno || false
      })),
      pendingDraw: game.pendingDraw
    };
    io.to(p.id).emit('gameState', payload);
  });
}

function removePlayerById(id){
  const idx = game.players.findIndex(p=>p.id === id);
  if(idx !== -1){ const nick = game.players[idx].nick; game.players.splice(idx,1); logAll(`${nick} s'est déconnecté.`); }
  if(game.players.length === 0){ game = createGame(); logAll('Partie réinitialisée (plus de joueurs).'); }
}

function makeSpectator(playerId, reason){
  const p = game.players.find(x=>x.id===playerId);
  if(!p) return;
  p.isSpectator = true;
  p.hasCalledUno = false;
  logAll(`${p.nick} devient spectateur (${reason}).`);
}

function checkEliminationsAndRestart(){
  for(const p of game.players){
    if(!p.isSpectator && p.hand.length > MAX_CARDS_LOSE) makeSpectator(p.id, `a dépassé ${MAX_CARDS_LOSE} cartes`);
    if(!p.isSpectator && p.hand.length === 0) makeSpectator(p.id, 'a gagné (0 cartes)');
  }
  const active = game.players.filter(p=>!p.isSpectator);
  if(active.length <= 1) restartGameAndRedeal();
  else emitStateToAll();
}

function restartGameAndRedeal(){
  const connected = game.players.slice();
  game = createGame();
  for(const old of connected){
    const newPlayer = { id: old.id, nick: old.nick, hand: [], hasCalledUno:false, isSpectator:false };
    for(let i=0;i<7;i++){ reshuffleIfNeeded(); newPlayer.hand.push(game.deck.shift()); }
    game.players.push(newPlayer);
  }
  game.currentIndex = 0; game.direction = 1; game.pendingDraw = 0;
  logAll('Nouvelle partie lancée et cartes redistribuées.');
  emitStateToAll();
}

io.on('connection', socket => {
  const nick = socket.handshake.auth?.nick || ('Joueur' + Math.floor(Math.random()*999));
  socket.data.nick = nick;
  removePlayerById(socket.id);

  const player = { id: socket.id, nick, hand: [], hasCalledUno:false, isSpectator:false };
  for(let i=0;i<7;i++){ reshuffleIfNeeded(); player.hand.push(game.deck.shift()); }
  game.players.push(player);
  logAll(`${nick} a rejoint la partie (${game.players.length} joueurs).`);
  emitStateToAll();

  socket.on('playCard', payload => {
    const meIdx = game.players.findIndex(p=>p.id===socket.id); if(meIdx === -1) return;
    const me = game.players[meIdx]; if(me.isSpectator) return;
    if(game.players[game.currentIndex].id !== socket.id) return;

    const idx = payload.cardIndex;
    if(typeof idx !== 'number' || idx < 0 || idx >= me.hand.length) return;

    const card = me.hand[idx]; const top = game.topCard;
    const sameColor = card.color === top.color;
    const sameNumber = card.type==='number' && top.type==='number' && card.value===top.value;
    const sameTypeSpecial = card.type === top.type && card.type!=='number';
    const isWildOrDraw4 = card.type==='wild'||card.type==='draw4';
    if(!(sameColor||sameNumber||sameTypeSpecial||isWildOrDraw4)) return;

    if(me.hand.length === 1 && card.type!=='number') return;

    me.hand.splice(idx,1);
    game.discard.push(card);
    io.emit('cardPlayed',{ playerId: me.id, card });

    if(card.type==='wild'||card.type==='draw4'){
      const chosen = payload.chosenColor; if(!['red','green','blue','yellow'].includes(chosen)) return;
      game.topCard = { ...card, color: chosen };
    } else game.topCard = card;

    if(me.hand.length===1) me.hasCalledUno=false;
    let advance=1;
    if(card.type==='reverse') game.direction*=-1;
    else if(card.type==='skip') advance=2;
    else if(card.type==='draw1') game.pendingDraw+=1;
    else if(card.type==='draw2') game.pendingDraw+=2;
    else if(card.type==='draw4') game.pendingDraw+=4;

    checkEliminationsAndRestart();
    game.currentIndex = nextIndex(advance);
    emitStateToAll();
  });

  socket.on('drawOne', () => {
    const meIdx = game.players.findIndex(p=>p.id===socket.id); if(meIdx === -1) return;
    const me = game.players[meIdx]; if(me.isSpectator) return;
    if(game.players[game.currentIndex].id !== socket.id) return;

    const amt = game.pendingDraw>0?game.pendingDraw:1;
    for(let i=0;i<amt;i++){ reshuffleIfNeeded(); const c=game.deck.shift(); me.hand.push(c); io.emit('cardDrawn',{ playerId: me.id, card:c }); }
    game.pendingDraw = 0;
    game.currentIndex = nextIndex(1);
    checkEliminationsAndRestart();
  });

  socket.on('callUno', () => {
    const me = game.players.find(p=>p.id===socket.id); if(!me || me.isSpectator) return;
    if(me.hand.length===1){ me.hasCalledUno=true; logAll(`${me.nick} dit UNO !`); emitStateToAll(); }
  });

  socket.on('counterUno', ({ targetId }) => {
    const target = game.players.find(p=>p.id===targetId); if(!target) return;
    if(target.hand.length===1 && !target.hasCalledUno){
      for(let i=0;i<2;i++){ reshuffleIfNeeded(); const c=game.deck.shift(); target.hand.push(c); io.emit('cardDrawn',{ playerId: target.id, card:c }); }
      logAll(`${socket.data.nick} fait contre-UNO sur ${target.nick}`);
      checkEliminationsAndRestart();
    }
  });

  socket.on('disconnect', () => { removePlayerById(socket.id); if(game.players.length>0 && game.currentIndex>=game.players.length) game.currentIndex=0; emitStateToAll(); });
});

server.listen(PORT,()=>console.log('UNO server listening on',PORT));
